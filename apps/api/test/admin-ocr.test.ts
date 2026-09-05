import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

test("OCR diagnostics require processing permission and serialize only exact operational metadata", async (context) => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  const { pool } = await import("@salarivo/database");
  const { adminOcrUsageView, registerAdminOcrRoutes } = await import("../src/admin-ocr.ts");
  const sentinel = "PRIVATE_SYNTHETIC_OCR_SALARY_SECRET";
  const totalTokens = "9007199254740993";
  const estimatedCost = "123456789012.12345678";
  const operationalRow = {
    provider: "zai", model: "glm-ocr", provider_version: "1", trigger_reason: "NO_NATIVE_TEXT", status: "SUCCEEDED",
    input_tokens: null, output_tokens: null, cached_tokens: null, total_tokens: totalTokens,
    estimated_cost_usd: estimatedCost, accounted_cost_usd: estimatedCost, duration_ms: 400, retry_count: 1, error_code: null,
    raw_payload: sentinel, filename: sentinel, salary: sentinel, api_key: sentinel, request_id: sentinel,
  };
  const usage = adminOcrUsageView(operationalRow);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.totalTokens, totalTokens);
  assert.equal(usage.estimatedCostUsd, estimatedCost);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE_SYNTHETIC/);

  const queries: string[] = [];
  let lastStatus = "SUCCEEDED";
  let lastRequestAt: Date | null = new Date();
  context.mock.method(pool, "query", async (sql: string) => {
    queries.push(sql);
    if (sql.includes("AS operations")) return { rows: [{
      operations: 1, calls: 1, succeeded: 1, failed: 0, blocked: 0, cache_hits: 0, timeouts: 0, retries: 1, documents: 1,
      review_required_documents: 0, reported_total_tokens: totalTokens, missing_token_reports: 0,
      estimated_cost_usd: estimatedCost, accounted_cost_usd: estimatedCost, average_duration_ms: 400, raw_payload: sentinel,
    }] };
    if (sql.includes("GROUP BY provider")) return { rows: [{
      provider: "zai", model: "glm-ocr", succeeded: 1, failed: 0, blocked: 0,
      last_request_at: lastRequestAt, last_status: lastStatus, last_error_code: null, raw_payload: sentinel,
    }] };
    if (sql.includes("GROUP BY user_id")) return { rows: [{
      user_id: "00000000-0000-4000-8000-000000000001", documents: 1, reported_total_tokens: totalTokens,
      estimated_cost_usd: estimatedCost, accounted_cost_usd: estimatedCost, raw_payload: sentinel,
    }] };
    if (sql.includes("AS processed_documents")) return { rows: [{ processed_documents: 2, without_ocr_documents: 1, zai_documents: 1, unknown_layout_documents: 0 }] };
    return { rows: [{ total: 1 }] };
  });
  const app = Fastify();
  context.after(() => app.close());
  await registerAdminOcrRoutes(app, { requireAdminPermission: async (request, permission) => {
    assert.equal(permission, "processing.read");
    if (request.headers.authorization !== "test-admin") throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  } });
  const denied = await app.inject({ url: "/api/v1/admin/processing/ocr" });
  assert.equal(denied.statusCode, 403);
  assert.equal(queries.length, 0);
  const invalid = await app.inject({ url: "/api/v1/admin/processing/ocr?pageSize=101", headers: { authorization: "test-admin" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(queries.length, 0);
  const response = await app.inject({ url: "/api/v1/admin/processing/ocr?page=1&pageSize=1", headers: { authorization: "test-admin" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.summary.reportedTotalTokens, totalTokens);
  assert.equal(response.json().data.summary.estimatedCostUsd, estimatedCost);
  assert.equal(response.json().data.summary.withoutOcrDocuments, 1);
  assert.equal(response.json().data.providers[0].health, "HEALTHY");
  assert.equal(response.json().data.users.pageSize, 1);
  assert.equal(response.json().data.users.items[0].estimatedCostUsd, estimatedCost);
  assert.doesNotMatch(response.body, /PRIVATE_SYNTHETIC/);
  lastStatus = "FAILED";
  const failed = await app.inject({ url: "/api/v1/admin/processing/ocr", headers: { authorization: "test-admin" } });
  assert.equal(failed.json().data.providers[0].health, "DEGRADED");
  lastRequestAt = new Date(Date.now() - 2 * 86_400_000);
  const stale = await app.inject({ url: "/api/v1/admin/processing/ocr", headers: { authorization: "test-admin" } });
  assert.equal(stale.json().data.providers[0].health, "UNKNOWN");
  lastRequestAt = null;
  const unobserved = await app.inject({ url: "/api/v1/admin/processing/ocr", headers: { authorization: "test-admin" } });
  assert.equal(unobserved.json().data.providers[0].health, "UNKNOWN");
});
