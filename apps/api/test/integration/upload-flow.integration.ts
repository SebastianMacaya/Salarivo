import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "redis";
import type { GoogleIdentity, GoogleOidcClient } from "../../src/google-oidc.ts";
import {
  lockR2PhysicalStorageBytes,
  R2_GLOBAL_STORAGE_CAP_BYTES,
} from "../../src/r2-capacity.ts";
import { createStorage } from "../../src/storage.ts";

const origin = "http://localhost:3000";

function syntheticPayrollPdf(): Uint8Array<ArrayBuffer> {
  const lines = [
    "RECIBO DE SUELDO",
    "Empleador: Empresa Sintetica SA",
    "CUIL: 20-00000000-0",
    "Periodo de liquidacion: 08/2026",
    "Sueldo basico $ 1.234.567,89",
    "Presentismo $ 123.456,78",
    "Jubilacion $ 135.802,47",
    "Obra social $ 37.037,04",
    "Total bruto $ 1.358.024,67",
    "Total descuentos $ 172.839,51",
    "Neto a cobrar $ 1.185.185,16",
  ];
  const escaped = lines.map((line) => line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"));
  const content = `BT\n/F1 11 Tf\n50 750 Td\n${escaped.map((line, index) => `${index ? "0 -18 Td\n" : ""}(${line}) Tj`).join("\n")}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("upload privado crea un único documento y un único intent durable", async (context) => {
  type IntegrationExtraction = {
    employerName: string | null;
    fields: Array<Record<string, unknown> & { fieldPath: string }>;
    [key: string]: unknown;
  };
  type IntegrationJobRow = {
    attempt: number;
    base_extraction_run_id: string | null;
    document_id: string;
    id: string;
    lease_owner: string;
    max_attempts: number;
    pipeline_fingerprint: string | null;
    previous_document_status: "COMPLETED" | "NEEDS_REVIEW" | "FAILED_PERMANENT" | "CANCELLED" | null;
    processing_version: number;
    reprocessing_batch_id: string | null;
    requested_by_user_id: string | null;
    stage: "SECURITY_VALIDATION" | "TEXT_EXTRACTION" | "PARSING" | "DOCUMENT_PIPELINE_V2";
    trigger_kind: "INITIAL_UPLOAD" | "USER_TYPE_CONFIRMATION" | "USER_REPROCESS" | "ADMIN_REPROCESS" | "PARSER_UPGRADE" | "AUTOMATIC_RECOVERY";
    user_id: string;
  };
  const workerModuleUrl = new URL("../../../worker-documents/src/index.ts", import.meta.url).href;
  const extractionEngineModuleUrl = new URL("../../../worker-documents/src/engine.ts", import.meta.url).href;
  const [
    { buildApp },
    { loadConfig },
    { currentPipelineFingerprint, pool, processingPipelineVersions, withTransaction },
    { generateTotpCode },
    { opaqueToken, sessionCookieName, tokenHash },
    workerModule,
    extractionEngineModule,
  ] = await Promise.all([
    import("../../src/app.ts"),
    import("../../src/config.ts"),
    import("@salarivo/database"),
    import("../../src/mfa.ts"),
    import("../../src/security.ts"),
    import(workerModuleUrl),
    import(extractionEngineModuleUrl),
  ]);
  const { failJob, persistExtraction, reconcileDatabaseState, setDocumentStage, WorkerError } = workerModule as {
    WorkerError: new (code: string, retryable: boolean) => Error;
    failJob: (job: IntegrationJobRow, error: unknown) => Promise<void>;
    persistExtraction: (
      job: IntegrationJobRow,
      classification: {
        confidence: number;
        decision: "SUPPORTED" | "LOW_CONFIDENCE" | "UNSUPPORTED";
        documentType: "PAYROLL" | null;
        signals: string[];
      },
      extraction: unknown,
      source: "PDF_TEXT" | "OCR",
      partialOcr: boolean,
      computeMs: number,
    ) => Promise<"COMPLETED" | "NEEDS_REVIEW" | null>;
    reconcileDatabaseState: (config: {
      dispatcherBatchSize: number;
    }) => Promise<{ batches: number; exhausted: number; recovered: number; released: number }>;
    setDocumentStage: (job: IntegrationJobRow, processingStatus: string, values?: Record<string, unknown>) => Promise<void>;
  };
  const { extractArgentinePayroll } = extractionEngineModule as {
    extractArgentinePayroll: (text: string, source: "PDF_TEXT" | "OCR") => IntegrationExtraction;
  };
  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    PUBLIC_ORIGIN: origin,
  });
  const googleIdentities = new Map<string, GoogleIdentity>();
  const googleStarts = new Map<string, {
    nonce: string;
    codeChallenge: string;
    stepUp: boolean;
    loginHint?: string;
  }>();
  let googleExchangeCalls = 0;
  const googleOidc: GoogleOidcClient = {
    async authorizationUrl(input) {
      googleStarts.set(input.state, {
        nonce: input.nonce,
        codeChallenge: input.codeChallenge,
        stepUp: input.stepUp,
        ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      });
      const url = new URL("https://accounts.google.test/authorize");
      url.searchParams.set("state", input.state);
      url.searchParams.set("nonce", input.nonce);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("step_up", String(input.stepUp));
      if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
      return url.href;
    },
    async exchange(input) {
      googleExchangeCalls += 1;
      const started = googleStarts.get(input.state);
      assert.ok(started, "Google exchange must use a state issued by authorizationUrl");
      assert.equal(input.callbackUrl.searchParams.get("state"), input.state);
      assert.equal(input.nonce, started.nonce);
      assert.equal(
        createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url"),
        started.codeChallenge,
      );
      assert.equal(input.stepUp, started.stepUp);
      const identity = googleIdentities.get(input.callbackUrl.searchParams.get("code") ?? "");
      assert.ok(identity, "Google exchange code must identify a synthetic account");
      return identity;
    },
  };
  const app = await buildApp(config, { provisionStorage: true, googleOidc });
  const s3 = new S3Client({
    credentials: { accessKeyId: config.storageAccessKey, secretAccessKey: config.storageSecretKey },
    endpoint: config.storageInternalEndpoint,
    forcePathStyle: true,
    region: config.storageRegion,
  });
  const redis = createClient({ url: process.env.QUEUE_URL ?? "redis://127.0.0.1:6379" });
  await redis.connect();
  context.after(async () => {
    await app.close();
    await redis.quit();
    s3.destroy();
    await pool.end();
  });
  await app.ready();
  const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });

  async function runWorkerUntil(event: string): Promise<void> {
    const worker = spawn(process.execPath, [fileURLToPath(new URL("../../../worker-documents/src/index.ts", import.meta.url))], {
      env: {
        ...process.env,
        APP_ENV: "test",
        STORAGE_DELETE_VERIFY_DELAY_MS: "100",
        UPLOAD_CLEANUP_GRACE_MS: "60000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let matched = false;
    const reached = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WORKER_EVENT_TIMEOUT:${event}:${output.slice(-500)}`)), 20_000);
      timer.unref();
      worker.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes(`"event":"${event}"`)) {
          matched = true;
          clearTimeout(timer);
          resolve();
        }
      });
      worker.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        if (!matched) {
          clearTimeout(timer);
          reject(new Error(`WORKER_EXITED:${String(code)}:${output.slice(-500)}`));
        }
      });
    });
    try {
      await reached;
    } finally {
      if (worker.exitCode === null) {
        const exited = once(worker, "exit");
        worker.kill("SIGTERM");
        await exited.catch(() => undefined);
      }
    }
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: config.storageBucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  const deletionReceiptToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  async function seedGoogleAccount(email: string): Promise<string> {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionToken = opaqueToken();
    const providerAccountId = createHash("sha256").update(email).digest("base64url");
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (
           id, email, password_hash, display_name, status, default_retention_policy,
           onboarding_completed_at, last_login_at
         ) VALUES ($1, $2, NULL, 'Persona Sintética', 'ACTIVE', 'KEEP_ORIGINAL', now(), now())`,
        [userId, email],
      );
      await client.query(
        `INSERT INTO auth_accounts (id, user_id, provider, provider_account_id, last_login_at)
         VALUES ($1, $2, 'GOOGLE', $3, now())`,
        [crypto.randomUUID(), userId, providerAccountId],
      );
      const acknowledgements = await client.query(
        `INSERT INTO legal_acknowledgements (user_id, document_version_id)
         SELECT $1, version.id
           FROM (
             SELECT DISTINCT ON (document_type) id, document_type
               FROM legal_document_versions
              WHERE document_type IN ('TERMS', 'PRIVACY_NOTICE')
                AND locale = 'es-AR' AND published_at <= now() AND effective_at <= now()
              ORDER BY document_type, effective_at DESC, published_at DESC
           ) AS version`,
        [userId],
      );
      assert.equal(acknowledgements.rowCount, 2);
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, userId, tokenHash(sessionToken), new Date(Date.now() + config.sessionTtlSeconds * 1000)],
      );
    });
    return `salarivo_session=${sessionToken}`;
  }

  function rotatedCookie(response: { headers: Record<string, string | string[] | number | undefined> }, current: string): string {
    const value = response.headers["set-cookie"];
    return value ? String(Array.isArray(value) ? value[0] : value).split(";", 1)[0]! : current;
  }

  function namedCookie(
    response: { headers: Record<string, string | string[] | number | undefined> },
    name: string,
  ): string {
    const raw = response.headers["set-cookie"];
    const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
    for (const value of values) {
      const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(value);
      if (match) return `${name}=${match[1] ?? ""}`;
    }
    assert.fail(`${name} cookie is missing`);
  }

  async function startGoogle(path = "/api/v1/auth/google/start", sessionCookie?: string) {
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { origin, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const authorizationUrl = new URL(String(response.json().data.authorizationUrl));
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    return { oauthCookie: namedCookie(response, "salarivo_oauth"), state, loginHint: authorizationUrl.searchParams.get("login_hint") };
  }

  function googleCallback(
    attempt: { oauthCookie: string; state: string },
    code: string,
    sessionCookie?: string,
    userAgent?: string,
  ) {
    return app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(attempt.state)}`,
      headers: {
        cookie: [sessionCookie, attempt.oauthCookie].filter(Boolean).join("; "),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
    });
  }

  async function createSession(email: string): Promise<string> {
    const sessionToken = opaqueToken();
    const inserted = await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       SELECT $1, users.id, $2, $3
         FROM users
        WHERE users.email = $4
          AND EXISTS (SELECT 1 FROM auth_accounts account
            WHERE account.user_id = users.id AND account.provider = 'GOOGLE')
       RETURNING id`,
      [crypto.randomUUID(), tokenHash(sessionToken), new Date(Date.now() + config.sessionTtlSeconds * 1000), email],
    );
    assert.equal(inserted.rowCount, 1);
    return `salarivo_session=${sessionToken}`;
  }

  async function grantStepUp(cookie: string): Promise<void> {
    const sessionToken = cookie.split("=", 2)[1];
    assert.ok(sessionToken);
    const updated = await pool.query(
      `UPDATE sessions SET step_up_expires_at = now() + interval '10 minutes'
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash(sessionToken)],
    );
    assert.equal(updated.rowCount, 1);
  }

  const suffix = crypto.randomUUID();
  const publicTerms = await app.inject({ method: "GET", url: "/api/v1/legal/terms" });
  assert.equal(publicTerms.statusCode, 200, publicTerms.body);
  assert.equal(publicTerms.json().data.version, "1.0");
  assert.doesNotMatch(publicTerms.json().data.content, /(?:^|\n)(?:BORRADOR|TODO)\b|revisión legal antes de producción/i);
  const publicPrivacy = await app.inject({ method: "GET", url: "/api/v1/legal/privacy" });
  assert.equal(publicPrivacy.statusCode, 200, publicPrivacy.body);
  assert.equal(publicPrivacy.json().data.version, "1.0");
  const versionedTerms = await app.inject({ method: "GET", url: "/api/v1/legal/terms?version=1.0" });
  assert.equal(versionedTerms.statusCode, 200, versionedTerms.body);
  await assert.rejects(
    () => pool.query("UPDATE legal_document_versions SET title = title WHERE document_type = 'TERMS' AND version = '1.0'"),
    /append-only/,
  );
  const approvedDocuments = await pool.query(
    `SELECT document_type, version, approved_for_production
       FROM legal_document_versions
      ORDER BY document_type`,
  );
  assert.deepEqual(
    approvedDocuments.rows,
    [
      { document_type: "PRIVACY_NOTICE", version: "1.0", approved_for_production: true },
      { document_type: "TERMS", version: "1.0", approved_for_production: true },
    ],
  );
  const productionApp = await buildApp(
    { ...config, appEnv: "production" },
    { provisionStorage: false, googleOidc },
  );
  await productionApp.ready();
  const productionGoogleSubject = `production_google_${suffix.replaceAll("-", "_")}`;
  const productionGoogleEmail = `production-google-${suffix}@example.test`;
  const legacyEmail = `legacy-${suffix}@example.test`;
  try {
    for (const path of ["register", "login", "forgot-password", "reset-password"]) {
      const legacyPasswordRoute = await productionApp.inject({
        method: "POST",
        url: `/api/v1/auth/${path}`,
        headers: { origin },
        payload: {},
      });
      assert.equal(legacyPasswordRoute.statusCode, 404, legacyPasswordRoute.body);
    }

    const legacyUserId = crypto.randomUUID();
    const legacySessionToken = opaqueToken();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, password_hash, display_name, status, default_retention_policy)
         VALUES ($1, $2, 'legacy-hash-never-verified', 'Cuenta legacy sintética', 'ACTIVE', 'KEEP_ORIGINAL')`,
        [legacyUserId, legacyEmail],
      );
      await client.query(
        `INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), legacyUserId, tokenHash(legacySessionToken), new Date(Date.now() + 60_000)],
      );
    });
    const legacySession = await productionApp.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `${sessionCookieName("production")}=${legacySessionToken}` },
    });
    assert.equal(legacySession.statusCode, 401, legacySession.body);

    const productionGoogleCode = `production-google-${suffix}`;
    googleIdentities.set(productionGoogleCode, {
      subject: productionGoogleSubject,
      email: productionGoogleEmail,
      emailVerified: true,
      displayName: "Google Producción Sintético",
    });
    const productionGoogleStart = await productionApp.inject({
      method: "POST",
      url: "/api/v1/auth/google/start",
      headers: { origin },
      payload: {},
    });
    assert.equal(productionGoogleStart.statusCode, 200, productionGoogleStart.body);
    const productionGoogleState = new URL(
      String(productionGoogleStart.json().data.authorizationUrl),
    ).searchParams.get("state");
    assert.ok(productionGoogleState);
    const productionGoogleOauthCookie = namedCookie(productionGoogleStart, "__Host-salarivo_oauth");
    const productionGoogleCallback = await productionApp.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=${encodeURIComponent(productionGoogleCode)}&state=${encodeURIComponent(productionGoogleState)}`,
      headers: { cookie: productionGoogleOauthCookie },
    });
    assert.equal(productionGoogleCallback.statusCode, 302, productionGoogleCallback.body);
    assert.equal(productionGoogleCallback.headers.location, `${origin}/?auth=google-registration`);
    const productionGoogleRegistration = await productionApp.inject({
      method: "POST",
      url: "/api/v1/auth/google/register",
      headers: { origin, cookie: productionGoogleOauthCookie },
      payload: {
        acceptedTerms: true,
        acknowledgedPrivacy: true,
        termsVersion: "1.0",
        privacyVersion: "1.0",
      },
    });
    assert.equal(productionGoogleRegistration.statusCode, 201, productionGoogleRegistration.body);
    assert.ok(namedCookie(productionGoogleRegistration, "__Host-salarivo_session"));
    assert.deepEqual(
      (await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM users WHERE email = $1) AS users,
           (SELECT count(*)::integer FROM auth_accounts
             WHERE provider = 'GOOGLE' AND provider_account_id = $2) AS accounts,
           (SELECT count(*)::integer FROM sessions session
             JOIN users ON users.id = session.user_id WHERE users.email = $1) AS sessions`,
        [productionGoogleEmail, productionGoogleSubject],
      )).rows[0],
      { users: 1, accounts: 1, sessions: 1 },
    );
    assert.equal(
      (await pool.query("SELECT 1 FROM oauth_attempts WHERE state_hash = $1", [
        createHash("sha256").update(productionGoogleState).digest("hex"),
      ])).rowCount,
      0,
    );
  } finally {
    await productionApp.close();
    await pool.query("DELETE FROM users WHERE email = ANY($1::text[])", [[productionGoogleEmail, legacyEmail]]);
  }
  const deniedGoogleStart = await app.inject({
    method: "POST",
    url: "/api/v1/auth/google/start",
    payload: {},
  });
  assert.equal(deniedGoogleStart.statusCode, 403, deniedGoogleStart.body);
  assert.equal(deniedGoogleStart.json().error.code, "UNTRUSTED_ORIGIN");

  const invalidAttempt = await startGoogle();
  const otherBrowserAttempt = await startGoogle();
  const identityCountsBefore = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM users) AS users,
       (SELECT count(*)::integer FROM auth_accounts) AS accounts,
       (SELECT count(*)::integer FROM sessions) AS sessions`,
  );
  const exchangeCallsBeforeInvalidState = googleExchangeCalls;
  const invalidCallback = await app.inject({
    method: "GET",
    url: `/api/v1/auth/google/callback?code=unused&state=${otherBrowserAttempt.state}`,
    headers: { cookie: invalidAttempt.oauthCookie },
  });
  assert.equal(invalidCallback.statusCode, 302, invalidCallback.body);
  assert.equal(invalidCallback.headers.location, `${origin}/?auth=invalid-callback`);
  assert.equal(googleExchangeCalls, exchangeCallsBeforeInvalidState);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM users) AS users,
         (SELECT count(*)::integer FROM auth_accounts) AS accounts,
         (SELECT count(*)::integer FROM sessions) AS sessions`,
    )).rows[0],
    identityCountsBefore.rows[0],
  );
  await pool.query("DELETE FROM oauth_attempts WHERE state_hash = $1", [
    createHash("sha256").update(invalidAttempt.state).digest("hex"),
  ]);
  await pool.query("DELETE FROM oauth_attempts WHERE state_hash = $1", [
    createHash("sha256").update(otherBrowserAttempt.state).digest("hex"),
  ]);

  const subjectSuffix = suffix.replaceAll("-", "_");
  const googleCode = `new-${suffix}`;
  const googleSubject = `google_${subjectSuffix}`;
  const googleEmail = `google-${suffix}@example.test`;
  googleIdentities.set(googleCode, {
    subject: googleSubject,
    email: googleEmail,
    emailVerified: true,
    displayName: "Persona Google Sintética",
  });
  const googleRegistrationAttempt = await startGoogle();
  const googleRegistrationCallback = await googleCallback(googleRegistrationAttempt, googleCode);
  assert.equal(googleRegistrationCallback.statusCode, 302, googleRegistrationCallback.body);
  assert.equal(googleRegistrationCallback.headers.location, `${origin}/?auth=google-registration`);
  const googleRegistration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/google/register",
    headers: {
      origin,
      cookie: googleRegistrationAttempt.oauthCookie,
      "user-agent": "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
    },
    payload: {
      acceptedTerms: true,
      acknowledgedPrivacy: true,
      termsVersion: "1.0",
      privacyVersion: "1.0",
    },
  });
  assert.equal(googleRegistration.statusCode, 201, googleRegistration.body);
  assert.equal(googleRegistration.json().data.onboardingCompleted, false);
  assert.deepEqual(googleRegistration.json().data.authMethods, ["GOOGLE"]);
  let googleCookie = namedCookie(googleRegistration, "salarivo_session");
  const googlePersisted = await pool.query(
    `SELECT users.id, users.password_hash, users.email_verified_at,
            users.onboarding_completed_at,
            (SELECT count(*)::integer FROM auth_accounts account WHERE account.user_id = users.id) AS accounts,
            (SELECT count(*)::integer FROM sessions session WHERE session.user_id = users.id) AS sessions
       FROM users WHERE users.email = $1`,
    [googleEmail],
  );
  assert.equal(googlePersisted.rowCount, 1);
  assert.equal(googlePersisted.rows[0].password_hash, null);
  assert.ok(googlePersisted.rows[0].email_verified_at instanceof Date);
  assert.equal(googlePersisted.rows[0].onboarding_completed_at, null);
  assert.equal(googlePersisted.rows[0].accounts, 1);
  assert.equal(googlePersisted.rows[0].sessions, 1);
  const googleUserId = String(googlePersisted.rows[0].id);
  assert.deepEqual(
    (await pool.query(
      "SELECT device_type, browser_family, os_family FROM sessions WHERE token_hash = $1",
      [tokenHash(googleCookie.split("=", 2)[1]!)],
    )).rows[0],
    { device_type: "TABLET", browser_family: "SAFARI", os_family: "IOS" },
  );
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count
         FROM legal_acknowledgements acknowledgement
         JOIN legal_document_versions version ON version.id = acknowledgement.document_version_id
           WHERE acknowledgement.user_id = $1 AND version.version = '1.0'`,
         [googleUserId],
       )).rows[0].count,
      2,
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('auth_accounts', 'oauth_attempts')
          AND column_name IN ('access_token', 'refresh_token', 'id_token')
        ORDER BY table_name, column_name`,
    )).rows,
    [],
  );
  const exchangeCallsBeforeReplay = googleExchangeCalls;
  const replayedRegistrationCallback = await googleCallback(googleRegistrationAttempt, googleCode);
  assert.equal(replayedRegistrationCallback.statusCode, 302, replayedRegistrationCallback.body);
  assert.equal(replayedRegistrationCallback.headers.location, `${origin}/?auth=invalid-callback`);
  assert.equal(googleExchangeCalls, exchangeCallsBeforeReplay);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM users WHERE id = $1) AS users,
         (SELECT count(*)::integer FROM auth_accounts WHERE user_id = $1) AS accounts,
         (SELECT count(*)::integer FROM sessions WHERE user_id = $1) AS sessions`,
      [googleUserId],
    )).rows[0],
    { users: 1, accounts: 1, sessions: 1 },
  );

  const completedGoogleOnboarding = await app.inject({
    method: "POST",
    url: "/api/v1/auth/onboarding/complete",
    headers: { origin, cookie: googleCookie },
    payload: {},
  });
  assert.equal(completedGoogleOnboarding.statusCode, 200, completedGoogleOnboarding.body);
  assert.equal(completedGoogleOnboarding.json().data.onboardingCompleted, true);
  assert.ok(
    (await pool.query("SELECT onboarding_completed_at FROM users WHERE id = $1", [googleUserId]))
      .rows[0].onboarding_completed_at instanceof Date,
  );
  const googleLogout = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: { origin, cookie: googleCookie },
    payload: {},
  });
  assert.equal(googleLogout.statusCode, 200, googleLogout.body);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: googleCookie } })).statusCode,
    401,
  );

  const googleLoginCode = `login-${suffix}`;
  googleIdentities.set(googleLoginCode, googleIdentities.get(googleCode)!);
  const googleLoginAttempt = await startGoogle();
  const googleLoginCallback = await googleCallback(
    googleLoginAttempt,
    googleLoginCode,
    undefined,
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/127.0 Mobile Safari/537.36 EdgA/127.0",
  );
  assert.equal(googleLoginCallback.statusCode, 302, googleLoginCallback.body);
  assert.equal(googleLoginCallback.headers.location, `${origin}/?auth=google-success`);
  googleCookie = namedCookie(googleLoginCallback, "salarivo_session");
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM users WHERE email = $1) AS users,
         (SELECT count(*)::integer FROM auth_accounts WHERE provider = 'GOOGLE' AND provider_account_id = $2) AS accounts,
         (SELECT count(*)::integer FROM sessions WHERE user_id = $3 AND revoked_at IS NULL) AS active_sessions`,
      [googleEmail, googleSubject, googleUserId],
    )).rows[0],
    { users: 1, accounts: 1, active_sessions: 1 },
  );
  assert.deepEqual(
    (await pool.query(
      "SELECT device_type, browser_family, os_family FROM sessions WHERE token_hash = $1",
      [tokenHash(googleCookie.split("=", 2)[1]!)],
    )).rows[0],
    { device_type: "MOBILE", browser_family: "EDGE", os_family: "ANDROID" },
  );

  const collisionUserId = crypto.randomUUID();
  const collisionEmail = `existing-collision-${suffix}@example.test`;
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name, status, default_retention_policy)
     VALUES ($1, $2, NULL, 'Cuenta Existente Sintética', 'ACTIVE', 'KEEP_ORIGINAL')`,
    [collisionUserId, collisionEmail],
  );
  const collisionCode = `collision-${suffix}`;
  const collisionSubject = `collision_${subjectSuffix}`;
  googleIdentities.set(collisionCode, {
    subject: collisionSubject,
    email: collisionEmail,
    emailVerified: true,
    displayName: "Colisión Sintética",
  });
  const collisionAttempt = await startGoogle();
  const collisionCallback = await googleCallback(collisionAttempt, collisionCode);
  assert.equal(collisionCallback.statusCode, 302, collisionCallback.body);
  assert.equal(collisionCallback.headers.location, `${origin}/?auth=account-link-required`);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM users WHERE email = $1", [collisionEmail])).rows[0].count, 1);
  assert.equal(
    (await pool.query(
      "SELECT 1 FROM auth_accounts WHERE provider = 'GOOGLE' AND provider_account_id = $1",
      [collisionSubject],
    )).rowCount,
    0,
  );
  await pool.query("DELETE FROM users WHERE id = $1", [collisionUserId]);

  for (const status of ["BLOCKED", "SUSPENDED"] as const) {
    const disabledUserId = crypto.randomUUID();
    const disabledSubject = `${status.toLowerCase()}_${subjectSuffix}`;
    const disabledEmail = `${status.toLowerCase()}-google-${suffix}@example.test`;
    await pool.query(
      `INSERT INTO users (
         id, email, password_hash, display_name, status, default_retention_policy, email_verified_at
       ) VALUES ($1, $2, NULL, 'Google Deshabilitado Sintético', $3, 'KEEP_ORIGINAL', now())`,
      [disabledUserId, disabledEmail, status],
    );
    await pool.query(
      `INSERT INTO auth_accounts (id, user_id, provider, provider_account_id)
       VALUES ($1, $2, 'GOOGLE', $3)`,
      [crypto.randomUUID(), disabledUserId, disabledSubject],
    );
    const disabledCode = `${status.toLowerCase()}-${suffix}`;
    googleIdentities.set(disabledCode, {
      subject: disabledSubject,
      email: disabledEmail,
      emailVerified: true,
      displayName: "Google Deshabilitado Sintético",
    });
    const disabledAttempt = await startGoogle();
    const disabledCallback = await googleCallback(disabledAttempt, disabledCode);
    assert.equal(disabledCallback.statusCode, 302, disabledCallback.body);
    assert.equal(disabledCallback.headers.location, `${origin}/?auth=account-disabled`);
    assert.equal((await pool.query("SELECT 1 FROM sessions WHERE user_id = $1", [disabledUserId])).rowCount, 0);
    await pool.query("DELETE FROM oauth_attempts WHERE state_hash = $1", [
      createHash("sha256").update(disabledAttempt.state).digest("hex"),
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [disabledUserId]);
  }

  const concurrentSubject = `concurrent_${subjectSuffix}`;
  const concurrentEmail = `concurrent-google-${suffix}@example.test`;
  const concurrentCodes = [`concurrent-a-${suffix}`, `concurrent-b-${suffix}`];
  for (const code of concurrentCodes) {
    googleIdentities.set(code, {
      subject: concurrentSubject,
      email: concurrentEmail,
      emailVerified: true,
      displayName: "Google Concurrente Sintético",
    });
  }
  const concurrentAttempts = await Promise.all([startGoogle(), startGoogle()]);
  const concurrentCallbacks = await Promise.all([
    googleCallback(concurrentAttempts[0]!, concurrentCodes[0]!),
    googleCallback(concurrentAttempts[1]!, concurrentCodes[1]!),
  ]);
  assert.deepEqual(
    concurrentCallbacks.map((response) => response.headers.location),
    [`${origin}/?auth=google-registration`, `${origin}/?auth=google-registration`],
  );
  const concurrentRegistrations = await Promise.all(concurrentAttempts.map((attempt) => app.inject({
    method: "POST",
    url: "/api/v1/auth/google/register",
    headers: { origin, cookie: attempt.oauthCookie },
    payload: {
      acceptedTerms: true,
      acknowledgedPrivacy: true,
      termsVersion: "1.0",
      privacyVersion: "1.0",
    },
  })));
  assert.deepEqual(
    concurrentRegistrations.map(({ statusCode }) => statusCode),
    [201, 201],
    concurrentRegistrations.map(({ body }) => body).join("\n"),
  );
  const concurrentIdentity = await pool.query(
    `SELECT users.id,
            (SELECT count(*)::integer FROM auth_accounts account WHERE account.user_id = users.id) AS accounts,
            (SELECT count(*)::integer FROM sessions session WHERE session.user_id = users.id) AS sessions
       FROM users WHERE users.email = $1`,
    [concurrentEmail],
  );
  assert.equal(concurrentIdentity.rowCount, 1);
  assert.deepEqual(
    { accounts: concurrentIdentity.rows[0].accounts, sessions: concurrentIdentity.rows[0].sessions },
    { accounts: 1, sessions: 2 },
  );
  await pool.query("DELETE FROM users WHERE id = $1", [concurrentIdentity.rows[0].id]);

  const googleOtherSessionCode = `other-session-${suffix}`;
  googleIdentities.set(googleOtherSessionCode, googleIdentities.get(googleCode)!);
  const googleOtherSessionAttempt = await startGoogle();
  const googleOtherSessionCallback = await googleCallback(googleOtherSessionAttempt, googleOtherSessionCode);
  assert.equal(googleOtherSessionCallback.headers.location, `${origin}/?auth=google-success`);
  const googleOtherSessionCookie = namedCookie(googleOtherSessionCallback, "salarivo_session");

  const sessionBoundStepUpCode = `session-bound-step-up-${suffix}`;
  googleIdentities.set(sessionBoundStepUpCode, googleIdentities.get(googleCode)!);
  const sessionBoundStepUpAttempt = await startGoogle("/api/v1/auth/google/step-up/start", googleCookie);
  const wrongSessionStepUp = await googleCallback(
    sessionBoundStepUpAttempt,
    sessionBoundStepUpCode,
    googleOtherSessionCookie,
  );
  assert.equal(wrongSessionStepUp.statusCode, 302, wrongSessionStepUp.body);
  assert.equal(wrongSessionStepUp.headers.location, `${origin}/?auth=invalid-callback`);
  await pool.query("DELETE FROM oauth_attempts WHERE state_hash = $1", [
    createHash("sha256").update(sessionBoundStepUpAttempt.state).digest("hex"),
  ]);

  const wrongSubjectStepUpCode = `wrong-subject-step-up-${suffix}`;
  googleIdentities.set(wrongSubjectStepUpCode, {
    subject: `unlinked_${subjectSuffix}`,
    email: `unlinked-google-${suffix}@example.test`,
    emailVerified: true,
    displayName: "Google No Vinculado Sintético",
  });
  const wrongSubjectStepUpAttempt = await startGoogle("/api/v1/auth/google/step-up/start", googleCookie);
  const wrongSubjectStepUp = await googleCallback(
    wrongSubjectStepUpAttempt,
    wrongSubjectStepUpCode,
    googleCookie,
  );
  assert.equal(wrongSubjectStepUp.statusCode, 302, wrongSubjectStepUp.body);
  assert.equal(wrongSubjectStepUp.headers.location, `${origin}/?auth=invalid-callback`);
  await pool.query("DELETE FROM oauth_attempts WHERE state_hash = $1", [
    createHash("sha256").update(wrongSubjectStepUpAttempt.state).digest("hex"),
  ]);
  for (const cookie of [googleCookie, googleOtherSessionCookie]) {
    const deniedSensitiveAction = await app.inject({
      method: "POST",
      url: "/api/v1/privacy/exports",
      headers: { origin, cookie },
      payload: {},
    });
    assert.equal(deniedSensitiveAction.statusCode, 403, deniedSensitiveAction.body);
    assert.equal(deniedSensitiveAction.json().error.code, "STEP_UP_REQUIRED");
  }

  const googleStepUpCode = `step-up-${suffix}`;
  googleIdentities.set(googleStepUpCode, googleIdentities.get(googleCode)!);
  const googleStepUpAttempt = await startGoogle("/api/v1/auth/google/step-up/start", googleCookie);
  assert.equal(googleStepUpAttempt.loginHint, googleIdentities.get(googleCode)!.subject);
  const previousGoogleCookie = googleCookie;
  const googleStepUpCallback = await googleCallback(googleStepUpAttempt, googleStepUpCode, googleCookie);
  assert.equal(googleStepUpCallback.statusCode, 302, googleStepUpCallback.body);
  assert.equal(googleStepUpCallback.headers.location, `${origin}/?auth=google-step-up`);
  googleCookie = namedCookie(googleStepUpCallback, "salarivo_session");
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: previousGoogleCookie } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: googleCookie } })).statusCode,
    200,
  );
  const revokedGoogleSessions = await app.inject({
    method: "POST",
    url: "/api/v1/auth/sessions/revoke-others",
    headers: { origin, cookie: googleCookie },
    payload: {},
  });
  assert.equal(revokedGoogleSessions.statusCode, 200, revokedGoogleSessions.body);
  assert.equal(revokedGoogleSessions.json().data.revokedSessions, 1);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: googleOtherSessionCookie } })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: googleCookie } })).statusCode,
    200,
  );

  const emailA = `a-${suffix}@example.test`;
  const emailB = `b-${suffix}@example.test`;
  let cookieA = await seedGoogleAccount(emailA);
  let cookieB = await seedGoogleAccount(emailB);
  const secondaryCookieA = await createSession(emailA);
  const meA = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieA } });
  assert.equal(meA.statusCode, 200, meA.body);
  assert.equal(meA.json().data.role, "USER");
  const userIdA = String(meA.json().data.id);
  const meB = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieB } });
  assert.equal(meB.statusCode, 200, meB.body);
  const userIdB = String(meB.json().data.id);

  const managedSessionCookieA = await createSession(emailA);
  const managedSessionDigest = tokenHash(managedSessionCookieA.split("=", 2)[1]!);
  const managedSessionId = String((await pool.query(
    `UPDATE sessions
        SET device_type = 'MOBILE', browser_family = 'SAFARI', os_family = 'IOS'
      WHERE token_hash = $1
      RETURNING id`,
    [managedSessionDigest],
  )).rows[0].id);
  const currentSessionDigestA = tokenHash(cookieA.split("=", 2)[1]!);
  await pool.query(
    `UPDATE sessions
        SET created_at = now() - interval '11 minutes', last_seen_at = now() - interval '10 minutes'
      WHERE token_hash = $1`,
    [currentSessionDigestA],
  );
  const listedSessions = await app.inject({
    method: "GET",
    url: "/api/v1/auth/sessions",
    headers: { cookie: cookieA },
  });
  assert.equal(listedSessions.statusCode, 200, listedSessions.body);
  assert.equal(listedSessions.json().data.length, 3);
  assert.equal(listedSessions.json().data[0].current, true);
  assert.deepEqual(
    listedSessions.json().data.find((session: { id: string }) => session.id === managedSessionId),
    {
      id: managedSessionId,
      current: false,
      deviceType: "MOBILE",
      browser: "SAFARI",
      operatingSystem: "IOS",
      createdAt: listedSessions.json().data.find((session: { id: string }) => session.id === managedSessionId).createdAt,
      lastSeenAt: listedSessions.json().data.find((session: { id: string }) => session.id === managedSessionId).lastSeenAt,
      expiresAt: listedSessions.json().data.find((session: { id: string }) => session.id === managedSessionId).expiresAt,
    },
  );
  assert.ok(new Date(listedSessions.json().data[0].lastSeenAt).valueOf() > Date.now() - 60_000);
  assert.doesNotMatch(listedSessions.body, /token|userAgent|user_agent|ipAddress|ip_address|location|latitude|longitude/i);
  const inactiveMfa = await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: { cookie: cookieA } });
  assert.equal(inactiveMfa.statusCode, 200, inactiveMfa.body);
  assert.deepEqual(inactiveMfa.json().data, {
    enabled: false,
    method: null,
    enabledAt: null,
    pendingEnrollment: false,
    recoveryCodesRemaining: 0,
  });
  const unsteppedSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${managedSessionId}`,
    headers: { origin, cookie: cookieA },
  });
  assert.equal(unsteppedSessionRevocation.statusCode, 403, unsteppedSessionRevocation.body);
  await grantStepUp(cookieA);
  const currentSessionIdA = String((await pool.query(
    "SELECT id FROM sessions WHERE token_hash = $1",
    [currentSessionDigestA],
  )).rows[0].id);
  const foreignSessionIdB = String((await pool.query(
    "SELECT id FROM sessions WHERE token_hash = $1",
    [tokenHash(cookieB.split("=", 2)[1]!)],
  )).rows[0].id);
  const missingSessionId = crypto.randomUUID();
  const foreignSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${foreignSessionIdB}`,
    headers: { origin, cookie: cookieA },
  });
  const missingSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${missingSessionId}`,
    headers: { origin, cookie: cookieA },
  });
  assert.deepEqual(
    [foreignSessionRevocation.statusCode, foreignSessionRevocation.json().error.code],
    [404, "SESSION_NOT_FOUND"],
  );
  assert.deepEqual(
    [missingSessionRevocation.statusCode, missingSessionRevocation.json().error.code],
    [404, "SESSION_NOT_FOUND"],
  );
  const currentSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${currentSessionIdA}`,
    headers: { origin, cookie: cookieA },
  });
  assert.equal(currentSessionRevocation.statusCode, 409, currentSessionRevocation.body);
  assert.equal(currentSessionRevocation.json().error.code, "CURRENT_SESSION");
  const expiredSessionIdA = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, now() - interval '1 minute', now() - interval '2 minutes')`,
    [expiredSessionIdA, userIdA, tokenHash(opaqueToken())],
  );
  const expiredSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${expiredSessionIdA}`,
    headers: { origin, cookie: cookieA },
  });
  assert.equal(expiredSessionRevocation.statusCode, 200, expiredSessionRevocation.body);
  assert.equal(expiredSessionRevocation.json().data.revoked, false);
  const managedSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${managedSessionId}`,
    headers: { origin, cookie: cookieA },
  });
  assert.equal(managedSessionRevocation.statusCode, 200, managedSessionRevocation.body);
  assert.equal(managedSessionRevocation.json().data.revoked, true);
  const repeatedSessionRevocation = await app.inject({
    method: "DELETE",
    url: `/api/v1/auth/sessions/${managedSessionId}`,
    headers: { origin, cookie: cookieA },
  });
  assert.equal(repeatedSessionRevocation.statusCode, 200, repeatedSessionRevocation.body);
  assert.equal(repeatedSessionRevocation.json().data.revoked, false);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: managedSessionCookieA } })).statusCode,
    401,
  );

  await pool.query(
    `INSERT INTO storage_deletion_tombstones (
       id, user_id, canonical_object_key, incoming_object_key,
       upload_expires_at, available_at, created_at
     )
      SELECT gen_random_uuid(), $1,
             'documents/fairness-a-' || $2 || '-' || lpad(series::text, 3, '0') || '.pdf',
             'incoming/fairness-a-' || $2 || '-' || lpad(series::text, 3, '0') || '.pdf',
             now() - interval '2 minutes', now() - interval '3 minutes', now() - interval '3 minutes'
       FROM generate_series(1, 101) AS series`,
    [userIdA, suffix],
  );
  await pool.query(
    `INSERT INTO storage_deletion_tombstones (
       id, user_id, canonical_object_key, incoming_object_key,
       upload_expires_at, available_at, created_at
     ) VALUES ($1, $2, $3, $4,
       now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '2 minutes')`,
    [crypto.randomUUID(), userIdB, `documents/fairness-b-${suffix}.pdf`, `incoming/fairness-b-${suffix}.pdf`],
  );
  await runWorkerUntil("storage_deletions_completed");
  await runWorkerUntil("storage_deletions_completed");
  assert.equal(
    (await pool.query(
      "SELECT count(*)::integer AS count FROM storage_deletion_tombstones WHERE user_id = $1",
      [userIdB],
    )).rows[0].count,
    0,
  );
  assert.equal(
    (await pool.query(
      "SELECT count(*)::integer AS count FROM storage_deletion_tombstones WHERE user_id = $1",
      [userIdA],
    )).rows[0].count,
    4,
  );
  await pool.query("DELETE FROM storage_deletion_tombstones WHERE user_id = $1", [userIdA]);
  const legalAcknowledgements = await pool.query(
    `SELECT version.document_type, version.version, acknowledgement.accepted_at
       FROM legal_acknowledgements acknowledgement
       JOIN legal_document_versions version ON version.id = acknowledgement.document_version_id
      WHERE acknowledgement.user_id = $1
      ORDER BY version.document_type`,
    [userIdA],
  );
  assert.deepEqual(
    legalAcknowledgements.rows.map((row) => [row.document_type, row.version]),
    [["PRIVACY_NOTICE", "1.0"], ["TERMS", "1.0"]],
  );
  assert.ok(legalAcknowledgements.rows.every((row) => row.accepted_at instanceof Date));
  const deniedAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieB } });
  assert.equal(deniedAdmin.statusCode, 403, deniedAdmin.body);
  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'READ_ONLY', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const blockedAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieA } });
  assert.equal(blockedAdmin.statusCode, 403, blockedAdmin.body);
  assert.equal(blockedAdmin.json().error.code, "MFA_SETUP_REQUIRED");
  await pool.query(
    "UPDATE sessions SET created_at = now() - interval '16 minutes' WHERE token_hash = $1",
    [tokenHash(cookieA.split("=", 2)[1]!)],
  );
  const staleEnrollment = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(staleEnrollment.statusCode, 403, staleEnrollment.body);
  assert.equal(staleEnrollment.json().error.code, "MFA_ENROLLMENT_REAUTH_REQUIRED");
  await pool.query(
    "UPDATE sessions SET created_at = now(), last_seen_at = now() WHERE token_hash = $1",
    [tokenHash(cookieA.split("=", 2)[1]!)],
  );
  const enrollment = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(enrollment.statusCode, 200, enrollment.body);
  const enrollmentCode = generateTotpCode(String(enrollment.json().data.secret));
  const wrongSessionConfirmation = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment/confirm",
    headers: { origin, cookie: secondaryCookieA },
    payload: { code: enrollmentCode },
  });
  assert.equal(wrongSessionConfirmation.statusCode, 409, wrongSessionConfirmation.body);
  assert.equal(wrongSessionConfirmation.json().error.code, "MFA_ENROLLMENT_NOT_FOUND");
  const confirmedMfa = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment/confirm",
    headers: { origin, cookie: cookieA },
    payload: { code: enrollmentCode },
  });
  assert.equal(confirmedMfa.statusCode, 200, confirmedMfa.body);
  const recoveryCodes = confirmedMfa.json().data.recoveryCodes as string[];
  assert.equal(recoveryCodes.length, 10);
  cookieA = rotatedCookie(confirmedMfa, cookieA);
  const activeMfa = await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: { cookie: cookieA } });
  assert.equal(activeMfa.statusCode, 200, activeMfa.body);
  assert.equal(activeMfa.json().data.enabled, true);
  assert.equal(activeMfa.json().data.method, "TOTP");
  assert.match(activeMfa.json().data.enabledAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(activeMfa.json().data.recoveryCodesRemaining, 10);
  const revokedSecondarySession = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: secondaryCookieA } });
  assert.equal(revokedSecondarySession.statusCode, 401, revokedSecondarySession.body);
  const activeFactorBeforeReplacement = await pool.query(
    "SELECT id FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE'",
    [userIdA],
  );
  const replacementEnrollment = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(replacementEnrollment.statusCode, 200, replacementEnrollment.body);
  await pool.query(
    "UPDATE sessions SET step_up_expires_at = created_at + interval '1 millisecond' WHERE token_hash = $1",
    [tokenHash(cookieA.split("=", 2)[1]!)],
  );
  const expiredReplacementConfirmation = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment/confirm",
    headers: { origin, cookie: cookieA },
    payload: { code: generateTotpCode(String(replacementEnrollment.json().data.secret)) },
  });
  assert.equal(expiredReplacementConfirmation.statusCode, 403, expiredReplacementConfirmation.body);
  assert.equal(expiredReplacementConfirmation.json().error.code, "STEP_UP_REQUIRED");
  assert.deepEqual(
    (await pool.query("SELECT id FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE'", [userIdA])).rows,
    activeFactorBeforeReplacement.rows,
  );
  const onlyCurrentSession = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: { cookie: cookieA } });
  assert.equal(onlyCurrentSession.statusCode, 200, onlyCurrentSession.body);
  assert.equal(onlyCurrentSession.json().data.length, 1);
  assert.equal(onlyCurrentSession.json().data[0].current, true);
  const readOnlyContext = await app.inject({ method: "GET", url: "/api/v1/admin/context", headers: { cookie: cookieA } });
  assert.equal(readOnlyContext.statusCode, 200, readOnlyContext.body);
  assert.equal(readOnlyContext.json().data.user.adminRole, "READ_ONLY");
  const readOnlyUsers = await app.inject({
    method: "GET",
    url: "/api/v1/admin/users?page=1&pageSize=10&sort=createdAt&direction=desc",
    headers: { cookie: cookieA },
  });
  assert.equal(readOnlyUsers.statusCode, 200, readOnlyUsers.body);
  assert.ok(readOnlyUsers.json().data.items.some((user: { id: string }) => user.id === userIdA));
  assert.equal(readOnlyUsers.body.includes(emailA), false);
  await pool.query("UPDATE sessions SET step_up_expires_at = NULL WHERE token_hash = $1", [
    tokenHash(cookieA.split("=", 2)[1]!),
  ]);
  const readOnlyEmailOracle = await app.inject({
    method: "GET",
    url: `/api/v1/admin/users?search=${encodeURIComponent(emailB)}`,
    headers: { cookie: cookieA },
  });
  assert.equal(readOnlyEmailOracle.statusCode, 200, readOnlyEmailOracle.body);
  assert.deepEqual(readOnlyEmailOracle.json().data.items, []);
  assert.equal(readOnlyEmailOracle.json().data.total, 0);
  const invalidAdminQuery = await app.inject({
    method: "GET",
    url: "/api/v1/admin/users?role=OWNER",
    headers: { cookie: cookieA },
  });
  assert.equal(invalidAdminQuery.statusCode, 400, invalidAdminQuery.body);

  const disposableAdminTargetCookie = await seedGoogleAccount(`admin-target-${suffix}@example.test`);
  const disposableAdminTarget = await app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    headers: { cookie: disposableAdminTargetCookie },
  });
  assert.equal(disposableAdminTarget.statusCode, 200, disposableAdminTarget.body);
  const disposableAdminTargetId = String(disposableAdminTarget.json().data.id);
  const deniedReadOnlyMutation = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${disposableAdminTargetId}/revoke-sessions`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "SECURITY_INCIDENT", reference: `INT-${suffix}` },
  });
  assert.equal(deniedReadOnlyMutation.statusCode, 403, deniedReadOnlyMutation.body);
  assert.equal(deniedReadOnlyMutation.json().error.code, "ADMIN_PERMISSION_REQUIRED");
  assert.deepEqual(
    (await pool.query(
      `SELECT result, actor_admin_role, reason_code, reference
         FROM admin_audit_events
        WHERE actor_user_id = $1 AND subject_user_id = $2 AND action = 'USER_SESSIONS_REVOKED'`,
      [userIdA, disposableAdminTargetId],
    )).rows,
    [{ result: "DENIED", actor_admin_role: "READ_ONLY", reason_code: "SECURITY_INCIDENT", reference: `INT-${suffix}` }],
  );

  await pool.query("UPDATE users SET admin_role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1", [userIdA]);
  await grantStepUp(cookieA);
  const revokedDisposableSessions = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${disposableAdminTargetId}/revoke-sessions`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "SECURITY_INCIDENT", reference: `INT-${suffix}` },
  });
  assert.equal(revokedDisposableSessions.statusCode, 200, revokedDisposableSessions.body);
  assert.equal(revokedDisposableSessions.json().data.revokedSessions, 1);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: disposableAdminTargetCookie } })).statusCode,
    401,
  );
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count FROM admin_audit_events
        WHERE actor_user_id = $1 AND subject_user_id = $2 AND action = 'USER_SESSIONS_REVOKED' AND result = 'SUCCESS'`,
      [userIdA, disposableAdminTargetId],
    )).rows[0].count,
    1,
  );
  await pool.query("DELETE FROM users WHERE id = $1", [disposableAdminTargetId]);

  const adminOverview = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieA } });
  assert.equal(adminOverview.statusCode, 200, adminOverview.body);
  assert.equal(adminOverview.headers["cache-control"], "no-store");
  assert.ok(adminOverview.json().data.metrics.activeUsers >= 2);
  assert.deepEqual(
    Object.keys(adminOverview.json().data.metrics).sort(),
    ["activeImports", "activeUsers", "failedDocuments", "pendingReview", "totalDocuments", "totalUsers"].sort(),
  );
  for (const forbidden of ["password_hash", "original_filename", "gross_amount", "net_amount", "object_key"]) {
    assert.equal(adminOverview.body.includes(forbidden), false);
  }
  const deniedAdminAccountDeletion = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieA },
    payload: { confirmation: "ELIMINAR", receiptToken: deletionReceiptToken() },
  });
  assert.equal(deniedAdminAccountDeletion.statusCode, 409, deniedAdminAccountDeletion.body);
  assert.equal(deniedAdminAccountDeletion.json().error.code, "ADMIN_ACCOUNT_DELETION_NOT_ALLOWED");
  assert.deepEqual(
    (await pool.query("SELECT role, admin_role, status FROM users WHERE id = $1", [userIdA])).rows[0],
    { role: "ADMIN", admin_role: "SUPER_ADMIN", status: "ACTIVE" },
  );
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const revokedAdmin = await app.inject({ method: "GET", url: "/api/v1/admin/overview", headers: { cookie: cookieA } });
  assert.equal(revokedAdmin.statusCode, 403, revokedAdmin.body);
  async function createEmployment(cookie: string, employerName: string) {
    const employment = await app.inject({
      method: "POST",
      url: "/api/v1/employments",
      headers: { origin, cookie },
      payload: {
        employerName,
        startDate: "2026-01-01",
        countryCode: "AR",
        currencyCode: "ARS",
      },
    });
    assert.equal(employment.statusCode, 201, employment.body);
    return String(employment.json().data.id);
  }
  const employmentA = await createEmployment(cookieA, "Empresa Asociada A");
  const employmentB = await createEmployment(cookieB, "Empresa Ajena B");
  const googleEmployment = await createEmployment(googleCookie, "Empresa Google Sintética");
  const priorEmploymentA = await app.inject({
    method: "POST",
    url: "/api/v1/employments",
    headers: { origin, cookie: cookieA },
    payload: {
      employerName: "Empresa Asociada A",
      startDate: "2024-01-01",
      endDate: "2025-12-31",
      countryCode: "AR",
      currencyCode: "ARS",
    },
  });
  assert.equal(priorEmploymentA.statusCode, 201, priorEmploymentA.body);
  const employmentEpisodes = await app.inject({ method: "GET", url: "/api/v1/employments", headers: { cookie: cookieA } });
  assert.equal(employmentEpisodes.statusCode, 200, employmentEpisodes.body);
  const currentEmploymentA = employmentEpisodes.json().data.find((employment: { id: string }) => employment.id === employmentA);
  assert.ok(currentEmploymentA);
  assert.deepEqual(
    employmentEpisodes.json().data
      .filter((employment: { employerId: string }) => employment.employerId === currentEmploymentA.employerId)
      .map((employment: { startDate: string; endDate: string | null }) => [employment.startDate, employment.endDate])
      .sort(),
    [["2024-01-01", "2025-12-31"], ["2026-01-01", null]],
  );
  const invalidExpandedEmployer = await app.inject({
    method: "POST",
    url: "/api/v1/employments",
    headers: { origin, cookie: cookieA },
    payload: {
      employerName: "ﬃ".repeat(100), startDate: "2025-01-01", countryCode: "AR", currencyCode: "ARS",
    },
  });
  assert.equal(invalidExpandedEmployer.statusCode, 400, invalidExpandedEmployer.body);
  assert.equal(invalidExpandedEmployer.json().error.code, "INVALID_EMPLOYER_NAME");
  const ownOrphanEmployerName = `Empresa Pendiente Propia Sin Empleo ${suffix}`;
  const unrelatedEmployerName = `Empresa Ajena Sin Vínculo ${suffix}`;
  const ownOrphanEmployer = await app.inject({
    method: "POST", url: "/api/v1/employers", headers: { origin, cookie: cookieA },
    payload: { name: ownOrphanEmployerName, countryCode: "AR" },
  });
  assert.equal(ownOrphanEmployer.statusCode, 201, ownOrphanEmployer.body);
  const unrelatedEmployer = await app.inject({
    method: "POST", url: "/api/v1/employers", headers: { origin, cookie: cookieB },
    payload: { name: unrelatedEmployerName, countryCode: "AR" },
  });
  assert.equal(unrelatedEmployer.statusCode, 201, unrelatedEmployer.body);
  const sharedEmployment = await app.inject({
    method: "POST", url: "/api/v1/employments", headers: { origin, cookie: cookieA },
    payload: {
      employerName: "Empresa Ajena B", startDate: "2025-01-01", countryCode: "AR", currencyCode: "ARS",
    },
  });
  assert.equal(sharedEmployment.statusCode, 201, sharedEmployment.body);
  const ownerEmployers = await app.inject({ method: "GET", url: "/api/v1/employers", headers: { cookie: cookieA } });
  assert.equal(ownerEmployers.statusCode, 200, ownerEmployers.body);
  assert.ok(ownerEmployers.json().data.some((employer: { name: string }) => employer.name === ownOrphanEmployerName));
  assert.ok(ownerEmployers.json().data.some((employer: { name: string }) => employer.name === "Empresa Ajena B"));
  assert.equal(ownerEmployers.json().data.some((employer: { name: string }) => employer.name === unrelatedEmployerName), false);
  assert.equal(/createdAt|updatedAt|createdSource|createdBy/i.test(ownerEmployers.body), false);
  await pool.query(
    `INSERT INTO employers (
       id, created_by_user_id, name, country_code, status, created_source, merged_into_employer_id
     ) VALUES
       ($1, $3, 'Empresa Propia Fusionada', 'AR', 'MERGED', 'ADMIN', $4),
       ($2, $3, 'Empresa Propia Rechazada', 'AR', 'REJECTED', 'ADMIN', NULL)`,
    [crypto.randomUUID(), crypto.randomUUID(), userIdA, ownOrphanEmployer.json().data.id],
  );
  await pool.query("UPDATE users SET role = 'ADMIN', admin_role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1", [userIdA]);
  const wildcardEmployerSearch = await app.inject({
    method: "GET",
    url: "/api/v1/admin/employers?search=%25",
    headers: { cookie: cookieA },
  });
  assert.equal(wildcardEmployerSearch.statusCode, 200, wildcardEmployerSearch.body);
  assert.deepEqual(wildcardEmployerSearch.json().data.items, []);
  assert.equal(wildcardEmployerSearch.json().data.total, 0);
  await pool.query("UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1", [userIdA]);
  const googleCannotEditOtherEmployment = await app.inject({
    method: "PATCH",
    url: `/api/v1/employments/${employmentA}`,
    headers: { origin, cookie: googleCookie },
    payload: { role: "Acceso cruzado Google" },
  });
  assert.equal(googleCannotEditOtherEmployment.statusCode, 404, googleCannotEditOtherEmployment.body);
  const otherGoogleCannotEditEmployment = await app.inject({
    method: "PATCH",
    url: `/api/v1/employments/${googleEmployment}`,
    headers: { origin, cookie: cookieA },
    payload: { role: "Acceso cruzado Google" },
  });
  assert.equal(otherGoogleCannotEditEmployment.statusCode, 404, otherGoogleCannotEditEmployment.body);

  const googleDeletionToken = deletionReceiptToken();
  const googleDeletion = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: googleCookie },
    payload: { confirmation: "ELIMINAR", receiptToken: googleDeletionToken },
  });
  assert.equal(googleDeletion.statusCode, 202, googleDeletion.body);
  assert.equal(googleDeletion.json().data.receiptToken, googleDeletionToken);
  await runWorkerUntil("accounts_deleted");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [googleUserId])).rowCount, 0);
  assert.equal(
    (await app.inject({
      method: "POST",
      url: "/api/v1/privacy/account-deletion/status",
      headers: { origin },
      payload: { token: googleDeletionToken },
    })).json().data.status,
    "COMPLETED",
  );
  await pool.query("DELETE FROM account_deletion_receipts WHERE token_hash = $1", [
    createHash("sha256").update(googleDeletionToken).digest("hex"),
  ]);

  const r2Config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    LOG_LEVEL: "silent",
    PUBLIC_ORIGIN: origin,
    OBJECT_STORAGE_PROVIDER: "r2",
    CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    CLOUDFLARE_R2_API_TOKEN: "synthetic-read-token",
    OBJECT_STORAGE_ACCESS_KEY: "synthetic-r2-access-key",
    OBJECT_STORAGE_SECRET_KEY: "synthetic-r2-secret-key",
    OBJECT_STORAGE_BUCKET: config.storageBucket,
    OBJECT_STORAGE_INTERNAL_ENDPOINT: undefined,
    OBJECT_STORAGE_PUBLIC_ENDPOINT: undefined,
    OBJECT_STORAGE_KMS_KEY_ID: undefined,
    OBJECT_STORAGE_REGION: undefined,
  });
  const r2Storage = createStorage(r2Config);
  let createdMarkers = 0;
  const r2App = await buildApp(r2Config, {
    provisionStorage: false,
    googleOidc,
    storage: {
      ...r2Storage,
      async createUploadMarker() {
        createdMarkers += 1;
        return '"synthetic-marker-etag"';
      },
    },
  });
  await r2App.ready();
  const capacityUserIds: string[] = [];
  try {
    const capacityEmails = [
      `r2-capacity-a-${suffix}@example.test`,
      `r2-capacity-b-${suffix}@example.test`,
    ];
    const capacityCookies = await Promise.all(capacityEmails.map(seedGoogleAccount));
    const capacityUsers = await pool.query<{ email: string; id: string }>(
      "SELECT id, email FROM users WHERE email = ANY($1::text[]) ORDER BY email",
      [capacityEmails],
    );
    assert.equal(capacityUsers.rowCount, 2);
    capacityUserIds.push(...capacityUsers.rows.map((row) => row.id));

    const capacityItemIds: string[] = [];
    for (let index = 0; index < capacityCookies.length; index += 1) {
      const response = await r2App.inject({
        method: "POST",
        url: "/api/v1/imports",
        headers: {
          origin,
          cookie: capacityCookies[index],
          "idempotency-key": crypto.randomUUID(),
        },
        payload: {
          items: [{
            clientItemKey: crypto.randomUUID(),
            originalFilename: `capacidad-${index + 1}.pdf`,
            declaredMimeType: "application/pdf",
            expectedSizeBytes: 20_000_000,
          }],
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      capacityItemIds.push(String(response.json().data.items[0].id));
    }

    const baselineUserId = crypto.randomUUID();
    const baselineBatchId = crypto.randomUUID();
    const baselineItemId = crypto.randomUUID();
    const baselineSessionId = crypto.randomUUID();
    capacityUserIds.push(baselineUserId);
    await withTransaction(async (client) => {
      const currentPhysicalBytes = await lockR2PhysicalStorageBytes(client);
      const candidateReservationBytes = 40_000_000n;
      const baselineReservationBytes = R2_GLOBAL_STORAGE_CAP_BYTES
        - currentPhysicalBytes
        - candidateReservationBytes;
      assert.ok(baselineReservationBytes > 2n);
      const baselineExpectedSize = baselineReservationBytes / 2n;
      const remainderSize = baselineReservationBytes % 2n;
      await client.query(
        `INSERT INTO users (
         id, email, password_hash, display_name, status, default_retention_policy,
           onboarding_completed_at, last_login_at
         ) VALUES ($1, $2, NULL, 'Reserva R2 Sintética', 'ACTIVE', 'KEEP_ORIGINAL', now(), now())`,
        [baselineUserId, `r2-capacity-baseline-${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO import_batches (id, user_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4)`,
        [baselineBatchId, baselineUserId, crypto.randomUUID(), "0".repeat(64)],
      );
      await client.query(
        `INSERT INTO import_batch_items (
           id, user_id, batch_id, client_item_key, ordinal, original_filename,
           declared_mime_type, expected_size_bytes
         ) VALUES ($1, $2, $3, $4, 0, 'reserva-global.pdf', 'application/pdf', $5)`,
        [baselineItemId, baselineUserId, baselineBatchId, crypto.randomUUID(), baselineExpectedSize.toString()],
      );
      await client.query(
        `INSERT INTO upload_sessions (
           id, user_id, batch_id, item_id, object_key, expected_size_bytes,
           expected_mime_type, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', now() + interval '5 minutes')`,
        [baselineSessionId, baselineUserId, baselineBatchId, baselineItemId, `incoming/${baselineSessionId}.pdf`, baselineExpectedSize.toString()],
      );
      if (remainderSize === 1n) {
        const remainderItemId = crypto.randomUUID();
        const remainderSessionId = crypto.randomUUID();
        await client.query(
          `INSERT INTO import_batch_items (
             id, user_id, batch_id, client_item_key, ordinal, original_filename,
             declared_mime_type, expected_size_bytes
           ) VALUES ($1, $2, $3, $4, 1, 'reserva-global-resto.pdf', 'application/pdf', 1)`,
          [remainderItemId, baselineUserId, baselineBatchId, crypto.randomUUID()],
        );
        await client.query(
          `INSERT INTO upload_sessions (
             id, user_id, batch_id, item_id, object_key, expected_size_bytes,
             expected_mime_type, status, expires_at
           ) VALUES ($1, $2, $3, $4, $5, 1, 'application/pdf', 'CANCELLED', now() + interval '5 minutes')`,
          [remainderSessionId, baselineUserId, baselineBatchId, remainderItemId, `incoming/${remainderSessionId}.pdf`],
        );
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           ) VALUES ($1, $2, $3, $3, now() + interval '5 minutes')`,
          [crypto.randomUUID(), baselineUserId, `incoming/${remainderSessionId}.pdf`],
        );
      }
    });

    const capacityResponses = await Promise.all(capacityItemIds.map((itemId, index) => r2App.inject({
      method: "POST",
      url: "/api/v1/upload-sessions",
      headers: { origin, cookie: capacityCookies[index] },
      payload: { itemId },
    })));
    assert.deepEqual(capacityResponses.map((response) => response.statusCode).sort(), [201, 503]);
    const acceptedCapacity = capacityResponses.find((response) => response.statusCode === 201);
    const deniedCapacity = capacityResponses.find((response) => response.statusCode === 503);
    assert.ok(acceptedCapacity);
    assert.ok(deniedCapacity);
    assert.equal(acceptedCapacity.json().data.method, "PUT");
    assert.match(String(acceptedCapacity.json().data.url), /X-Amz-SignedHeaders=[^&]*content-length/i);
    assert.equal(acceptedCapacity.json().data.headers["Content-Length"], "20000000");
    assert.equal(deniedCapacity.json().error.code, "R2_STORAGE_CAPACITY_EXCEEDED");

    const reserved = await pool.query<{ count: number; owners: number }>(
      `SELECT count(*)::integer AS count, count(DISTINCT user_id)::integer AS owners
         FROM upload_sessions
        WHERE user_id = ANY($1::uuid[]) AND status = 'OPEN'`,
      [capacityUsers.rows.map((row) => row.id)],
    );
    const reservation = reserved.rows[0];
    assert.ok(reservation);
    assert.equal(reservation.count, 1);
    assert.equal(reservation.owners, 1);
    assert.equal(createdMarkers, 1);
    assert.equal(
      await withTransaction((client) => lockR2PhysicalStorageBytes(client)),
      R2_GLOBAL_STORAGE_CAP_BYTES,
    );
  } finally {
    await r2App.close();
    if (capacityUserIds.length > 0) {
      await pool.query("DELETE FROM storage_deletion_tombstones WHERE user_id = ANY($1::uuid[])", [capacityUserIds]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [capacityUserIds]);
    }
  }

  const itemKey = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const pdfBytes = syntheticPayrollPdf();
  const item = {
    clientItemKey: itemKey,
    originalFilename: "recibo-sintetico.pdf",
    declaredMimeType: "application/pdf",
    expectedSizeBytes: pdfBytes.byteLength,
  };
  const batch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [item] },
  });
  assert.equal(batch.statusCode, 201, batch.body);
  const batchData = batch.json().data as { id: string; items: Array<{ id: string }> };

  const activeBatch = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } });
  assert.equal(activeBatch.statusCode, 200, activeBatch.body);
  assert.equal(activeBatch.json().data.id, batchData.id);
  assert.deepEqual(activeBatch.json().data.progress, { total: 1, resolved: 0, percentage: 0 });
  const isolatedActiveBatch = await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieB } });
  assert.equal(isolatedActiveBatch.json().data, null);

  const secondActiveBatch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID() }] },
  });
  assert.equal(secondActiveBatch.statusCode, 409, secondActiveBatch.body);

  const oversizedBatch = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: Array.from({ length: 26 }, (_, index) => ({
      ...item,
      clientItemKey: crypto.randomUUID(),
      originalFilename: `recibo-grande-${index}.pdf`,
      expectedSizeBytes: 20 * 1024 * 1024,
    })) },
  });
  assert.equal(oversizedBatch.statusCode, 413, oversizedBatch.body);

  const foreignEmploymentAtImport = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), employmentId: employmentA }] },
  });
  assert.equal(foreignEmploymentAtImport.statusCode, 404, foreignEmploymentAtImport.body);

  const associatedAtImport = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieB, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), employmentId: employmentB }] },
  });
  assert.equal(associatedAtImport.statusCode, 201, associatedAtImport.body);
  assert.equal(associatedAtImport.json().data.items[0].employmentId, employmentB);
  const cancelledUploadSession = await app.inject({
    method: "POST",
    url: "/api/v1/upload-sessions",
    headers: { origin, cookie: cookieB },
    payload: { itemId: associatedAtImport.json().data.items[0].id },
  });
  assert.equal(cancelledUploadSession.statusCode, 201, cancelledUploadSession.body);
  const cancelledBatch = await app.inject({
    method: "POST",
    url: `/api/v1/imports/${associatedAtImport.json().data.id}/cancel`,
    headers: { origin, cookie: cookieB },
    payload: {},
  });
  assert.equal(cancelledBatch.statusCode, 200, cancelledBatch.body);
  assert.equal(cancelledBatch.json().data.status, "CANCELLED");
  assert.equal(cancelledBatch.json().data.items[0].status, "CANCELLED");
  assert.equal(
    (await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [cancelledUploadSession.json().data.id])).rows[0].status,
    "EXPIRED",
  );
  const cancelledSessionId = String(cancelledUploadSession.json().data.id);
  const cancelledObjectKey = String((await pool.query(
    "SELECT object_key FROM upload_sessions WHERE id = $1",
    [cancelledSessionId],
  )).rows[0].object_key);
  await runWorkerUntil("uploads_cleaned");
  assert.equal(
    (await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [cancelledSessionId])).rows[0].status,
    "EXPIRED",
  );
  assert.equal(await objectExists(cancelledObjectKey), false);
  const capacityAfterFirstCleanup = await withTransaction((client) => lockR2PhysicalStorageBytes(client));

  const cancelledPdf = new Blob([pdfBytes], { type: "application/pdf" });
  const cancelledForm = new FormData();
  for (const [name, value] of Object.entries(cancelledUploadSession.json().data.fields as Record<string, string>)) {
    cancelledForm.append(name, value);
  }
  cancelledForm.append("file", cancelledPdf, "recibo-cancelado-sintetico.pdf");
  const cancelledReplay = await fetch(String(cancelledUploadSession.json().data.url), {
    method: "POST",
    body: cancelledForm,
  });
  assert.equal(cancelledReplay.status, 204, await cancelledReplay.text());
  assert.equal(await objectExists(cancelledObjectKey), true);
  const capacityBeforeFinalCleanup = await withTransaction((client) => lockR2PhysicalStorageBytes(client));
  assert.equal(capacityBeforeFinalCleanup, capacityAfterFirstCleanup);

  await pool.query(
    `UPDATE upload_sessions
        SET created_at = now() - interval '3 minutes', expires_at = now() - interval '2 minutes'
      WHERE id = $1 AND status = 'EXPIRED'`,
    [cancelledSessionId],
  );
  await runWorkerUntil("uploads_cleaned");
  assert.equal(await objectExists(cancelledObjectKey), false);
  assert.equal(
    (await pool.query("SELECT status FROM upload_sessions WHERE id = $1", [cancelledSessionId])).rows[0].status,
    "CANCELLED",
  );
  assert.equal(
    capacityBeforeFinalCleanup - await withTransaction((client) => lockR2PhysicalStorageBytes(client)),
    BigInt(pdfBytes.byteLength) * 2n,
  );

  const repeated = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [item] },
  });
  assert.equal(repeated.statusCode, 201, repeated.body);
  assert.equal(repeated.json().data.id, batchData.id);

  const reused = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": idempotencyKey },
    payload: { items: [{ ...item, originalFilename: "otro.pdf" }] },
  });
  assert.equal(reused.statusCode, 409, reused.body);

  const sessionResponse = await app.inject({
    method: "POST",
    url: "/api/v1/upload-sessions",
    headers: { origin, cookie: cookieA },
    payload: { itemId: batchData.items[0]!.id },
  });
  assert.equal(sessionResponse.statusCode, 201, sessionResponse.body);
  const session = sessionResponse.json().data as {
    id: string;
    url: string;
    fields: Record<string, string>;
  };

  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/upload-sessions/${session.id}/complete`,
    headers: { origin, cookie: cookieB },
    payload: {},
  });
  assert.equal(denied.statusCode, 404, denied.body);

  async function uploadWithSignedPost() {
    const pdf = new Blob([pdfBytes], { type: "application/pdf" });
    assert.equal(pdf.size, item.expectedSizeBytes);
    const form = new FormData();
    for (const [name, value] of Object.entries(session.fields)) form.append(name, value);
    form.append("file", pdf, "recibo-sintetico.pdf");
    return fetch(session.url, { method: "POST", body: form });
  }
  const upload = await uploadWithSignedPost();
  assert.equal(upload.status, 204, await upload.text());

  const complete = () => app.inject({
    method: "POST",
    url: `/api/v1/upload-sessions/${session.id}/complete`,
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  const confirmations = await Promise.all([complete(), complete()]);
  assert.deepEqual(confirmations.map((response) => response.statusCode), [200, 200]);
  assert.equal(confirmations[0]!.json().data.id, confirmations[1]!.json().data.id);
  const uploadReference = await pool.query(
    "SELECT object_key FROM upload_sessions WHERE id = $1",
    [session.id],
  );
  const incomingObjectKey = String(uploadReference.rows[0].object_key);
  assert.match(incomingObjectKey, /^incoming\/[0-9a-f-]+\.pdf$/);

  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM documents WHERE import_batch_id = $1) AS documents,
       (SELECT count(*)::integer FROM processing_jobs job
          JOIN documents document ON document.id = job.document_id
         WHERE document.import_batch_id = $1 AND job.stage = 'DOCUMENT_PIPELINE_V2') AS jobs,
       (SELECT min(job.state) FROM processing_jobs job
          JOIN documents document ON document.id = job.document_id
         WHERE document.import_batch_id = $1) AS job_state`,
    [batchData.id],
  );
  assert.deepEqual(counts.rows[0], { documents: 1, jobs: 1, job_state: "PENDING" });
  assert.equal(await redis.lLen("salarivo:processing-jobs:documents"), 0);

  const documentId = confirmations[0]!.json().data.id as string;
  const canonicalObjectKey = String((await pool.query("SELECT object_key FROM documents WHERE id = $1", [documentId])).rows[0].object_key);
  const processingAssociation = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentA },
  });
  assert.equal(processingAssociation.statusCode, 409, processingAssociation.body);
  await pool.query(
    `UPDATE processing_jobs
        SET state = 'COMPLETED', completed_at = now()
      WHERE document_id = $1 AND stage = 'DOCUMENT_PIPELINE_V2'`,
    [documentId],
  );
  await pool.query(
    `UPDATE documents
        SET security_status = 'CLEAN', processing_status = 'NEEDS_TYPE_CONFIRMATION', classification_status = 'NEEDS_CONFIRMATION'
      WHERE id = $1`,
    [documentId],
  );
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  await pool.query(
    "UPDATE import_batches SET status = 'COMPLETED', completed_at = now() WHERE id = $1",
    [batchData.id],
  );
  const activeBlocker = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { origin, cookie: cookieA, "idempotency-key": crypto.randomUUID() },
    payload: { items: [{ ...item, clientItemKey: crypto.randomUUID(), originalFilename: "otro-recibo.pdf" }] },
  });
  assert.equal(activeBlocker.statusCode, 201, activeBlocker.body);
  const blockedTypeConfirmation = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/type-confirmation`,
    headers: { origin, cookie: cookieA },
    payload: { documentType: "PAYROLL" },
  });
  assert.equal(blockedTypeConfirmation.statusCode, 409, blockedTypeConfirmation.body);
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/api/v1/imports/${activeBlocker.json().data.id}/cancel`,
      headers: { origin, cookie: cookieA },
      payload: {},
    })).statusCode,
    200,
  );
  const typeConfirmation = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/type-confirmation`,
    headers: { origin, cookie: cookieA },
    payload: { documentType: "PAYROLL" },
  });
  assert.equal(typeConfirmation.statusCode, 201, typeConfirmation.body);
  const resumed = await pool.query(
    `SELECT stage, processing_version, state, trigger_kind, requested_by_user_id
       FROM processing_jobs
      WHERE document_id = $1 ORDER BY processing_version DESC LIMIT 1`,
    [documentId],
  );
  assert.deepEqual(resumed.rows[0], {
    stage: "DOCUMENT_PIPELINE_V2",
    processing_version: 2,
    state: "PENDING",
    trigger_kind: "USER_TYPE_CONFIRMATION",
    requested_by_user_id: userIdA,
  });
  assert.deepEqual(
    (await pool.query(
      `SELECT batch.status AS batch_status, item.status AS item_status
         FROM import_batches batch JOIN import_batch_items item ON item.batch_id = batch.id
        WHERE batch.id = $1 AND item.id = $2`,
      [batchData.id, batchData.items[0]!.id],
    )).rows[0],
    { batch_status: "ACTIVE", item_status: "PROCESSING" },
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } })).json().data.id,
    batchData.id,
  );

  const owner = await pool.query("SELECT user_id FROM documents WHERE id = $1", [documentId]);
  const userId = String(owner.rows[0].user_id);
  const runId = crypto.randomUUID();
  const settlementId = crypto.randomUUID();
  const employerFieldId = crypto.randomUUID();
  const deductionsFieldId = crypto.randomUUID();
  await pool.query(
    `UPDATE processing_jobs SET state = 'COMPLETED', completed_at = now() WHERE document_id = $1 AND processing_version = 2`,
    [documentId],
  );
  await pool.query(
    `UPDATE documents SET processing_status = 'COMPLETED', classification_status = 'SUPPORTED',
            document_type = 'PAYROLL', detected_mime_type = 'application/pdf', page_count = 1,
            security_status = 'CLEAN', processed_at = now() WHERE id = $1`,
    [documentId],
  );
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at, confidence
     ) VALUES ($1, $2, $3, 2, 'COMPLETED', 'synthetic-test', '3', '3', '3', now(), 0.9)`,
    [runId, userId, documentId],
  );
  await pool.query(
    `UPDATE extraction_runs SET promotion_outcome = 'PROMOTED', promoted_at = now() WHERE id = $1`,
    [runId],
  );
  await pool.query(
    `UPDATE documents SET active_extraction_run_id = $1 WHERE id = $2 AND user_id = $3`,
    [runId, documentId, userId],
  );
  await pool.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version, signals
     ) VALUES
       ($1, $2, $3, $4, 'employer.name', 'EMPLOYER', 'Empresa Sintética SA', $5::jsonb, 0.9, 'PDF_TEXT', '3', '{}'::jsonb),
       ($6, $2, $3, $4, 'settlement.payrollPeriod', 'PAYROLL_SETTLEMENT', '08/2026', $7::jsonb, 0.9, 'PDF_TEXT', '3', '{}'::jsonb),
       ($8, $2, $3, $4, 'settlement.grossAmount', 'PAYROLL_SETTLEMENT', '', 'null'::jsonb, 0, 'RULE', '3', $9::jsonb),
       ($10, $2, $3, $4, 'settlement.netAmount', 'PAYROLL_SETTLEMENT', '', 'null'::jsonb, 0, 'RULE', '3', $11::jsonb),
       ($12, $2, $3, $4, 'settlement.deductionsAmount', 'PAYROLL_SETTLEMENT', '180.00', $13::jsonb, 0.9, 'RULE', '3', '{}'::jsonb)`,
    [
      employerFieldId, userId, documentId, runId, JSON.stringify("Empresa Sintética SA"),
      crypto.randomUUID(), JSON.stringify("2026-08"),
      crypto.randomUUID(), JSON.stringify({ missingReason: "LABEL_OR_LAYOUT_NOT_RECOGNIZED" }),
      crypto.randomUUID(), JSON.stringify({ missingReason: "VALUE_NOT_INTERPRETABLE" }),
      deductionsFieldId,
      JSON.stringify({ amount: "180.00", currencyCode: "ARS" }),
    ],
  );
  await pool.query(
    `UPDATE extracted_fields
        SET page_number = 1,
            source_region = $2::jsonb
      WHERE id = $1`,
    [employerFieldId, JSON.stringify({
      version: 1, space: "PAGE_NORMALIZED", origin: "TOP_LEFT",
      x: 0.1, y: 0.2, width: 0.3, height: 0.1,
    })],
  );
  await pool.query(
    "UPDATE extracted_fields SET source_region = $2::jsonb WHERE id = $1",
    [deductionsFieldId, JSON.stringify({
      version: 1, space: "PAGE_NORMALIZED", origin: "TOP_LEFT",
      x: 0.9, y: 0.2, width: 0.3, height: 0.1,
    })],
  );
  await pool.query(
    `INSERT INTO payroll_settlements (
       id, user_id, document_id, extraction_run_id, settlement_ordinal,
       payroll_period, settlement_type, is_recurring, currency_code,
       gross_amount, net_amount, deductions_amount
     ) VALUES ($1, $2, $3, $4, 1, '2026-08-01', 'NORMAL', true, 'ARS', NULL, NULL, 180.00)`,
    [settlementId, userId, documentId, runId],
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description,
       normalized_concept_code, amount, currency_code, item_type, confidence
     ) VALUES
       ($1, $2, $3, 1, 'Deducción', NULL, 110.00, 'ARS', 'DEDUCTION', 0.9),
       ($4, $2, $3, 2, 'Deducción', NULL, 50.00, 'ARS', 'DEDUCTION', 0.9),
       ($5, $2, $3, 3, 'Deducción', NULL, 20.00, 'ARS', 'DEDUCTION', 0.8)`,
    [crypto.randomUUID(), userId, settlementId, crypto.randomUUID(), crypto.randomUUID()],
  );

  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'SECURITY', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const securityUserDetail = await app.inject({
    method: "GET",
    url: `/api/v1/admin/users/${userIdA}`,
    headers: { cookie: cookieA },
  });
  assert.equal(securityUserDetail.statusCode, 200, securityUserDetail.body);
  assert.deepEqual(securityUserDetail.json().data.employments, []);
  const adminDocuments = await app.inject({
    method: "GET",
    url: `/api/v1/admin/documents?search=${documentId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(adminDocuments.statusCode, 200, adminDocuments.body);
  assert.deepEqual(adminDocuments.json().data.items.map((document: { id: string }) => document.id), [documentId]);
  const adminDocument = await app.inject({
    method: "GET",
    url: `/api/v1/admin/documents/${documentId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(adminDocument.statusCode, 200, adminDocument.body);
  assert.deepEqual(adminDocument.json().data.recentJobs, []);
  for (const forbidden of [
    "originalFilename", "original_filename", "objectKey", "object_key", "sha256", "ocr",
    "extracted", "grossAmount", "gross_amount", "netAmount", "net_amount", "rawValue",
    "raw_value", "correctedValue", "corrected_value", canonicalObjectKey, incomingObjectKey,
    "recibo-sintetico.pdf", "1000.00", "820.00", "180.00",
  ]) {
    assert.equal(adminDocuments.body.includes(forbidden), false, `admin document list exposed ${forbidden}`);
    assert.equal(adminDocument.body.includes(forbidden), false, `admin document detail exposed ${forbidden}`);
  }
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );

  await pool.query("UPDATE documents SET processing_status = 'NEEDS_REVIEW' WHERE id = $1", [documentId]);
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  const reviewDetail = await app.inject({ method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA } });
  assert.equal(reviewDetail.statusCode, 200, reviewDetail.body);
  const reviewData = reviewDetail.json().data;
  assert.equal(reviewData.settlement.documentId, documentId);
  assert.equal(reviewData.settlement.deductionsAmount, "180.00");
  assert.equal(reviewData.declaredMimeType, "application/pdf");
  assert.equal(reviewData.detectedMimeType, "application/pdf");
  assert.equal(reviewData.securityStatus, "CLEAN");
  assert.equal(reviewData.classificationStatus, "SUPPORTED");
  assert.equal(reviewData.retentionPolicy, "KEEP_ORIGINAL");
  assert.equal(typeof reviewData.sizeBytes, "number");
  assert.equal(typeof reviewData.pageCount, "number");
  assert.equal(typeof reviewData.processedAt, "string");
  assert.deepEqual(reviewData.reviewSettlement, { totalsBalance: false, componentsBalance: true, deductionsMatchTotal: true });
  assert.deepEqual(reviewData.extractionRun, {
    id: runId,
    processingVersion: 2,
    extractorName: "synthetic-test",
    extractorVersion: "3",
    parserVersion: "3",
    normalizerVersion: "3",
    ocrProvider: null,
    ocrVersion: null,
    confidence: "0.9000",
    finishedAt: reviewData.extractionRun.finishedAt,
  });
  assert.equal(typeof reviewData.extractionRun.finishedAt, "string");
  assert.equal(reviewDetail.body.includes("objectKey"), false);
  assert.equal(reviewDetail.body.includes("object_key"), false);
  assert.equal(reviewDetail.body.includes("sha256"), false);
  const reviewFields = reviewData.extractedFields as Array<{
    id: string | null; fieldPath: string; rawValue: string | null; interpretedValue: string | null;
    correctedValue: string | null; effectiveValue: string | null; source: string; missingReason?: string;
    pageNumber: number | null; sourceRegion: unknown; extractorVersion: string | null;
    correction: { id: string; version: number; correctedAt: string } | null;
  }>;
  const employerField = reviewFields.find(({ fieldPath }) => fieldPath === "employer.name");
  assert.deepEqual(employerField?.sourceRegion, {
    version: 1, space: "PAGE_NORMALIZED", origin: "TOP_LEFT",
    x: 0.1, y: 0.2, width: 0.3, height: 0.1,
  });
  assert.equal(employerField?.pageNumber, 1);
  assert.equal(employerField?.rawValue, "Empresa Sintética SA");
  assert.equal(employerField?.effectiveValue, "Empresa Sintética SA");
  assert.equal(employerField?.extractorVersion, "3");
  assert.equal(employerField?.correction, null);
  assert.equal(
    reviewFields.find(({ fieldPath }) => fieldPath === "settlement.deductionsAmount")?.sourceRegion,
    null,
  );
  assert.deepEqual(
    reviewData.lineItems.map((item: { itemOrdinal: number; amount: string; itemType: string }) =>
      [item.itemOrdinal, item.amount, item.itemType]),
    [[1, "110.00", "DEDUCTION"], [2, "50.00", "DEDUCTION"], [3, "20.00", "DEDUCTION"]],
  );
  const documentIdor = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieB },
  });
  assert.equal(documentIdor.statusCode, 404, documentIdor.body);
  const correctionIdor = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieB },
    payload: { extractedFieldId: employerFieldId, extractionRunId: runId, correctedValue: "No autorizado" },
  });
  assert.equal(correctionIdor.statusCode, 404, correctionIdor.body);
  const reviewIdor = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieB },
    payload: { extractionRunId: runId },
  });
  assert.equal(reviewIdor.statusCode, 404, reviewIdor.body);
  const reprocessIdor = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieB, "idempotency-key": "foreign-reprocess-0001" },
  });
  assert.equal(reprocessIdor.statusCode, 404, reprocessIdor.body);
  const employerCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: {
      extractedFieldId: employerFieldId,
      extractionRunId: runId,
      correctedValue: "Empresa Sintética SA",
    },
  });
  assert.equal(employerCorrection.statusCode, 201, employerCorrection.body);
  assert.equal(employerCorrection.json().data.extractionRunId, runId);
  const correctedEmployerProjection = (await pool.query(
      `SELECT document.detected_employer_id::text AS document_employer_id,
              run.detected_employer_id::text AS run_employer_id
         FROM documents document
         JOIN extraction_runs run ON run.id = document.active_extraction_run_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0];
  assert.ok(correctedEmployerProjection.document_employer_id);
  assert.equal(correctedEmployerProjection.run_employer_id, correctedEmployerProjection.document_employer_id);
  const employerCorrectionDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  const correctedEmployer = employerCorrectionDetail.json().data.extractedFields.find(
    (field: { fieldPath: string }) => field.fieldPath === "employer.name",
  );
  assert.equal(correctedEmployer.correctedValue, "Empresa Sintética SA");
  assert.equal(correctedEmployer.effectiveValue, "Empresa Sintética SA");
  assert.equal(correctedEmployer.correction.version, 1);
  assert.equal(typeof correctedEmployer.correction.correctedAt, "string");
  assert.deepEqual(
    reviewFields.filter(({ source }) => source === "MANUAL_REQUIRED").map(({ fieldPath }) => fieldPath).sort(),
    ["settlement.grossAmount", "settlement.netAmount"],
  );
  assert.deepEqual(
    Object.fromEntries(reviewFields.filter(({ missingReason }) => missingReason).map(({ fieldPath, missingReason }) => [fieldPath, missingReason])),
    {
      "settlement.grossAmount": "LABEL_OR_LAYOUT_NOT_RECOGNIZED",
      "settlement.netAmount": "VALUE_NOT_INTERPRETABLE",
    },
  );
  for (const [fieldPath, correctedValue] of [["settlement.grossAmount", "5.372.075"], ["settlement.netAmount", "820.00"]]) {
    const target = reviewFields.find((field) => field.fieldPath === fieldPath);
    assert.ok(target?.id);
    const manualCorrection = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/corrections`,
      headers: { origin, cookie: cookieA },
      payload: { extractedFieldId: target.id, extractionRunId: runId, correctedValue },
    });
    assert.equal(manualCorrection.statusCode, 201, manualCorrection.body);
    if (fieldPath === "settlement.grossAmount") {
      assert.equal(manualCorrection.json().data.correctedValue, "5372075");
    }
  }
  const mismatchedSettlement = (await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } }))
    .json().data.find((row: { documentId: string }) => row.documentId === documentId);
  assert.equal(mismatchedSettlement.totalsBalance, false);
  const blockedTotalsReview = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: { extractionRunId: runId },
  });
  assert.equal(blockedTotalsReview.statusCode, 409, blockedTotalsReview.body);
  assert.equal(blockedTotalsReview.json().error.code, "TOTALS_MISMATCH_REQUIRES_CORRECTION");
  const grossField = reviewFields.find((field) => field.fieldPath === "settlement.grossAmount");
  assert.ok(grossField?.id);
  const correctedGross = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: grossField.id, extractionRunId: runId, correctedValue: "1000.00" },
  });
  assert.equal(correctedGross.statusCode, 201, correctedGross.body);
  const balancedReviewDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.deepEqual(
    balancedReviewDetail.json().data.reviewSettlement,
    { totalsBalance: true, componentsBalance: true, deductionsMatchTotal: true },
  );
  await pool.query("UPDATE documents SET retention_policy = 'DELETE_AFTER_PROCESSING' WHERE id = $1", [documentId]);
  const completedReview = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: { extractionRunId: runId },
  });
  assert.equal(completedReview.statusCode, 200, completedReview.body);
  assert.equal(completedReview.json().data.processingStatus, "COMPLETED");
  assert.equal(
    (await pool.query(
      `SELECT document.original_deleted_at IS NOT NULL AS blocked,
              EXISTS (SELECT 1 FROM storage_deletion_tombstones tombstone
                       WHERE tombstone.canonical_object_key = document.object_key) AS scheduled
         FROM documents AS document WHERE document.id = $1`,
      [documentId],
    )).rows[0].blocked,
    true,
  );
  assert.equal(
    (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM storage_deletion_tombstones tombstone
                       JOIN documents document ON document.object_key = tombstone.canonical_object_key
                      WHERE document.id = $1) AS scheduled`,
      [documentId],
    )).rows[0].scheduled,
    true,
  );
  await pool.query(
    `DELETE FROM storage_deletion_tombstones
      WHERE canonical_object_key = (SELECT object_key FROM documents WHERE id = $1)`,
    [documentId],
  );
  await pool.query(
    "UPDATE documents SET retention_policy = 'KEEP_ORIGINAL', original_deleted_at = NULL WHERE id = $1",
    [documentId],
  );
  const completedBatch = await app.inject({ method: "GET", url: `/api/v1/imports/${batchData.id}`, headers: { cookie: cookieA } });
  assert.deepEqual(completedBatch.json().data.progress, { total: 1, resolved: 1, percentage: 100 });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/imports/active", headers: { cookie: cookieA } })).json().data, null);

  const sharedDocumentCreatedAt = "2026-08-30T12:34:56.123456Z";
  const listFixtures = [
    {
      id: crypto.randomUUID(), filename: "revision-sintetica.pdf", processingStatus: "NEEDS_REVIEW",
      documentType: "PAYROLL", classificationStatus: "SUPPORTED", itemStatus: "NEEDS_REVIEW", employmentId: null,
    },
    {
      id: crypto.randomUUID(), filename: "tipo-no-soportado-sintetico.pdf", processingStatus: "REJECTED_UNSUPPORTED",
      documentType: null, classificationStatus: "UNSUPPORTED", itemStatus: "REJECTED", employmentId: employmentA,
    },
    {
      id: crypto.randomUUID(), filename: "procesando-sintetico.pdf", processingStatus: "OCR",
      documentType: "PAYROLL", classificationStatus: "SUPPORTED", itemStatus: "PROCESSING", employmentId: employmentA,
    },
    {
      id: crypto.randomUUID(), filename: "error-sintetico.pdf", processingStatus: "FAILED_PERMANENT",
      documentType: "PAYROLL", classificationStatus: "SUPPORTED", itemStatus: "FAILED", employmentId: employmentA,
    },
  ];
  await pool.query("UPDATE documents SET created_at = $2::timestamptz WHERE id = $1", [documentId, sharedDocumentCreatedAt]);
  for (const [index, fixture] of listFixtures.entries()) {
    const itemId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    await pool.query(
      `WITH inserted_item AS (
         INSERT INTO import_batch_items (
           id, user_id, batch_id, employment_id, client_item_key, ordinal, original_filename,
           declared_mime_type, expected_size_bytes, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', $8, $9, $10, $10)
         RETURNING id
       ), inserted_upload AS (
         INSERT INTO upload_sessions (
           id, user_id, batch_id, item_id, object_key, expected_size_bytes, expected_mime_type,
           status, expires_at, confirmed_at, created_at
         ) SELECT $11, $2, $3, inserted_item.id, $12, $8, 'application/pdf',
                  'CONFIRMED', $10::timestamptz + interval '1 hour', $10, $10
             FROM inserted_item
         RETURNING id, item_id
       )
       INSERT INTO documents (
         id, user_id, import_batch_id, import_batch_item_id, upload_session_id, employment_id,
         object_key, original_filename, declared_mime_type, detected_mime_type, size_bytes,
         security_status, classification_status, document_type, classification_confidence,
         processing_status, retention_policy, created_at
       ) SELECT $13, $2, $3, inserted_upload.item_id, inserted_upload.id, $4,
                $14, $7, 'application/pdf', 'application/pdf', $8,
                'CLEAN', $15, $16, 0.9, $17, 'KEEP_ORIGINAL', $10
           FROM inserted_upload`,
      [
        itemId, userId, batchData.id, fixture.employmentId, `list-${fixture.id}`, 100 + index,
        fixture.filename, pdfBytes.byteLength, fixture.itemStatus, sharedDocumentCreatedAt,
        uploadId, `incoming/list-${fixture.id}.pdf`, fixture.id, `documents/list-${fixture.id}.pdf`,
        fixture.classificationStatus, fixture.documentType, fixture.processingStatus,
      ],
    );
  }

  const allListIds = [documentId, ...listFixtures.map(({ id }) => id)];
  const expectedDocumentOrder = (await pool.query<{ id: string }>(
    "SELECT id FROM documents WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC, id DESC",
    [allListIds],
  )).rows.map(({ id }) => id);
  const documentsView = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie: cookieA } });
  assert.equal(documentsView.statusCode, 200, documentsView.body);
  assert.deepEqual(
    {
      total: documentsView.json().data.total,
      pendingReview: documentsView.json().data.pendingReview,
      nextCursor: documentsView.json().data.nextCursor,
    },
    { total: 5, pendingReview: 1, nextCursor: null },
  );
  const listedDocument = documentsView.json().data.items.find((document: { id: string }) => document.id === documentId);
  assert.equal(listedDocument.displayFilename, "2026-08 - Empresa Sintética SA.pdf");
  const filteredDocuments = await app.inject({
    method: "GET",
    url: "/api/v1/documents?year=2026&documentType=PAYROLL&settlementType=NORMAL&search=Empresa%20Sint%C3%A9tica",
    headers: { cookie: cookieA },
  });
  assert.equal(filteredDocuments.statusCode, 200, filteredDocuments.body);
  assert.deepEqual(filteredDocuments.json().data.items.map((document: { id: string }) => document.id), [documentId]);
  assert.deepEqual(
    [filteredDocuments.json().data.total, filteredDocuments.json().data.pendingReview],
    [1, 0],
  );

  type DocumentPageData = {
    items: Array<{ id: string }>;
    total: number;
    pendingReview: number;
    nextCursor: string | null;
  };
  const pagedDocumentIds: string[] = [];
  let documentPageCursor: string | null = null;
  let firstDocumentPage: DocumentPageData | null = null;
  do {
    const pageResponse: typeof documentsView = await app.inject({
      method: "GET",
      url: `/api/v1/documents?limit=2${documentPageCursor ? `&cursor=${encodeURIComponent(documentPageCursor)}` : ""}`,
      headers: { cookie: cookieA },
    });
    assert.equal(pageResponse.statusCode, 200, pageResponse.body);
    const data = pageResponse.json().data as DocumentPageData;
    firstDocumentPage ??= data;
    assert.equal(data.total, 5);
    assert.equal(data.pendingReview, 1);
    pagedDocumentIds.push(...data.items.map((document: { id: string }) => document.id));
    documentPageCursor = data.nextCursor;
  } while (documentPageCursor);
  assert.deepEqual(pagedDocumentIds, expectedDocumentOrder);
  assert.equal(new Set(pagedDocumentIds).size, 5);
  assert.ok(firstDocumentPage);
  const firstOpaqueCursor = firstDocumentPage.nextCursor;
  const boundary = firstDocumentPage.items.at(-1);
  assert.ok(firstOpaqueCursor);
  assert.ok(boundary);
  const decodedDocumentCursor = JSON.parse(Buffer.from(firstOpaqueCursor, "base64url").toString("utf8"));
  const boundaryId = boundary.id;
  assert.equal(decodedDocumentCursor[1], boundaryId);
  assert.equal(
    decodedDocumentCursor[0],
    (await pool.query(
      "SELECT floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS micros FROM documents WHERE id = $1",
      [boundaryId],
    )).rows[0].micros,
  );

  const emptyCursor = Buffer.from(JSON.stringify(["1", "00000000-0000-4000-8000-000000000000"])).toString("base64url");
  const emptyDocumentsPage = await app.inject({
    method: "GET",
    url: `/api/v1/documents?cursor=${emptyCursor}`,
    headers: { cookie: cookieA },
  });
  assert.deepEqual(emptyDocumentsPage.json().data, { items: [], total: 5, pendingReview: 1, nextCursor: null });

  const documentFilterCases: Array<[string, string[], number]> = [
    ["period=2026-08", [documentId], 0],
    ["statusGroup=READY", [documentId], 0],
    ["statusGroup=REVIEW", [listFixtures[0]!.id], 1],
    ["statusGroup=PROCESSING", [listFixtures[2]!.id], 0],
    ["statusGroup=ERROR", [listFixtures[3]!.id], 0],
    ["documentType=UNSUPPORTED", [listFixtures[1]!.id], 0],
    ["processingStatus=OCR", [listFixtures[2]!.id], 0],
    [`employmentId=${employmentA}`, listFixtures.slice(1).map(({ id }) => id), 0],
    ["employmentId=unassociated", [documentId, listFixtures[0]!.id], 1],
    ["documentType=PAYROLL", [documentId, listFixtures[0]!.id, listFixtures[2]!.id, listFixtures[3]!.id], 1],
    ["search=revision-sintetica", [listFixtures[0]!.id], 1],
    ["statusGroup=ALL", allListIds, 1],
  ];
  for (const [query, expectedIds, pendingReview] of documentFilterCases) {
    const response = await app.inject({ method: "GET", url: `/api/v1/documents?${query}`, headers: { cookie: cookieA } });
    assert.equal(response.statusCode, 200, `${query}: ${response.body}`);
    assert.deepEqual(
      response.json().data.items.map((document: { id: string }) => document.id).sort(),
      [...expectedIds].sort(),
      query,
    );
    assert.equal(response.json().data.total, expectedIds.length, query);
    assert.equal(response.json().data.pendingReview, pendingReview, query);
  }
  assert.equal(
    (await pool.query("SELECT document_type FROM documents WHERE id = $1", [listFixtures[1]!.id])).rows[0].document_type,
    null,
  );
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie: cookieB } })).json().data,
    { items: [], total: 0, pendingReview: 0, nextCursor: null },
  );
  for (const query of [
    "limit=101", "cursor=no-es-un-cursor", "period=2026-13", "processingStatus=INVENTADO",
    "statusGroup=INVENTADO", "documentType=INVENTADO", "search=uno&search=dos",
  ]) {
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/v1/documents?${query}`, headers: { cookie: cookieA } })).statusCode,
      400,
      query,
    );
  }
  const groupedEmploymentDocuments = [
    { documentId: listFixtures[2]!.id, runId: crypto.randomUUID(), settlementId: crypto.randomUUID(), period: "2026-06-01" },
    { documentId: listFixtures[3]!.id, runId: crypto.randomUUID(), settlementId: crypto.randomUUID(), period: "2026-07-01" },
  ];
  for (const fixture of groupedEmploymentDocuments) {
    await pool.query("UPDATE documents SET processing_status = 'COMPLETED' WHERE id = $1", [fixture.documentId]);
    await pool.query(
      `INSERT INTO extraction_runs (
         id, user_id, document_id, processing_version, status, extractor_name,
         extractor_version, parser_version, normalizer_version, finished_at
       ) VALUES ($1, $2, $3, 1, 'COMPLETED', 'synthetic-selector', '1', '1', '1', now())`,
      [fixture.runId, userId, fixture.documentId],
    );
    await pool.query(
      `UPDATE extraction_runs SET promotion_outcome = 'PROMOTED', promoted_at = now() WHERE id = $1`,
      [fixture.runId],
    );
    await pool.query(
      `UPDATE documents SET active_extraction_run_id = $1 WHERE id = $2 AND user_id = $3`,
      [fixture.runId, fixture.documentId, userId],
    );
    await pool.query(
      `INSERT INTO payroll_settlements (
         id, user_id, document_id, extraction_run_id, employment_id, settlement_ordinal,
         payroll_period, settlement_type, is_recurring, currency_code, basic_amount
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, 'NORMAL', true, 'ARS', 900.00)`,
      [fixture.settlementId, userId, fixture.documentId, fixture.runId, employmentA, fixture.period],
    );
  }
  const groupedEmploymentHistory = await app.inject({
    method: "GET", url: "/api/v1/salary-history", headers: { cookie: cookieA },
  });
  assert.equal(groupedEmploymentHistory.statusCode, 200, groupedEmploymentHistory.body);
  const groupedEmploymentContexts = groupedEmploymentHistory.json().data.contexts.filter(
    (context: { employmentContext: string }) => context.employmentContext === employmentA,
  );
  assert.deepEqual(
    groupedEmploymentContexts.map((context: { firstPeriod: string; lastPeriod: string }) => ({
      firstPeriod: context.firstPeriod, lastPeriod: context.lastPeriod,
    })),
    [{ firstPeriod: "2026-06", lastPeriod: "2026-07" }],
  );
  await pool.query("DELETE FROM extraction_runs WHERE id = ANY($1::uuid[])", [
    groupedEmploymentDocuments.map(({ runId }) => runId),
  ]);
  await pool.query(
    `UPDATE documents
        SET processing_status = CASE id WHEN $1 THEN 'OCR' WHEN $2 THEN 'FAILED_PERMANENT' END
      WHERE id = ANY($3::uuid[])`,
    [listFixtures[2]!.id, listFixtures[3]!.id, [listFixtures[2]!.id, listFixtures[3]!.id]],
  );
  await pool.query(
    `UPDATE payroll_settlements
        SET basic_amount = 1000.00, remunerative_amount = 1000.00, non_remunerative_amount = 0.00
      WHERE id = $1 AND user_id = $2`,
    [settlementId, userId],
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description, normalized_concept_code,
       amount, currency_code, item_type, is_recurring, confidence
     ) VALUES
       ($1, $2, $3, 4, 'Sueldo básico sintético', 'BASIC_SALARY', 1000.00, 'ARS', 'EARNING', true, 0.99),
       ($4, $2, $3, 5, 'Bono sintético', 'BONUS', 25.00, 'ARS', 'EARNING', false, 0.99),
       ($5, $2, $3, 6, 'Haber desconocido sintético', NULL, 15.00, 'ARS', 'EARNING', NULL, 0.50)`,
    [crypto.randomUUID(), userId, settlementId, crypto.randomUUID(), crypto.randomUUID()],
  );
  const detectedCanonicalEmployer = await pool.query(
    `SELECT document.detected_employer_id, employer.name
       FROM documents document
       JOIN employers employer ON employer.id = document.detected_employer_id
      WHERE document.id = $1`,
    [documentId],
  );
  assert.equal(detectedCanonicalEmployer.rowCount, 1);
  const detectedCanonicalEmployerId = String(detectedCanonicalEmployer.rows[0].detected_employer_id);
  const detectedCanonicalEmployerName = String(detectedCanonicalEmployer.rows[0].name);
  await pool.query(
    "UPDATE employers SET name = 'Empresa Canónica Renombrada SA', updated_at = now() WHERE id = $1",
    [detectedCanonicalEmployerId],
  );
  const renamedCanonicalSalaryHistory = await app.inject({
    method: "GET", url: "/api/v1/salary-history", headers: { cookie: cookieA },
  });
  assert.equal(renamedCanonicalSalaryHistory.statusCode, 200, renamedCanonicalSalaryHistory.body);
  assert.equal(
    renamedCanonicalSalaryHistory.json().data.contexts.find(
      (context: { employmentContext: string }) => context.employmentContext === `detected:${detectedCanonicalEmployerId}`,
    )?.employerName,
    "Empresa Canónica Renombrada SA",
  );
  const renamedCanonicalDetections = await app.inject({
    method: "GET", url: "/api/v1/employment-detections", headers: { cookie: cookieA },
  });
  assert.equal(renamedCanonicalDetections.statusCode, 200, renamedCanonicalDetections.body);
  assert.equal(
    renamedCanonicalDetections.json().data.find(
      (detection: { employerId: string | null }) => detection.employerId === detectedCanonicalEmployerId,
    )?.employerName,
    "Empresa Canónica Renombrada SA",
  );
  await pool.query(
    `UPDATE user_corrections
        SET extracted_field_id = NULL, field_path = 'employer.name.hidden'
      WHERE user_id = $1 AND extraction_run_id = $2 AND field_path = 'employer.name'`,
    [userId, runId],
  );
  await pool.query("UPDATE extracted_fields SET field_path = 'employer.name.hidden' WHERE id = $1", [employerFieldId]);
  const fieldlessCanonicalDetections = await app.inject({
    method: "GET", url: "/api/v1/employment-detections", headers: { cookie: cookieA },
  });
  assert.equal(fieldlessCanonicalDetections.statusCode, 200, fieldlessCanonicalDetections.body);
  assert.equal(
    fieldlessCanonicalDetections.json().data.find(
      (detection: { employerId: string | null }) => detection.employerId === detectedCanonicalEmployerId,
    )?.employerName,
    "Empresa Canónica Renombrada SA",
  );
  await pool.query("UPDATE documents SET detected_employer_id = $2 WHERE id = $1", [
    documentId, currentEmploymentA.employerId,
  ]);
  const postMergeCanonicalDetections = await app.inject({
    method: "GET", url: "/api/v1/employment-detections", headers: { cookie: cookieA },
  });
  assert.equal(postMergeCanonicalDetections.statusCode, 200, postMergeCanonicalDetections.body);
  assert.equal(
    postMergeCanonicalDetections.json().data.find(
      (detection: { employerId: string | null }) => detection.employerId === currentEmploymentA.employerId,
    )?.employerName,
    currentEmploymentA.employerName,
  );
  await pool.query("UPDATE documents SET detected_employer_id = $2 WHERE id = $1", [
    documentId, detectedCanonicalEmployerId,
  ]);
  await pool.query("UPDATE extracted_fields SET field_path = 'employer.name' WHERE id = $1", [employerFieldId]);
  await pool.query(
    `UPDATE user_corrections
        SET extracted_field_id = $3, field_path = 'employer.name'
      WHERE user_id = $1 AND extraction_run_id = $2 AND field_path = 'employer.name.hidden'`,
    [userId, runId, employerFieldId],
  );
  await pool.query("UPDATE employers SET name = $2, updated_at = now() WHERE id = $1", [
    detectedCanonicalEmployerId, detectedCanonicalEmployerName,
  ]);
  const salaryHistory = await app.inject({ method: "GET", url: "/api/v1/salary-history", headers: { cookie: cookieA } });
  assert.equal(salaryHistory.statusCode, 200, salaryHistory.body);
  assert.equal(salaryHistory.json().data.calculationVersion, "salary-analytics-v1");
  assert.equal(salaryHistory.json().data.contexts[0].state, "DETECTED");
  assert.equal(salaryHistory.json().data.analytics.scopes[0].currencyCode, "ARS");
  assert.equal(salaryHistory.json().data.analytics.scopes[0].current.comparableSalary, "1000.00");
  assert.equal("settlements" in salaryHistory.json().data.analytics.scopes[0].evolution[0], false);
  assert.doesNotMatch(salaryHistory.body, /Sueldo básico sintético|Bono sintético|Haber desconocido sintético/);
  const employmentContext = salaryHistory.json().data.contexts[0].employmentContext as string;
  assert.match(employmentContext, /^detected:[0-9a-f-]{36}$/);
  const detectedEmployerContextId = employmentContext.slice("detected:".length);
  const conceptContextQuery = `employmentContext=${encodeURIComponent(employmentContext)}&currencyCode=ARS&employerName=${encodeURIComponent("Empresa Sintética SA")}`;
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?employmentContext=${encodeURIComponent(employmentContext)}&currencyCode=ARS&employerName=Otra`,
    headers: { cookie: cookieA },
  })).statusCode, 200);
  const firstConcepts = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?${conceptContextQuery}&limit=1`,
    headers: { cookie: cookieA },
  });
  assert.equal(firstConcepts.statusCode, 200, firstConcepts.body);
  assert.deepEqual(firstConcepts.json().data.items.map((item: { code: string; category: string }) => [item.code, item.category]), [
    ["BASIC_SALARY", "NORMAL"],
  ]);
  assert.equal(typeof firstConcepts.json().data.nextCursor, "string");
  const nextConcepts = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?${conceptContextQuery}&limit=1&cursor=${encodeURIComponent(firstConcepts.json().data.nextCursor)}`,
    headers: { cookie: cookieA },
  });
  assert.equal(nextConcepts.statusCode, 200, nextConcepts.body);
  assert.deepEqual(nextConcepts.json().data.items.map((item: { code: string; category: string }) => [item.code, item.category]), [
    ["BONUS", "BONO"],
  ]);
  assert.equal(nextConcepts.json().data.nextCursor, null);
  for (const invalidCursor of [
    ["0000-01", "1", 1, crypto.randomUUID(), 1, crypto.randomUUID()],
    ["2026-08", "1", 2_147_483_648, crypto.randomUUID(), 1, crypto.randomUUID()],
  ]) {
    assert.equal((await app.inject({
      method: "GET",
      url: `/api/v1/salary-history/concepts?${conceptContextQuery}&cursor=${Buffer.from(JSON.stringify(invalidCursor)).toString("base64url")}`,
      headers: { cookie: cookieA },
    })).statusCode, 400);
  }
  const bonusConcepts = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?${conceptContextQuery}&year=2026&category=BONO`,
    headers: { cookie: cookieA },
  });
  assert.deepEqual(bonusConcepts.json().data.items.map((item: { code: string }) => item.code), ["BONUS"]);
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?${conceptContextQuery}&limit=101`,
    headers: { cookie: cookieA },
  })).statusCode, 400);
  const employerCorrectionState = await pool.query(
    `SELECT id, corrected_value
       FROM user_corrections
      WHERE user_id = $1 AND extraction_run_id = $2 AND field_path = 'employer.name'
      ORDER BY correction_version DESC
      LIMIT 1`,
    [userId, runId],
  );
  assert.equal(employerCorrectionState.rowCount, 1);
  await pool.query("UPDATE documents SET detected_employer_id = NULL WHERE id = $1", [documentId]);
  await pool.query("UPDATE user_corrections SET corrected_value = $2::jsonb WHERE id = $1", [
    employerCorrectionState.rows[0].id, JSON.stringify("Empresa+Sintética SA"),
  ]);
  const legacyPunctuationSalaryHistory = await app.inject({
    method: "GET", url: "/api/v1/salary-history", headers: { cookie: cookieA },
  });
  assert.equal(legacyPunctuationSalaryHistory.statusCode, 200, legacyPunctuationSalaryHistory.body);
  const legacyPunctuationContext = legacyPunctuationSalaryHistory.json().data.contexts.find(
    (context: { employerName: string }) => context.employerName === "Empresa+Sintética SA",
  )?.employmentContext as string;
  assert.match(legacyPunctuationContext, /^detected:[0-9a-f]{24}$/);
  const legacyPunctuationConcepts = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?employmentContext=${encodeURIComponent(legacyPunctuationContext)}&currencyCode=ARS&employerName=${encodeURIComponent("Empresa+Sintética SA")}`,
    headers: { cookie: cookieA },
  });
  assert.equal(legacyPunctuationConcepts.statusCode, 200, legacyPunctuationConcepts.body);
  assert.ok(legacyPunctuationConcepts.json().data.items.length > 0);
  await pool.query("UPDATE user_corrections SET corrected_value = $2::jsonb WHERE id = $1", [
    employerCorrectionState.rows[0].id, JSON.stringify(employerCorrectionState.rows[0].corrected_value),
  ]);
  await pool.query("UPDATE documents SET detected_employer_id = $2 WHERE id = $1", [
    documentId, detectedCanonicalEmployerId,
  ]);
  const isolatedSalaryHistory = await app.inject({ method: "GET", url: "/api/v1/salary-history", headers: { cookie: cookieB } });
  assert.equal(isolatedSalaryHistory.statusCode, 200, isolatedSalaryHistory.body);
  assert.deepEqual(isolatedSalaryHistory.json().data.analytics.scopes, []);
  const isolatedConcepts = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?${conceptContextQuery}`,
    headers: { cookie: cookieB },
  });
  assert.deepEqual(isolatedConcepts.json().data, { items: [], nextCursor: null });
  const detectedEmployments = await app.inject({ method: "GET", url: "/api/v1/employment-detections", headers: { cookie: cookieA } });
  assert.equal(detectedEmployments.statusCode, 200, detectedEmployments.body);
  assert.deepEqual(detectedEmployments.json().data[0], {
    employerId: detectedEmployerContextId,
    employerName: "Empresa Sintética SA",
    currencyCode: "ARS",
    firstPeriod: "2026-08",
    lastPeriod: "2026-08",
    documentCount: 1,
    state: "DETECTED",
  });
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/v1/employment-detections", headers: { cookie: cookieB } })).json().data,
    [],
  );
  const settlementsView = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(settlementsView.statusCode, 200, settlementsView.body);
  assert.equal(settlementsView.json().data[0].employerName, "Empresa Sintética SA");
  assert.equal(settlementsView.json().data[0].deductionsPercentage, "18.00");
  assert.equal(settlementsView.json().data[0].deductionsMatchTotal, true);
  assert.equal(settlementsView.json().data[0].deductionsDifferenceKind, "MATCHED");
  assert.deepEqual(
    settlementsView.json().data[0].deductions.map((deduction: { amount: string; grossPercentage: string }) => [deduction.amount, deduction.grossPercentage]),
    [["110.00", "11.00"], ["50.00", "5.00"], ["20.00", "2.00"]],
  );

  const foreignEmployment = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentB },
  });
  assert.equal(foreignEmployment.statusCode, 404, foreignEmployment.body);
  const partialBatch = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId, crypto.randomUUID()], employmentId: employmentA },
  });
  assert.equal(partialBatch.statusCode, 404, partialBatch.body);
  const unchangedAssociation = await pool.query(
    "SELECT employment_id FROM documents WHERE id = $1",
    [documentId],
  );
  assert.equal(unchangedAssociation.rows[0].employment_id, null);

  const association = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentA },
  });
  assert.equal(association.statusCode, 200, association.body);
  assert.equal(association.json().data.updatedCount, 1);
  const associatedDocuments = await app.inject({ method: "GET", url: "/api/v1/documents", headers: { cookie: cookieA } });
  const associatedDocument = associatedDocuments.json().data.items.find((document: { id: string }) => document.id === documentId);
  assert.equal(associatedDocument.employmentId, employmentA);
  assert.equal(associatedDocument.displayFilename, "2026-08 - Empresa Asociada A.pdf");
  const associatedSettlements = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(associatedSettlements.json().data[0].employerName, "Empresa Asociada A");
  const persistedAssociation = await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id,
            item.employment_id AS item_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  );
  assert.equal(String(persistedAssociation.rows[0].document_employment_id), employmentA);
  assert.equal(String(persistedAssociation.rows[0].settlement_employment_id), employmentA);
  assert.equal(String(persistedAssociation.rows[0].item_employment_id), employmentA);

  const disassociation = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: null },
  });
  assert.equal(disassociation.statusCode, 200, disassociation.body);
  const clearedAssociation = await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id,
            item.employment_id AS item_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  );
  assert.equal(clearedAssociation.rows[0].document_employment_id, null);
  assert.equal(clearedAssociation.rows[0].settlement_employment_id, null);
  assert.equal(clearedAssociation.rows[0].item_employment_id, null);

  const foreignDetectionConfirmation = await app.inject({
    method: "POST",
    url: "/api/v1/employment-detections/confirm",
    headers: { origin, cookie: cookieB },
    payload: { employerId: detectedEmployerContextId, employerName: "Empresa Sintética SA", currencyCode: "ARS", startDate: "2026-08-01", endDate: null },
  });
  assert.equal(foreignDetectionConfirmation.statusCode, 404, foreignDetectionConfirmation.body);
  await Promise.all([
    pool.query("UPDATE payroll_settlements SET employment_id = $1 WHERE document_id = $2", [employmentA, documentId]),
    pool.query(
      `UPDATE import_batch_items SET employment_id = $1
        WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $2)`,
      [employmentA, documentId],
    ),
  ]);
  const confirmedDetection = await app.inject({
    method: "POST",
    url: "/api/v1/employment-detections/confirm",
    headers: { origin, cookie: cookieA },
    payload: { employerId: detectedEmployerContextId, employerName: "Empresa Sintética SA", currencyCode: "ARS", startDate: "2026-08-01", endDate: null },
  });
  assert.equal(confirmedDetection.statusCode, 201, confirmedDetection.body);
  assert.equal(confirmedDetection.json().data.associatedDocuments, 1);
  assert.equal(confirmedDetection.json().data.employment.status, "ACTIVE");
  const detectedEmploymentId = String(confirmedDetection.json().data.employment.id);
  const detectedEmployerId = String(confirmedDetection.json().data.employment.employerId);
  assert.deepEqual((await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id,
            item.employment_id AS item_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  )).rows[0], {
    document_employment_id: detectedEmploymentId,
    settlement_employment_id: detectedEmploymentId,
    item_employment_id: detectedEmploymentId,
  });
  const clearDetectedEmployment = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: null },
  });
  assert.equal(clearDetectedEmployment.statusCode, 200, clearDetectedEmployment.body);
  await Promise.all([
    pool.query("UPDATE employers SET name = name || chr(160) WHERE id = $1", [detectedEmployerId]),
    pool.query(
      `UPDATE extracted_fields
          SET interpreted_value = to_jsonb((interpreted_value #>> '{}') || chr(160))
        WHERE document_id = $1 AND field_path = 'employer.name'`,
      [documentId],
    ),
  ]);
  const employmentCountBeforeReuse = Number((await pool.query(
    "SELECT count(*) FROM employments WHERE user_id = $1",
    [userId],
  )).rows[0].count);
  const rejectedForeignEmploymentReuse = await app.inject({
    method: "POST",
    url: "/api/v1/employment-detections/confirm",
    headers: { origin, cookie: cookieA },
    payload: {
      employerName: "Empresa Sintética SA",
      currencyCode: "ARS",
      employmentId: employmentB,
    },
  });
  assert.equal(rejectedForeignEmploymentReuse.statusCode, 404, rejectedForeignEmploymentReuse.body);
  assert.equal((await pool.query("SELECT employment_id FROM documents WHERE id = $1", [documentId])).rows[0].employment_id, null);
  const reusedDetection = await app.inject({
    method: "POST",
    url: "/api/v1/employment-detections/confirm",
    headers: { origin, cookie: cookieA },
    payload: {
      employerName: "empresa sintética sa",
      employerId: detectedEmployerId,
      currencyCode: "ARS",
      employmentId: detectedEmploymentId,
    },
  });
  assert.equal(reusedDetection.statusCode, 201, reusedDetection.body);
  assert.equal(reusedDetection.json().data.employment.id, detectedEmploymentId);
  assert.equal(reusedDetection.json().data.associatedDocuments, 1);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM employments WHERE user_id = $1", [userId])).rows[0].count),
    employmentCountBeforeReuse,
  );
  assert.deepEqual((await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            settlement.employment_id AS settlement_employment_id,
            item.employment_id AS item_employment_id
       FROM documents document
       JOIN payroll_settlements settlement ON settlement.document_id = document.id
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  )).rows[0], {
    document_employment_id: detectedEmploymentId,
    settlement_employment_id: detectedEmploymentId,
    item_employment_id: detectedEmploymentId,
  });
  assert.equal((await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: null },
  })).statusCode, 200);
  await pool.query("DELETE FROM employments WHERE id = $1 AND user_id = $2", [detectedEmploymentId, userId]);
  await pool.query("DELETE FROM employers WHERE id = $1 AND created_by_user_id = $2", [detectedEmployerId, userId]);

  const correction = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: deductionsFieldId, extractionRunId: runId, correctedValue: "200.00" },
  });
  assert.equal(correction.statusCode, 201, correction.body);
  assert.equal(
    (await pool.query("SELECT processing_status FROM documents WHERE id = $1", [documentId])).rows[0].processing_status,
    "NEEDS_REVIEW",
  );
  const correctedSettlements = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(correctedSettlements.json().data[0].deductionsAmount, "200.00");
  assert.equal(correctedSettlements.json().data[0].deductionsMatchTotal, false);
  assert.equal(correctedSettlements.json().data[0].deductionsDifferenceKind, "MISSING_ITEMS");
  assert.equal(correctedSettlements.json().data[0].deductionsDifferenceAmount, "20.00");
  assert.equal(correctedSettlements.json().data[0].deductions.length, 3);
  const creditCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: deductionsFieldId, extractionRunId: runId, correctedValue: "-20.00" },
  });
  assert.equal(creditCorrection.statusCode, 201, creditCorrection.body);
  const creditSettlement = (await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } }))
    .json().data.find((row: { documentId: string }) => row.documentId === documentId);
  assert.equal(creditSettlement.deductionsAmount, "-20.00");
  assert.equal(creditSettlement.deductionsChargedAmount, "0.00");
  assert.equal(creditSettlement.reimbursementsAmount, "20.00");
  assert.equal(creditSettlement.deductionsPercentage, null);
  assert.equal((await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: deductionsFieldId, extractionRunId: runId, correctedValue: "200.00" },
  })).statusCode, 201);

  const manualRunId = crypto.randomUUID();
  const manualEmployerFieldId = crypto.randomUUID();
  const manualGrossFieldId = crypto.randomUUID();
  const manualNetFieldId = crypto.randomUUID();
  const manualDeductionsFieldId = crypto.randomUUID();
  const manualTypeFieldId = crypto.randomUUID();
  const manualRemunerativeFieldId = crypto.randomUUID();
  const manualNonRemunerativeFieldId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status, extractor_name,
       extractor_version, parser_version, normalizer_version, finished_at, confidence
     ) VALUES ($1, $2, $3, 3, 'COMPLETED', 'synthetic-test', '3', '3', '3', now(), 0.7)`,
    [manualRunId, userId, documentId],
  );
  await pool.query(
    `UPDATE extraction_runs SET promotion_outcome = 'PROMOTED', promoted_at = now() WHERE id = $1`,
    [manualRunId],
  );
  await pool.query(
    `UPDATE documents SET active_extraction_run_id = $1 WHERE id = $2 AND user_id = $3`,
    [manualRunId, documentId, userId],
  );
  await pool.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version
     ) VALUES
       ($1, $2, $3, $4, 'settlement.grossAmount', 'PAYROLL_SETTLEMENT', '1000.00', $5::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($6, $2, $3, $4, 'settlement.netAmount', 'PAYROLL_SETTLEMENT', '820.00', $7::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($8, $2, $3, $4, 'settlement.deductionsAmount', 'PAYROLL_SETTLEMENT', '180.00', $9::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($10, $2, $3, $4, 'settlement.type', 'PAYROLL_SETTLEMENT', 'BONO', $11::jsonb, 0.8, 'RULE', '3'),
       ($12, $2, $3, $4, 'settlement.remunerativeAmount', 'PAYROLL_SETTLEMENT', '700.00', $13::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($14, $2, $3, $4, 'settlement.nonRemunerativeAmount', 'PAYROLL_SETTLEMENT', '300.00', $15::jsonb, 0.7, 'PDF_TEXT', '3'),
       ($16, $2, $3, $4, 'employer.name', 'EMPLOYER', 'Empresa Sintética SA', $17::jsonb, 0.8, 'PDF_TEXT', '3')`,
    [
      manualGrossFieldId, userId, documentId, manualRunId, JSON.stringify({ amount: "1000.00", currencyCode: "ARS" }),
      manualNetFieldId, JSON.stringify({ amount: "820.00", currencyCode: "ARS" }),
      manualDeductionsFieldId, JSON.stringify({ amount: "180.00", currencyCode: "ARS" }),
      manualTypeFieldId, JSON.stringify("BONO"),
      manualRemunerativeFieldId, JSON.stringify({ amount: "700.00", currencyCode: "ARS" }),
      manualNonRemunerativeFieldId, JSON.stringify({ amount: "300.00", currencyCode: "ARS" }),
      manualEmployerFieldId, JSON.stringify("Empresa Sintética SA"),
    ],
  );
  await pool.query("UPDATE documents SET processing_status = 'NEEDS_REVIEW' WHERE id = $1", [documentId]);
  await pool.query("UPDATE import_batch_items SET status = 'NEEDS_REVIEW' WHERE id = $1", [batchData.items[0]!.id]);
  await pool.query("UPDATE import_batches SET status = 'ACTIVE', completed_at = NULL WHERE id = $1", [batchData.id]);

  const periodReview = await app.inject({ method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA } });
  const periodFields = periodReview.json().data.extractedFields as Array<{
    id: string | null; fieldPath: string; correctedValue: string | null; source: string;
  }>;
  assert.deepEqual(
    periodFields.filter(({ source }) => source === "MANUAL_REQUIRED").map(({ fieldPath }) => fieldPath).sort(),
    ["settlement.deductionsAmount", "settlement.grossAmount", "settlement.netAmount", "settlement.payrollPeriod"],
  );
  const unversionedCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { fieldPath: "settlement.payrollPeriod", correctedValue: "2026-09" },
  });
  assert.equal(unversionedCorrection.statusCode, 400, unversionedCorrection.body);
  const staleCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualGrossFieldId, extractionRunId: runId, correctedValue: "1000.00" },
  });
  assert.equal(staleCorrection.statusCode, 409, staleCorrection.body);
  assert.equal(staleCorrection.json().error.code, "STALE_EXTRACTION_RUN");
  const unversionedReview = await app.inject({
    method: "POST", url: `/api/v1/documents/${documentId}/review-complete`, headers: { origin, cookie: cookieA }, payload: {},
  });
  assert.equal(unversionedReview.statusCode, 400, unversionedReview.body);
  const staleReview = await app.inject({
    method: "POST", url: `/api/v1/documents/${documentId}/review-complete`, headers: { origin, cookie: cookieA },
    payload: { extractionRunId: runId },
  });
  assert.equal(staleReview.statusCode, 409, staleReview.body);
  assert.equal(staleReview.json().error.code, "STALE_EXTRACTION_RUN");
  const amountBeforePeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualGrossFieldId, extractionRunId: manualRunId, correctedValue: "1000.00" },
  });
  assert.equal(amountBeforePeriod.statusCode, 409, amountBeforePeriod.body);
  const typeBeforePeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualTypeFieldId, extractionRunId: manualRunId, correctedValue: "AJUSTE" },
  });
  assert.equal(typeBeforePeriod.statusCode, 201, typeBeforePeriod.body);
  const manualPeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { fieldPath: "settlement.payrollPeriod", extractionRunId: manualRunId, correctedValue: "2026-09" },
  });
  assert.equal(manualPeriod.statusCode, 201, manualPeriod.body);
  const missingTotalSettlement = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(missingTotalSettlement.json().data[0].deductionsMatchTotal, false);
  assert.equal(missingTotalSettlement.json().data[0].deductionsDifferenceKind, "TOTAL_MISSING");
  assert.equal(missingTotalSettlement.json().data[0].deductionsDifferenceAmount, null);
  assert.equal(missingTotalSettlement.json().data[0].settlementType, "AJUSTE");
  for (const [extractedFieldId, correctedValue] of [
    [manualGrossFieldId, "1000.00"],
    [manualRemunerativeFieldId, "700.00"],
    [manualNonRemunerativeFieldId, "200.00"],
    [manualNetFieldId, "820.00"],
    [manualDeductionsFieldId, "180.00"],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/corrections`,
      headers: { origin, cookie: cookieA },
      payload: { extractedFieldId, extractionRunId: manualRunId, correctedValue },
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  const correctedBreakdown = (await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } })).json().data[0];
  assert.equal(correctedBreakdown.remunerativeAmount, "700.00");
  assert.equal(correctedBreakdown.nonRemunerativeAmount, "200.00");
  const mismatchedComponentsDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.equal(mismatchedComponentsDetail.json().data.reviewSettlement.componentsBalance, false);
  const blockedComponentsReview = await app.inject({
    method: "POST", url: `/api/v1/documents/${documentId}/review-complete`, headers: { origin, cookie: cookieA },
    payload: { acceptDeductionsMismatch: true, extractionRunId: manualRunId },
  });
  assert.equal(blockedComponentsReview.statusCode, 409, blockedComponentsReview.body);
  assert.equal(blockedComponentsReview.json().error.code, "COMPONENTS_MISMATCH_REQUIRES_CORRECTION");
  const correctedComponents = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualNonRemunerativeFieldId, extractionRunId: manualRunId, correctedValue: "300.00" },
  });
  assert.equal(correctedComponents.statusCode, 201, correctedComponents.body);
  const balancedComponentsDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.equal(balancedComponentsDetail.json().data.reviewSettlement.componentsBalance, true);
  const unconfirmedMismatch = await app.inject({
    method: "POST", url: `/api/v1/documents/${documentId}/review-complete`, headers: { origin, cookie: cookieA }, payload: { extractionRunId: manualRunId },
  });
  assert.equal(unconfirmedMismatch.statusCode, 409, unconfirmedMismatch.body);
  const acceptedMismatch = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: { acceptDeductionsMismatch: true, extractionRunId: manualRunId },
  });
  assert.equal(acceptedMismatch.statusCode, 200, acceptedMismatch.body);
  const completedManualDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  const completedManualPeriod = completedManualDetail.json().data.extractedFields.find(
    (field: { fieldPath: string }) => field.fieldPath === "settlement.payrollPeriod",
  );
  assert.deepEqual(
    {
      id: completedManualPeriod.id,
      fieldPath: completedManualPeriod.fieldPath,
      rawValue: completedManualPeriod.rawValue,
      interpretedValue: completedManualPeriod.interpretedValue,
      correctedValue: completedManualPeriod.correctedValue,
      effectiveValue: completedManualPeriod.effectiveValue,
      confidence: completedManualPeriod.confidence,
      source: completedManualPeriod.source,
      pageNumber: completedManualPeriod.pageNumber,
      sourceRegion: completedManualPeriod.sourceRegion,
      extractorVersion: completedManualPeriod.extractorVersion,
    },
    {
      id: null,
      fieldPath: "settlement.payrollPeriod",
      rawValue: null,
      interpretedValue: null,
      correctedValue: "2026-09",
      effectiveValue: "2026-09",
      confidence: "0",
      source: "MANUAL_REQUIRED",
      pageNumber: null,
      sourceRegion: null,
      extractorVersion: null,
    },
  );
  assert.equal(completedManualPeriod.correction.version, 1);
  assert.equal(typeof completedManualPeriod.correction.correctedAt, "string");
  const editCompletedManualPeriod = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { fieldPath: "settlement.payrollPeriod", extractionRunId: manualRunId, correctedValue: "2026-10" },
  });
  assert.equal(editCompletedManualPeriod.statusCode, 201, editCompletedManualPeriod.body);
  assert.equal(
    (await pool.query("SELECT processing_status FROM documents WHERE id = $1", [documentId])).rows[0].processing_status,
    "NEEDS_REVIEW",
  );
  assert.equal(
    (await pool.query("SELECT to_char(payroll_period, 'YYYY-MM') AS period FROM payroll_settlements WHERE extraction_run_id = $1", [manualRunId])).rows[0].period,
    "2026-10",
  );
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/review-complete`,
      headers: { origin, cookie: cookieA },
      payload: { acceptDeductionsMismatch: true, extractionRunId: manualRunId },
    })).statusCode,
    200,
  );
  const correctedType = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualTypeFieldId, extractionRunId: manualRunId, correctedValue: "AJUSTE" },
  });
  assert.equal(correctedType.statusCode, 201, correctedType.body);
  const typeView = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieA } });
  assert.equal(typeView.json().data[0].settlementType, "AJUSTE");
  assert.equal(
    (await app.inject({
      method: "POST",
      url: `/api/v1/documents/${documentId}/review-complete`,
      headers: { origin, cookie: cookieA },
      payload: { acceptDeductionsMismatch: true, extractionRunId: manualRunId },
    })).statusCode,
    200,
  );
  const unsupportedCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: { extractedFieldId: manualTypeFieldId, extractionRunId: manualRunId, correctedValue: "NO_EXISTE" },
  });
  assert.equal(unsupportedCorrection.statusCode, 400, unsupportedCorrection.body);

  await assert.rejects(
    pool.query(
      `INSERT INTO user_corrections (
         id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
         correction_version, extracted_value, corrected_value
       ) VALUES ($1, $2, $3, $4, $5, 'settlement.netAmount', 99, '{}'::jsonb, '{}'::jsonb)`,
      [crypto.randomUUID(), userId, manualGrossFieldId, documentId, manualRunId],
    ),
    /foreign key constraint/,
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description,
       normalized_concept_code, amount, currency_code, item_type, is_recurring, confidence
     )
     SELECT $1, $2, settlement.id, 1, 'Bono sintético',
            'BONO', 100.00, 'ARS', 'EARNING', false, 0.9
       FROM payroll_settlements settlement
      WHERE settlement.user_id = $2 AND settlement.extraction_run_id = $3`,
    [crypto.randomUUID(), userIdA, manualRunId],
  );

  const isolatedView = await app.inject({ method: "GET", url: "/api/v1/settlements", headers: { cookie: cookieB } });
  assert.deepEqual(isolatedView.json().data, []);

  await pool.query("UPDATE sessions SET step_up_expires_at = NULL WHERE user_id = $1", [userIdA]);
  const blockedReplacementEnrollment = await app.inject({
    method: "POST",
    url: "/api/v1/auth/mfa/enrollment",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(blockedReplacementEnrollment.statusCode, 403, blockedReplacementEnrollment.body);
  assert.equal(blockedReplacementEnrollment.json().error.code, "STEP_UP_REQUIRED");
  const blockedExport = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/exports",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(blockedExport.statusCode, 403, blockedExport.body);
  assert.equal(blockedExport.json().error.code, "STEP_UP_REQUIRED");
  const steppedUp = await app.inject({
    method: "POST",
    url: "/api/v1/auth/step-up",
    headers: { origin, cookie: cookieA },
    payload: { code: recoveryCodes[0] },
  });
  assert.equal(steppedUp.statusCode, 200, steppedUp.body);
  cookieA = rotatedCookie(steppedUp, cookieA);
  const foreignDetectedEmployerId = String(unrelatedEmployer.json().data.id);
  assert.equal((await pool.query(
    `UPDATE documents
        SET detected_employer_id = $2
      WHERE id = $1 AND user_id = $3 AND employment_id IS NULL`,
    [documentId, foreignDetectedEmployerId, userIdA],
  )).rowCount, 1);
  await pool.query(
    `INSERT INTO extraction_run_issues (
       id, user_id, document_id, extraction_run_id, code, severity,
       recoverable, affected_field_path, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
       'settlement.basicAmount', '{}'::jsonb)
     ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
    [crypto.randomUUID(), userIdA, documentId, manualRunId],
  );
  const firstExport = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/exports",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(firstExport.statusCode, 201, firstExport.body);
  const secondExport = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/exports",
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(secondExport.statusCode, 200, secondExport.body);
  assert.equal(secondExport.json().data.id, firstExport.json().data.id);
  assert.equal(firstExport.json().data.created, true);
  assert.equal(firstExport.json().data.status, "READY");
  assert.equal(typeof firstExport.json().data.createdAt, "string");
  assert.equal(firstExport.json().data.startedAt, null);
  assert.equal(typeof firstExport.json().data.expiresAt, "string");
  assert.equal(firstExport.json().data.completedAt, null);
  assert.equal(secondExport.json().data.created, false);
  assert.equal(secondExport.json().data.createdAt, firstExport.json().data.createdAt);
  const exportId = String(firstExport.json().data.id);
  const readyExport = await app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(readyExport.statusCode, 200, readyExport.body);
  assert.deepEqual(
    {
      status: readyExport.json().data.status,
      createdAt: readyExport.json().data.createdAt,
      startedAt: readyExport.json().data.startedAt,
      expiresAt: readyExport.json().data.expiresAt,
      completedAt: readyExport.json().data.completedAt,
    },
    {
      status: "READY",
      createdAt: firstExport.json().data.createdAt,
      startedAt: null,
      expiresAt: firstExport.json().data.expiresAt,
      completedAt: null,
    },
  );
  const foreignExport = await app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}`,
    headers: { cookie: cookieB },
  });
  assert.equal(foreignExport.statusCode, 404, foreignExport.body);
  const foreignExportDownload = await app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}/download`,
    headers: { cookie: cookieB },
  });
  assert.equal(foreignExportDownload.statusCode, 403, foreignExportDownload.body);
  assert.equal(foreignExportDownload.json().error.code, "STEP_UP_REQUIRED");
  const download = () => app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}/download`,
    headers: { cookie: cookieA },
  });
  const downloads = await Promise.all([download(), download()]);
  assert.deepEqual(downloads.map((response) => response.statusCode).sort(), [200, 409]);
  const exported = downloads.find(({ statusCode }) => statusCode === 200)!.json();
  assert.equal((await pool.query(
    "UPDATE documents SET detected_employer_id = NULL WHERE id = $1 AND user_id = $2",
    [documentId, userIdA],
  )).rowCount, 1);
  assert.equal(exported.format, "salarivo-user-export-v4");
  assert.deepEqual(Object.keys(exported), [
    "format", "exportedAt", "account", "authenticationMethods", "employers", "employments",
    "imports", "documents", "settlements", "concepts", "processingRuns", "processingIssues",
    "corrections", "legalAcknowledgements", "sessions", "privacyRequests",
  ]);
  assert.equal(exported.account.secondFactor.enabled, true);
  assert.ok(exported.employers.some((employer: { name: string; firstLinkedAt: string | null }) =>
    employer.name === ownOrphanEmployerName && employer.firstLinkedAt === null));
  assert.ok(exported.employers.some((employer: {
    name: string; firstLinkedAt: string | null; status: string | null; createdAt: string | null;
  }) => employer.name === "Empresa Ajena B" && typeof employer.firstLinkedAt === "string"
    && employer.status === null && employer.createdAt === null));
  assert.ok(exported.employers.some((employer: {
    name: string; firstLinkedAt: string | null; status: string | null; createdAt: string | null;
  }) => employer.name === unrelatedEmployerName && employer.firstLinkedAt === null
    && employer.status === null && employer.createdAt === null));
  for (const [name, status] of [
    ["Empresa Propia Fusionada", "MERGED"], ["Empresa Propia Rechazada", "REJECTED"],
  ]) {
    assert.ok(exported.employers.some((employer: {
      name: string; status: string | null; createdAt: string | null;
    }) => employer.name === name && employer.status === status && typeof employer.createdAt === "string"));
  }
  assert.equal(/updatedAt|createdSource|createdBy/i.test(JSON.stringify(exported.employers)), false);
  assert.ok(exported.imports.some((item: { filename: string }) => item.filename === "recibo-sintetico.pdf"));
  assert.ok(exported.documents.some((document: { filename: string; employerName: string | null }) =>
    document.filename === "recibo-sintetico.pdf" && document.employerName === unrelatedEmployerName));
  assert.ok(exported.settlements.some((settlement: {
    active: boolean; documentRevision: number; payrollPeriod: string;
    grossAmount: string; employerName: string | null; promotionOutcome: string;
  }) => settlement.documentRevision === 3 && settlement.active
    && settlement.promotionOutcome === "PROMOTED"
    && settlement.payrollPeriod.startsWith("2026-10") && settlement.grossAmount === "1000.00"
    && settlement.employerName === null));
  assert.ok(exported.settlements.some((settlement: {
    active: boolean; documentRevision: number; payrollPeriod: string;
  }) => settlement.documentRevision === 2 && !settlement.active
    && settlement.payrollPeriod.startsWith("2026-08")));
  assert.ok(exported.concepts.some((concept: {
    active: boolean; description: string; documentRevision: number; type: string;
  }) => concept.documentRevision === 3 && concept.active
    && concept.description === "Bono sintético" && concept.type === "EARNING"));
  assert.ok(exported.concepts.some((concept: {
    active: boolean; description: string; documentRevision: number;
  }) => concept.documentRevision === 2 && !concept.active && concept.description === "Deducción"));
  assert.ok(exported.processingRuns.some((run: {
    active: boolean; documentRevision: number; promotionOutcome: string; status: string;
  }) => run.documentRevision === 3 && run.active
    && run.promotionOutcome === "PROMOTED" && run.status === "COMPLETED"));
  assert.ok(exported.processingRuns.some((run: {
    active: boolean; documentRevision: number;
  }) => run.documentRevision === 2 && !run.active));
  assert.ok(exported.processingIssues.some((issue: {
    affectedField: string; code: string; documentRevision: number; recoverable: boolean;
  }) => issue.documentRevision === 3 && issue.code === "LABEL_OR_LAYOUT_NOT_RECOGNIZED"
    && issue.affectedField === "settlement.basicAmount" && issue.recoverable));
  assert.ok(exported.corrections.some((correction: {
    documentRevision: number; field: string; correctedValue: string;
  }) => correction.documentRevision === 3
    && correction.field === "settlement.payrollPeriod"
    && correction.correctedValue === "2026-10"));
  const exportedText = JSON.stringify(exported);
  assert.equal(/"(?:id|[A-Za-z][A-Za-z0-9]*Id|[a-z][a-z0-9_]*_id)"\s*:/.test(exportedText), false);
  for (const internalIdentifier of [
    userIdA,
    documentId,
    settlementId,
    manualRunId,
    manualGrossFieldId,
    employmentA,
    foreignDetectedEmployerId,
    createHash("sha256").update(emailA).digest("base64url"),
  ]) assert.equal(exportedText.includes(internalIdentifier), false);
  assert.equal(
    /provider_account_id|sha256|client_item_key|source_region|processingVersion|compute_ms|error_code|encrypted_secret|token_hash|password_hash|HEALTH_INSURANCE|UNION_DUES/i
      .test(exportedText),
    false,
  );
  assert.ok(exported.sessions.every((session: Record<string, unknown>) =>
    ["lastSeenAt", "deviceType", "browser", "operatingSystem"].every((key) => Object.hasOwn(session, key))));
  assert.equal(/userAgent|ipAddress|geo|browserVersion|operatingSystemVersion/i.test(JSON.stringify(exported.sessions)), false);
  const completedExport = await app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${exportId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(completedExport.statusCode, 200, completedExport.body);
  assert.equal(completedExport.json().data.status, "COMPLETED");
  assert.equal(typeof completedExport.json().data.startedAt, "string");
  assert.equal(typeof completedExport.json().data.completedAt, "string");
  assert.equal(completedExport.json().data.downloadUrl, null);

  const revocableToken = deletionReceiptToken();
  const revocableSessionHash = createHash("sha256").update(revocableToken).digest("hex");
  const revocableExportId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at, step_up_expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour', now(), now() + interval '10 minutes')`,
    [crypto.randomUUID(), userIdA, revocableSessionHash],
  );
  await pool.query(
    `INSERT INTO privacy_operations (
       id, user_id, operation_type, idempotency_key, status, output_expires_at
     ) VALUES ($1, $2, 'DATA_EXPORT', $3, 'READY', now() + interval '10 minutes')`,
    [revocableExportId, userIdA, `revocable-export:${revocableExportId}`],
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description,
       amount, currency_code, item_type
     )
     SELECT gen_random_uuid(), $1, settlement.id, page.number + 1,
            'Concepto sintético de exportación', 0, 'ARS', 'INFORMATIONAL'
       FROM payroll_settlements settlement
       CROSS JOIN generate_series(1, 1001) AS page(number)
      WHERE settlement.user_id = $1 AND settlement.extraction_run_id = $2`,
    [userIdA, manualRunId],
  );
  const conceptLock = await pool.connect();
  await conceptLock.query("BEGIN");
  await conceptLock.query("LOCK TABLE payroll_line_items IN ACCESS EXCLUSIVE MODE");
  const revokedDownload = app.inject({
    method: "GET",
    url: `/api/v1/privacy/exports/${revocableExportId}/download`,
    headers: { cookie: `salarivo_session=${revocableToken}` },
  }).catch(() => undefined);
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await pool.query("SELECT status FROM privacy_operations WHERE id = $1", [revocableExportId]);
      if (status.rows[0]?.status === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [revocableSessionHash]);
  } finally {
    await conceptLock.query("COMMIT").catch(() => undefined);
    conceptLock.release();
  }
  await revokedDownload;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await pool.query("SELECT status FROM privacy_operations WHERE id = $1", [revocableExportId]);
    if (status.rows[0]?.status === "READY") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    (await pool.query("SELECT status FROM privacy_operations WHERE id = $1", [revocableExportId])).rows[0].status,
    "READY",
  );

  const socketExports: Array<{ id: string; token: string; userId: string }> = [
    { id: crypto.randomUUID(), token: deletionReceiptToken(), userId: userIdA },
    { id: crypto.randomUUID(), token: deletionReceiptToken(), userId: userIdB },
    { id: crypto.randomUUID(), token: deletionReceiptToken(), userId: userIdA },
  ];
  for (const item of socketExports) {
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, mfa_verified_at, step_up_expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour', now(), now() + interval '10 minutes')`,
      [crypto.randomUUID(), item.userId, createHash("sha256").update(item.token).digest("hex")],
    );
    await pool.query(
      `INSERT INTO privacy_operations (
         id, user_id, operation_type, idempotency_key, status, output_expires_at
       ) VALUES ($1, $2, 'DATA_EXPORT', $3, 'READY', now() + interval '10 minutes')`,
      [item.id, item.userId, `socket-export:${item.id}`],
    );
  }
  const employerLock = await pool.connect();
  const socketRequests: ReturnType<typeof httpRequest>[] = [];
  const socketStarts: Promise<void>[] = [];
  await employerLock.query("BEGIN");
  await employerLock.query("LOCK TABLE employers IN ACCESS EXCLUSIVE MODE");
  try {
    for (const item of socketExports.slice(0, 2)) {
      let socketRequest!: ReturnType<typeof httpRequest>;
      const started = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("EXPORT_SOCKET_START_TIMEOUT")), 5_000);
        timer.unref();
        const fail = (error: Error) => { clearTimeout(timer); reject(error); };
        socketRequest = httpRequest(
          new URL(`/api/v1/privacy/exports/${item.id}/download`, apiOrigin),
          { headers: { cookie: `salarivo_session=${item.token}` } },
          (response) => {
            response.once("data", () => { clearTimeout(timer); resolve(); });
            response.once("error", fail);
          },
        );
        socketRequest.once("error", fail);
      });
      socketRequest.end();
      socketRequests.push(socketRequest);
      socketStarts.push(started);
    }
    await Promise.all(socketStarts);
    let activeStatuses: string[] = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const active = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM privacy_operations WHERE id = ANY($1::uuid[]) ORDER BY id",
        [socketExports.slice(0, 2).map(({ id }) => id)],
      );
      activeStatuses = active.rows.map(({ status }) => status);
      if (activeStatuses.length === 2 && activeStatuses.every((status) => status === "RUNNING")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(activeStatuses, ["RUNNING", "RUNNING"]);
    for (const socketRequest of socketRequests) socketRequest.destroy();
    const capacityHeldAfterAbort = await app.inject({
      method: "GET",
      url: `/api/v1/privacy/exports/${socketExports[2]!.id}/download`,
      headers: { cookie: `salarivo_session=${socketExports[2]!.token}` },
    });
    const capacityRejection = [capacityHeldAfterAbort.statusCode, capacityHeldAfterAbort.json().error.code];
    assert.ok(
      (capacityRejection[0] === 503 && capacityRejection[1] === "EXPORT_CAPACITY")
      || (capacityRejection[0] === 409 && capacityRejection[1] === "EXPORT_IN_PROGRESS"),
      capacityHeldAfterAbort.body,
    );
  } finally {
    for (const socketRequest of socketRequests) socketRequest.destroy();
    await employerLock.query("COMMIT").catch(() => undefined);
    employerLock.release();
  }
  let releasedStatuses: string[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const released = await pool.query<{ status: string }>(
      "SELECT status FROM privacy_operations WHERE id = ANY($1::uuid[]) ORDER BY id",
      [socketExports.slice(0, 2).map(({ id }) => id)],
    );
    releasedStatuses = released.rows.map(({ status }) => status);
    if (releasedStatuses.length === 2 && releasedStatuses.every((status) => status === "READY")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(releasedStatuses, ["READY", "READY"]);

  await pool.query(
    `INSERT INTO extraction_run_issues (
       id, user_id, document_id, extraction_run_id, code, severity,
       recoverable, affected_field_path, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
       'settlement.basicAmount', '{}'::jsonb)
     ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
    [crypto.randomUUID(), userId, documentId, manualRunId],
  );

  const associatedBeforeMismatchedReprocess = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: employmentA },
  });
  assert.equal(associatedBeforeMismatchedReprocess.statusCode, 200, associatedBeforeMismatchedReprocess.body);
  const projectionBeforeMismatchedReprocess = (await pool.query(
    `SELECT document.active_extraction_run_id, document.detected_employer_id,
            document.processing_status, document.employment_id,
            item.status AS item_status, item.employment_id AS item_employment_id
       FROM documents document
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  )).rows[0];
  const lineageBeforeReprocess = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
       (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
    [documentId],
  )).rows[0];
  const priorCorrectionsSnapshot = (await pool.query(
    `SELECT correction.id, correction.extraction_run_id, correction.field_path,
            correction.correction_version, correction.corrected_value,
            correction.inherited_from_correction_id
       FROM user_corrections correction
       JOIN extraction_runs run ON run.id = correction.extraction_run_id
      WHERE correction.document_id = $1 AND correction.user_id = $2
        AND run.processing_version <= 3
      ORDER BY correction.id`,
    [documentId, userId],
  )).rows;
  const priorSettlementsSnapshot = (await pool.query(
    `SELECT settlement.id, settlement.extraction_run_id,
            to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
            settlement.settlement_type, settlement.gross_amount::text AS gross_amount,
            settlement.net_amount::text AS net_amount,
            settlement.deductions_amount::text AS deductions_amount
       FROM payroll_settlements settlement
       JOIN extraction_runs run ON run.id = settlement.extraction_run_id
      WHERE settlement.document_id = $1 AND settlement.user_id = $2
        AND run.processing_version <= 3
      ORDER BY settlement.id`,
    [documentId, userId],
  )).rows;
  type PriorCorrectionRoot = {
    corrected_value: unknown;
    field_path: string;
    root_created_at: Date;
    root_id: string;
    root_version: number;
  };
  const priorCorrectionRoots = (await pool.query<PriorCorrectionRoot>(
    `SELECT DISTINCT ON (correction.field_path)
            correction.field_path, correction.corrected_value,
            COALESCE(root.id, correction.id) AS root_id,
            COALESCE(root.correction_version, correction.correction_version) AS root_version,
            COALESCE(root.created_at, correction.created_at) AS root_created_at
       FROM user_corrections correction
       JOIN extraction_runs run
         ON run.id = correction.extraction_run_id
        AND run.user_id = correction.user_id
        AND run.document_id = correction.document_id
       LEFT JOIN user_corrections root
         ON root.id = correction.inherited_from_correction_id
        AND root.user_id = correction.user_id
        AND root.document_id = correction.document_id
        AND root.field_path = correction.field_path
      WHERE correction.document_id = $1 AND correction.user_id = $2
        AND run.id = $3
      ORDER BY correction.field_path, run.processing_version DESC,
               correction.correction_version DESC, correction.created_at DESC, correction.id DESC`,
    [documentId, userId, manualRunId],
  )).rows;
  const periodCorrectionRoot = priorCorrectionRoots.find(
    ({ field_path }) => field_path === "settlement.payrollPeriod",
  );
  assert.ok(periodCorrectionRoot);
  const reprocess = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-0001" },
  });
  assert.equal(reprocess.statusCode, 201, reprocess.body);
  assert.equal(reprocess.json().data.processingStatus, "COMPLETED");
  assert.equal(reprocess.json().data.job.state, "PENDING");
  assert.equal(reprocess.json().data.job.processingVersion, 4);
  const reprocessReplay = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-0001" },
  });
  assert.equal(reprocessReplay.statusCode, 200, reprocessReplay.body);
  assert.equal(reprocessReplay.json().data.job.id, reprocess.json().data.job.id);
  assert.equal(reprocessReplay.json().data.job.processingVersion, 4);
  const concurrentReprocess = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-concurrent-0001" },
  });
  assert.equal(concurrentReprocess.statusCode, 409, concurrentReprocess.body);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
         (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
      [documentId],
    )).rows[0],
    lineageBeforeReprocess,
  );
  assert.equal(
    (await pool.query(
      "SELECT count(*)::integer AS count FROM processing_jobs WHERE document_id = $1 AND processing_version = 4",
      [documentId],
    )).rows[0].count,
    1,
  );
  assert.equal(
    (await pool.query(
      "SELECT previous_document_status FROM processing_jobs WHERE id = $1",
      [reprocess.json().data.job.id],
    )).rows[0].previous_document_status,
    "COMPLETED",
  );
  const reprocessLeaseOwner = `integration-reprocess-${crypto.randomUUID()}`;
  const runningReprocess = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [reprocess.json().data.job.id, reprocessLeaseOwner],
  );
  assert.equal(runningReprocess.rowCount, 1);
  const reprocessedExtraction = extractArgentinePayroll([
    "RECIBO DE SUELDO",
    "Empleador: Empresa Distinta En Reproceso SA",
    "Periodo de liquidacion: 08/2026",
    "Sueldo basico $ 1.234.567,89",
    "Presentismo $ 123.456,78",
    "Jubilacion $ 135.802,47",
    "Obra social $ 37.037,04",
    "Total bruto $ 1.358.024,67",
    "Total descuentos $ 172.839,51",
    "Neto a cobrar $ 1.185.185,16",
  ].join("\n"), "PDF_TEXT");
  const reprocessResult = await persistExtraction(
    runningReprocess.rows[0]!,
    {
      confidence: 0.99,
      decision: "SUPPORTED",
      documentType: "PAYROLL",
      signals: ["synthetic_integration"],
    },
    reprocessedExtraction,
    "PDF_TEXT",
    false,
    1,
  );
  assert.equal(reprocessResult, "NEEDS_REVIEW");
  const mismatchState = (await pool.query(
    `SELECT document.employment_id AS document_employment_id,
            document.active_extraction_run_id, document.detected_employer_id, document.processing_status,
            item.employment_id AS item_employment_id,
            ARRAY(
              SELECT DISTINCT settlement.employment_id::text
                FROM payroll_settlements settlement
               WHERE settlement.document_id = document.id
               ORDER BY settlement.employment_id::text
            ) AS settlement_employment_ids
       FROM documents document
       JOIN import_batch_items item ON item.id = document.import_batch_item_id
      WHERE document.id = $1`,
    [documentId],
  )).rows[0];
  assert.equal(String(mismatchState.document_employment_id), employmentA);
  assert.equal(String(mismatchState.item_employment_id), employmentA);
  assert.deepEqual(mismatchState.settlement_employment_ids, [employmentA]);
  assert.equal(mismatchState.processing_status, "COMPLETED");
  assert.equal(String(mismatchState.active_extraction_run_id), manualRunId);
  assert.equal(String(mismatchState.detected_employer_id), String(projectionBeforeMismatchedReprocess.detected_employer_id));
  const mismatchAudit = await pool.query(
    `SELECT metadata_no_sensitive FROM audit_events
      WHERE action = 'EMPLOYMENT_ASSOCIATION_MISMATCH' AND resource_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [documentId],
  );
  for (const row of mismatchAudit.rows) {
    assert.doesNotMatch(JSON.stringify(row.metadata_no_sensitive), /Empresa|sueldo|salary|ocr|gross|net/i);
  }
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [reprocess.json().data.job.id],
  );

  const reprocessedRun = await pool.query<{ id: string; promotion_outcome: string; status: string }>(
    `SELECT id, status, promotion_outcome FROM extraction_runs
      WHERE document_id = $1 AND user_id = $2 AND processing_version = 4`,
    [documentId, userId],
  );
  assert.equal(reprocessedRun.rowCount, 1);
  assert.deepEqual(
    { outcome: reprocessedRun.rows[0]!.promotion_outcome, status: reprocessedRun.rows[0]!.status },
    { outcome: "REVIEW_REQUIRED", status: "REVIEW_REQUIRED" },
  );
  const reprocessedRunId = reprocessedRun.rows[0]!.id;
  const pendingReprocessingReviews = await app.inject({
    method: "GET",
    url: "/api/v1/documents?statusGroup=REVIEW",
    headers: { cookie: cookieA },
  });
  assert.equal(pendingReprocessingReviews.statusCode, 200, pendingReprocessingReviews.body);
  const pendingReprocessingDocument = pendingReprocessingReviews.json().data.items.find(
    (document: { id: string }) => document.id === documentId,
  );
  assert.deepEqual(
    { decisionRequired: pendingReprocessingDocument?.decisionRequired, needsReview: pendingReprocessingDocument?.needsReview },
    { decisionRequired: true, needsReview: true },
  );
  assert.equal(
    pendingReprocessingReviews.json().data.pendingReview,
    pendingReprocessingReviews.json().data.total,
  );
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/api/v1/documents?statusGroup=REVIEW", headers: { cookie: cookieB } })).json().data,
    { items: [], total: 0, pendingReview: 0, nextCursor: null },
  );
  await pool.query(
    "UPDATE extraction_runs SET pipeline_fingerprint = $2 WHERE id = $1",
    [reprocessedRunId, "d".repeat(64)],
  );
  const staleReprocessingReviews = await app.inject({
    method: "GET",
    url: "/api/v1/documents?statusGroup=REVIEW",
    headers: { cookie: cookieA },
  });
  assert.equal(staleReprocessingReviews.statusCode, 200, staleReprocessingReviews.body);
  assert.equal(
    staleReprocessingReviews.json().data.items.some((document: { id: string }) => document.id === documentId),
    false,
  );
  const staleProcessingRuns = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/processing-runs`,
    headers: { cookie: cookieA },
  });
  assert.equal(staleProcessingRuns.statusCode, 200, staleProcessingRuns.body);
  assert.equal(
    staleProcessingRuns.json().data.items.find((run: { id: string }) => run.id === reprocessedRunId)?.decisionRequired,
    false,
  );
  await pool.query(
    "UPDATE extraction_runs SET pipeline_fingerprint = $2 WHERE id = $1",
    [reprocessedRunId, currentPipelineFingerprint],
  );
  const reviewCandidateDetail = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(reviewCandidateDetail.statusCode, 200, reviewCandidateDetail.body);
  assert.equal(reviewCandidateDetail.json().data.decisionRequired, true);
  assert.deepEqual(
    reviewCandidateDetail.json().data.comparisonPreview.fields.find(
      (field: { fieldPath: string }) => field.fieldPath === "employer.name",
    ),
    {
      fieldPath: "employer.name",
      before: "Empresa Sintética SA",
      after: "Empresa Distinta En Reproceso SA",
      change: "CHANGED",
    },
  );
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/processing-runs`,
    headers: { cookie: cookieB },
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}`,
    headers: { cookie: cookieB },
  })).statusCode, 404);
  const decisionRaceOwner = `integration-decision-race-${crypto.randomUUID()}`;
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = $2, updated_at = now() WHERE id = $1",
    [reprocess.json().data.job.id, decisionRaceOwner],
  );
  const blockedCandidateDecision = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}/decision`,
    headers: { origin, cookie: cookieA },
    payload: { decision: "KEEP_ACTIVE", expectedActiveRunId: manualRunId },
  });
  assert.equal(blockedCandidateDecision.statusCode, 409, blockedCandidateDecision.body);
  assert.equal(blockedCandidateDecision.json().error.code, "DOCUMENT_STILL_PROCESSING");
  assert.deepEqual(
    (await pool.query(
      `SELECT document.active_extraction_run_id, candidate.promotion_outcome
         FROM documents document
         JOIN extraction_runs candidate ON candidate.id = $2
        WHERE document.id = $1`,
      [documentId, reprocessedRunId],
    )).rows[0],
    { active_extraction_run_id: manualRunId, promotion_outcome: "REVIEW_REQUIRED" },
  );
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [reprocess.json().data.job.id],
  );
  await pool.query(
    "UPDATE documents SET security_status = 'QUARANTINED', processing_status = 'QUARANTINED' WHERE id = $1",
    [documentId],
  );
  const quarantinedCandidateDecision = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}/decision`,
    headers: { origin, cookie: cookieA },
    payload: { decision: "PROMOTE", expectedActiveRunId: manualRunId },
  });
  assert.equal(quarantinedCandidateDecision.statusCode, 409, quarantinedCandidateDecision.body);
  assert.equal(quarantinedCandidateDecision.json().error.code, "REPROCESS_NOT_ALLOWED");
  await pool.query(
    "UPDATE documents SET security_status = 'CLEAN', processing_status = 'COMPLETED' WHERE id = $1",
    [documentId],
  );
  const staleBaseCorrectionId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO user_corrections (
       id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
       correction_version, extracted_value, corrected_value
     ) VALUES ($1, $2, NULL, $3, $4, 'settlement.basicAmount', 1,
       'null'::jsonb, '{"amount":"999.00","currencyCode":"ARS"}'::jsonb)`,
    [staleBaseCorrectionId, userId, documentId, manualRunId],
  );
  const staleBaseDecision = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}/decision`,
    headers: { origin, cookie: cookieA },
    payload: { decision: "PROMOTE", expectedActiveRunId: manualRunId },
  });
  assert.equal(staleBaseDecision.statusCode, 409, staleBaseDecision.body);
  assert.equal(staleBaseDecision.json().error.code, "RUN_BASE_CHANGED");
  await pool.query("DELETE FROM user_corrections WHERE id = $1", [staleBaseCorrectionId]);
  const promotedCandidateDecision = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/processing-runs/${reprocessedRunId}/decision`,
    headers: { origin, cookie: cookieA },
    payload: { decision: "PROMOTE", expectedActiveRunId: manualRunId },
  });
  assert.equal(promotedCandidateDecision.statusCode, 200, promotedCandidateDecision.body);
  assert.equal(promotedCandidateDecision.json().data.activeRunId, reprocessedRunId);
  assert.deepEqual(
    (await pool.query(
      `SELECT document.active_extraction_run_id, document.processing_status,
              item.status AS item_status, candidate.promotion_outcome
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
         JOIN extraction_runs candidate ON candidate.id = $2
        WHERE document.id = $1`,
      [documentId, reprocessedRunId],
    )).rows[0],
    {
      active_extraction_run_id: reprocessedRunId,
      processing_status: "NEEDS_REVIEW",
      item_status: "NEEDS_REVIEW",
      promotion_outcome: "PROMOTED",
    },
  );
  const historyWhileReviewCandidateActive = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  assert.equal(historyWhileReviewCandidateActive.statusCode, 200, historyWhileReviewCandidateActive.body);
  assert.equal(historyWhileReviewCandidateActive.body.includes("1234567.89"), false);
  const reviewCandidateEmployerId = String((await pool.query(
    "SELECT detected_employer_id FROM extraction_runs WHERE id = $1",
    [reprocessedRunId],
  )).rows[0].detected_employer_id);
  const conceptsWhileReviewCandidateActive = await app.inject({
    method: "GET",
    url: `/api/v1/salary-history/concepts?employmentContext=${encodeURIComponent(`detected:${reviewCandidateEmployerId}`)}&currencyCode=ARS&employerName=${encodeURIComponent("Empresa Distinta En Reproceso SA")}`,
    headers: { cookie: cookieA },
  });
  assert.equal(conceptsWhileReviewCandidateActive.statusCode, 200, conceptsWhileReviewCandidateActive.body);
  assert.deepEqual(conceptsWhileReviewCandidateActive.json().data.items, []);
  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  await grantStepUp(cookieA);
  await pool.query(
    "UPDATE documents SET security_status = 'QUARANTINED', processing_status = 'QUARANTINED' WHERE id = $1",
    [documentId],
  );
  const quarantinedRollback = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${manualRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `QUARANTINE-${suffix}` },
  });
  assert.equal(quarantinedRollback.statusCode, 409, quarantinedRollback.body);
  assert.equal(quarantinedRollback.json().error.code, "REPROCESS_NOT_ALLOWED");
  await pool.query(
    "UPDATE documents SET security_status = 'CLEAN', processing_status = 'NEEDS_REVIEW' WHERE id = $1",
    [documentId],
  );
  const restoreBaselineAfterOwnerDecision = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${manualRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `OWNER-DECISION-${suffix}` },
  });
  assert.equal(
    restoreBaselineAfterOwnerDecision.statusCode,
    200,
    restoreBaselineAfterOwnerDecision.body,
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.active_extraction_run_id, document.processing_status,
              item.status AS item_status
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    {
      active_extraction_run_id: manualRunId,
      processing_status: "COMPLETED",
      item_status: "COMPLETED",
    },
  );
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const inheritedCorrections = (await pool.query<{
    corrected_value: unknown;
    correction_version: number;
    extracted_field_id: string | null;
    field_path: string;
    inherited_from_correction_id: string;
  }>(
    `SELECT correction.field_path, correction.corrected_value,
            correction.correction_version, correction.extracted_field_id,
            correction.inherited_from_correction_id
       FROM user_corrections correction
      WHERE correction.document_id = $1 AND correction.user_id = $2
        AND correction.extraction_run_id = $3
      ORDER BY correction.field_path`,
    [documentId, userId, reprocessedRunId],
  )).rows;
  assert.equal(inheritedCorrections.length, priorCorrectionRoots.length);
  const reprocessedFieldPaths = new Set((await pool.query<{ field_path: string }>(
    "SELECT field_path FROM extracted_fields WHERE extraction_run_id = $1 ORDER BY field_path",
    [reprocessedRunId],
  )).rows.map(({ field_path }) => field_path));
  for (const inherited of inheritedCorrections) {
    const root = priorCorrectionRoots.find(({ field_path }) => field_path === inherited.field_path);
    assert.ok(root);
    assert.equal(inherited.inherited_from_correction_id, root.root_id);
    assert.deepEqual(inherited.corrected_value, root.corrected_value);
    assert.equal(inherited.correction_version, 1);
    assert.equal(inherited.extracted_field_id !== null, reprocessedFieldPaths.has(inherited.field_path));
  }
  assert.deepEqual(
    (await pool.query(
      `SELECT correction.id, correction.extraction_run_id, correction.field_path,
              correction.correction_version, correction.corrected_value,
              correction.inherited_from_correction_id
         FROM user_corrections correction
         JOIN extraction_runs run ON run.id = correction.extraction_run_id
        WHERE correction.document_id = $1 AND correction.user_id = $2
          AND run.processing_version <= 3
        ORDER BY correction.id`,
      [documentId, userId],
    )).rows,
    priorCorrectionsSnapshot,
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT settlement.id, settlement.extraction_run_id,
              to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
              settlement.settlement_type, settlement.gross_amount::text AS gross_amount,
              settlement.net_amount::text AS net_amount,
              settlement.deductions_amount::text AS deductions_amount
         FROM payroll_settlements settlement
         JOIN extraction_runs run ON run.id = settlement.extraction_run_id
        WHERE settlement.document_id = $1 AND settlement.user_id = $2
          AND run.processing_version <= 3
        ORDER BY settlement.id`,
      [documentId, userId],
    )).rows,
    priorSettlementsSnapshot,
  );
  const lineageAfterReprocess = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
       (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
    [documentId],
  )).rows[0];
  assert.deepEqual(lineageAfterReprocess, {
    runs: Number(lineageBeforeReprocess.runs) + 1,
    corrections: Number(lineageBeforeReprocess.corrections) + priorCorrectionRoots.length,
  });
  assert.deepEqual(
    (await pool.query(
      `SELECT to_char(payroll_period, 'YYYY-MM') AS payroll_period, settlement_type,
              gross_amount::text AS gross_amount, net_amount::text AS net_amount,
              deductions_amount::text AS deductions_amount
         FROM payroll_settlements WHERE extraction_run_id = $1`,
      [reprocessedRunId],
    )).rows[0],
    {
      payroll_period: "2026-10",
      settlement_type: "AJUSTE",
      gross_amount: "1000.00",
      net_amount: "820.00",
      deductions_amount: "180.00",
    },
  );
  assert.equal(
    (await pool.query(
      `SELECT sum(item.amount)::text AS total
         FROM payroll_line_items item
         JOIN payroll_settlements settlement ON settlement.id = item.settlement_id
        WHERE settlement.extraction_run_id = $1 AND item.item_type = 'DEDUCTION'`,
      [reprocessedRunId],
    )).rows[0].total,
    "172839.51",
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status, document.security_status, item.status AS item_status
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    { processing_status: "COMPLETED", security_status: "CLEAN", item_status: "COMPLETED" },
  );
  const reprocessedDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.equal(reprocessedDetail.statusCode, 200, reprocessedDetail.body);
  const reprocessedPeriod = reprocessedDetail.json().data.extractedFields.find(
    (field: { fieldPath: string }) => field.fieldPath === "settlement.payrollPeriod",
  );
  assert.equal(reprocessedPeriod.effectiveValue, "2026-10");
  assert.deepEqual(reprocessedPeriod.correction, {
    id: periodCorrectionRoot.root_id,
    version: Number(periodCorrectionRoot.root_version),
    correctedAt: new Date(periodCorrectionRoot.root_created_at).toISOString(),
  });

  await pool.query(
    `UPDATE extraction_runs SET pipeline_fingerprint = $2, parser_version = '5' WHERE id = $1`,
    [reprocessedRunId, "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO user_corrections (
       id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
       correction_version, extracted_value, corrected_value, inherited_from_correction_id
     )
     SELECT $1, correction.user_id, NULL, correction.document_id, $2,
            correction.field_path, 1, 'null'::jsonb, correction.corrected_value,
            COALESCE(correction.inherited_from_correction_id, correction.id)
       FROM user_corrections AS correction
      WHERE correction.user_id = $3 AND correction.document_id = $4
        AND correction.field_path = 'employer.name'
      ORDER BY correction.created_at DESC, correction.id DESC
      LIMIT 1`,
    [crypto.randomUUID(), manualRunId, userId, documentId],
  );

  const normalBaselineCorrection = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/corrections`,
    headers: { origin, cookie: cookieA },
    payload: {
      extractedFieldId: manualTypeFieldId,
      extractionRunId: manualRunId,
      correctedValue: "NORMAL",
    },
  });
  assert.equal(normalBaselineCorrection.statusCode, 201, normalBaselineCorrection.body);
  const completeNormalBaselineReview = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/review-complete`,
    headers: { origin, cookie: cookieA },
    payload: { acceptDeductionsMismatch: true, extractionRunId: manualRunId },
  });
  assert.equal(completeNormalBaselineReview.statusCode, 200, completeNormalBaselineReview.body);
  assert.deepEqual(
    (await pool.query(
      `SELECT settlement_type, basic_amount::text AS basic_amount
         FROM payroll_settlements
        WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3
          AND settlement_ordinal = 1`,
      [userId, documentId, manualRunId],
    )).rows[0],
    { settlement_type: "NORMAL", basic_amount: null },
  );
  const historyBeforeBasicRecovery = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  assert.equal(historyBeforeBasicRecovery.statusCode, 200, historyBeforeBasicRecovery.body);
  const arsScopeBeforeBasicRecovery = historyBeforeBasicRecovery.json().data.analytics.scopes.find(
    (scope: { currencyCode: string; current: { comparableSalary: string | null } | null }) =>
      scope.currencyCode === "ARS" && scope.current !== null,
  );
  assert.ok(arsScopeBeforeBasicRecovery);
  assert.equal(arsScopeBeforeBasicRecovery.current.comparableSalary, null);
  assert.equal(historyBeforeBasicRecovery.body.includes("1234567.89"), false);

  const disassociateBeforeImprovedReprocess = await app.inject({
    method: "PATCH",
    url: "/api/v1/documents/employment",
    headers: { origin, cookie: cookieA },
    payload: { documentIds: [documentId], employmentId: null },
  });
  assert.equal(
    disassociateBeforeImprovedReprocess.statusCode,
    200,
    disassociateBeforeImprovedReprocess.body,
  );
  await pool.query(
    `DELETE FROM payroll_line_items
      WHERE settlement_id = (
        SELECT id FROM payroll_settlements
         WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3
           AND settlement_ordinal = 1
      )`,
    [userId, documentId, manualRunId],
  );
  await pool.query(
    `INSERT INTO payroll_line_items (
       id, user_id, settlement_id, item_ordinal, raw_description,
       normalized_concept_code, amount, currency_code, item_type,
       is_recurring, confidence, source_field
     )
     SELECT input.id, $1, settlement.id, input.item_ordinal, input.raw_description,
            input.normalized_concept_code, input.amount, 'ARS', input.item_type,
            input.is_recurring, 0.84, input.source_field
       FROM payroll_settlements settlement
       CROSS JOIN (VALUES
         (gen_random_uuid(), 1, 'Sueldo basico', 'BASIC_SALARY', 1000.00::numeric, 'EARNING', true, 'BASIC_SALARY'),
         (gen_random_uuid(), 2, 'Deducción', NULL, 110.00::numeric, 'DEDUCTION', NULL, NULL),
         (gen_random_uuid(), 3, 'Deducción', NULL, 50.00::numeric, 'DEDUCTION', NULL, NULL),
         (gen_random_uuid(), 4, 'Deducción', NULL, 20.00::numeric, 'DEDUCTION', NULL, NULL)
       ) AS input(id, item_ordinal, raw_description, normalized_concept_code, amount, item_type, is_recurring, source_field)
      WHERE settlement.user_id = $1 AND settlement.document_id = $2
        AND settlement.extraction_run_id = $3 AND settlement.settlement_ordinal = 1`,
    [userId, documentId, manualRunId],
  );

  const reviewReprocess = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-review-0002" },
  });
  assert.equal(reviewReprocess.statusCode, 201, reviewReprocess.body);
  assert.equal(reviewReprocess.json().data.job.processingVersion, 5);
  const reviewLeaseOwner = `integration-reprocess-review-${crypto.randomUUID()}`;
  const runningReviewReprocess = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [reviewReprocess.json().data.job.id, reviewLeaseOwner],
  );
  assert.equal(runningReviewReprocess.rows[0]!.previous_document_status, "COMPLETED");
  const balancedReviewExtraction = extractArgentinePayroll([
    "RECIBO DE SUELDO",
    "Empleador: Empresa Sintetica SA",
    "Periodo de liquidacion: 08/2026",
    "Sueldo basico $ 1.000,00",
    "Jubilacion $ 110,00",
    "Obra social $ 50,00",
    "Sindicato $ 20,00",
    "Total bruto $ 1.000,00",
    "Total descuentos $ 180,00",
    "Neto a cobrar $ 820,00",
  ].join("\n"), "PDF_TEXT");
  const reviewReprocessResult = await persistExtraction(
    runningReviewReprocess.rows[0]!,
    {
      confidence: 0.99,
      decision: "SUPPORTED",
      documentType: "PAYROLL",
      signals: ["synthetic_integration"],
    },
    balancedReviewExtraction,
    "PDF_TEXT",
    false,
    1,
  );
  assert.equal(reviewReprocessResult, "COMPLETED");
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [reviewReprocess.json().data.job.id],
  );
  const reviewReprocessedRun = await pool.query<{ id: string; promotion_outcome: string }>(
    `SELECT id, promotion_outcome FROM extraction_runs
      WHERE document_id = $1 AND user_id = $2 AND processing_version = 5
        AND status = 'COMPLETED_WITH_WARNINGS'`,
    [documentId, userId],
  );
  assert.equal(reviewReprocessedRun.rowCount, 1);
  const reviewReprocessedRunId = reviewReprocessedRun.rows[0]!.id;
  assert.equal(reviewReprocessedRun.rows[0]!.promotion_outcome, "PROMOTED");
  assert.equal(
    String((await pool.query("SELECT active_extraction_run_id FROM documents WHERE id = $1", [documentId])).rows[0].active_extraction_run_id),
    reviewReprocessedRunId,
  );
  assert.equal(
    (await pool.query(
      `SELECT sum(item.amount)::text AS total
         FROM payroll_line_items item
         JOIN payroll_settlements settlement ON settlement.id = item.settlement_id
        WHERE settlement.extraction_run_id = $1 AND item.item_type = 'DEDUCTION'`,
      [reviewReprocessedRunId],
    )).rows[0].total,
    "180.00",
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status, document.security_status, item.status AS item_status
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    { processing_status: "COMPLETED", security_status: "CLEAN", item_status: "COMPLETED" },
  );
  const historyAfterBasicRecovery = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  assert.equal(historyAfterBasicRecovery.statusCode, 200, historyAfterBasicRecovery.body);
  const arsScopeAfterBasicRecovery = historyAfterBasicRecovery.json().data.analytics.scopes.find(
    (scope: { currencyCode: string; current: { comparableSalary: string | null } | null }) =>
      scope.currencyCode === "ARS" && scope.current !== null,
  );
  assert.ok(arsScopeAfterBasicRecovery);
  assert.equal(arsScopeAfterBasicRecovery.current.comparableSalary, "1000.00");
  assert.equal(historyAfterBasicRecovery.body.includes("1234567.89"), false);
  const candidatesAfterBasicRecovery = await app.inject({
    method: "GET",
    url: "/api/v1/reprocessing/candidates",
    headers: { cookie: cookieA },
  });
  assert.equal(candidatesAfterBasicRecovery.statusCode, 200, candidatesAfterBasicRecovery.body);
  assert.equal(
    candidatesAfterBasicRecovery.json().data.items.some(
      (candidate: { documentId: string }) => candidate.documentId === documentId,
    ),
    false,
  );
  const unavailableAfterBasicRecovery = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-current-pipeline" },
  });
  assert.equal(unavailableAfterBasicRecovery.statusCode, 409, unavailableAfterBasicRecovery.body);
  assert.equal(unavailableAfterBasicRecovery.json().error.code, "REPROCESS_NOT_AVAILABLE");
  const pipelineBeforeSemverProbe = (await pool.query(
    "SELECT parser_version, pipeline_fingerprint FROM extraction_runs WHERE id = $1",
    [reviewReprocessedRunId],
  )).rows[0];
  await pool.query(
    `INSERT INTO extraction_run_issues (
       id, user_id, document_id, extraction_run_id, code, severity,
       recoverable, affected_field_path, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
       'settlement.basicAmount', '{}'::jsonb)
     ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
    [crypto.randomUUID(), userId, documentId, reviewReprocessedRunId],
  );
  await pool.query(
    "UPDATE extraction_runs SET parser_version = $2, pipeline_fingerprint = $3 WHERE id = $1",
    [reviewReprocessedRunId, processingPipelineVersions.parser, "e".repeat(64)],
  );
  const currentParserCandidates = await app.inject({
    method: "GET",
    url: "/api/v1/reprocessing/candidates",
    headers: { cookie: cookieA },
  });
  assert.equal(currentParserCandidates.statusCode, 200, currentParserCandidates.body);
  assert.equal(
    currentParserCandidates.json().data.items.some(
      (candidate: { documentId: string }) => candidate.documentId === documentId,
    ),
    false,
  );
  await pool.query(
    "UPDATE extraction_runs SET parser_version = $2, pipeline_fingerprint = $3 WHERE id = $1",
    [reviewReprocessedRunId, `${processingPipelineVersions.parser}.1.0`, "f".repeat(64)],
  );
  const textualVersionCandidates = await app.inject({
    method: "GET",
    url: "/api/v1/reprocessing/candidates",
    headers: { cookie: cookieA },
  });
  assert.equal(textualVersionCandidates.statusCode, 200, textualVersionCandidates.body);
  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'OPERATIONS', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const processingHealth = await app.inject({
    method: "GET",
    url: "/api/v1/admin/processing/health?page=1&pageSize=1",
    headers: { cookie: cookieA },
  });
  assert.equal(processingHealth.statusCode, 200, processingHealth.body);
  assert.equal(processingHealth.json().data.versions.pageSize, 1);
  assert.equal(processingHealth.json().data.issues.pageSize, 1);
  assert.ok(processingHealth.json().data.versions.items.length <= 1);
  assert.ok(processingHealth.json().data.issues.items.length <= 1);
  assert.doesNotMatch(processingHealth.body, /1000\.00|1234567\.89|Empresa|recibo-sintetico/i);
  await pool.query(
    "UPDATE extraction_runs SET parser_version = $2, pipeline_fingerprint = $3 WHERE id = $1",
    [reviewReprocessedRunId, pipelineBeforeSemverProbe.parser_version, pipelineBeforeSemverProbe.pipeline_fingerprint],
  );
  const operationsRollbackDenied = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${manualRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `ROLLBACK-${suffix}` },
  });
  assert.equal(operationsRollbackDenied.statusCode, 403, operationsRollbackDenied.body);
  assert.equal(operationsRollbackDenied.json().error.code, "ADMIN_PERMISSION_REQUIRED");
  await pool.query(
    "UPDATE users SET admin_role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  await pool.query(
    "UPDATE sessions SET step_up_expires_at = NULL WHERE token_hash = $1",
    [tokenHash(cookieA.split("=", 2)[1]!)],
  );
  const rollbackWithoutStepUp = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${manualRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `ROLLBACK-${suffix}` },
  });
  assert.equal(rollbackWithoutStepUp.statusCode, 403, rollbackWithoutStepUp.body);
  assert.equal(rollbackWithoutStepUp.json().error.code, "STEP_UP_REQUIRED");
  await grantStepUp(cookieA);
  const rollbackToMissingBasic = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${manualRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `ROLLBACK-${suffix}` },
  });
  assert.equal(rollbackToMissingBasic.statusCode, 200, rollbackToMissingBasic.body);
  assert.deepEqual(
    (await pool.query(
      `SELECT document.active_extraction_run_id, document.processing_status,
              document.classification_confidence::text, document.detected_employer_id,
              item.status AS item_status, item.error_code AS item_error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    {
      active_extraction_run_id: manualRunId,
      processing_status: "COMPLETED",
      classification_confidence: "0.7000",
      detected_employer_id: null,
      item_status: "COMPLETED",
      item_error_code: null,
    },
  );
  const historyAfterRollback = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  const rollbackArsScope = historyAfterRollback.json().data.analytics.scopes.find(
    (scope: { currencyCode: string; current: { comparableSalary: string | null } | null }) =>
      scope.currencyCode === "ARS" && scope.current !== null,
  );
  assert.ok(rollbackArsScope);
  assert.equal(rollbackArsScope.current.comparableSalary, null);
  const candidatesAfterRollback = await app.inject({
    method: "GET",
    url: "/api/v1/reprocessing/candidates",
    headers: { cookie: cookieA },
  });
  assert.equal(candidatesAfterRollback.statusCode, 200, candidatesAfterRollback.body);
  assert.ok(
    !candidatesAfterRollback.json().data.items.some(
      (candidate: { documentId: string }) => candidate.documentId === documentId,
    ),
    "a rollback must not reoffer the exact pipeline result that was already evaluated",
  );
  const rollbackToImprovedRun = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/processing-runs/${reviewReprocessedRunId}/rollback`,
    headers: { origin, cookie: cookieA },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `RESTORE-${suffix}` },
  });
  assert.equal(rollbackToImprovedRun.statusCode, 200, rollbackToImprovedRun.body);
  const improvedRunProjection = (await pool.query(
    `SELECT detected_employer_id, confidence::text FROM extraction_runs WHERE id = $1`,
    [reviewReprocessedRunId],
  )).rows[0];
  assert.deepEqual(
    (await pool.query(
      `SELECT document.active_extraction_run_id, document.processing_status,
              document.classification_confidence::text, document.detected_employer_id,
              item.status AS item_status, item.error_code AS item_error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    {
      active_extraction_run_id: reviewReprocessedRunId,
      processing_status: "COMPLETED",
      classification_confidence: improvedRunProjection.confidence,
      detected_employer_id: improvedRunProjection.detected_employer_id,
      item_status: "COMPLETED",
      item_error_code: null,
    },
  );
  const historyAfterRollbackRestore = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  const restoredArsScope = historyAfterRollbackRestore.json().data.analytics.scopes.find(
    (scope: { currencyCode: string; current: { comparableSalary: string | null } | null }) =>
      scope.currencyCode === "ARS" && scope.current !== null,
  );
  assert.ok(restoredArsScope);
  assert.equal(restoredArsScope.current.comparableSalary, "1000.00");
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count FROM admin_audit_events
        WHERE actor_user_id = $1 AND action = 'PROCESSING_RUN_ROLLED_BACK'
          AND result = 'SUCCESS' AND reason_code = 'OPERATIONAL_RECOVERY'`,
      [userIdA],
    )).rows[0].count,
    3,
  );
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const reinheritedRoots = (await pool.query<{ field_path: string; inherited_from_correction_id: string }>(
    `SELECT field_path, inherited_from_correction_id
       FROM user_corrections
      WHERE extraction_run_id = $1
      ORDER BY field_path`,
    [reviewReprocessedRunId],
  )).rows;
  assert.equal(reinheritedRoots.length, priorCorrectionRoots.length + 1);
  for (const inherited of reinheritedRoots) {
    const priorRoot = priorCorrectionRoots.find(({ field_path }) => field_path === inherited.field_path);
    if (inherited.field_path === "settlement.type") {
      assert.equal(inherited.inherited_from_correction_id, normalBaselineCorrection.json().data.id);
    } else if (priorRoot) assert.equal(inherited.inherited_from_correction_id, priorRoot.root_id);
    else {
      assert.equal(inherited.field_path, "employer.name");
      assert.ok(inherited.inherited_from_correction_id);
    }
  }
  const reviewReprocessedDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  const reviewReprocessedPeriod = reviewReprocessedDetail.json().data.extractedFields.find(
    (field: { fieldPath: string }) => field.fieldPath === "settlement.payrollPeriod",
  );
  assert.deepEqual(reviewReprocessedPeriod.correction, {
    id: periodCorrectionRoot.root_id,
    version: Number(periodCorrectionRoot.root_version),
    correctedAt: new Date(periodCorrectionRoot.root_created_at).toISOString(),
  });
  const lineageAfterReviewReprocess = (await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
       (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
    [documentId],
  )).rows[0];
  assert.deepEqual(lineageAfterReviewReprocess, {
    runs: Number(lineageAfterReprocess.runs) + 1,
    corrections: Number(lineageAfterReprocess.corrections) + priorCorrectionRoots.length + 3,
  });

  await pool.query(
    `UPDATE extraction_runs SET pipeline_fingerprint = $2, parser_version = '5' WHERE id = $1`,
    [reviewReprocessedRunId, "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO extraction_run_issues (
       id, user_id, document_id, extraction_run_id, code, severity,
       recoverable, affected_field_path, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
       'settlement.basicAmount', '{}'::jsonb)
     ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
    [crypto.randomUUID(), userId, documentId, reviewReprocessedRunId],
  );

  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'OPERATIONS', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  await grantStepUp(cookieA);
  const failedReprocess = await app.inject({
    method: "POST",
    url: `/api/v1/admin/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-failure-0002" },
    payload: { reasonCode: "OPERATIONAL_RECOVERY", reference: `REPROCESS-${suffix}` },
  });
  assert.equal(failedReprocess.statusCode, 201, failedReprocess.body);
  assert.equal(failedReprocess.json().data.job.processingVersion, 6);
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );
  const projectionBeforeFailedReprocess = (await pool.query(
    `SELECT classification_status, document_type, classification_confidence::text,
            active_extraction_run_id AS extraction_run_id
       FROM documents document WHERE id = $1`,
    [documentId],
  )).rows[0];
  const failedLeaseOwner = `integration-reprocess-failure-${crypto.randomUUID()}`;
  const runningFailedReprocess = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = max_attempts, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [failedReprocess.json().data.job.id, failedLeaseOwner],
  );
  assert.equal(runningFailedReprocess.rows[0]!.previous_document_status, "COMPLETED");
  await setDocumentStage(runningFailedReprocess.rows[0]!, "TEXT_EXTRACTION", {
    classification_status: "SUPPORTED",
    document_type: "PAYROLL",
    classification_confidence: 0.01,
  });
  await failJob(runningFailedReprocess.rows[0]!, new Error("synthetic post-classification failure"));
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [failedReprocess.json().data.job.id],
  );
  assert.deepEqual(
    (await pool.query(
      "SELECT state, error_code, previous_document_status FROM processing_jobs WHERE id = $1",
      [failedReprocess.json().data.job.id],
    )).rows[0],
    { state: "FAILED", error_code: "WORKER_INTERNAL_ERROR", previous_document_status: "COMPLETED" },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status, document.security_status, item.status AS item_status,
              item.error_code AS item_error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    {
      processing_status: "COMPLETED",
      security_status: "CLEAN",
      item_status: "COMPLETED",
      item_error_code: null,
    },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
         (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
      [documentId],
    )).rows[0],
    {
      runs: Number(lineageAfterReviewReprocess.runs) + 1,
      corrections: Number(lineageAfterReviewReprocess.corrections),
    },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT run.status, run.error_code, issue.code, issue.severity, issue.recoverable
         FROM extraction_runs run
         JOIN extraction_run_issues issue ON issue.extraction_run_id = run.id
        WHERE run.document_id = $1 AND run.processing_version = 6`,
      [documentId],
    )).rows[0],
    {
      status: "FAILED",
      error_code: "WORKER_INTERNAL_ERROR",
      code: "WORKER_INTERNAL_ERROR",
      severity: "ERROR",
      recoverable: true,
    },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT classification_status, document_type, classification_confidence::text,
              active_extraction_run_id AS extraction_run_id
         FROM documents document WHERE id = $1`,
      [documentId],
    )).rows[0],
    projectionBeforeFailedReprocess,
  );
  const failedReprocessDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.equal(failedReprocessDetail.statusCode, 200, failedReprocessDetail.body);
  assert.equal(failedReprocessDetail.json().data.lastReprocessError.code, "WORKER_INTERNAL_ERROR");
  assert.equal(failedReprocessDetail.json().data.lastReprocessError.processingVersion, 6);
  assert.match(failedReprocessDetail.json().data.lastReprocessError.failedAt, /^\d{4}-\d{2}-\d{2}T/);
  const failedEvaluationAudit = (await pool.query(
    `SELECT result, metadata_no_sensitive
       FROM audit_events
      WHERE action = 'EXTRACTION_RUN_EVALUATED' AND resource_type = 'EXTRACTION_RUN'
        AND resource_id = (
          SELECT id FROM extraction_runs
           WHERE user_id = $1 AND document_id = $2 AND processing_version = 6
        )`,
    [userId, documentId],
  )).rows[0];
  assert.equal(failedEvaluationAudit.result, "FAILED");
  assert.deepEqual(
    {
      activeRunAfterId: failedEvaluationAudit.metadata_no_sensitive.activeRunAfterId,
      activeRunBeforeId: failedEvaluationAudit.metadata_no_sensitive.activeRunBeforeId,
      outcome: failedEvaluationAudit.metadata_no_sensitive.outcome,
      processingVersion: failedEvaluationAudit.metadata_no_sensitive.processingVersion,
      reason: failedEvaluationAudit.metadata_no_sensitive.reason,
      triggerKind: failedEvaluationAudit.metadata_no_sensitive.triggerKind,
    },
    {
      activeRunAfterId: reviewReprocessedRunId,
      activeRunBeforeId: reviewReprocessedRunId,
      outcome: "FAILED",
      processingVersion: 6,
      reason: "WORKER_INTERNAL_ERROR",
      triggerKind: "ADMIN_REPROCESS",
    },
  );
  assert.doesNotMatch(JSON.stringify(failedEvaluationAudit.metadata_no_sensitive), /salary|sueldo|gross|net|ocr|Empresa/i);

  const retryRecoveryDocumentId = listFixtures[2]!.id;
  await pool.query(
    `UPDATE documents
        SET active_extraction_run_id = NULL, employment_id = NULL,
            detected_employer_id = NULL, processing_status = 'FAILED_PERMANENT',
            security_status = 'CLEAN', classification_status = 'SUPPORTED',
            document_type = 'PAYROLL', original_deleted_at = NULL
      WHERE id = $1 AND user_id = $2`,
    [retryRecoveryDocumentId, userId],
  );
  await pool.query(
    `UPDATE import_batch_items
        SET employment_id = NULL, status = 'FAILED', error_code = 'WORKER_INTERNAL_ERROR', updated_at = now()
      WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
    [retryRecoveryDocumentId, userId],
  );
  const retryRecoveryDetail = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${retryRecoveryDocumentId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(retryRecoveryDetail.statusCode, 200, retryRecoveryDetail.body);
  assert.equal(retryRecoveryDetail.json().data.analysis.reprocess.retryAvailable, true);
  const retryRecoveryWithoutFlag = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${retryRecoveryDocumentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-retry-without-flag" },
  });
  assert.equal(retryRecoveryWithoutFlag.statusCode, 409, retryRecoveryWithoutFlag.body);
  assert.equal(retryRecoveryWithoutFlag.json().error.code, "REPROCESS_NOT_AVAILABLE");
  const retryRecovery = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${retryRecoveryDocumentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-retry-with-explicit-flag" },
    payload: { retry: true },
  });
  assert.equal(retryRecovery.statusCode, 201, retryRecovery.body);
  assert.equal(retryRecovery.json().data.job.processingVersion, 1);
  assert.deepEqual(
    (await pool.query(
      `SELECT trigger_kind, base_extraction_run_id FROM processing_jobs WHERE id = $1`,
      [retryRecovery.json().data.job.id],
    )).rows[0],
    { trigger_kind: "USER_REPROCESS", base_extraction_run_id: null },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status, item.status AS item_status, item.error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [retryRecoveryDocumentId],
    )).rows[0],
    {
      processing_status: "FAILED_PERMANENT",
      item_status: "FAILED",
      error_code: "WORKER_INTERNAL_ERROR",
    },
  );
  const retryRecoveryOwner = `integration-retry-recovery-${crypto.randomUUID()}`;
  const firstRetryRecoveryAttempt = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [retryRecovery.json().data.job.id, retryRecoveryOwner],
  );
  await failJob(
    firstRetryRecoveryAttempt.rows[0]!,
    new WorkerError("STORAGE_TEMPORARILY_UNAVAILABLE", true),
  );
  const transientRetryRun = (await pool.query<{ id: string }>(
    `SELECT run.id
       FROM extraction_runs run
       JOIN extraction_run_issues issue
         ON issue.user_id = run.user_id AND issue.document_id = run.document_id
        AND issue.extraction_run_id = run.id
      WHERE run.document_id = $1 AND run.processing_version = 1
        AND run.status = 'FAILED' AND issue.code = 'STORAGE_TEMPORARILY_UNAVAILABLE'`,
    [retryRecoveryDocumentId],
  )).rows[0];
  assert.ok(transientRetryRun);
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [retryRecovery.json().data.job.id],
  );
  const secondRetryRecoveryOwner = `integration-retry-recovery-2-${crypto.randomUUID()}`;
  const runningRetryRecovery = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            available_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'RETRYABLE'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [retryRecovery.json().data.job.id, secondRetryRecoveryOwner],
  );
  assert.equal(runningRetryRecovery.rows[0]!.attempt, 2);
  assert.equal(await persistExtraction(
    runningRetryRecovery.rows[0]!,
    {
      confidence: 0.99,
      decision: "SUPPORTED",
      documentType: "PAYROLL",
      signals: ["synthetic_retry_recovery"],
    },
    balancedReviewExtraction,
    "PDF_TEXT",
    false,
    1,
  ), "COMPLETED");
  assert.deepEqual(
    (await pool.query(
      `SELECT run.id, run.status, run.error_code,
              count(issue.id) FILTER (WHERE issue.code = 'STORAGE_TEMPORARILY_UNAVAILABLE')::integer AS stale_issues
         FROM extraction_runs run
         LEFT JOIN extraction_run_issues issue
           ON issue.user_id = run.user_id AND issue.document_id = run.document_id
          AND issue.extraction_run_id = run.id
        WHERE run.document_id = $1 AND run.processing_version = 1
        GROUP BY run.id`,
      [retryRecoveryDocumentId],
    )).rows[0],
    {
      id: transientRetryRun.id,
      status: "COMPLETED_WITH_WARNINGS",
      error_code: null,
      stale_issues: 0,
    },
  );
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [retryRecovery.json().data.job.id],
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status,
              document.active_extraction_run_id IS NOT NULL AS has_active_run,
              item.status AS item_status, item.error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [retryRecoveryDocumentId],
    )).rows[0],
    {
      processing_status: "COMPLETED",
      has_active_run: true,
      item_status: "COMPLETED",
      error_code: null,
    },
  );

  const preferredBatchEmployerId = crypto.randomUUID();
  const homonymBatchEmployerId = crypto.randomUUID();
  const preferredBatchEmploymentId = crypto.randomUUID();
  const preferredBatchEmployerName = "Empresa Preferida Sintética SA";
  await pool.query(
    `INSERT INTO employers (id, created_by_user_id, name, country_code, status, created_source)
     VALUES ($1, $3, $5, 'AR', 'PENDING', 'MANUAL'),
            ($2, $4, $5, 'AR', 'PENDING', 'MANUAL')`,
    [preferredBatchEmployerId, homonymBatchEmployerId, userId, userIdB, preferredBatchEmployerName],
  );
  await pool.query(
    `INSERT INTO employments (
       id, user_id, employer_id, status, start_date, country_code, currency_code
     ) VALUES ($1, $2, $3, 'ACTIVE', '2026-01-01', 'AR', 'ARS')`,
    [preferredBatchEmploymentId, userId, preferredBatchEmployerId],
  );
  const preferredBatchExtraction = {
    ...balancedReviewExtraction,
    employerName: preferredBatchEmployerName,
    fields: balancedReviewExtraction.fields.map((field) => field.fieldPath === "employer.name"
      ? { ...field, interpretedValue: preferredBatchEmployerName, rawValue: preferredBatchEmployerName }
      : field),
  };
  const batchFixtureIds = [listFixtures[0]!.id, listFixtures[3]!.id];
  const batchBaselineRunIds = new Map<string, string>();
  for (const [index, batchDocumentId] of batchFixtureIds.entries()) {
    const baselineRunId = crypto.randomUUID();
    batchBaselineRunIds.set(batchDocumentId, baselineRunId);
    await pool.query(
      `INSERT INTO extraction_runs (
         id, user_id, document_id, processing_version, status,
         classifier_name, classifier_version, extractor_name, extractor_version,
         parser_version, normalizer_version, result_schema_version,
         pipeline_fingerprint, trigger_kind, promotion_outcome, promoted_at,
         finished_at, confidence
       ) VALUES ($1, $2, $3, 1, 'COMPLETED_WITH_WARNINGS',
         'heuristic-ar-payroll', '6', 'deterministic-ar-payroll', '6',
         '5', '6', '1', $4, 'INITIAL_UPLOAD', 'PROMOTED', now(), now(), 0.7)`,
      [baselineRunId, userId, batchDocumentId, `${index + 4}`.repeat(64)],
    );
    await pool.query(
      `INSERT INTO extraction_run_issues (
         id, user_id, document_id, extraction_run_id, code, severity,
         recoverable, affected_field_path, metadata_no_sensitive
       ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
         'settlement.basicAmount', '{}'::jsonb)`,
      [crypto.randomUUID(), userId, batchDocumentId, baselineRunId],
    );
    await pool.query(
      `UPDATE documents
          SET active_extraction_run_id = $1, employment_id = $4,
              detected_employer_id = $5, processing_status = 'COMPLETED',
              security_status = 'CLEAN', classification_status = 'SUPPORTED',
              document_type = 'PAYROLL', classification_confidence = 0.7
        WHERE id = $2 AND user_id = $3`,
      [
        baselineRunId,
        batchDocumentId,
        userId,
        index === 0 ? preferredBatchEmploymentId : null,
        index === 0 ? preferredBatchEmployerId : null,
      ],
    );
    await pool.query(
      `UPDATE import_batch_items
          SET employment_id = $3, status = 'COMPLETED', error_code = NULL, updated_at = now()
        WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
      [batchDocumentId, userId, index === 0 ? preferredBatchEmploymentId : null],
    );
  }
  await pool.query(
    "UPDATE users SET role = 'ADMIN', admin_role = 'OPERATIONS', updated_at = now() WHERE id = $1",
    [userIdA],
  );
  await pool.query(
    "UPDATE sessions SET step_up_expires_at = NULL WHERE token_hash = $1",
    [tokenHash(cookieA.split("=", 2)[1]!)],
  );
  const adminBatchWithoutStepUp = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reprocessing-batches",
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-batch-partial-0001" },
    payload: {
      userId,
      documentIds: batchFixtureIds,
      reasonCode: "OPERATIONAL_RECOVERY",
      reference: `BATCH-${suffix}`,
    },
  });
  assert.equal(adminBatchWithoutStepUp.statusCode, 403, adminBatchWithoutStepUp.body);
  assert.equal(adminBatchWithoutStepUp.json().error.code, "STEP_UP_REQUIRED");
  await grantStepUp(cookieA);
  const reprocessingBatch = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reprocessing-batches",
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-batch-partial-0001" },
    payload: {
      userId,
      documentIds: batchFixtureIds,
      reasonCode: "OPERATIONAL_RECOVERY",
      reference: `BATCH-${suffix}`,
    },
  });
  assert.equal(reprocessingBatch.statusCode, 201, reprocessingBatch.body);
  assert.equal(reprocessingBatch.json().data.progress.total, 2);
  const reprocessingBatchId = String(reprocessingBatch.json().data.id);
  const replayedReprocessingBatch = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reprocessing-batches",
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-batch-partial-0001" },
    payload: {
      userId,
      documentIds: batchFixtureIds,
      reasonCode: "OPERATIONAL_RECOVERY",
      reference: `BATCH-${suffix}`,
    },
  });
  assert.equal(replayedReprocessingBatch.statusCode, 200, replayedReprocessingBatch.body);
  assert.equal(replayedReprocessingBatch.json().data.id, reprocessingBatchId);
  const conflictingReprocessingBatch = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reprocessing-batches",
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-batch-partial-0002" },
    payload: {
      userId,
      documentIds: batchFixtureIds,
      reasonCode: "OPERATIONAL_RECOVERY",
      reference: `BATCH-CONFLICT-${suffix}`,
    },
  });
  assert.equal(conflictingReprocessingBatch.statusCode, 409, conflictingReprocessingBatch.body);
  assert.equal(conflictingReprocessingBatch.json().error.code, "REPROCESSING_BATCH_ALREADY_ACTIVE");
  const activeAdminBatch = await app.inject({
    method: "GET",
    url: `/api/v1/admin/reprocessing-batches/active?userId=${userId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(activeAdminBatch.statusCode, 200, activeAdminBatch.body);
  assert.equal(activeAdminBatch.json().data.id, reprocessingBatchId);
  assert.equal(activeAdminBatch.json().data.progress.total, 2);
  assert.doesNotMatch(activeAdminBatch.body, /Empresa|recibo|1000\.00|1234567\.89/i);
  const adminBatchView = await app.inject({
    method: "GET",
    url: `/api/v1/admin/reprocessing-batches/${reprocessingBatchId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(adminBatchView.statusCode, 200, adminBatchView.body);
  assert.equal(adminBatchView.json().data.progress.total, 2);
  assert.doesNotMatch(adminBatchView.body, /Empresa|recibo|1000\.00|1234567\.89/i);
  assert.equal(
    (await pool.query(
      `SELECT count(*)::integer AS count FROM admin_audit_events
        WHERE actor_user_id = $1 AND action = 'REPROCESSING_BATCH_REQUESTED'
          AND resource_id = $2 AND result = 'SUCCESS'`,
      [userIdA, reprocessingBatchId],
    )).rows[0].count,
    1,
  );
  await pool.query(
    "UPDATE users SET role = 'USER', admin_role = NULL, updated_at = now() WHERE id = $1",
    [userIdA],
  );
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/admin/reprocessing-batches/active?userId=${userId}`,
    headers: { cookie: cookieA },
  })).statusCode, 403);
  assert.equal((await app.inject({
    method: "GET",
    url: `/api/v1/reprocessing-batches/${reprocessingBatchId}`,
    headers: { cookie: cookieB },
  })).statusCode, 404);
  const batchJobs = await pool.query<IntegrationJobRow>(
    `SELECT id, user_id, document_id, processing_version, stage, attempt, max_attempts,
            ''::text AS lease_owner, previous_document_status, trigger_kind,
            requested_by_user_id, base_extraction_run_id, reprocessing_batch_id,
            pipeline_fingerprint
       FROM processing_jobs
      WHERE user_id = $1 AND reprocessing_batch_id = $2
      ORDER BY document_id`,
    [userId, reprocessingBatchId],
  );
  assert.equal(batchJobs.rowCount, 2);
  const improvingBatchJobId = String(batchJobs.rows.find(({ document_id }) =>
    document_id === batchFixtureIds[0])!.id);
  const failingBatchJobId = String(batchJobs.rows.find(({ document_id }) =>
    document_id === batchFixtureIds[1])!.id);
  const improvingBatchOwner = `integration-batch-improved-${crypto.randomUUID()}`;
  const improvingBatchJob = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [improvingBatchJobId, improvingBatchOwner],
  );
  assert.equal(await persistExtraction(
    improvingBatchJob.rows[0]!,
    {
      confidence: 0.99,
      decision: "SUPPORTED",
      documentType: "PAYROLL",
      signals: ["synthetic_batch_integration"],
    },
    preferredBatchExtraction,
    "PDF_TEXT",
    false,
    1,
  ), "COMPLETED");
  const preferredBatchProjection = (await pool.query(
    `SELECT document.employment_id, document.detected_employer_id,
            run.detected_employer_id AS run_employer_id, run.promotion_outcome,
            NOT EXISTS (
              SELECT 1 FROM extraction_run_issues issue
               WHERE issue.user_id = run.user_id AND issue.document_id = run.document_id
                 AND issue.extraction_run_id = run.id
                 AND issue.code = 'EMPLOYER_ASSOCIATION_REVIEW'
            ) AS employer_is_unambiguous
       FROM documents document
       JOIN extraction_runs run ON run.id = document.active_extraction_run_id
      WHERE document.id = $1 AND document.user_id = $2`,
    [batchFixtureIds[0], userId],
  )).rows[0];
  assert.deepEqual(preferredBatchProjection, {
    employment_id: preferredBatchEmploymentId,
    detected_employer_id: preferredBatchEmployerId,
    run_employer_id: preferredBatchEmployerId,
    promotion_outcome: "PROMOTED",
    employer_is_unambiguous: true,
  });
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [improvingBatchJobId],
  );
  const failingBatchOwner = `integration-batch-failed-${crypto.randomUUID()}`;
  const failingBatchJob = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = max_attempts, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [failingBatchJobId, failingBatchOwner],
  );
  await failJob(failingBatchJob.rows[0]!, new Error("synthetic batch terminal failure"));
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [failingBatchJobId],
  );
  const partialReprocessingBatch = await app.inject({
    method: "GET",
    url: `/api/v1/reprocessing-batches/${reprocessingBatchId}`,
    headers: { cookie: cookieA },
  });
  assert.equal(partialReprocessingBatch.statusCode, 200, partialReprocessingBatch.body);
  assert.equal(partialReprocessingBatch.json().data.status, "PARTIAL");
  assert.equal(typeof partialReprocessingBatch.json().data.completedAt, "string");
  assert.deepEqual(partialReprocessingBatch.json().data.progress, {
    total: 2,
    queued: 0,
    processing: 0,
    improved: 1,
    unchanged: 0,
    reviewRequired: 0,
    failed: 1,
    skipped: 0,
  });

  const raceDocumentId = listFixtures[1]!.id;
  const raceBaselineRunId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status,
       classifier_name, classifier_version, extractor_name, extractor_version,
       parser_version, normalizer_version, result_schema_version,
       pipeline_fingerprint, trigger_kind, promotion_outcome, promoted_at,
       finished_at, confidence
     ) VALUES ($1, $2, $3, 1, 'COMPLETED_WITH_WARNINGS',
       'heuristic-ar-payroll', '6', 'deterministic-ar-payroll', '6',
       '5', '6', '1', $4, 'INITIAL_UPLOAD', 'PROMOTED', now(), now(), 0.7)`,
    [raceBaselineRunId, userId, raceDocumentId, "e".repeat(64)],
  );
  await pool.query(
    `INSERT INTO extraction_run_issues (
       id, user_id, document_id, extraction_run_id, code, severity,
       recoverable, affected_field_path, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, 'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'WARNING', true,
       'settlement.basicAmount', '{}'::jsonb)`,
    [crypto.randomUUID(), userId, raceDocumentId, raceBaselineRunId],
  );
  await pool.query(
    `UPDATE documents
        SET active_extraction_run_id = $1, processing_status = 'COMPLETED',
            security_status = 'CLEAN', classification_status = 'SUPPORTED',
            document_type = 'PAYROLL', classification_confidence = 0.7
      WHERE id = $2 AND user_id = $3`,
    [raceBaselineRunId, raceDocumentId, userId],
  );
  const [raceBatch, raceIndividual] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/reprocessing-batches",
      headers: { origin, cookie: cookieA, "idempotency-key": "owner-batch-race-0001" },
      payload: { documentIds: [raceDocumentId] },
    }),
    app.inject({
      method: "POST",
      url: `/api/v1/documents/${raceDocumentId}/reprocess`,
      headers: { origin, cookie: cookieA, "idempotency-key": "owner-individual-race-0001" },
    }),
  ]);
  assert.deepEqual([raceBatch.statusCode, raceIndividual.statusCode].sort(), [201, 409]);
  const raceJob = await pool.query(
    `SELECT id, processing_version, stage, reprocessing_batch_id
       FROM processing_jobs
      WHERE user_id = $1 AND document_id = $2
        AND (state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE') OR execution_owner IS NOT NULL)`,
    [userId, raceDocumentId],
  );
  assert.equal(raceJob.rowCount, 1);
  assert.equal(raceJob.rows[0].processing_version, 2);
  assert.equal(raceJob.rows[0].stage, "DOCUMENT_PIPELINE_V2");
  await pool.query(
    `UPDATE processing_jobs
        SET state = 'CANCELLED', completed_at = now(), error_code = 'INTEGRATION_CLEANUP', updated_at = now()
      WHERE id = $1`,
    [raceJob.rows[0].id],
  );
  if (raceJob.rows[0].reprocessing_batch_id) {
    await pool.query(
      `UPDATE reprocessing_batches
          SET status = 'CANCELLED', completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [raceJob.rows[0].reprocessing_batch_id],
    );
  }

  const signedOriginal = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/original?disposition=inline`,
    headers: { cookie: cookieA },
  });
  assert.equal(signedOriginal.statusCode, 200, signedOriginal.body);
  const signedOriginalUrl = new URL(String(signedOriginal.json().data.url));
  assert.match(signedOriginalUrl.search, /X-Amz-(?:Algorithm|Signature)=/i);
  assert.equal(signedOriginalUrl.searchParams.get("X-Amz-Expires"), "120");
  assert.match(String(signedOriginal.headers["cache-control"]), /no-store/);
  assert.equal(signedOriginalUrl.searchParams.get("response-cache-control"), "no-store, private, max-age=0");
  assert.equal(signedOriginalUrl.searchParams.get("response-content-type"), "application/pdf");
  assert.equal(
    signedOriginalUrl.searchParams.get("response-content-disposition"),
    "inline; filename=\"salarivo-document.pdf\"",
  );
  const rangedOriginal = await fetch(signedOriginalUrl, {
    headers: { Origin: origin, Range: "bytes=0-31" },
  });
  assert.equal(rangedOriginal.status, 206);
  assert.equal(rangedOriginal.headers.get("access-control-allow-origin"), origin);
  assert.match(rangedOriginal.headers.get("access-control-expose-headers") ?? "", /content-range/i);
  assert.equal(rangedOriginal.headers.get("accept-ranges"), "bytes");
  assert.match(rangedOriginal.headers.get("content-range") ?? "", /^bytes 0-31\//);
  assert.equal(rangedOriginal.headers.get("cache-control"), "no-store, private, max-age=0");
  assert.equal(rangedOriginal.headers.get("content-disposition"), "inline; filename=\"salarivo-document.pdf\"");
  assert.equal(new TextDecoder().decode((await rangedOriginal.arrayBuffer()).slice(0, 5)), "%PDF-");

  const rejectedReprocess = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "owner-reprocess-rejected-0003" },
  });
  assert.equal(rejectedReprocess.statusCode, 201, rejectedReprocess.body);
  assert.equal(rejectedReprocess.json().data.job.processingVersion, 7);
  const activeReprocessDetail = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}`, headers: { cookie: cookieA },
  });
  assert.equal(activeReprocessDetail.statusCode, 200, activeReprocessDetail.body);
  assert.equal(activeReprocessDetail.json().data.lastReprocessError, null);
  const rejectedLeaseOwner = `integration-reprocess-rejected-${crypto.randomUUID()}`;
  const runningRejectedReprocess = await pool.query<IntegrationJobRow>(
    `UPDATE processing_jobs
        SET state = 'RUNNING', attempt = max_attempts, lease_owner = $2,
            lease_expires_at = now() + interval '5 minutes', execution_owner = $2,
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1 AND state = 'PENDING'
      RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
    [rejectedReprocess.json().data.job.id, rejectedLeaseOwner],
  );
  assert.equal(runningRejectedReprocess.rows[0]!.previous_document_status, "COMPLETED");
  await failJob(
    runningRejectedReprocess.rows[0]!,
    new WorkerError("DOCUMENT_MALWARE_DETECTED", false),
  );
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [rejectedReprocess.json().data.job.id],
  );
  assert.deepEqual(
    (await pool.query(
      "SELECT state, error_code FROM processing_jobs WHERE id = $1",
      [rejectedReprocess.json().data.job.id],
    )).rows[0],
    { state: "FAILED", error_code: "DOCUMENT_MALWARE_DETECTED" },
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT document.processing_status, document.security_status, item.status AS item_status,
              item.error_code AS item_error_code
         FROM documents document
         JOIN import_batch_items item ON item.id = document.import_batch_item_id
        WHERE document.id = $1`,
      [documentId],
    )).rows[0],
    {
      processing_status: "QUARANTINED",
      security_status: "QUARANTINED",
      item_status: "REJECTED",
      item_error_code: "DOCUMENT_MALWARE_DETECTED",
    },
  );
  const quarantinedSalaryHistory = await app.inject({
    method: "GET",
    url: "/api/v1/salary-history",
    headers: { cookie: cookieA },
  });
  assert.equal(quarantinedSalaryHistory.statusCode, 200, quarantinedSalaryHistory.body);
  assert.equal(quarantinedSalaryHistory.body.includes("1234567.89"), false);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM extraction_runs WHERE document_id = $1) AS runs,
         (SELECT count(*)::integer FROM user_corrections WHERE document_id = $1) AS corrections`,
      [documentId],
    )).rows[0],
    {
      runs: Number(lineageAfterReviewReprocess.runs) + 2,
      corrections: Number(lineageAfterReviewReprocess.corrections),
    },
  );
  const rejectedOriginal = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/original?disposition=inline`,
    headers: { cookie: cookieA },
  });
  assert.equal(rejectedOriginal.statusCode, 404, rejectedOriginal.body);
  assert.equal(rejectedOriginal.json().error.code, "ORIGINAL_NOT_FOUND");

  const exhaustedJobId = crypto.randomUUID();
  const exhaustedRunId = crypto.randomUUID();
  const exhaustedOwner = `integration-exhausted-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO processing_jobs (
       id, user_id, document_id, stage, processing_version, idempotency_key,
       state, attempt, max_attempts, lease_owner, lease_expires_at,
       execution_owner, previous_document_status, trigger_kind,
       requested_by_user_id, base_extraction_run_id, pipeline_fingerprint,
       started_at, updated_at
     ) VALUES ($1, $2, $3, 'TEXT_EXTRACTION', 8, $4,
       'RUNNING', 3, 3, $5, now() - interval '2 minutes',
       $5, 'COMPLETED', 'USER_REPROCESS', $2, $6, $7, now() - interval '5 minutes', now())`,
    [
      exhaustedJobId,
      userId,
      documentId,
      `synthetic-exhausted:${exhaustedJobId}`,
      exhaustedOwner,
      reviewReprocessedRunId,
      "d".repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status,
       classifier_name, classifier_version, extractor_name, extractor_version,
       parser_version, normalizer_version, result_schema_version,
       pipeline_fingerprint, trigger_kind, requested_by_user_id,
       base_extraction_run_id, promotion_outcome, started_at
     ) VALUES ($1, $2, $3, 8, 'PROCESSING',
       'heuristic-ar-payroll', '6', 'deterministic-ar-payroll', '6',
       '6', '6', '1', $4, 'USER_REPROCESS', $2, $5,
       'NOT_EVALUATED', now() - interval '5 minutes')`,
    [exhaustedRunId, userId, documentId, "d".repeat(64), reviewReprocessedRunId],
  );
  const reconciledExhausted = await reconcileDatabaseState({
    dispatcherBatchSize: 100,
  });
  assert.equal(reconciledExhausted.exhausted, 1);
  assert.equal(reconciledExhausted.recovered, 0);
  assert.deepEqual(
    (await pool.query(
      `SELECT job.state, job.error_code, job.execution_owner,
              run.status AS run_status, run.error_code AS run_error_code,
              issue.code AS issue_code, issue.severity, issue.recoverable
         FROM processing_jobs job
         JOIN extraction_runs run
           ON run.user_id = job.user_id AND run.document_id = job.document_id
          AND run.processing_version = job.processing_version
         JOIN extraction_run_issues issue ON issue.extraction_run_id = run.id
        WHERE job.id = $1`,
      [exhaustedJobId],
    )).rows[0],
    {
      state: "FAILED",
      error_code: "WORKER_LEASE_EXHAUSTED",
      execution_owner: exhaustedOwner,
      run_status: "FAILED",
      run_error_code: "WORKER_LEASE_EXHAUSTED",
      issue_code: "WORKER_LEASE_EXHAUSTED",
      severity: "ERROR",
      recoverable: false,
    },
  );
  const exhaustedAudit = (await pool.query(
    `SELECT result, metadata_no_sensitive FROM audit_events
      WHERE action = 'EXTRACTION_RUN_EVALUATED' AND resource_id = $1`,
    [exhaustedRunId],
  )).rows[0];
  assert.equal(exhaustedAudit.result, "FAILED");
  assert.deepEqual(
    {
      activeRunAfterId: exhaustedAudit.metadata_no_sensitive.activeRunAfterId,
      activeRunBeforeId: exhaustedAudit.metadata_no_sensitive.activeRunBeforeId,
      outcome: exhaustedAudit.metadata_no_sensitive.outcome,
      reason: exhaustedAudit.metadata_no_sensitive.reason,
    },
    {
      activeRunAfterId: reviewReprocessedRunId,
      activeRunBeforeId: reviewReprocessedRunId,
      outcome: "FAILED",
      reason: "WORKER_LEASE_EXHAUSTED",
    },
  );
  await pool.query(
    `UPDATE processing_jobs
        SET execution_owner = $2, updated_at = now() - interval '10 minutes'
      WHERE id = $1 AND state = 'FAILED'`,
    [exhaustedJobId, `integration-orphan-${crypto.randomUUID()}`],
  );
  const releasedTerminalOwner = await reconcileDatabaseState({
    dispatcherBatchSize: 100,
  });
  assert.equal(releasedTerminalOwner.released, 0);
  assert.ok(
    (await pool.query("SELECT execution_owner FROM processing_jobs WHERE id = $1", [exhaustedJobId])).rows[0].execution_owner,
  );
  await pool.query(
    "UPDATE processing_jobs SET execution_owner = NULL, updated_at = now() WHERE id = $1",
    [exhaustedJobId],
  );

  const blockedWithoutStepUp = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieB },
    payload: { confirmation: "ELIMINAR", receiptToken: deletionReceiptToken() },
  });
  assert.equal(blockedWithoutStepUp.statusCode, 403, blockedWithoutStepUp.body);
  assert.equal(blockedWithoutStepUp.json().error.code, "STEP_UP_REQUIRED");
  const blockedEmploymentDeletion = await app.inject({
    method: "DELETE",
    url: `/api/v1/employments/${employmentB}`,
    headers: { origin, cookie: cookieB },
  });
  assert.equal(blockedEmploymentDeletion.statusCode, 403, blockedEmploymentDeletion.body);
  assert.equal(
    (await pool.query("SELECT 1 FROM employments WHERE id = $1 AND user_id = $2", [employmentB, userIdB])).rowCount,
    1,
  );
  await grantStepUp(cookieB);
  const foreignOriginal = await app.inject({
    method: "GET",
    url: `/api/v1/documents/${documentId}/original?disposition=inline`,
    headers: { cookie: cookieB },
  });
  assert.equal(foreignOriginal.statusCode, 404, foreignOriginal.body);

  const expectedArtifactKey = `artifacts/${createHash("sha256").update(
    `${userId}:${documentId}:${reprocessedRunId}:PDF_TEXT:salarivo-pdf-text:6:`,
  ).digest("hex")}.json.gz`;
  assert.equal(
    (await pool.query(
      `INSERT INTO processing_artifacts (
         id, user_id, document_id, extraction_run_id, artifact_type, object_key,
         content_sha256, size_bytes, page_count, producer_name, producer_version,
         metadata_no_sensitive
       ) VALUES ($1, $2, $3, $4, 'PDF_TEXT', $5, $6, 1, 1,
         'salarivo-pdf-text', '6',
         '{"complete":false,"payloadVersion":1,"writeState":"PENDING"}'::jsonb)
        RETURNING id`,
      [crypto.randomUUID(), userId, documentId, reprocessedRunId, expectedArtifactKey, "f".repeat(64)],
    )).rowCount,
    1,
  );
  const originalDeletion = await app.inject({
    method: "DELETE",
    url: `/api/v1/documents/${documentId}/original`,
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(originalDeletion.statusCode, 202, originalDeletion.body);
  assert.equal(
    (await pool.query("SELECT original_deleted_at IS NOT NULL AS deleted FROM documents WHERE id = $1", [documentId])).rows[0].deleted,
    true,
  );
  assert.equal(
    (await pool.query(
      `SELECT $2 = ANY(artifact_object_keys) AS captured
         FROM storage_deletion_tombstones
        WHERE user_id = $1 AND canonical_object_key = $3`,
      [userId, expectedArtifactKey, canonicalObjectKey],
    )).rows[0].captured,
    true,
  );
  assert.equal(
    (await pool.query(
      `SELECT $2 = ANY(uncertain_artifact_object_keys) AS captured
         FROM storage_deletion_tombstones
        WHERE user_id = $1 AND canonical_object_key = $3`,
      [userId, expectedArtifactKey, canonicalObjectKey],
    )).rows[0].captured,
    true,
  );
  await pool.query(
    `UPDATE processing_artifacts
        SET metadata_no_sensitive = '{"complete":true,"payloadVersion":1,"writeState":"COMPLETED"}'::jsonb
      WHERE user_id = $1 AND object_key = $2`,
    [userId, expectedArtifactKey],
  );
  await pool.query(
    `UPDATE storage_deletion_tombstones
        SET uncertain_artifact_object_keys = '{}'::text[]
      WHERE user_id = $1 AND canonical_object_key = $2`,
    [userId, canonicalObjectKey],
  );
  assert.ok((await pool.query("SELECT 1 FROM payroll_settlements WHERE document_id = $1", [documentId])).rowCount);
  const deletedOriginalDownload = await app.inject({
    method: "GET", url: `/api/v1/documents/${documentId}/original`, headers: { cookie: cookieA },
  });
  assert.equal(deletedOriginalDownload.statusCode, 404, deletedOriginalDownload.body);
  const deletedOriginalReprocess = await app.inject({
    method: "POST",
    url: `/api/v1/documents/${documentId}/reprocess`,
    headers: { origin, cookie: cookieA, "idempotency-key": "deleted-original-reprocess" },
  });
  assert.equal(deletedOriginalReprocess.statusCode, 409, deletedOriginalReprocess.body);
  assert.equal(deletedOriginalReprocess.json().error.code, "ORIGINAL_NOT_AVAILABLE");

  const documentDeletion = await app.inject({
    method: "DELETE",
    url: `/api/v1/documents/${documentId}`,
    headers: { origin, cookie: cookieA },
    payload: {},
  });
  assert.equal(documentDeletion.statusCode, 202, documentDeletion.body);
  assert.equal((await pool.query("SELECT 1 FROM documents WHERE id = $1", [documentId])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM import_batch_items WHERE id = $1", [batchData.items[0]!.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM upload_sessions WHERE item_id = $1", [batchData.items[0]!.id])).rowCount, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::integer AS count FROM storage_deletion_tombstones WHERE user_id = $1", [userIdA])).rows[0].count,
    1,
  );

  const legacyPasswordPayload = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieB },
    payload: { confirmation: "ELIMINAR", password: "contraseña deliberadamente incorrecta", receiptToken: deletionReceiptToken() },
  });
  assert.equal(legacyPasswordPayload.statusCode, 400, legacyPasswordPayload.body);
  const activeDocumentB = crypto.randomUUID();
  const activeJobB = crypto.randomUUID();
  const activeWorkerB = `synthetic-worker-${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO documents (
       id, user_id, import_batch_id, import_batch_item_id, upload_session_id, employment_id,
       object_key, original_filename, declared_mime_type, size_bytes, processing_status, retention_policy
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'recibo-activo-sintetico.pdf',
       'application/pdf', $8, 'SECURITY_VALIDATION', 'KEEP_ORIGINAL')`,
    [
      activeDocumentB,
      userIdB,
      associatedAtImport.json().data.id,
      associatedAtImport.json().data.items[0].id,
      cancelledUploadSession.json().data.id,
      employmentB,
      `documents/${createHash("sha256").update(activeDocumentB).digest("hex")}.pdf`,
      pdfBytes.byteLength,
    ],
  );
  await pool.query(
    `INSERT INTO processing_jobs (
       id, user_id, document_id, stage, processing_version, idempotency_key,
       state, attempt, lease_owner, lease_expires_at, started_at, execution_owner
     ) VALUES ($1, $2, $3, 'SECURITY_VALIDATION', 1, $4,
       'RUNNING', 1, $5, now() + interval '1 hour', now(), $5)`,
    [activeJobB, userIdB, activeDocumentB, `synthetic-active-job:${activeJobB}`, activeWorkerB],
  );
  const receiptTokenB = deletionReceiptToken();
  const deleteB = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieB },
    payload: { confirmation: "ELIMINAR", receiptToken: receiptTokenB },
  });
  assert.equal(deleteB.statusCode, 202, deleteB.body);
  const receiptB = deleteB.json().data as { receiptToken: string };
  assert.equal(receiptB.receiptToken, receiptTokenB);
  assert.match(receiptB.receiptToken, /^[A-Za-z0-9_-]{43}$/);
  const receiptStatusB = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/account-deletion/status",
    headers: { origin },
    payload: { token: receiptB.receiptToken },
  });
  assert.equal(receiptStatusB.statusCode, 200, receiptStatusB.body);
  assert.equal(receiptStatusB.json().data.status, "PENDING");
  assert.equal(
    (await pool.query(
      "SELECT state, execution_owner FROM processing_jobs WHERE id = $1",
      [activeJobB],
    )).rows[0].state,
    "RUNNING",
  );

  if (process.env.KEEP_INTEGRATION_DATA === "1") return;
  const receiptTokenA = deletionReceiptToken();
  const deleteA = await app.inject({
    method: "DELETE",
    url: "/api/v1/privacy/account",
    headers: { origin, cookie: cookieA },
    payload: { confirmation: "ELIMINAR", receiptToken: receiptTokenA },
  });
  assert.equal(deleteA.statusCode, 202, deleteA.body);
  assert.equal(deleteA.json().data.receiptToken, receiptTokenA);

  const replay = await uploadWithSignedPost();
  assert.equal(replay.status, 204, await replay.text());
  assert.equal(await objectExists(incomingObjectKey), true);

  await runWorkerUntil("worker_started");
  const pendingReceiptA = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/account-deletion/status",
    headers: { origin },
    payload: { token: receiptTokenA },
  });
  assert.equal(pendingReceiptA.statusCode, 200, pendingReceiptA.body);
  assert.equal(pendingReceiptA.json().data.status, "PENDING");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [userIdA])).rowCount, 1);

  await pool.query(
    `UPDATE storage_deletion_tombstones
        SET upload_expires_at = now() - interval '2 minutes', available_at = now() - interval '2 minutes',
            object_delete_verify_after = now() - interval '2 minutes'
      WHERE user_id = $1`,
    [userIdA],
  );
  await runWorkerUntil("accounts_deleted");

  const completedReceiptA = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/account-deletion/status",
    headers: { origin },
    payload: { token: receiptTokenA },
  });
  assert.equal(completedReceiptA.statusCode, 200, completedReceiptA.body);
  assert.equal(completedReceiptA.json().data.status, "COMPLETED");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [userIdA])).rowCount, 0);
  assert.deepEqual(
    (await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM auth_accounts WHERE user_id = $1) AS auth_accounts,
         (SELECT count(*)::integer FROM sessions WHERE user_id = $1) AS sessions,
         (SELECT count(*)::integer FROM mfa_factors WHERE user_id = $1) AS mfa_factors,
         (SELECT count(*)::integer FROM mfa_recovery_codes WHERE user_id = $1) AS recovery_codes,
         (SELECT count(*)::integer FROM employers WHERE created_by_user_id = $1) AS employers,
         (SELECT count(*)::integer FROM employments WHERE user_id = $1) AS employments,
         (SELECT count(*)::integer FROM import_batches WHERE user_id = $1) AS import_batches,
         (SELECT count(*)::integer FROM upload_sessions WHERE user_id = $1) AS upload_sessions,
         (SELECT count(*)::integer FROM documents WHERE user_id = $1) AS documents,
         (SELECT count(*)::integer FROM processing_jobs WHERE user_id = $1) AS processing_jobs,
         (SELECT count(*)::integer FROM extraction_runs WHERE user_id = $1) AS extraction_runs,
         (SELECT count(*)::integer FROM payroll_settlements WHERE user_id = $1) AS settlements,
         (SELECT count(*)::integer FROM user_corrections WHERE user_id = $1) AS corrections,
         (SELECT count(*)::integer FROM privacy_operations WHERE user_id = $1) AS privacy_operations,
         (SELECT count(*)::integer FROM legal_acknowledgements WHERE user_id = $1) AS legal_acknowledgements,
         (SELECT count(*)::integer FROM audit_events WHERE user_id = $1) AS audit_events`,
      [userIdA],
    )).rows[0],
    {
      auth_accounts: 0,
      sessions: 0,
      mfa_factors: 0,
      recovery_codes: 0,
      employers: 0,
      employments: 0,
      import_batches: 0,
      upload_sessions: 0,
      documents: 0,
      processing_jobs: 0,
      extraction_runs: 0,
      settlements: 0,
      corrections: 0,
      privacy_operations: 0,
      legal_acknowledgements: 0,
      audit_events: 0,
    },
  );
  assert.equal((await pool.query("SELECT 1 FROM storage_deletion_tombstones WHERE user_id = $1", [userIdA])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [userIdB])).rowCount, 1);
  await pool.query(
    `UPDATE processing_jobs
        SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
            lease_expires_at = NULL, execution_owner = NULL, error_code = 'ACCOUNT_DELETION'
      WHERE id = $1`,
    [activeJobB],
  );
  await pool.query(
    `UPDATE upload_sessions
        SET created_at = now() - interval '3 minutes', expires_at = now() - interval '2 minutes'
      WHERE user_id = $1`,
    [userIdB],
  );
  await pool.query(
    `UPDATE storage_deletion_tombstones
        SET upload_expires_at = now() - interval '2 minutes', available_at = now() - interval '2 minutes',
            object_delete_verify_after = now() - interval '2 minutes'
      WHERE user_id = $1`,
    [userIdB],
  );
  await runWorkerUntil("accounts_deleted");
  const completedReceiptB = await app.inject({
    method: "POST",
    url: "/api/v1/privacy/account-deletion/status",
    headers: { origin },
    payload: { token: receiptTokenB },
  });
  assert.equal(completedReceiptB.statusCode, 200, completedReceiptB.body);
  assert.equal(completedReceiptB.json().data.status, "COMPLETED");
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [userIdB])).rowCount, 0);
  assert.equal(await objectExists(incomingObjectKey), false);
  assert.equal(await objectExists(canonicalObjectKey), false);
});
