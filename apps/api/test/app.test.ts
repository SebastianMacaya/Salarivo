import assert from "node:assert/strict";
import test from "node:test";

test("Fastify registers every local route and rejects untrusted mutations", async (context) => {
  process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
  const [
    { buildApp, validateEmploymentDates, validateRegistrationLegalDocuments },
    { loadConfig },
    { derivedDocumentFilename, rankedSalaryContextIndexes },
  ] = await Promise.all([
    import("../src/app.ts"),
    import("../src/config.ts"),
    import("../src/data-routes.ts"),
  ]);
  const approvedLegalDocuments = [
    { id: "terms", document_type: "TERMS", version: "1.0", requires_acceptance: true, approved_for_production: true },
    { id: "privacy", document_type: "PRIVACY_NOTICE", version: "1.0", requires_acceptance: false, approved_for_production: true },
  ];
  assert.doesNotThrow(() => validateRegistrationLegalDocuments("production", approvedLegalDocuments));
  assert.throws(
    () => validateRegistrationLegalDocuments("production", [
      { ...approvedLegalDocuments[0]!, approved_for_production: false },
      approvedLegalDocuments[1]!,
    ]),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error
      && error.code === "LEGAL_REVIEW_REQUIRED",
  );
  const currentYear = new Date().getUTCFullYear();
  assert.doesNotThrow(() => validateEmploymentDates(`${currentYear - 1}-01-01`, null));
  assert.throws(() => validateEmploymentDates("0001-01-01", null));
  assert.throws(() => validateEmploymentDates("1900-01-01", "2000-01-01"));
  assert.throws(() => validateEmploymentDates(`${currentYear + 1}-01-01`, null));
  const app = await buildApp(loadConfig({ APP_ENV: "test", LOG_LEVEL: "silent" }), {
    provisionStorage: false,
  });
  context.after(() => app.close());

  await app.ready();
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });

  const rejected = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, "UNTRUSTED_ORIGIN");
  assert.equal(rejected.headers["cache-control"], "no-store");

  const googleUnavailable = await app.inject({
    method: "POST",
    url: "/api/v1/auth/google/start",
    headers: { origin: "http://localhost:3000" },
    payload: {},
  });
  assert.equal(googleUnavailable.statusCode, 503);
  assert.equal(googleUnavailable.json().error.code, "GOOGLE_AUTH_UNAVAILABLE");

  for (const path of ["register", "login", "forgot-password", "reset-password"]) {
    const legacyPasswordRoute = await app.inject({
      method: "POST",
      url: `/api/v1/auth/${path}`,
      headers: { origin: "http://localhost:3000" },
      payload: {},
    });
    assert.equal(legacyPasswordRoute.statusCode, 404);
    assert.equal(legacyPasswordRoute.json().error.code, "NOT_FOUND");
  }

  assert.equal(
    derivedDocumentFilename("document.pdf", "2026-07", "Empresa: Sintética / Norte?"),
    "2026-07 - Empresa Sintética Norte.pdf",
  );
  assert.equal(derivedDocumentFilename("CON.pdf"), "document-CON.pdf");
  assert.equal(derivedDocumentFilename("recibo\u202Efdp.pdf"), "recibo fdp.pdf");
  assert.ok(derivedDocumentFilename("document.pdf", "2026-07", "A".repeat(400)).length <= 250);

  const contexts = [
    { employmentContext: "recent", currencyCode: "ARS", employerName: "Reciente", lastPeriod: "2026-08", isFavorite: false, state: "CONFIRMED" as const, employmentStatus: "ACTIVE" },
    { employmentContext: "favorite-old", currencyCode: "ARS", employerName: "Favorita vieja", lastPeriod: "2020-01", isFavorite: true, state: "CONFIRMED" as const, employmentStatus: "ENDED" },
    { employmentContext: "older", currencyCode: "ARS", employerName: "Anterior", lastPeriod: "2025-12", isFavorite: false, state: "CONFIRMED" as const, employmentStatus: "ENDED" },
    { employmentContext: "favorite-new", currencyCode: "ARS", employerName: "Favorita nueva", lastPeriod: "2024-02", isFavorite: true, state: "CONFIRMED" as const, employmentStatus: "ACTIVE" },
    { employmentContext: "empty", currencyCode: "ARS", employerName: "Sin período", lastPeriod: null, isFavorite: false, state: "UNCONFIRMED" as const, employmentStatus: null },
  ];
  assert.deepEqual(
    rankedSalaryContextIndexes(contexts).map((index) => contexts[index]!.employmentContext),
    ["favorite-new", "favorite-old", "recent", "older", "empty"],
  );

  const proxyApp = await buildApp({
    ...loadConfig({ APP_ENV: "test", LOG_LEVEL: "silent" }),
    appEnv: "production",
  }, { provisionStorage: false });
  context.after(() => proxyApp.close());
  proxyApp.get("/test/client-rate-limit", {
    config: { rateLimit: { max: 1, timeWindow: "1 minute" } },
  }, async (request) => ({ ip: request.headers["cf-connecting-ip"] }));
  await proxyApp.ready();
  const hitLimit = (clientIp: string) => proxyApp.inject({
    method: "GET", url: "/test/client-rate-limit", headers: { "cf-connecting-ip": clientIp },
  });
  assert.equal((await hitLimit("198.51.100.10")).statusCode, 200);
  assert.equal((await hitLimit("198.51.100.10")).statusCode, 429);
  assert.equal((await hitLimit("198.51.100.11")).statusCode, 200);
  assert.equal((await hitLimit("not-an-ip")).statusCode, 200);
  assert.equal((await hitLimit("still-not-an-ip")).statusCode, 429);
});
