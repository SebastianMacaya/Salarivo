import assert from "node:assert/strict";
import test from "node:test";

test("Fastify registers every local route and rejects untrusted mutations", async (context) => {
  process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused";
  const [{ buildApp }, { loadConfig }, { derivedDocumentFilename }] = await Promise.all([
    import("../src/app.ts"),
    import("../src/config.ts"),
    import("../src/data-routes.ts"),
  ]);
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

  assert.equal(
    derivedDocumentFilename("document.pdf", "2026-07", "Empresa: Sintética / Norte?"),
    "2026-07 - Empresa Sintética Norte.pdf",
  );
  assert.equal(derivedDocumentFilename("CON.pdf"), "document-CON.pdf");
  assert.ok(derivedDocumentFilename("document.pdf", "2026-07", "A".repeat(400)).length <= 250);
});
