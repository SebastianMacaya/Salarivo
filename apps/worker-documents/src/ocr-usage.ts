import { randomUUID } from 'node:crypto';
import { currentLegalAcknowledgementsSql, pool, withTransaction, type PoolClient } from '@salarivo/database';
import { estimateOcrCostUsd, OCRProviderError, type OCRConfig, type OCRProvider, type OCRResult } from './ocr-provider.ts';

export type OcrUsageContext = {
  job: { id: string; user_id: string; document_id: string; lease_owner: string };
  runId: string;
  triggerReason: string;
  provider: Pick<OCRProvider, 'providerName' | 'model' | 'providerVersion'>;
  config: OCRConfig;
};

async function insertUsage(
  client: PoolClient, context: OcrUsageContext, requestId: string,
  status: 'RESERVED' | 'BLOCKED' | 'CACHE_HIT', errorCode: string | null,
): Promise<string> {
  const id = randomUUID();
  const { job, provider, config } = context;
  const result = await client.query(
    `INSERT INTO ocr_provider_usage (
       id, user_id, document_id, extraction_run_id, processing_job_id,
       provider, model, provider_version, trigger_reason, request_id, status,
       reserved_cost_usd, accounted_cost_usd, estimated_cost_usd, error_code, finished_at
     )
     SELECT $1, job.user_id, job.document_id, run.id, job.id, $6, $7, $8, $9, $10, $11,
            CASE WHEN $11 = 'RESERVED' THEN $12::numeric * $13::integer ELSE 0 END,
            CASE WHEN $11 = 'RESERVED' THEN $12::numeric * $13::integer ELSE 0 END,
            CASE WHEN $11 = 'CACHE_HIT' THEN 0 ELSE NULL END, $14,
            CASE WHEN $11 = 'RESERVED' THEN NULL ELSE now() END
       FROM processing_jobs AS job
       JOIN extraction_runs AS run ON run.user_id = job.user_id AND run.document_id = job.document_id
            AND run.processing_version = job.processing_version AND run.id = $5
       JOIN documents AS document ON document.user_id = job.user_id AND document.id = job.document_id
       JOIN users AS owner ON owner.id = document.user_id
      WHERE job.id = $2 AND job.user_id = $3 AND job.document_id = $4
        AND job.state = 'RUNNING' AND job.lease_owner = $15 AND job.lease_expires_at > now()
        AND job.execution_owner = $15 AND run.status IN ('RUNNING', 'PROCESSING')
        AND document.deleted_at IS NULL AND document.original_deleted_at IS NULL
        AND document.security_status = 'CLEAN' AND owner.status = 'ACTIVE'`,
    [id, job.id, job.user_id, job.document_id, context.runId, provider.providerName, provider.model,
      provider.providerVersion, context.triggerReason, requestId, status, config.reservationUsd,
      config.maxRetries + 1, errorCode, job.lease_owner],
  );
  if (result.rowCount !== 1) throw new OCRProviderError('OCR_JOB_NOT_AUTHORIZED');
  return id;
}

async function reserveOcrUsage(context: OcrUsageContext, requestId: string): Promise<string> {
  const { config, provider } = context;
  const reservation = await withTransaction(async (client) => {
    // Serialize provider admission across workers, not the network request itself.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('ocr:' || $1, 0))`, [provider.providerName]);
    const acceptance = await client.query<{ acknowledged: boolean }>(
      `SELECT ${currentLegalAcknowledgementsSql('owner')} AS acknowledged FROM users owner WHERE owner.id = $1`,
      [context.job.user_id],
    );
    if (acceptance.rows[0]?.acknowledged !== true) {
      const error = 'OCR_LEGAL_ACCEPTANCE_REQUIRED';
      const id = await insertUsage(client, context, requestId, 'BLOCKED', error);
      return { id, error };
    }
    const attempted = await client.query(
      `SELECT 1 FROM ocr_provider_usage WHERE extraction_run_id = $1 AND provider = $2
       AND model = $3 AND provider_version = $4 AND status IN ('RESERVED', 'SUCCEEDED', 'FAILED') LIMIT 1`,
      [context.runId, provider.providerName, provider.model, provider.providerVersion],
    );
    const totals = await client.query<{ budget_exceeded: boolean; active_count: string; recent_failures: string }>(
      `SELECT
         (SELECT COALESCE(sum(accounted_cost_usd), 0) FROM ocr_provider_daily_costs
           WHERE provider = $1 AND usage_date = (now() AT TIME ZONE 'UTC')::date)
             + $2::numeric * $3::integer > $4::numeric
         OR (SELECT COALESCE(sum(accounted_cost_usd), 0) FROM ocr_provider_daily_costs
           WHERE provider = $1 AND usage_date >= date_trunc('month', now() AT TIME ZONE 'UTC')::date)
             + $2::numeric * $3::integer > $5::numeric AS budget_exceeded,
         count(*) FILTER (WHERE status = 'RESERVED' AND EXISTS (
             SELECT 1 FROM processing_jobs job WHERE job.id = processing_job_id AND job.execution_owner IS NOT NULL
         )) AS active_count,
         count(*) FILTER (WHERE status = 'FAILED' AND created_at > now() - interval '5 minutes'
             AND error_code IN ('OCR_TIMEOUT', 'OCR_RATE_LIMITED', 'OCR_PROVIDER_UNAVAILABLE', 'OCR_AUTH_FAILED')) AS recent_failures
       FROM ocr_provider_usage WHERE provider = $1
         AND (created_at > now() - interval '5 minutes' OR status = 'RESERVED')`,
      [provider.providerName, config.reservationUsd, config.maxRetries + 1, config.dailyBudgetUsd, config.monthlyBudgetUsd],
    );
    const state = totals.rows[0]!;
    const error = attempted.rowCount ? 'OCR_ALREADY_ATTEMPTED'
      : state.budget_exceeded ? 'OCR_BUDGET_EXCEEDED'
      : Number(state.active_count) >= config.maxConcurrency ? 'OCR_CONCURRENCY_LIMIT'
      : Number(state.recent_failures) >= 5 ? 'OCR_CIRCUIT_OPEN' : null;
    const id = await insertUsage(client, context, requestId, error ? 'BLOCKED' : 'RESERVED', error);
    if (!error) await client.query(
      `INSERT INTO ocr_provider_daily_costs (provider, usage_date, accounted_cost_usd)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2::numeric * $3::integer)
       ON CONFLICT (provider, usage_date) DO UPDATE SET
         accounted_cost_usd = ocr_provider_daily_costs.accounted_cost_usd + EXCLUDED.accounted_cost_usd`,
      [provider.providerName, config.reservationUsd, config.maxRetries + 1],
    );
    return { id, error };
  });
  if (reservation.error) throw new OCRProviderError(reservation.error, reservation.error === 'OCR_LEGAL_ACCEPTANCE_REQUIRED');
  return reservation.id;
}

export async function recordOcrCacheHit(context: OcrUsageContext): Promise<void> {
  await withTransaction((client) => insertUsage(client, context, `sal_${randomUUID()}`, 'CACHE_HIT', null));
}

export async function runBudgetedOcr(
  context: OcrUsageContext,
  providerCall: (requestId: string) => Promise<OCRResult>,
): Promise<OCRResult> {
  if (!context.config.enabled || context.config.provider === 'disabled') throw new OCRProviderError('OCR_DISABLED');
  const requestId = `sal_${randomUUID()}`;
  const id = await reserveOcrUsage(context, requestId);
  let result: OCRResult;
  try {
    result = await providerCall(requestId);
  } catch (error) {
    const failure = error instanceof OCRProviderError ? error : new OCRProviderError('OCR_PROVIDER_UNAVAILABLE');
    // Unknown billing remains reserved even after a crash or timeout; never report it as free.
    await pool.query(
      `UPDATE ocr_provider_usage SET status = 'FAILED', error_code = $2,
         retry_count = $3, duration_ms = $4, external_request_id = $5, finished_at = now()
       WHERE id = $1 AND status = 'RESERVED'`,
      [id, failure.code, failure.retryCount, failure.durationMs, failure.externalRequestId],
    );
    throw failure;
  }
  const estimated = estimateOcrCostUsd(result.usage, context.config);
  await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('ocr:' || $1, 0))`, [context.provider.providerName]);
    const updated = await client.query<{ provider: string; usage_date: string; adjustment: string }>(
    `UPDATE ocr_provider_usage SET status = 'SUCCEEDED', input_tokens = $2, output_tokens = $3,
       cached_tokens = $4, total_tokens = $5, estimated_cost_usd = $6,
       accounted_cost_usd = CASE WHEN $6::numeric IS NULL THEN reserved_cost_usd
         ELSE $6::numeric + $7::integer * $8::numeric END,
       retry_count = $7, duration_ms = $9, external_request_id = $10, finished_at = now()
     WHERE id = $1 AND status = 'RESERVED'
     RETURNING provider, (created_at AT TIME ZONE 'UTC')::date::text AS usage_date,
       (accounted_cost_usd - reserved_cost_usd)::text AS adjustment`,
    [id, result.usage?.inputTokens ?? null, result.usage?.outputTokens ?? null,
      result.usage?.cachedTokens ?? null, result.usage?.totalTokens ?? null, estimated,
      result.retryCount, context.config.reservationUsd, result.durationMs, result.externalRequestId],
    );
    const row = updated.rows[0];
    if (!row) throw new OCRProviderError('OCR_JOB_NOT_AUTHORIZED');
    await client.query(
      `UPDATE ocr_provider_daily_costs SET accounted_cost_usd = accounted_cost_usd + $3::numeric
       WHERE provider = $1 AND usage_date = $2::date`, [row.provider, row.usage_date, row.adjustment],
    );
  });
  return result;
}
