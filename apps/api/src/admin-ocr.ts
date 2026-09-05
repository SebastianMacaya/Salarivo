import { pool } from "@salarivo/database";
import type { FastifyInstance } from "fastify";
import type { AdminRouteDependencies } from "./admin-routes.ts";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const countSchema = { type: "integer", minimum: 0 };
const tokenSchema = { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] };
const costSchema = { type: "string", pattern: "^[0-9]+(?:\\.[0-9]+)?$" };

export const adminOcrUsageSchema = {
  type: "object", additionalProperties: false,
  required: ["provider", "model", "providerVersion", "triggerReason", "status", "inputTokens", "outputTokens", "cachedTokens", "totalTokens", "estimatedCostUsd", "accountedCostUsd", "durationMs", "retryCount", "errorCode"],
  properties: {
    provider: { type: "string" }, model: { type: "string" }, providerVersion: { type: "string" },
    triggerReason: { type: "string" }, status: { type: "string" },
    inputTokens: tokenSchema, outputTokens: tokenSchema, cachedTokens: tokenSchema, totalTokens: tokenSchema,
    estimatedCostUsd: { anyOf: [costSchema, { type: "null" }] }, accountedCostUsd: costSchema,
    durationMs: { anyOf: [countSchema, { type: "null" }] }, retryCount: countSchema, errorCode: nullableString,
  },
};

// Select and serialize operational metadata only; provider payloads never enter an admin DTO.
export function adminOcrUsageView(row: Record<string, unknown>) {
  const nullableText = (value: unknown) => value === null || value === undefined ? null : String(value);
  return {
    provider: String(row.provider), model: String(row.model), providerVersion: String(row.provider_version),
    triggerReason: String(row.trigger_reason), status: String(row.status),
    inputTokens: nullableText(row.input_tokens), outputTokens: nullableText(row.output_tokens),
    cachedTokens: nullableText(row.cached_tokens), totalTokens: nullableText(row.total_tokens),
    estimatedCostUsd: nullableText(row.estimated_cost_usd), accountedCostUsd: String(row.accounted_cost_usd ?? "0"),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    retryCount: Number(row.retry_count ?? 0), errorCode: nullableText(row.error_code),
  };
}

const aggregateKeys = ["operations", "calls", "succeeded", "failed", "blocked", "cacheHits", "timeouts", "retries", "documents", "reviewRequiredDocuments", "processedDocuments", "withoutOcrDocuments", "zaiDocuments", "unknownLayoutDocuments"] as const;
const aggregateSchema = {
  type: "object", additionalProperties: false,
  required: [...aggregateKeys, "reportedTotalTokens", "missingTokenReports", "estimatedCostUsd", "accountedCostUsd", "averageDurationMs"],
  properties: {
    ...Object.fromEntries(aggregateKeys.map((key) => [key, countSchema])),
    reportedTotalTokens: { type: "string", pattern: "^[0-9]+$" }, missingTokenReports: countSchema,
    estimatedCostUsd: costSchema, accountedCostUsd: costSchema,
    averageDurationMs: { anyOf: [countSchema, { type: "null" }] },
  },
};

export async function registerAdminOcrRoutes(app: FastifyInstance, dependencies: Pick<AdminRouteDependencies, "requireAdminPermission">) {
  app.get<{ Querystring: { page?: number; pageSize?: number } }>("/api/v1/admin/processing/ocr", {
    preValidation: (request) => dependencies.requireAdminPermission(request, "processing.read"),
    schema: {
      querystring: {
        type: "object", additionalProperties: false,
        properties: { page: { type: "integer", minimum: 1, maximum: 1_000 }, pageSize: { type: "integer", minimum: 1, maximum: 100 } },
      },
      response: { 200: {
        type: "object", additionalProperties: false, required: ["data"],
        properties: { data: {
          type: "object", additionalProperties: false, required: ["periodStart", "summary", "providers", "users", "checkedAt"],
          properties: {
            periodStart: { type: "string" }, summary: aggregateSchema,
            providers: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["provider", "model", "health", "lastRequestAt", "lastErrorCode", "succeeded", "failed", "blocked"],
              properties: {
                provider: { type: "string" }, model: { type: "string" },
                health: { type: "string", enum: ["HEALTHY", "DEGRADED", "UNKNOWN"] },
                lastRequestAt: nullableString, lastErrorCode: nullableString,
                succeeded: countSchema, failed: countSchema, blocked: countSchema,
              },
            } },
            users: {
              type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
              properties: {
                page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1 }, total: countSchema,
                items: { type: "array", items: {
                  type: "object", additionalProperties: false,
                  required: ["userId", "documents", "reportedTotalTokens", "estimatedCostUsd", "accountedCostUsd"],
                  properties: {
                    userId: { type: "string", format: "uuid" }, documents: countSchema,
                    reportedTotalTokens: { type: "string", pattern: "^[0-9]+$" }, estimatedCostUsd: costSchema, accountedCostUsd: costSchema,
                  },
                } },
              },
            },
            checkedAt: { type: "string" },
          },
        } },
      } },
    },
  }, async (request) => {
    const page = request.query.page ?? 1;
    const pageSize = request.query.pageSize ?? 25;
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const [summary, providers, users, total, runs] = await Promise.all([
      pool.query(`SELECT count(*)::integer AS operations,
          count(*) FILTER (WHERE usage.status IN ('RESERVED', 'SUCCEEDED', 'FAILED'))::integer AS calls,
          count(*) FILTER (WHERE usage.status = 'SUCCEEDED')::integer AS succeeded,
          count(*) FILTER (WHERE usage.status = 'FAILED')::integer AS failed,
          count(*) FILTER (WHERE usage.status = 'BLOCKED')::integer AS blocked,
          count(*) FILTER (WHERE usage.status = 'CACHE_HIT')::integer AS cache_hits,
          count(*) FILTER (WHERE usage.error_code = 'OCR_TIMEOUT')::integer AS timeouts,
          COALESCE(sum(usage.retry_count), 0)::integer AS retries,
          count(DISTINCT usage.document_id)::integer AS documents,
          count(DISTINCT usage.document_id) FILTER (WHERE run.status = 'REVIEW_REQUIRED')::integer AS review_required_documents,
          COALESCE(sum(usage.total_tokens) FILTER (WHERE usage.status <> 'CACHE_HIT'), 0)::text AS reported_total_tokens,
          count(*) FILTER (WHERE usage.status IN ('SUCCEEDED', 'FAILED') AND usage.total_tokens IS NULL)::integer AS missing_token_reports,
          COALESCE(sum(usage.estimated_cost_usd), 0)::text AS estimated_cost_usd,
          (SELECT COALESCE(sum(accounted_cost_usd), 0)::text FROM ocr_provider_daily_costs
            WHERE usage_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date) AS accounted_cost_usd,
          round(avg(usage.duration_ms) FILTER (WHERE usage.status IN ('SUCCEEDED', 'FAILED')))::integer AS average_duration_ms
        FROM ocr_provider_usage usage
        LEFT JOIN extraction_runs run ON run.id = usage.extraction_run_id
          AND run.user_id = usage.user_id AND run.document_id = usage.document_id
        WHERE usage.created_at >= $1`, [periodStart]),
      pool.query(`WITH totals AS (SELECT provider, model,
          count(*) FILTER (WHERE status = 'SUCCEEDED')::integer AS succeeded,
          count(*) FILTER (WHERE status = 'FAILED')::integer AS failed,
          count(*) FILTER (WHERE status = 'BLOCKED')::integer AS blocked
        FROM ocr_provider_usage WHERE created_at >= $1 GROUP BY provider, model)
        SELECT totals.*, recent.finished_at AS last_request_at, recent.status AS last_status, recent.error_code AS last_error_code
          FROM totals LEFT JOIN LATERAL (
            SELECT finished_at, status, error_code FROM ocr_provider_usage usage
             WHERE usage.provider = totals.provider AND usage.model = totals.model AND usage.created_at >= $1
               AND usage.status IN ('SUCCEEDED', 'FAILED')
             ORDER BY finished_at DESC, id DESC LIMIT 1
          ) recent ON true ORDER BY totals.provider, totals.model`, [periodStart]),
      pool.query(`SELECT user_id, count(DISTINCT document_id)::integer AS documents,
          COALESCE(sum(total_tokens) FILTER (WHERE status <> 'CACHE_HIT'), 0)::text AS reported_total_tokens,
          COALESCE(sum(estimated_cost_usd), 0)::text AS estimated_cost_usd,
          COALESCE(sum(accounted_cost_usd), 0)::text AS accounted_cost_usd
        FROM ocr_provider_usage WHERE created_at >= $1
        GROUP BY user_id ORDER BY sum(accounted_cost_usd) DESC, user_id LIMIT $2 OFFSET $3`,
      [periodStart, pageSize, (page - 1) * pageSize]),
      pool.query("SELECT count(DISTINCT user_id)::integer AS total FROM ocr_provider_usage WHERE created_at >= $1", [periodStart]),
      pool.query(`SELECT count(*)::integer AS processed_documents,
          count(*) FILTER (WHERE latest.ocr_provider IS NULL)::integer AS without_ocr_documents,
          count(*) FILTER (WHERE latest.ocr_provider = 'zai')::integer AS zai_documents,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM extraction_run_issues issue
             WHERE issue.extraction_run_id = latest.id AND issue.user_id = latest.user_id
               AND issue.document_id = latest.document_id AND issue.code = 'UNKNOWN_LAYOUT'
          ))::integer AS unknown_layout_documents
        FROM (
          SELECT DISTINCT ON (user_id, document_id) id, user_id, document_id, ocr_provider
            FROM extraction_runs
           WHERE started_at >= $1 AND status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REVIEW_REQUIRED', 'FAILED', 'CANCELLED')
           ORDER BY user_id, document_id, processing_version DESC
        ) latest`, [periodStart]),
    ]);
    const row = summary.rows[0]!;
    return { data: {
      periodStart,
      summary: {
        operations: Number(row.operations), calls: Number(row.calls), succeeded: Number(row.succeeded), failed: Number(row.failed), blocked: Number(row.blocked),
        cacheHits: Number(row.cache_hits), timeouts: Number(row.timeouts), retries: Number(row.retries), documents: Number(row.documents),
        reviewRequiredDocuments: Number(row.review_required_documents), reportedTotalTokens: String(row.reported_total_tokens),
        missingTokenReports: Number(row.missing_token_reports), estimatedCostUsd: String(row.estimated_cost_usd), accountedCostUsd: String(row.accounted_cost_usd),
        averageDurationMs: row.average_duration_ms === null ? null : Number(row.average_duration_ms),
        processedDocuments: Number(runs.rows[0]!.processed_documents), withoutOcrDocuments: Number(runs.rows[0]!.without_ocr_documents),
        zaiDocuments: Number(runs.rows[0]!.zai_documents), unknownLayoutDocuments: Number(runs.rows[0]!.unknown_layout_documents),
      },
      providers: providers.rows.map((provider) => {
        const lastRequestAt = provider.last_request_at === null ? null : new Date(provider.last_request_at).toISOString();
        return {
          provider: String(provider.provider), model: String(provider.model),
          health: lastRequestAt === null || now.getTime() - new Date(lastRequestAt).getTime() > 86_400_000
            ? "UNKNOWN" : provider.last_status === "SUCCEEDED" ? "HEALTHY" : "DEGRADED",
          lastRequestAt, lastErrorCode: provider.last_error_code === null ? null : String(provider.last_error_code),
          succeeded: Number(provider.succeeded), failed: Number(provider.failed), blocked: Number(provider.blocked),
        };
      }),
      users: { items: users.rows.map((user) => ({
        userId: String(user.user_id), documents: Number(user.documents), reportedTotalTokens: String(user.reported_total_tokens),
        estimatedCostUsd: String(user.estimated_cost_usd), accountedCostUsd: String(user.accounted_cost_usd),
      })), page, pageSize, total: Number(total.rows[0]!.total) },
      checkedAt: now.toISOString(),
    } };
  });
}
