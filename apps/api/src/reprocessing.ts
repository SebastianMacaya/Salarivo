import { createHash, randomUUID } from "node:crypto";
import {
  currentPipelineFingerprint,
  hasDocumentCountryRecoverySql as countryRecoverySql,
  followMergedEmployer,
  hasNewDocumentLayoutSql,
  lockEmployerMutation,
  parserFixCatalog,
  processingPipelineVersions,
  retryableOcrIssueCodes,
  type PoolClient,
  type ProcessingTriggerKind,
} from "@salarivo/database";
import { externalOcrEnabled } from "./config.ts";

export type ReprocessingCandidate = {
  documentId: string;
  activeRunId: string;
  activeProcessingVersion: number;
  parserVersion: string;
  pipelineFingerprint: string | null;
  inProgress: boolean;
  issues: Array<{
    code: string;
    severity: string;
    affectedFieldPath: string | null;
  }>;
};

export type EnqueuedReprocessing = {
  created: boolean;
  documentId: string;
  activeRunId: string | null;
  processingStatus: string;
  job: { id: string; state: string; processingVersion: number; stage: string };
};

type ApiErrorConstructor = new (statusCode: number, code: string, message: string) => Error;
type Queryable = Pick<PoolClient, "query">;

const fixesJson = JSON.stringify(parserFixCatalog);
const reprocessTriggers = new Set<ProcessingTriggerKind>([
  "USER_REPROCESS",
  "ADMIN_REPROCESS",
  "PARSER_UPGRADE",
  "AUTOMATIC_RECOVERY",
]);

function ocrRecoverySql(runAlias: string, issueAlias: string): string {
  if (!externalOcrEnabled()) return "false";
  return `(${issueAlias}.code IN (${retryableOcrIssueCodes.map((code) => `'${code}'`).join(",")}) OR (${issueAlias}.code IN (
    'UNKNOWN_LAYOUT', 'CRITICAL_FIELD_MISSING', 'BASIC_AMOUNT_MISSING',
    'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'OCR_PARTIAL'
  ) AND CASE WHEN ${runAlias}.extractor_version ~ '^[0-9]{1,8}$'
      THEN ${runAlias}.extractor_version::integer < ${Number(processingPipelineVersions.extractor)}
      ELSE false END))`;
}

function ocrRetrySql(runAlias: string): string {
  if (!externalOcrEnabled()) return "false";
  return `EXISTS (SELECT 1 FROM extraction_run_issues ocr_retry
    WHERE ocr_retry.user_id = ${runAlias}.user_id AND ocr_retry.document_id = ${runAlias}.document_id
      AND ocr_retry.extraction_run_id = ${runAlias}.id AND ocr_retry.recoverable
      AND ocr_retry.code IN (${retryableOcrIssueCodes.map((code) => `'${code}'`).join(",")}))`;
}

function layoutObservationSql(runAlias: string, issueAlias: string): string {
  // Parser 8 first records structural observations. This is a bounded discovery pass,
  // not a claim that an unapproved layout has a parser fix.
  return `(${runAlias}.layout_fingerprint IS NULL
    AND CASE WHEN ${runAlias}.parser_version ~ '^[0-9]{1,8}$'
      THEN ${runAlias}.parser_version::integer < 8 ELSE false END
    AND ${issueAlias}.code IN ('UNKNOWN_LAYOUT', 'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
      'BASIC_AMOUNT_MISSING', 'CRITICAL_FIELD_MISSING'))`;
}

function earningsRecoverySql(runAlias: string): string {
  return `(CASE WHEN ${runAlias}.parser_version ~ '^[0-9]{1,8}$'
    THEN ${runAlias}.parser_version::integer < 9 ELSE false END
    AND EXISTS (
      SELECT 1 FROM payroll_settlements earning_settlement
      JOIN payroll_line_items earning_item
        ON earning_item.settlement_id = earning_settlement.id
       AND earning_item.user_id = earning_settlement.user_id AND earning_item.item_type = 'EARNING'
      WHERE earning_settlement.user_id = ${runAlias}.user_id
        AND earning_settlement.document_id = ${runAlias}.document_id
        AND earning_settlement.extraction_run_id = ${runAlias}.id
        AND earning_settlement.gross_amount IS NOT NULL
        AND earning_settlement.remunerative_amount IS NOT NULL
        AND earning_settlement.non_remunerative_amount IS NOT NULL
        AND earning_settlement.gross_amount = earning_settlement.remunerative_amount + earning_settlement.non_remunerative_amount
      GROUP BY earning_settlement.id
      HAVING sum(earning_item.amount) <> earning_settlement.gross_amount
    ))`;
}

export function reprocessingCandidateExistsSql(
  documentAlias: string,
  fixesExpression: string,
  parserVersionExpression: string,
  fingerprintExpression: string,
) {
  if (!/^[a-z_][a-z0-9_]*$/.test(documentAlias)) throw new Error("INVALID_SQL_ALIAS");
  return `(
    ${documentAlias}.deleted_at IS NULL
    AND ${documentAlias}.original_deleted_at IS NULL
    AND ${documentAlias}.security_status = 'CLEAN'
    AND ${documentAlias}.document_type = 'PAYROLL'
    AND EXISTS (
      SELECT 1
        FROM extraction_runs candidate_run
        LEFT JOIN extraction_run_issues candidate_issue
          ON candidate_issue.user_id = candidate_run.user_id
         AND candidate_issue.document_id = candidate_run.document_id
         AND candidate_issue.extraction_run_id = candidate_run.id
         AND candidate_issue.recoverable
        LEFT JOIN jsonb_to_recordset(${fixesExpression}::jsonb) AS candidate_fix(
          "issueCode" text,
          "affectedFieldPath" text,
          "introducedInParserVersion" text
        )
          ON candidate_fix."issueCode" = candidate_issue.code
         AND candidate_fix."affectedFieldPath" IS NOT DISTINCT FROM candidate_issue.affected_field_path
         AND CASE
           WHEN candidate_fix."introducedInParserVersion" ~ '^[0-9]+$'
             AND ${parserVersionExpression} ~ '^[0-9]+$'
             THEN ${parserVersionExpression}::integer >= candidate_fix."introducedInParserVersion"::integer
           ELSE candidate_fix."introducedInParserVersion" = ${parserVersionExpression}
         END
       WHERE candidate_run.id = ${documentAlias}.active_extraction_run_id
         AND candidate_run.user_id = ${documentAlias}.user_id
         AND candidate_run.document_id = ${documentAlias}.id
         AND (candidate_run.pipeline_fingerprint IS DISTINCT FROM ${fingerprintExpression}
              OR ${ocrRetrySql("candidate_run")} OR ${hasNewDocumentLayoutSql("candidate_run")} OR ${countryRecoverySql("candidate_run")})
         AND ((candidate_fix."issueCode" IS NOT NULL AND CASE
           WHEN candidate_run.parser_version ~ '^[0-9]+$'
             AND candidate_fix."introducedInParserVersion" ~ '^[0-9]+$'
             THEN candidate_run.parser_version::integer < candidate_fix."introducedInParserVersion"::integer
           ELSE candidate_run.parser_version IS DISTINCT FROM candidate_fix."introducedInParserVersion"
         END) OR ${ocrRecoverySql("candidate_run", "candidate_issue")} OR ${hasNewDocumentLayoutSql("candidate_run")}
           OR ${layoutObservationSql("candidate_run", "candidate_issue")} OR ${countryRecoverySql("candidate_run")}
           OR ${earningsRecoverySql("candidate_run")})
         AND NOT EXISTS (
           SELECT 1 FROM extraction_runs attempted_run
            WHERE attempted_run.user_id = candidate_run.user_id
              AND attempted_run.document_id = candidate_run.document_id
              AND attempted_run.base_extraction_run_id = candidate_run.id
              AND attempted_run.pipeline_fingerprint = ${fingerprintExpression}
              AND NOT (${ocrRetrySql("attempted_run")} OR ${hasNewDocumentLayoutSql("attempted_run")} OR ${countryRecoverySql("attempted_run")})
              AND (
                attempted_run.status = 'REVIEW_REQUIRED'
                OR attempted_run.promotion_outcome IN ('PROMOTED', 'UNCHANGED', 'REVIEW_REQUIRED', 'REJECTED_REGRESSION')
              )
         )
    )
  )`;
}

function timestamp(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  return input instanceof Date ? input.toISOString() : new Date(String(input)).toISOString();
}

export async function findReprocessingCandidates(
  client: Queryable,
  userId: string,
  options: { documentId?: string; documentIds?: readonly string[]; limit?: number; offset?: number } = {},
): Promise<ReprocessingCandidate[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const result = await client.query(
    `WITH fixes AS (
       SELECT * FROM jsonb_to_recordset($3::jsonb) AS fix(
         "issueCode" text,
         "affectedFieldPath" text,
         "introducedInParserVersion" text
       )
     )
     SELECT document.id AS document_id,
            run.id AS active_run_id,
            run.processing_version,
            run.parser_version,
            run.pipeline_fingerprint,
            bool_or(job.id IS NOT NULL) AS in_progress,
            COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
              'code', issue.code,
              'severity', issue.severity,
              'affectedFieldPath', issue.affected_field_path
            )) FILTER (WHERE issue.id IS NOT NULL), '[]'::jsonb) AS issues
       FROM documents document
       JOIN extraction_runs run
         ON run.id = document.active_extraction_run_id
        AND run.user_id = document.user_id
        AND run.document_id = document.id
       LEFT JOIN extraction_run_issues issue
         ON issue.user_id = run.user_id
        AND issue.document_id = run.document_id
        AND issue.extraction_run_id = run.id
        AND issue.recoverable
       LEFT JOIN fixes fix
         ON fix."issueCode" = issue.code
        AND fix."affectedFieldPath" IS NOT DISTINCT FROM issue.affected_field_path
        AND CASE
          WHEN fix."introducedInParserVersion" ~ '^[0-9]+$' AND $4 ~ '^[0-9]+$'
            THEN $4::integer >= fix."introducedInParserVersion"::integer
          ELSE fix."introducedInParserVersion" = $4
        END
       LEFT JOIN processing_jobs job
         ON job.user_id = document.user_id
        AND job.document_id = document.id
        AND (job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
             OR job.execution_owner IS NOT NULL)
      WHERE document.user_id = $1
        AND document.deleted_at IS NULL
        AND document.original_deleted_at IS NULL
        AND document.security_status = 'CLEAN'
        AND document.document_type = 'PAYROLL'
        AND ($2::uuid IS NULL OR document.id = $2)
        AND ($6::uuid[] IS NULL OR document.id = ANY($6::uuid[]))
        AND (run.pipeline_fingerprint IS DISTINCT FROM $5 OR ${ocrRetrySql("run")} OR ${hasNewDocumentLayoutSql("run")} OR ${countryRecoverySql("run")})
        AND ((fix."issueCode" IS NOT NULL AND CASE
          WHEN run.parser_version ~ '^[0-9]+$' AND fix."introducedInParserVersion" ~ '^[0-9]+$'
            THEN run.parser_version::integer < fix."introducedInParserVersion"::integer
          ELSE run.parser_version IS DISTINCT FROM fix."introducedInParserVersion"
        END) OR ${ocrRecoverySql("run", "issue")} OR ${hasNewDocumentLayoutSql("run")}
          OR ${layoutObservationSql("run", "issue")} OR ${countryRecoverySql("run")}
          OR ${earningsRecoverySql("run")})
        AND NOT EXISTS (
          SELECT 1 FROM extraction_runs attempted_run
           WHERE attempted_run.user_id = run.user_id
             AND attempted_run.document_id = run.document_id
             AND attempted_run.base_extraction_run_id = run.id
             AND attempted_run.pipeline_fingerprint = $5
             AND NOT (${ocrRetrySql("attempted_run")} OR ${hasNewDocumentLayoutSql("attempted_run")} OR ${countryRecoverySql("attempted_run")})
             AND (
               attempted_run.status = 'REVIEW_REQUIRED'
               OR attempted_run.promotion_outcome IN ('PROMOTED', 'UNCHANGED', 'REVIEW_REQUIRED', 'REJECTED_REGRESSION')
             )
        )
      GROUP BY document.id, run.id
      ORDER BY document.created_at, document.id
      LIMIT $7 OFFSET $8`,
    [
      userId,
      options.documentId ?? null,
      fixesJson,
      processingPipelineVersions.parser,
      currentPipelineFingerprint,
      options.documentIds?.length ? [...options.documentIds] : null,
      limit,
      offset,
    ],
  );
  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    activeRunId: String(row.active_run_id),
    activeProcessingVersion: Number(row.processing_version),
    parserVersion: String(row.parser_version),
    pipelineFingerprint: row.pipeline_fingerprint === null ? null : String(row.pipeline_fingerprint),
    inProgress: row.in_progress === true,
    issues: Array.isArray(row.issues)
      ? row.issues.map((issue: Record<string, unknown>) => ({
          code: String(issue.code),
          severity: String(issue.severity),
          affectedFieldPath: issue.affectedFieldPath === null ? null : String(issue.affectedFieldPath),
        }))
      : [],
  }));
}

export async function countReprocessingCandidates(
  client: Queryable,
  userId: string,
  documentIds?: readonly string[],
) {
  const predicate = reprocessingCandidateExistsSql("document", "$2", "$3", "$4");
  const result = await client.query(
    `SELECT count(*)::integer AS count
       FROM documents document
      WHERE document.user_id = $1
        AND ($5::uuid[] IS NULL OR document.id = ANY($5::uuid[]))
        AND ${predicate}`,
    [
      userId,
      fixesJson,
      processingPipelineVersions.parser,
      currentPipelineFingerprint,
      documentIds?.length ? [...documentIds] : null,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function enqueueReprocessing(
  client: PoolClient,
  input: {
    userId: string;
    requestedByUserId: string;
    documentId: string;
    requestedKey: string;
    triggerKind: ProcessingTriggerKind;
    batchId?: string | null;
    allowRetry?: boolean;
  },
  ApiError: ApiErrorConstructor,
): Promise<EnqueuedReprocessing> {
  if (!reprocessTriggers.has(input.triggerKind)) throw new Error("INVALID_REPROCESS_TRIGGER");
  const idempotencyKey = `reprocess:${input.triggerKind}:${input.userId}:${input.documentId}:${createHash("sha256").update(input.requestedKey).digest("hex")}`;
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
  const document = await client.query(
    `SELECT processing_status, security_status, document_type, original_deleted_at,
            active_extraction_run_id
       FROM documents
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [input.documentId, input.userId],
  );
  if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
  const row = document.rows[0];
  const existing = await client.query(
    `SELECT id, state, processing_version, stage
       FROM processing_jobs
      WHERE document_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [input.documentId, input.userId, idempotencyKey],
  );
  if (existing.rowCount) {
    return {
      created: false,
      documentId: input.documentId,
      activeRunId: row.active_extraction_run_id === null ? null : String(row.active_extraction_run_id),
      processingStatus: String(row.processing_status),
      job: {
        id: String(existing.rows[0].id),
        state: String(existing.rows[0].state),
        processingVersion: Number(existing.rows[0].processing_version),
        stage: String(existing.rows[0].stage),
      },
    };
  }
  if (row.original_deleted_at !== null) {
    throw new ApiError(409, "ORIGINAL_NOT_AVAILABLE", "El original no está disponible para reprocesarlo.");
  }
  if (row.security_status !== "CLEAN" || row.document_type !== "PAYROLL") {
    throw new ApiError(409, "REPROCESS_NOT_ALLOWED", "El documento no es elegible para reprocesamiento.");
  }
  const activeJob = await client.query(
    `SELECT 1 FROM processing_jobs
      WHERE document_id = $1 AND user_id = $2
        AND (state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE') OR execution_owner IS NOT NULL)
      LIMIT 1`,
    [input.documentId, input.userId],
  );
  if (activeJob.rowCount) {
    throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento actual.");
  }
  const candidates = await findReprocessingCandidates(client, input.userId, {
    documentId: input.documentId,
    limit: 1,
  });
  const retryableStatus = ["FAILED_PERMANENT", "CANCELLED"].includes(String(row.processing_status));
  if (!candidates.length && !(input.allowRetry === true && retryableStatus)) {
    throw new ApiError(409, "REPROCESS_NOT_AVAILABLE", "No hay una mejora compatible disponible para este documento.");
  }
  const version = await client.query(
    `SELECT GREATEST(
              COALESCE((SELECT max(processing_version) FROM processing_jobs
                         WHERE document_id = $1 AND user_id = $2), 0),
              COALESCE((SELECT max(processing_version) FROM extraction_runs
                         WHERE document_id = $1 AND user_id = $2), 0)
            )::integer + 1 AS processing_version`,
    [input.documentId, input.userId],
  );
  const processingVersion = Number(version.rows[0].processing_version);
  const activeRunId = row.active_extraction_run_id === null ? null : String(row.active_extraction_run_id);
  const stage = "DOCUMENT_PIPELINE_V2";
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO processing_jobs (
       id, user_id, document_id, stage, processing_version, idempotency_key,
       previous_document_status, trigger_kind, requested_by_user_id,
       base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      jobId,
      input.userId,
      input.documentId,
      stage,
      processingVersion,
      idempotencyKey,
      ["COMPLETED", "NEEDS_REVIEW", "FAILED_PERMANENT", "CANCELLED"].includes(String(row.processing_status))
        ? row.processing_status
        : null,
      input.triggerKind,
      input.requestedByUserId,
      activeRunId,
      input.batchId ?? null,
      currentPipelineFingerprint,
    ],
  );
  return {
    created: true,
    documentId: input.documentId,
    activeRunId,
    processingStatus: String(row.processing_status),
    job: { id: jobId, state: "PENDING", processingVersion, stage },
  };
}

export async function enqueueReprocessingBatch(
  client: PoolClient,
  input: {
    userId: string;
    requestedByUserId: string;
    documentIds: readonly string[];
    triggerKind: "USER_REPROCESS" | "ADMIN_REPROCESS";
    batchId: string;
  },
  ApiError: ApiErrorConstructor,
) {
  if (!input.documentIds.length) return;
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
  const jobIds = input.documentIds.map(() => randomUUID());
  const idempotencyKeys = input.documentIds.map((documentId) =>
    `reprocess:${input.triggerKind}:${input.userId}:${documentId}:${createHash("sha256").update(`${input.batchId}:${documentId}`).digest("hex")}`);
  const inserted = await client.query(
    `WITH requested AS (
       SELECT * FROM unnest($5::uuid[], $6::uuid[], $7::text[])
         AS item(job_id, document_id, idempotency_key)
     ), locked AS (
       SELECT item.*, document.processing_status, document.active_extraction_run_id
         FROM requested item
         JOIN documents document ON document.id = item.document_id AND document.user_id = $1
        WHERE document.deleted_at IS NULL AND document.original_deleted_at IS NULL
          AND document.security_status = 'CLEAN' AND document.document_type = 'PAYROLL'
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs active_job
             WHERE active_job.user_id = document.user_id
               AND active_job.document_id = document.id
               AND (active_job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                    OR active_job.execution_owner IS NOT NULL)
          )
        ORDER BY document.id
        FOR UPDATE OF document
     )
     INSERT INTO processing_jobs (
       id, user_id, document_id, stage, processing_version, idempotency_key,
       previous_document_status, trigger_kind, requested_by_user_id,
       base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint
     )
     SELECT locked.job_id, $1, locked.document_id, 'DOCUMENT_PIPELINE_V2',
            GREATEST(
              COALESCE((SELECT max(job.processing_version) FROM processing_jobs job
                         WHERE job.user_id = $1 AND job.document_id = locked.document_id), 0),
              COALESCE((SELECT max(run.processing_version) FROM extraction_runs run
                         WHERE run.user_id = $1 AND run.document_id = locked.document_id), 0)
            ) + 1,
            locked.idempotency_key,
            CASE WHEN locked.processing_status IN ('COMPLETED', 'NEEDS_REVIEW', 'FAILED_PERMANENT', 'CANCELLED')
              THEN locked.processing_status ELSE NULL END,
            $4, $2, locked.active_extraction_run_id, $3, $8
       FROM locked
     RETURNING document_id`,
    [input.userId, input.requestedByUserId, input.batchId, input.triggerKind,
      jobIds, [...input.documentIds], idempotencyKeys, currentPipelineFingerprint],
  );
  if (inserted.rowCount !== input.documentIds.length) {
    throw new ApiError(409, "BATCH_CONTAINS_UNAVAILABLE_DOCUMENT", "Uno o más documentos dejaron de estar disponibles para reprocesar.");
  }
}

export async function loadProcessingAnalysis(client: PoolClient, userId: string, documentId: string) {
  const runs = await client.query(
    `SELECT run.id, run.processing_version, run.status, run.trigger_kind,
            run.parser_version, run.result_schema_version, run.pipeline_fingerprint,
            run.promotion_outcome, run.comparison_summary, run.promoted_at,
            run.started_at, run.finished_at,
            document.active_extraction_run_id,
            document.processing_status AS document_processing_status,
            document.security_status AS document_security_status,
            document.document_type,
            document.original_deleted_at,
            EXISTS (
              SELECT 1 FROM processing_jobs active_job
               WHERE active_job.user_id = document.user_id
                 AND active_job.document_id = document.id
                 AND (active_job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                      OR active_job.execution_owner IS NOT NULL)
            ) AS has_active_job,
            (run.id = document.active_extraction_run_id) AS active,
            (run.id IS DISTINCT FROM document.active_extraction_run_id
              AND run.status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REVIEW_REQUIRED')
              AND run.promotion_outcome = 'REVIEW_REQUIRED'
              AND run.pipeline_fingerprint = $3
              AND run.base_extraction_run_id IS NOT DISTINCT FROM document.active_extraction_run_id
            ) AS decision_required
       FROM documents document
       LEFT JOIN LATERAL (
         SELECT current.* FROM extraction_runs current
          WHERE current.user_id = document.user_id AND current.document_id = document.id
          ORDER BY current.processing_version DESC, current.id DESC LIMIT 1
       ) run ON true
      WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL`,
    [documentId, userId, currentPipelineFingerprint],
  );
  const issues = await client.query(
    `SELECT issue.id, issue.code, issue.severity, issue.recoverable,
            issue.affected_field_path, issue.created_at
       FROM documents document
       JOIN extraction_run_issues issue
        ON issue.user_id = document.user_id
        AND issue.document_id = document.id
        AND issue.extraction_run_id = COALESCE(
          document.active_extraction_run_id,
          (SELECT latest.id FROM extraction_runs latest
            WHERE latest.user_id = document.user_id AND latest.document_id = document.id
            ORDER BY latest.processing_version DESC, latest.id DESC LIMIT 1)
        )
      WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
        AND NOT (
          issue.code = 'COUNTRY_UNCONFIRMED'
          AND document.country_code = 'AR'
          AND document.country_source = 'EMPLOYMENT_CONFIRMED'
          AND EXISTS (SELECT 1 FROM employments employment
            WHERE employment.id = document.employment_id
              AND employment.user_id = document.user_id
              AND employment.country_confirmed_at IS NOT NULL
              AND employment.country_code = document.country_code)
        )
      ORDER BY issue.severity DESC, issue.code, issue.affected_field_path`,
    [documentId, userId],
  );
  const candidate = await findReprocessingCandidates(client, userId, { documentId, limit: 1 });
  const current = runs.rows[0];
  const hasCurrentRun = current?.id !== null && current?.id !== undefined;
  const issueViews = issues.rows.map((issue) => ({
    id: String(issue.id),
    code: String(issue.code),
    severity: String(issue.severity),
    recoverable: issue.recoverable === true,
    affectedFieldPath: issue.affected_field_path === null ? null : String(issue.affected_field_path),
    message: issue.affected_field_path === "settlement.basicAmount"
      ? "No pudimos identificar el sueldo básico de este recibo."
      : issue.severity === "ERROR"
        ? "No pudimos completar el análisis de este recibo."
      : "Hay datos del recibo que no pudimos identificar.",
    createdAt: timestamp(issue.created_at),
  }));
  const inProgress = current?.has_active_job === true
    || (hasCurrentRun && ["RUNNING", "PROCESSING"].includes(String(current.status)));
  const analysisStatus = hasCurrentRun
    && current.active === true
    && current.status === "COMPLETED"
    && issueViews.some(({ severity }) => severity === "WARNING" || severity === "ERROR")
    ? "COMPLETED_WITH_WARNINGS"
    : hasCurrentRun ? String(current.status) : "UNAVAILABLE";
  const retryAvailable = current?.active_extraction_run_id === null
    && ["FAILED_PERMANENT", "CANCELLED"].includes(String(current.document_processing_status))
    && current.document_security_status === "CLEAN"
    && current.document_type === "PAYROLL"
    && current.original_deleted_at === null
    && current.has_active_job !== true;
  const currentIsReprocessing = hasCurrentRun && reprocessTriggers.has(String(current.trigger_kind) as ProcessingTriggerKind);
  const latestOutcome = !currentIsReprocessing || ["RUNNING", "PROCESSING"].includes(String(current.status))
    ? null
    : current.status === "FAILED"
      ? "FAILED"
      : current.status === "CANCELLED"
        ? "CANCELLED"
        : String(current.promotion_outcome);
  return {
    status: analysisStatus,
    activeRunId: current?.active_extraction_run_id === null || current?.active_extraction_run_id === undefined
      ? null
      : String(current.active_extraction_run_id),
    currentRun: hasCurrentRun ? processingRunView(current) : null,
    issues: issueViews,
    reprocess: {
      available: candidate.length > 0 && !candidate[0]!.inProgress,
      retryAvailable,
      inProgress: inProgress || candidate[0]?.inProgress === true,
      latestOutcome,
    },
  };
}

export function processingRunView(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    processingVersion: Number(row.processing_version),
    status: String(row.status),
    triggerKind: String(row.trigger_kind),
    parserVersion: String(row.parser_version),
    resultSchemaVersion: row.result_schema_version === null ? null : String(row.result_schema_version),
    pipelineFingerprint: row.pipeline_fingerprint === null ? null : String(row.pipeline_fingerprint),
    promotionOutcome: String(row.promotion_outcome),
    comparisonSummary: row.comparison_summary ?? {},
    promotedAt: timestamp(row.promoted_at),
    startedAt: timestamp(row.started_at),
    finishedAt: timestamp(row.finished_at),
    active: row.active === true,
    decisionRequired: row.decision_required === true,
  };
}

export async function loadProcessingComparisonPreview(
  client: Queryable,
  userId: string,
  documentId: string,
  runId: string,
  includeLineItemChanges = false,
) {
  const selected = await client.query(
    `WITH target AS (
       SELECT id, base_extraction_run_id
         FROM extraction_runs
        WHERE id = $1 AND user_id = $2 AND document_id = $3
     )
      SELECT run.id,
             target.base_extraction_run_id,
             settlement.id AS settlement_id,
             to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
            settlement.settlement_type,
            settlement.currency_code,
            settlement.basic_amount::text,
            settlement.gross_amount::text,
            settlement.net_amount::text,
            settlement.remunerative_amount::text,
            settlement.non_remunerative_amount::text,
            settlement.deductions_amount::text,
            COALESCE(
              correction.corrected_value #>> '{}',
              detected_employer.name,
              employer_field.interpreted_value #>> '{}'
            ) AS employer_name,
             COALESCE(items.item_count, 0)::integer AS item_count,
             items.fingerprint AS line_items_fingerprint,
             items.line_items
       FROM target
       JOIN extraction_runs run
         ON run.user_id = $2 AND run.document_id = $3
        AND run.id IN (target.id, target.base_extraction_run_id)
       LEFT JOIN payroll_settlements settlement
         ON settlement.user_id = run.user_id AND settlement.document_id = run.document_id
        AND settlement.extraction_run_id = run.id AND settlement.settlement_ordinal = 1
       LEFT JOIN employers detected_employer ON detected_employer.id = run.detected_employer_id
       LEFT JOIN LATERAL (
         SELECT current.corrected_value
           FROM user_corrections current
          WHERE current.user_id = run.user_id AND current.document_id = run.document_id
            AND current.extraction_run_id = run.id AND current.field_path = 'employer.name'
          ORDER BY current.correction_version DESC, current.created_at DESC, current.id DESC LIMIT 1
       ) correction ON true
       LEFT JOIN extracted_fields employer_field
         ON employer_field.user_id = run.user_id AND employer_field.document_id = run.document_id
        AND employer_field.extraction_run_id = run.id AND employer_field.field_path = 'employer.name'
       LEFT JOIN LATERAL (
          SELECT count(*)::integer AS item_count,
                 md5(COALESCE(jsonb_agg(jsonb_build_array(
                   item.item_type, item.normalized_concept_code, item.amount::text,
                   item.currency_code, item.is_recurring
                 ) ORDER BY item.item_ordinal, item.id)::text, '[]')) AS fingerprint,
                 CASE WHEN $4::boolean THEN COALESCE(jsonb_agg(jsonb_build_object(
                   'itemOrdinal', item.item_ordinal,
                   'rawDescription', item.raw_description,
                   'normalizedConceptCode', item.normalized_concept_code,
                   'amount', item.amount::text,
                   'currencyCode', item.currency_code,
                   'itemType', item.item_type,
                   'isRecurring', item.is_recurring
                 ) ORDER BY item.item_ordinal, item.id), '[]'::jsonb) END AS line_items
           FROM payroll_line_items item
          WHERE item.user_id = settlement.user_id AND item.settlement_id = settlement.id
       ) items ON true`,
    [runId, userId, documentId, includeLineItemChanges],
  );
  const candidate = selected.rows.find((row) => String(row.id) === runId);
  const baseRunId = candidate?.base_extraction_run_id === null || candidate?.base_extraction_run_id === undefined
    ? null
    : String(candidate.base_extraction_run_id);
  if (!candidate || !baseRunId || candidate.settlement_id === null) return null;
  const base = selected.rows.find((row) => String(row.id) === baseRunId);
  if (!base) return null;
  const lineItems = (row: Record<string, unknown>) => (Array.isArray(row.line_items) ? row.line_items : [])
    .map((item) => {
      const value = item as Record<string, unknown>;
      return {
        itemOrdinal: Number(value.itemOrdinal),
        rawDescription: String(value.rawDescription ?? ''),
        normalizedConceptCode: value.normalizedConceptCode === null ? null : String(value.normalizedConceptCode),
        amount: String(value.amount),
        currencyCode: String(value.currencyCode),
        itemType: String(value.itemType),
        isRecurring: value.isRecurring === true ? true : value.isRecurring === false ? false : null,
      };
    });
  const beforeItems = new Map(lineItems(base).map((item) => [item.itemOrdinal, item]));
  const afterItems = new Map(lineItems(candidate).map((item) => [item.itemOrdinal, item]));
  const changedLineItems = [...new Set([...beforeItems.keys(), ...afterItems.keys()])]
    .sort((left, right) => left - right)
    .flatMap((itemOrdinal) => {
      const before = beforeItems.get(itemOrdinal) ?? null;
      const after = afterItems.get(itemOrdinal) ?? null;
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ itemOrdinal, before, after }];
    });
  const fields = [
    ["employer.name", "employer_name"],
    ["settlement.payrollPeriod", "payroll_period"],
    ["settlement.type", "settlement_type"],
    ["settlement.currencyCode", "currency_code"],
    ["settlement.basicAmount", "basic_amount"],
    ["settlement.grossAmount", "gross_amount"],
    ["settlement.netAmount", "net_amount"],
    ["settlement.remunerativeAmount", "remunerative_amount"],
    ["settlement.nonRemunerativeAmount", "non_remunerative_amount"],
    ["settlement.deductionsAmount", "deductions_amount"],
  ] as const;
  return {
    baseRunId,
    candidateRunId: runId,
    fields: fields.map(([fieldPath, column]) => {
      const before = base[column] === null || base[column] === undefined ? null : String(base[column]);
      const after = candidate[column] === null || candidate[column] === undefined ? null : String(candidate[column]);
      return {
        fieldPath,
        before,
        after,
        change: before === after ? "UNCHANGED" : before === null ? "ADDED" : after === null ? "REMOVED" : "CHANGED",
      };
    }),
    lineItems: {
      beforeCount: Number(base.item_count ?? 0),
      afterCount: Number(candidate.item_count ?? 0),
      changed: base.line_items_fingerprint !== candidate.line_items_fingerprint,
      changes: changedLineItems,
    },
  };
}

export type CompatibleProcessingRun = {
  documentId: string;
  runId: string;
  expectedActiveRunId: string;
};

function processingComparisonShape(
  preview: NonNullable<Awaited<ReturnType<typeof loadProcessingComparisonPreview>>>,
) {
  return JSON.stringify({
    fields: preview.fields
      .filter(({ change }) => change !== "UNCHANGED")
      .map(({ fieldPath, change }) => `${fieldPath}:${change}`)
      .sort(),
    lineItems: preview.lineItems,
  });
}

export async function findCompatibleProcessingRuns(
  client: Queryable,
  input: { userId: string; documentId: string; runId: string },
): Promise<CompatibleProcessingRun[]> {
  const result = await client.query(
    `WITH source AS (
       SELECT source_run.*, source_document.employment_id,
              source_job.reprocessing_batch_id,
              source_settlement.currency_code, source_settlement.settlement_type,
               source_transition.signature AS line_item_transition_signature,
              source_base.pipeline_fingerprint AS base_pipeline_fingerprint,
              source_base.classifier_name AS base_classifier_name,
              source_base.classifier_version AS base_classifier_version,
              source_base.extractor_name AS base_extractor_name,
              source_base.extractor_version AS base_extractor_version,
              source_base.parser_version AS base_parser_version,
              source_base.normalizer_version AS base_normalizer_version,
              source_base.result_schema_version AS base_result_schema_version,
              source_base.ocr_provider AS base_ocr_provider,
              source_base.ocr_version AS base_ocr_version,
              source_base.ocr_language AS base_ocr_language,
              COALESCE((SELECT jsonb_agg(jsonb_build_array(issue.code, issue.severity, issue.affected_field_path)
                ORDER BY issue.code, issue.severity, issue.affected_field_path)
                FROM extraction_run_issues issue WHERE issue.user_id = source_run.user_id
                  AND issue.document_id = source_run.document_id AND issue.extraction_run_id = source_run.id), '[]'::jsonb) AS issue_signature,
              COALESCE((SELECT jsonb_agg(jsonb_build_array(issue.code, issue.severity, issue.affected_field_path)
                ORDER BY issue.code, issue.severity, issue.affected_field_path)
                FROM extraction_run_issues issue WHERE issue.user_id = source_base.user_id
                  AND issue.document_id = source_base.document_id AND issue.extraction_run_id = source_base.id), '[]'::jsonb) AS base_issue_signature
         FROM extraction_runs source_run
         JOIN documents source_document ON source_document.id = source_run.document_id AND source_document.user_id = source_run.user_id
         JOIN employments source_employment ON source_employment.id = source_document.employment_id
           AND source_employment.user_id = source_document.user_id
         JOIN extraction_runs source_base ON source_base.id = source_document.active_extraction_run_id
           AND source_base.user_id = source_document.user_id AND source_base.document_id = source_document.id
         JOIN processing_jobs source_job ON source_job.user_id = source_run.user_id
           AND source_job.document_id = source_run.document_id AND source_job.processing_version = source_run.processing_version
         JOIN payroll_settlements source_settlement ON source_settlement.user_id = source_run.user_id
           AND source_settlement.document_id = source_run.document_id AND source_settlement.extraction_run_id = source_run.id
           AND source_settlement.settlement_ordinal = 1
         JOIN payroll_settlements source_base_settlement ON source_base_settlement.user_id = source_base.user_id
           AND source_base_settlement.document_id = source_base.document_id
           AND source_base_settlement.extraction_run_id = source_base.id
           AND source_base_settlement.settlement_ordinal = 1
         CROSS JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(jsonb_build_array(
                     transition.item_ordinal,
                     lower(btrim(COALESCE(base_item.raw_description, ''))),
                     base_item.item_type, candidate_item.item_type,
                    base_item.normalized_concept_code, candidate_item.normalized_concept_code,
                    base_item.currency_code, candidate_item.currency_code,
                    base_item.is_recurring, candidate_item.is_recurring,
                    base_item.amount IS DISTINCT FROM candidate_item.amount
                   ) ORDER BY transition.item_ordinal), '[]'::jsonb) AS signature,
                   bool_and(base_item.id IS NOT NULL AND candidate_item.id IS NOT NULL
                     AND lower(btrim(base_item.raw_description)) = lower(btrim(candidate_item.raw_description))) AS descriptions_unchanged
             FROM (
               SELECT item.item_ordinal FROM payroll_line_items item
                WHERE item.user_id = source_base.user_id AND item.settlement_id = source_base_settlement.id
               UNION
               SELECT item.item_ordinal FROM payroll_line_items item
                WHERE item.user_id = source_run.user_id AND item.settlement_id = source_settlement.id
             ) transition
             LEFT JOIN payroll_line_items base_item ON base_item.user_id = source_base.user_id
              AND base_item.settlement_id = source_base_settlement.id
              AND base_item.item_ordinal = transition.item_ordinal
             LEFT JOIN payroll_line_items candidate_item ON candidate_item.user_id = source_run.user_id
              AND candidate_item.settlement_id = source_settlement.id
              AND candidate_item.item_ordinal = transition.item_ordinal
         ) source_transition
        WHERE source_run.id = $1 AND source_run.document_id = $2 AND source_run.user_id = $3
          AND source_run.status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS')
          AND source_run.promotion_outcome = 'REVIEW_REQUIRED'
          AND source_run.comparison_summary ->> 'comparison' = 'REVIEW_REQUIRED'
           AND source_run.pipeline_fingerprint = $4
           AND source_run.parser_version = $5
           AND source_base.parser_version ~ '^[0-9]{1,8}$'
           AND source_base.parser_version::integer < $5::integer
          AND source_run.base_extraction_run_id = source_document.active_extraction_run_id
          AND source_document.deleted_at IS NULL AND source_document.original_deleted_at IS NULL
          AND source_document.security_status = 'CLEAN' AND source_document.document_type = 'PAYROLL'
          AND source_document.employment_id IS NOT NULL
          AND source_run.detected_employer_id = source_employment.employer_id
          AND (source_run.country_code IS NULL OR source_document.country_code IS NULL
            OR source_run.country_code = source_document.country_code)
          AND (source_run.country_code IS NULL OR source_employment.country_confirmed_at IS NULL
            OR source_run.country_code = source_employment.country_code)
          AND NOT EXISTS (SELECT 1 FROM extraction_run_issues country_issue
            WHERE country_issue.user_id = source_run.user_id
              AND country_issue.document_id = source_run.document_id
              AND country_issue.extraction_run_id = source_run.id
              AND country_issue.code IN ('COUNTRY_UNCONFIRMED', 'COUNTRY_EMPLOYMENT_CONFLICT',
                'COUNTRY_SNAPSHOT_CONFLICT', 'COUNTRY_NOT_SUPPORTED'))
          AND source_employment.currency_code = source_settlement.currency_code
          AND source_settlement.is_recurring IS NOT DISTINCT FROM source_base_settlement.is_recurring
          AND source_settlement.payment_date IS NOT DISTINCT FROM source_base_settlement.payment_date
          AND source_settlement.issue_date IS NOT DISTINCT FROM source_base_settlement.issue_date
          AND source_settlement.employment_id = source_document.employment_id
           AND source_base_settlement.employment_id = source_document.employment_id
           AND source_transition.descriptions_unchanged
           AND source_base_settlement.gross_amount = source_base_settlement.remunerative_amount
             + source_base_settlement.non_remunerative_amount
           AND (SELECT COALESCE(sum(item.amount), 0) FROM payroll_line_items item
             WHERE item.user_id = source_base.user_id AND item.settlement_id = source_base_settlement.id
               AND item.item_type = 'EARNING') IS DISTINCT FROM source_base_settlement.gross_amount
           AND (SELECT COALESCE(sum(item.amount), 0) FROM payroll_line_items item
             WHERE item.user_id = source_run.user_id AND item.settlement_id = source_settlement.id
               AND item.item_type = 'EARNING') IS NOT DISTINCT FROM source_settlement.gross_amount
          AND (SELECT count(*) FROM payroll_settlements settlement_count
            WHERE settlement_count.user_id = source_run.user_id
              AND settlement_count.document_id = source_run.document_id
              AND settlement_count.extraction_run_id = source_run.id) = 1
          AND (SELECT count(*) FROM payroll_settlements settlement_count
            WHERE settlement_count.user_id = source_base.user_id
              AND settlement_count.document_id = source_base.document_id
              AND settlement_count.extraction_run_id = source_base.id) = 1
          AND date_trunc('month', source_employment.start_date)::date <= source_settlement.payroll_period
          AND (source_employment.end_date IS NULL
            OR date_trunc('month', source_employment.end_date)::date >= source_settlement.payroll_period)
          AND source_run.layout_fingerprint IS NOT NULL
          AND source_job.reprocessing_batch_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM processing_jobs active_job
            WHERE active_job.user_id = source_document.user_id AND active_job.document_id = source_document.id
              AND (active_job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE') OR active_job.execution_owner IS NOT NULL))
     ), candidates AS (
       SELECT source.document_id, source.id AS run_id, source.base_extraction_run_id AS expected_active_run_id
         FROM source
       UNION ALL
       SELECT candidate.document_id, candidate.id, candidate.base_extraction_run_id
         FROM source
         JOIN processing_jobs peer_job ON peer_job.user_id = source.user_id
          AND peer_job.reprocessing_batch_id = source.reprocessing_batch_id
          AND peer_job.document_id <> source.document_id
         JOIN extraction_runs candidate ON candidate.user_id = peer_job.user_id
          AND candidate.document_id = peer_job.document_id AND candidate.processing_version = peer_job.processing_version
         JOIN documents document ON document.id = candidate.document_id AND document.user_id = candidate.user_id
         JOIN employments employment ON employment.id = document.employment_id
           AND employment.user_id = document.user_id
         JOIN extraction_runs base ON base.id = document.active_extraction_run_id
          AND base.user_id = document.user_id AND base.document_id = document.id
         JOIN payroll_settlements settlement ON settlement.user_id = candidate.user_id
          AND settlement.document_id = candidate.document_id AND settlement.extraction_run_id = candidate.id
          AND settlement.settlement_ordinal = 1
         JOIN payroll_settlements base_settlement ON base_settlement.user_id = base.user_id
          AND base_settlement.document_id = base.document_id AND base_settlement.extraction_run_id = base.id
          AND base_settlement.settlement_ordinal = 1
         CROSS JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(jsonb_build_array(
                     transition.item_ordinal,
                     lower(btrim(COALESCE(base_item.raw_description, ''))),
                     base_item.item_type, candidate_item.item_type,
                    base_item.normalized_concept_code, candidate_item.normalized_concept_code,
                    base_item.currency_code, candidate_item.currency_code,
                    base_item.is_recurring, candidate_item.is_recurring,
                    base_item.amount IS DISTINCT FROM candidate_item.amount
                   ) ORDER BY transition.item_ordinal), '[]'::jsonb) AS signature,
                   bool_and(base_item.id IS NOT NULL AND candidate_item.id IS NOT NULL
                     AND lower(btrim(base_item.raw_description)) = lower(btrim(candidate_item.raw_description))) AS descriptions_unchanged
             FROM (
               SELECT item.item_ordinal FROM payroll_line_items item
                WHERE item.user_id = base.user_id AND item.settlement_id = base_settlement.id
               UNION
               SELECT item.item_ordinal FROM payroll_line_items item
                WHERE item.user_id = candidate.user_id AND item.settlement_id = settlement.id
             ) transition
             LEFT JOIN payroll_line_items base_item ON base_item.user_id = base.user_id
              AND base_item.settlement_id = base_settlement.id
              AND base_item.item_ordinal = transition.item_ordinal
             LEFT JOIN payroll_line_items candidate_item ON candidate_item.user_id = candidate.user_id
              AND candidate_item.settlement_id = settlement.id
              AND candidate_item.item_ordinal = transition.item_ordinal
         ) peer_transition
        WHERE candidate.status = source.status
          AND candidate.promotion_outcome = 'REVIEW_REQUIRED'
          AND candidate.comparison_summary ->> 'comparison' = 'REVIEW_REQUIRED'
          AND candidate.pipeline_fingerprint = source.pipeline_fingerprint
          AND candidate.base_extraction_run_id = document.active_extraction_run_id
          AND document.deleted_at IS NULL AND document.original_deleted_at IS NULL
          AND document.security_status = 'CLEAN' AND document.document_type = 'PAYROLL'
          AND document.employment_id = source.employment_id
          AND candidate.detected_employer_id = employment.employer_id
          AND candidate.detected_employer_id = source.detected_employer_id
          AND candidate.country_code IS NOT DISTINCT FROM source.country_code
          AND (candidate.country_code IS NULL OR document.country_code IS NULL
            OR candidate.country_code = document.country_code)
          AND (candidate.country_code IS NULL OR employment.country_confirmed_at IS NULL
            OR candidate.country_code = employment.country_code)
          AND NOT EXISTS (SELECT 1 FROM extraction_run_issues country_issue
            WHERE country_issue.user_id = candidate.user_id
              AND country_issue.document_id = candidate.document_id
              AND country_issue.extraction_run_id = candidate.id
              AND country_issue.code IN ('COUNTRY_UNCONFIRMED', 'COUNTRY_EMPLOYMENT_CONFLICT',
                'COUNTRY_SNAPSHOT_CONFLICT', 'COUNTRY_NOT_SUPPORTED'))
          AND candidate.layout_fingerprint = source.layout_fingerprint
          AND candidate.layout_fingerprint_version = source.layout_fingerprint_version
          AND candidate.document_layout_version_id IS NOT DISTINCT FROM source.document_layout_version_id
          AND candidate.classifier_name IS NOT DISTINCT FROM source.classifier_name
          AND candidate.classifier_version IS NOT DISTINCT FROM source.classifier_version
          AND candidate.extractor_name = source.extractor_name
          AND candidate.extractor_version IS NOT DISTINCT FROM source.extractor_version
          AND candidate.parser_version IS NOT DISTINCT FROM source.parser_version
          AND candidate.normalizer_version IS NOT DISTINCT FROM source.normalizer_version
          AND candidate.result_schema_version IS NOT DISTINCT FROM source.result_schema_version
          AND candidate.ocr_provider IS NOT DISTINCT FROM source.ocr_provider
          AND candidate.ocr_version IS NOT DISTINCT FROM source.ocr_version
          AND candidate.ocr_language IS NOT DISTINCT FROM source.ocr_language
          AND settlement.currency_code = source.currency_code
          AND settlement.settlement_type = source.settlement_type
          AND settlement.is_recurring IS NOT DISTINCT FROM base_settlement.is_recurring
          AND settlement.payment_date IS NOT DISTINCT FROM base_settlement.payment_date
          AND settlement.issue_date IS NOT DISTINCT FROM base_settlement.issue_date
          AND settlement.employment_id = document.employment_id
           AND base_settlement.employment_id = document.employment_id
           AND peer_transition.descriptions_unchanged
           AND base_settlement.gross_amount = base_settlement.remunerative_amount
             + base_settlement.non_remunerative_amount
           AND (SELECT COALESCE(sum(item.amount), 0) FROM payroll_line_items item
             WHERE item.user_id = base.user_id AND item.settlement_id = base_settlement.id
               AND item.item_type = 'EARNING') IS DISTINCT FROM base_settlement.gross_amount
           AND (SELECT COALESCE(sum(item.amount), 0) FROM payroll_line_items item
             WHERE item.user_id = candidate.user_id AND item.settlement_id = settlement.id
               AND item.item_type = 'EARNING') IS NOT DISTINCT FROM settlement.gross_amount
          AND peer_transition.signature = source.line_item_transition_signature
          AND employment.currency_code = settlement.currency_code
          AND (SELECT count(*) FROM payroll_settlements settlement_count
            WHERE settlement_count.user_id = candidate.user_id
              AND settlement_count.document_id = candidate.document_id
              AND settlement_count.extraction_run_id = candidate.id) = 1
          AND (SELECT count(*) FROM payroll_settlements settlement_count
            WHERE settlement_count.user_id = base.user_id
              AND settlement_count.document_id = base.document_id
              AND settlement_count.extraction_run_id = base.id) = 1
          AND date_trunc('month', employment.start_date)::date <= settlement.payroll_period
          AND (employment.end_date IS NULL
            OR date_trunc('month', employment.end_date)::date >= settlement.payroll_period)
          AND base.pipeline_fingerprint IS NOT DISTINCT FROM source.base_pipeline_fingerprint
          AND base.classifier_name IS NOT DISTINCT FROM source.base_classifier_name
          AND base.classifier_version IS NOT DISTINCT FROM source.base_classifier_version
          AND base.extractor_name = source.base_extractor_name
          AND base.extractor_version IS NOT DISTINCT FROM source.base_extractor_version
          AND base.parser_version IS NOT DISTINCT FROM source.base_parser_version
          AND base.normalizer_version IS NOT DISTINCT FROM source.base_normalizer_version
          AND base.result_schema_version IS NOT DISTINCT FROM source.base_result_schema_version
          AND base.ocr_provider IS NOT DISTINCT FROM source.base_ocr_provider
          AND base.ocr_version IS NOT DISTINCT FROM source.base_ocr_version
          AND base.ocr_language IS NOT DISTINCT FROM source.base_ocr_language
          AND COALESCE((SELECT jsonb_agg(jsonb_build_array(issue.code, issue.severity, issue.affected_field_path)
                ORDER BY issue.code, issue.severity, issue.affected_field_path)
                FROM extraction_run_issues issue WHERE issue.user_id = candidate.user_id
                  AND issue.document_id = candidate.document_id AND issue.extraction_run_id = candidate.id), '[]'::jsonb) = source.issue_signature
          AND COALESCE((SELECT jsonb_agg(jsonb_build_array(issue.code, issue.severity, issue.affected_field_path)
                ORDER BY issue.code, issue.severity, issue.affected_field_path)
                FROM extraction_run_issues issue WHERE issue.user_id = base.user_id
                  AND issue.document_id = base.document_id AND issue.extraction_run_id = base.id), '[]'::jsonb) = source.base_issue_signature
          AND NOT EXISTS (SELECT 1 FROM processing_jobs active_job
            WHERE active_job.user_id = document.user_id AND active_job.document_id = document.id
              AND (active_job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE') OR active_job.execution_owner IS NOT NULL))
     )
     SELECT document_id, run_id, expected_active_run_id
       FROM candidates ORDER BY (run_id = $1) DESC, document_id LIMIT 100`,
    [input.runId, input.documentId, input.userId, currentPipelineFingerprint, processingPipelineVersions.parser],
  );
  const candidates = result.rows.map((row) => ({
    documentId: String(row.document_id),
    runId: String(row.run_id),
    expectedActiveRunId: String(row.expected_active_run_id),
  }));
  // ponytail: bounded to 100 candidates; fold previews into the CTE if review latency becomes material.
  const previews: Array<Awaited<ReturnType<typeof loadProcessingComparisonPreview>>> = [];
  for (const candidate of candidates) {
    previews.push(await loadProcessingComparisonPreview(
      client, input.userId, candidate.documentId, candidate.runId,
    ));
  }
  const sourceIndex = candidates.findIndex(({ runId }) => runId === input.runId);
  const sourcePreview = previews[sourceIndex];
  if (!sourcePreview) return [];
  if (sourcePreview.fields.some(({ change }) => change !== "UNCHANGED")
    || !sourcePreview.lineItems.changed
    || sourcePreview.lineItems.beforeCount !== sourcePreview.lineItems.afterCount) return [];
  const sourceShape = processingComparisonShape(sourcePreview);
  return candidates.filter((_candidate, index) => {
    const preview = previews[index];
    return preview !== null && preview !== undefined && processingComparisonShape(preview) === sourceShape;
  });
}

export async function promoteProcessingRun(
  client: PoolClient,
  input: {
    userId: string;
    documentId: string;
    runId: string;
    expectedActiveRunId: string | null;
    decision: "PROMOTE" | "KEEP_ACTIVE";
    requireReviewCandidate?: boolean;
  },
  ApiError: ApiErrorConstructor,
) {
  await lockEmployerMutation(client);
  const document = await client.query(
    `SELECT active_extraction_run_id, security_status, employment_id, country_code FROM documents
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [input.documentId, input.userId],
  );
  if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
  const activeRunId = document.rows[0].active_extraction_run_id === null
    ? null
    : String(document.rows[0].active_extraction_run_id);
  if (activeRunId !== input.expectedActiveRunId) {
    throw new ApiError(409, "ACTIVE_RUN_CHANGED", "El análisis activo cambió; recargá antes de continuar.");
  }
  const activeJob = await client.query(
    `SELECT 1 FROM processing_jobs
      WHERE document_id = $1 AND user_id = $2
        AND (state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
             OR execution_owner IS NOT NULL)
      LIMIT 1`,
    [input.documentId, input.userId],
  );
  if (activeJob.rowCount) {
    throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento actual.");
  }
  const run = await client.query(
    `SELECT run.id, run.status, run.promotion_outcome, run.base_extraction_run_id,
            run.pipeline_fingerprint, run.detected_employer_id, run.confidence, run.country_code,
            run.comparison_summary ->> 'comparison' AS comparison,
            settlement.id IS NOT NULL AS has_settlement,
            settlement.payroll_period, settlement.currency_code
       FROM extraction_runs run
       LEFT JOIN LATERAL (
         SELECT current_settlement.id, current_settlement.payroll_period,
                current_settlement.currency_code
           FROM payroll_settlements current_settlement
          WHERE current_settlement.user_id = run.user_id
            AND current_settlement.document_id = run.document_id
            AND current_settlement.extraction_run_id = run.id
          ORDER BY current_settlement.settlement_ordinal
          LIMIT 1
       ) settlement ON true
      WHERE run.id = $1 AND run.document_id = $2 AND run.user_id = $3
      FOR UPDATE OF run`,
    [input.runId, input.documentId, input.userId],
  );
  if (!run.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
  if (!["COMPLETED", "COMPLETED_WITH_WARNINGS", "REVIEW_REQUIRED"].includes(String(run.rows[0].status))) {
    throw new ApiError(409, "RUN_NOT_PROMOTABLE", "El análisis todavía no puede activarse.");
  }
  if (input.requireReviewCandidate === true && (
    run.rows[0].promotion_outcome !== "REVIEW_REQUIRED"
    || (input.decision === "PROMOTE"
      && String(run.rows[0].base_extraction_run_id) !== String(input.expectedActiveRunId))
    || run.rows[0].pipeline_fingerprint !== currentPipelineFingerprint
  )) {
    throw new ApiError(409, "RUN_NOT_REVIEW_CANDIDATE", "Ese análisis no está esperando una decisión sobre el resultado activo.");
  }
  if (input.decision === "KEEP_ACTIVE") {
    if (input.runId === activeRunId) {
      throw new ApiError(409, "RUN_ALREADY_ACTIVE", "Ese análisis ya está activo.");
    }
    await client.query(
      `UPDATE extraction_runs
          SET promotion_outcome = 'REJECTED_REGRESSION', promoted_at = NULL
        WHERE id = $1 AND user_id = $2 AND document_id = $3`,
      [input.runId, input.userId, input.documentId],
    );
    return { activeRunId, decision: input.decision };
  }
  if (document.rows[0].security_status !== "CLEAN") {
    throw new ApiError(409, "REPROCESS_NOT_ALLOWED", "El documento no está habilitado para activar resultados.");
  }
  const countryIssues = await client.query(`SELECT 1 FROM extraction_run_issues
    WHERE extraction_run_id = $1 AND document_id = $2 AND user_id = $3
      AND code IN ('COUNTRY_UNCONFIRMED', 'COUNTRY_EMPLOYMENT_CONFLICT', 'COUNTRY_SNAPSHOT_CONFLICT', 'COUNTRY_NOT_SUPPORTED') LIMIT 1`,
  [input.runId, input.documentId, input.userId]);
  const confirmedEmployment = document.rows[0].employment_id ? await client.query(
    `SELECT country_code FROM employments WHERE id = $1 AND user_id = $2 AND country_confirmed_at IS NOT NULL FOR SHARE`,
    [document.rows[0].employment_id, input.userId]) : null;
  const runCountry = run.rows[0].country_code;
  if (countryIssues.rowCount || (runCountry && (
    (document.rows[0].country_code && document.rows[0].country_code !== runCountry)
    || (confirmedEmployment?.rows[0]?.country_code && confirmedEmployment.rows[0].country_code !== runCountry)
  ))) {
    throw new ApiError(409, 'COUNTRY_REVIEW_REQUIRED', 'Revisá el país y la asociación del empleo; después reprocesá el documento antes de activar este análisis.');
  }
  const activeCorrectionsChanged = await client.query(
    `WITH active_corrections AS (
       SELECT DISTINCT ON (correction.field_path)
              correction.field_path,
              COALESCE(correction.inherited_from_correction_id, correction.id) AS root_id,
              correction.corrected_value
         FROM user_corrections correction
        WHERE correction.user_id = $1 AND correction.document_id = $2
          AND correction.extraction_run_id = $3
        ORDER BY correction.field_path, correction.correction_version DESC,
                 correction.created_at DESC, correction.id DESC
     ), target_corrections AS (
       SELECT DISTINCT ON (correction.field_path)
              correction.field_path,
              COALESCE(correction.inherited_from_correction_id, correction.id) AS root_id,
              correction.corrected_value
         FROM user_corrections correction
        WHERE correction.user_id = $1 AND correction.document_id = $2
          AND correction.extraction_run_id = $4
        ORDER BY correction.field_path, correction.correction_version DESC,
                 correction.created_at DESC, correction.id DESC
     )
     SELECT 1
       FROM active_corrections active
       FULL JOIN target_corrections target USING (field_path)
      WHERE active.root_id IS DISTINCT FROM target.root_id
         OR active.corrected_value IS DISTINCT FROM target.corrected_value
      LIMIT 1`,
    [input.userId, input.documentId, activeRunId, input.runId],
  );
  if (activeCorrectionsChanged.rowCount) {
    throw new ApiError(409, "RUN_BASE_CHANGED", "La versión activa contiene correcciones distintas; generá una comparación nueva antes de reemplazarla.");
  }
  if (run.rows[0].has_settlement !== true) {
    throw new ApiError(409, "RUN_NOT_PROMOTABLE", "Ese análisis no contiene una liquidación estructurada para activar.");
  }
  if (input.requireReviewCandidate === true && run.rows[0].comparison !== "REVIEW_REQUIRED") {
    throw new ApiError(409, "RUN_NOT_REVIEW_CANDIDATE", "Ese análisis no contiene una comparación pendiente de decisión.");
  }
  let employmentAssociationRemoved = false;
  const employmentId = document.rows[0].employment_id === null ? null : String(document.rows[0].employment_id);
  if (employmentId) {
    const employment = await client.query(
      `SELECT employer_id,
              currency_code = $3
                AND date_trunc('month', start_date)::date <= $4::date
                AND (end_date IS NULL OR date_trunc('month', end_date)::date >= $4::date)
                AS scope_matches
         FROM employments
        WHERE id = $1 AND user_id = $2
        FOR SHARE`,
      [employmentId, input.userId, run.rows[0].currency_code, run.rows[0].payroll_period],
    );
    const associatedEmployer = employment.rows[0]
      ? await followMergedEmployer(client, String(employment.rows[0].employer_id))
      : null;
    const detectedEmployer = run.rows[0].detected_employer_id
      ? await followMergedEmployer(client, String(run.rows[0].detected_employer_id))
      : null;
    employmentAssociationRemoved = employment.rows[0]?.scope_matches !== true
      || associatedEmployer?.id !== detectedEmployer?.id;
  }
  const promoted = await client.query(
    `UPDATE documents
        SET active_extraction_run_id = $3,
            classification_status = 'SUPPORTED',
            document_type = 'PAYROLL',
            classification_confidence = $7,
            processing_status = CASE
              WHEN $4 = 'REVIEW_REQUIRED' OR $8::boolean THEN 'NEEDS_REVIEW'
              ELSE 'COMPLETED'
            END,
            employment_id = CASE WHEN $8::boolean THEN NULL ELSE employment_id END,
            detected_employer_id = $6,
            processed_at = now()
      WHERE id = $1 AND user_id = $2
        AND active_extraction_run_id IS NOT DISTINCT FROM $5::uuid`,
    [
      input.documentId,
      input.userId,
      input.runId,
      run.rows[0].status,
      input.expectedActiveRunId,
      run.rows[0].detected_employer_id,
      run.rows[0].confidence,
      employmentAssociationRemoved,
    ],
  );
  if (!promoted.rowCount) {
    throw new ApiError(409, "ACTIVE_RUN_CHANGED", "El análisis activo cambió; recargá antes de continuar.");
  }
  await client.query(
    `UPDATE import_batch_items item
        SET status = CASE WHEN $3 = 'REVIEW_REQUIRED' OR $4::boolean THEN 'NEEDS_REVIEW' ELSE 'COMPLETED' END,
            employment_id = CASE WHEN $4::boolean THEN NULL ELSE item.employment_id END,
            error_code = NULL,
            updated_at = now()
       FROM documents document
      WHERE document.id = $1 AND document.user_id = $2
        AND item.id = document.import_batch_item_id
        AND item.user_id = document.user_id`,
    [input.documentId, input.userId, run.rows[0].status, employmentAssociationRemoved],
  );
  if (employmentAssociationRemoved) {
    await client.query(
      `UPDATE payroll_settlements SET employment_id = NULL
        WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3`,
      [input.userId, input.documentId, input.runId],
    );
  }
  await client.query(
    `UPDATE extraction_runs
        SET promotion_outcome = 'PROMOTED', promoted_at = COALESCE(promoted_at, now())
      WHERE id = $1 AND user_id = $2 AND document_id = $3`,
    [input.runId, input.userId, input.documentId],
  );
  return { activeRunId: input.runId, decision: input.decision, employmentAssociationRemoved };
}

export async function loadReprocessingBatch(client: Queryable, userId: string, batchId: string) {
  const result = await client.query(
    `SELECT batch.id, batch.status, batch.trigger_kind, batch.created_at, batch.updated_at,
            batch.completed_at,
            count(job.id)::integer AS total,
            count(job.id) FILTER (WHERE job.state IN ('PENDING', 'PUBLISHED', 'RETRYABLE'))::integer AS queued,
            count(job.id) FILTER (WHERE job.state = 'RUNNING')::integer AS processing,
            count(job.id) FILTER (WHERE run.promotion_outcome = 'PROMOTED')::integer AS improved,
            count(job.id) FILTER (WHERE run.promotion_outcome = 'UNCHANGED')::integer AS unchanged,
            count(job.id) FILTER (WHERE run.promotion_outcome = 'REVIEW_REQUIRED')::integer AS review_required,
            count(job.id) FILTER (WHERE job.state = 'FAILED')::integer AS failed,
            count(job.id) FILTER (
              WHERE job.state = 'CANCELLED' OR run.promotion_outcome = 'REJECTED_REGRESSION'
            )::integer AS skipped
       FROM reprocessing_batches batch
       LEFT JOIN processing_jobs job
         ON job.user_id = batch.user_id AND job.reprocessing_batch_id = batch.id
       LEFT JOIN extraction_runs run
         ON run.user_id = job.user_id AND run.document_id = job.document_id
        AND run.processing_version = job.processing_version
      WHERE batch.id = $1 AND batch.user_id = $2
      GROUP BY batch.id`,
    [batchId, userId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: String(row.id),
    status: String(row.status),
    triggerKind: String(row.trigger_kind),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: timestamp(row.completed_at),
    progress: {
      total: Number(row.total),
      queued: Number(row.queued),
      processing: Number(row.processing),
      improved: Number(row.improved),
      unchanged: Number(row.unchanged),
      reviewRequired: Number(row.review_required),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
    },
  };
}

export async function refreshReprocessingBatch(
  client: PoolClient,
  userId: string,
  batchId: string,
) {
  await client.query(
    `UPDATE reprocessing_batches batch
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND (current.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                        OR current.execution_owner IS NOT NULL)
              ) THEN 'RUNNING'
              WHEN NOT EXISTS (
                SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND current.state <> 'CANCELLED'
              ) THEN 'CANCELLED'
              WHEN EXISTS (
                SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND current.state = 'COMPLETED'
              ) AND EXISTS (
                SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND current.state IN ('FAILED', 'CANCELLED')
              ) THEN 'PARTIAL'
              WHEN EXISTS (
                SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND current.state = 'FAILED'
              ) THEN 'FAILED'
              ELSE 'COMPLETED'
            END,
            completed_at = CASE WHEN EXISTS (
              SELECT 1 FROM processing_jobs current
                 WHERE current.user_id = batch.user_id
                   AND current.reprocessing_batch_id = batch.id
                   AND (current.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                        OR current.execution_owner IS NOT NULL)
            ) THEN NULL ELSE now() END,
            updated_at = now()
      WHERE batch.id = $1 AND batch.user_id = $2`,
    [batchId, userId],
  );
}

export async function loadProcessingHealth(
  client: Queryable,
  options: { page?: number; pageSize?: number } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 100);
  const offset = (page - 1) * pageSize;
  const candidatePredicate = reprocessingCandidateExistsSql("document", "$1", "$2", "$3");
  const [summary, versions, issues] = await Promise.all([
    client.query(
      `SELECT count(*)::integer AS total_documents,
              count(*) FILTER (
                WHERE active_run.status = 'COMPLETED'
                  AND NOT EXISTS (
                    SELECT 1 FROM extraction_run_issues active_issue
                     WHERE active_issue.user_id = document.user_id
                       AND active_issue.document_id = document.id
                       AND active_issue.extraction_run_id = active_run.id
                       AND active_issue.severity IN ('WARNING', 'ERROR')
                  )
              )::integer AS complete_documents,
              count(*) FILTER (
                WHERE active_run.status = 'COMPLETED_WITH_WARNINGS'
                   OR (active_run.status = 'COMPLETED' AND EXISTS (
                    SELECT 1 FROM extraction_run_issues active_issue
                     WHERE active_issue.user_id = document.user_id
                       AND active_issue.document_id = document.id
                       AND active_issue.extraction_run_id = active_run.id
                       AND active_issue.severity IN ('WARNING', 'ERROR')
                  ))
              )::integer AS warning_documents,
              count(*) FILTER (WHERE current_run.status = 'FAILED')::integer AS failed_documents,
              count(*) FILTER (WHERE document.processing_status = 'NEEDS_REVIEW'
                                OR current_run.promotion_outcome = 'REVIEW_REQUIRED')::integer AS review_required_documents,
              count(*) FILTER (WHERE ${candidatePredicate})::integer AS candidate_documents,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM processing_jobs job
                 WHERE job.user_id = document.user_id AND job.document_id = document.id
                   AND job.trigger_kind IN ('USER_REPROCESS', 'ADMIN_REPROCESS', 'PARSER_UPGRADE', 'AUTOMATIC_RECOVERY')
                   AND (job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                        OR job.execution_owner IS NOT NULL)
              ))::integer AS processing_documents
         FROM documents document
         LEFT JOIN extraction_runs active_run
           ON active_run.id = document.active_extraction_run_id
          AND active_run.user_id = document.user_id AND active_run.document_id = document.id
         LEFT JOIN LATERAL (
           SELECT run.status, run.promotion_outcome
             FROM extraction_runs run
            WHERE run.user_id = document.user_id AND run.document_id = document.id
            ORDER BY run.processing_version DESC, run.id DESC LIMIT 1
         ) current_run ON true
        WHERE document.deleted_at IS NULL AND document.document_type = 'PAYROLL'`,
      [fixesJson, processingPipelineVersions.parser, currentPipelineFingerprint],
    ),
    client.query(
      `SELECT run.pipeline_fingerprint, run.parser_version, run.status, run.promotion_outcome,
              count(DISTINCT document.id)::integer AS documents, count(*) OVER ()::integer AS total
         FROM extraction_runs run
         JOIN documents document
           ON document.id = run.document_id AND document.user_id = run.user_id
        WHERE document.deleted_at IS NULL AND document.document_type = 'PAYROLL'
        GROUP BY run.pipeline_fingerprint, run.parser_version, run.status, run.promotion_outcome
        ORDER BY count(DISTINCT document.id) DESC, run.parser_version, run.status, run.promotion_outcome
        LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    client.query(
      `SELECT issue.code, issue.severity, count(DISTINCT document.id)::integer AS documents,
              count(DISTINCT document.id) FILTER (WHERE ${candidatePredicate})::integer AS candidates,
              count(*) OVER ()::integer AS total
         FROM documents document
         JOIN extraction_run_issues issue
           ON issue.user_id = document.user_id
          AND issue.document_id = document.id
          AND issue.extraction_run_id = document.active_extraction_run_id
        WHERE document.deleted_at IS NULL
        GROUP BY issue.code, issue.severity
        ORDER BY count(DISTINCT document.id) DESC, issue.code
        LIMIT $4 OFFSET $5`,
      [fixesJson, processingPipelineVersions.parser, currentPipelineFingerprint, pageSize, offset],
    ),
  ]);
  const row = summary.rows[0] ?? {};
  return {
    summary: {
      totalDocuments: Number(row.total_documents ?? 0),
      completeDocuments: Number(row.complete_documents ?? 0),
      warningDocuments: Number(row.warning_documents ?? 0),
      failedDocuments: Number(row.failed_documents ?? 0),
      reviewRequiredDocuments: Number(row.review_required_documents ?? 0),
      candidateDocuments: Number(row.candidate_documents ?? 0),
      processingDocuments: Number(row.processing_documents ?? 0),
    },
    versions: {
      items: versions.rows.map((version) => ({
        pipelineFingerprint: version.pipeline_fingerprint === null ? null : String(version.pipeline_fingerprint),
        parserVersion: String(version.parser_version),
        status: String(version.status),
        promotionOutcome: String(version.promotion_outcome),
        documents: Number(version.documents),
      })),
      page,
      pageSize,
      total: Number(versions.rows[0]?.total ?? 0),
    },
    issues: {
      items: issues.rows.map((issue) => ({
        code: String(issue.code),
        severity: String(issue.severity),
        documents: Number(issue.documents),
        candidates: Number(issue.candidates),
      })),
      page,
      pageSize,
      total: Number(issues.rows[0]?.total ?? 0),
    },
  };
}
