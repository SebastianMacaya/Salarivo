import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const origin = "http://localhost:3000";

test("reaceptar documentos vigentes habilita el producto sin bloquear derechos de privacidad", async (context) => {
  const [{ buildApp }, { loadConfig }, { pool, withTransaction }, { opaqueToken, sessionCookieName, tokenHash }] = await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("@salarivo/database"),
    import("../../src/security.ts"),
  ]);
  const config = loadConfig({ ...process.env, APP_ENV: "test", LOG_LEVEL: "silent", PUBLIC_ORIGIN: origin });
  const app = await buildApp(config, { provisionStorage: false });
  await app.ready();

  const userId = randomUUID();
  const sessionToken = opaqueToken();
  const cookie = `${sessionCookieName(config.appEnv)}=${sessionToken}`;
  context.after(async () => {
    try {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    } finally {
      await app.close();
      await pool.end();
    }
  });

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users (
         id, email, password_hash, display_name, status, default_retention_policy,
         onboarding_completed_at, last_login_at
       ) VALUES ($1, $2, NULL, 'Persona Sintética', 'ACTIVE', 'KEEP_ORIGINAL', now(), now())`,
      [userId, `legal-reacceptance-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO auth_accounts (id, user_id, provider, provider_account_id, last_login_at)
       VALUES ($1, $2, 'GOOGLE', $3, now())`,
      [randomUUID(), userId, `legal-reacceptance-${userId}`],
    );
    await client.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), userId, tokenHash(sessionToken)],
    );
  });

  const meBefore = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
  assert.equal(meBefore.statusCode, 200, meBefore.body);
  assert.equal(meBefore.json().data.legalAcceptanceRequired, true);

  const blockedProduct = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie } });
  assert.equal(blockedProduct.statusCode, 403, blockedProduct.body);
  assert.equal(blockedProduct.json().error.code, "LEGAL_ACCEPTANCE_REQUIRED");

  for (const request of [
    { method: "POST" as const, url: "/api/v1/privacy/exports", payload: {} },
    {
      method: "DELETE" as const,
      url: "/api/v1/privacy/account",
      payload: { confirmation: "ELIMINAR", receiptToken: opaqueToken() },
    },
  ]) {
    const response = await app.inject({ ...request, headers: { origin, cookie } });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "STEP_UP_REQUIRED");
  }

  const [terms, privacy] = await Promise.all([
    app.inject({ method: "GET", url: "/api/v1/legal/terms" }),
    app.inject({ method: "GET", url: "/api/v1/legal/privacy" }),
  ]);
  assert.equal(terms.statusCode, 200, terms.body);
  assert.equal(privacy.statusCode, 200, privacy.body);
  const payload = {
    acceptedTerms: true,
    acknowledgedPrivacy: true,
    termsVersion: terms.json().data.version,
    privacyVersion: privacy.json().data.version,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/legal-acknowledgements",
      headers: { origin, cookie },
      payload,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().data.legalAcceptanceRequired, false);
  }

  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM legal_acknowledgements WHERE user_id = $1) AS acknowledgements,
         (SELECT count(*)::integer FROM audit_events
           WHERE user_id = $1 AND action = 'LEGAL_DOCUMENTS_RECORDED') AS audits`,
      [userId],
    )).rows[0],
    { acknowledgements: 2, audits: 1 },
  );

  const meAfter = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
  assert.equal(meAfter.statusCode, 200, meAfter.body);
  assert.equal(meAfter.json().data.legalAcceptanceRequired, false);
  const enabledProduct = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie } });
  assert.equal(enabledProduct.statusCode, 200, enabledProduct.body);
});
