import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "@salarivo/database";
import type { FastifyRequest } from "fastify";

class TestApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

test("legal publication is coordinated, incremental and audited without its text", async () => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  const {
    hasInternalLegalReviewLanguage, isNewerLegalVersion, legalAdminVersionItems, publishLegalDocuments,
  } = await import("../src/admin-routes.ts");
  assert.equal(isNewerLegalVersion("1.10", "1.9"), true);
  assert.equal(isNewerLegalVersion("2.0", "1.99"), true);
  assert.equal(isNewerLegalVersion("1.0", "1.0"), false);
  assert.equal(hasInternalLegalReviewLanguage("BORRADOR\nTexto no publicable"), true);

  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("INSERT INTO legal_document_versions")) {
        return { rowCount: 1, rows: [{ published_at: new Date("2026-09-02T12:00:00Z") }] };
      }
      if (sql.includes("clock_timestamp")) return { rowCount: 1, rows: [{
        minimum_effective_at: "2026-09-02T12:01:00.000Z",
        maximum_effective_at: "2027-09-02T12:00:00.000Z",
      }] };
      if (sql.includes("FROM sessions")) return { rowCount: 1, rows: [{ id: "session-1" }] };
      if (sql.includes("FROM users")) {
        return { rowCount: 1, rows: [{ role: "ADMIN", admin_role: "SUPER_ADMIN", status: "ACTIVE", deleted_at: null }] };
      }
      if (sql.includes("FROM legal_document_versions")) return { rowCount: 1, rows: [{ version: "1.0", max_effective_at: "2026-11-01T03:00:00.000Z" }] };
      return { rowCount: 1, rows: [{}] };
    },
  } as unknown as PoolClient;
  const request = {
    authSessionHash: "session-hash",
    authUser: { id: "00000000-0000-4000-8000-000000000099" },
  } as unknown as FastifyRequest;
  const privateSentinel = "TEXTO-LEGAL-SINTETICO-NO-AUDITAR";
  const titleSentinel = "TITULO-SINTETICO-NO-AUDITAR";
  const common = {
    effectiveAt: "2026-11-01T03:00:00.000Z",
    approvedForProduction: true as const,
    reasonCode: "OPERATIONAL_RECOVERY" as const,
    reference: "LEGAL-TEST-1",
  };
  const items = await publishLegalDocuments(client, request, {
    ...common,
    documents: [
      { documentType: "TERMS", version: "1.1", title: titleSentinel, content: `${privateSentinel} ${"t".repeat(100)}` },
      { documentType: "PRIVACY_NOTICE", version: "1.1", title: titleSentinel, content: `${privateSentinel} ${"p".repeat(100)}` },
    ],
  }, TestApiError);

  assert.equal(calls[0]?.sql.includes("pg_advisory_xact_lock"), true);
  assert.deepEqual(items.map(({ documentType, requiresAcceptance }) => ({ documentType, requiresAcceptance })), [
    { documentType: "TERMS", requiresAcceptance: true },
    { documentType: "PRIVACY_NOTICE", requiresAcceptance: false },
  ]);
  const versionWrites = calls.filter(({ sql }) => sql.includes("INSERT INTO legal_document_versions"));
  assert.equal(versionWrites.length, 2);
  assert.equal(versionWrites.every(({ sql }) => sql.includes("clock_timestamp()")), true);
  assert.deepEqual(versionWrites.map(({ values }) => values?.at(-1)), [true, false]);
  const auditWrites = calls.filter(({ sql }) => sql.includes("INSERT INTO admin_audit_events"));
  assert.equal(auditWrites.length, 2);
  assert.equal(auditWrites.some(({ values }) => JSON.stringify(values).includes(privateSentinel)), false);
  assert.equal(auditWrites.some(({ values }) => JSON.stringify(values).includes(titleSentinel)), false);

  const scheduledCorrection = legalAdminVersionItems([
    {
      id: "new", document_type: "TERMS", version: "1.2", title: "Corrección",
      published_at: "2026-09-02T12:02:00.000Z", effective_at: common.effectiveAt,
      requires_acceptance: true, approved_for_production: true, acknowledgement_count: 0, available: false,
    },
    {
      id: "old", document_type: "TERMS", version: "1.1", title: "Programación reemplazada",
      published_at: "2026-09-02T12:01:00.000Z", effective_at: common.effectiveAt,
      requires_acceptance: true, approved_for_production: true, acknowledgement_count: 0, available: false,
    },
    {
      id: "current", document_type: "TERMS", version: "1.0", title: "Vigente",
      published_at: "2026-08-30T12:30:00.000Z", effective_at: "2026-08-30T12:30:00.000Z",
      requires_acceptance: true, approved_for_production: true, acknowledgement_count: 1, available: true,
    },
  ]);
  assert.deepEqual(scheduledCorrection.map(({ version, status }) => ({ version, status })), [
    { version: "1.2", status: "SCHEDULED" },
    { version: "1.1", status: "SUPERSEDED" },
    { version: "1.0", status: "CURRENT" },
  ]);

  await assert.rejects(
    () => publishLegalDocuments(client, request, {
      ...common,
      effectiveAt: "2026-09-02T12:00:59.000Z",
      documents: [{ documentType: "TERMS", version: "1.1", title: "Sin anticipación", content: "x".repeat(120) }],
    }, TestApiError),
    (error: unknown) => error instanceof TestApiError && error.code === "LEGAL_EFFECTIVE_AT_INVALID",
  );

  await assert.rejects(
    () => publishLegalDocuments(client, request, {
      ...common,
      effectiveAt: "2027-09-02T12:00:00.001Z",
      documents: [{ documentType: "TERMS", version: "1.1", title: "Demasiado lejana", content: "x".repeat(120) }],
    }, TestApiError),
    (error: unknown) => error instanceof TestApiError && error.code === "LEGAL_EFFECTIVE_AT_TOO_FAR",
  );

  await assert.rejects(
    () => publishLegalDocuments(client, request, {
      ...common,
      documents: [{ documentType: "TERMS", version: "1.0", title: "Versión repetida", content: "x".repeat(120) }],
    }, TestApiError),
    (error: unknown) => error instanceof TestApiError && error.code === "LEGAL_VERSION_EXISTS",
  );
  await assert.rejects(
    () => publishLegalDocuments(client, request, {
      ...common,
      effectiveAt: "2026-10-31T03:00:00.000Z",
      documents: [{ documentType: "TERMS", version: "1.1", title: "Vigencia regresiva", content: "x".repeat(120) }],
    }, TestApiError),
    (error: unknown) => error instanceof TestApiError && error.code === "LEGAL_EFFECTIVE_AT_NOT_INCREMENTAL",
  );
});
