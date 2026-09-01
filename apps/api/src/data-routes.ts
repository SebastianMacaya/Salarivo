import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  EmployerResolutionError,
  currentPipelineFingerprint,
  followMergedEmployer,
  lockEmployerMutation,
  normalizeEmployerNameConservative,
  parserFixCatalog,
  pool,
  processingPipelineVersions,
  resolveEmployer,
  withTransaction,
  type PoolClient,
} from "@salarivo/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.ts";
import {
  analyzeSalaryHistory,
  compareSalaryPeriods,
  salaryCategoryForEarning,
  SALARY_CATEGORIES,
  type SalaryCategory,
  type SalarySettlement,
} from "./salary-analytics.ts";
import { sessionCookieName, tokenHash } from "./security.ts";
import { lockValidStepUpSession } from "./session-assurance.ts";
import { lockR2UploadCapacity } from "./r2-capacity.ts";
import {
  enqueueReprocessing,
  enqueueReprocessingBatch,
  countReprocessingCandidates,
  findReprocessingCandidates,
  loadProcessingAnalysis,
  loadProcessingComparisonPreview,
  loadReprocessingBatch,
  processingRunView,
  promoteProcessingRun,
  refreshReprocessingBatch,
  reprocessingCandidateExistsSql,
} from "./reprocessing.ts";
import { createStorage, waitForR2WriteWindow, type Storage } from "./storage.ts";

type ErrorConstructor = new (statusCode: number, code: string, message: string) => Error;
type RegisterOptions = {
  config: ApiConfig;
  requireAuth: (request: FastifyRequest) => Promise<void>;
  requireStepUp: (request: FastifyRequest) => Promise<void>;
  ApiError: ErrorConstructor;
  provisionStorage: boolean;
  storage?: Storage;
};
type IdParams = { id: string };
type ImportItemInput = {
  clientItemKey: string;
  originalFilename: string;
  declaredMimeType: string;
  expectedSizeBytes: number;
  employmentId?: string | null;
};
type ImportBody = { items: ImportItemInput[] };
type UploadBody = { itemId: string };
type CorrectionBody = {
  extractedFieldId?: string;
  fieldPath?: string;
  correctedValue: string;
  extractionRunId: string;
};
type ReviewCompleteBody = { acceptDeductionsMismatch?: boolean; extractionRunId: string };
type DocumentEmploymentBody = { documentIds: string[]; employmentId: string | null };
type SalaryComparisonQuery = {
  employmentContext: string;
  currencyCode: string;
  fromPeriod: string;
  toPeriod: string;
};
type SalaryConceptQuery = {
  employmentContext: string;
  currencyCode: string;
  employerName?: string;
  year?: string;
  category?: SalaryCategory;
  limit?: string;
  cursor?: string;
};
type DocumentListQuery = {
  limit?: string;
  cursor?: string;
  search?: string;
  year?: string;
  period?: string;
  employmentId?: string;
  employmentContext?: string;
  currencyCode?: string;
  employerName?: string;
  processingStatus?: string;
  statusGroup?: "ALL" | "READY" | "REVIEW" | "PROCESSING" | "ERROR";
  documentType?: string;
  settlementType?: string;
};
type OriginalQuery = { disposition?: "inline" | "attachment" };
type UnsupportedFeedbackBody = { comment: string };
type ReprocessBody = { retry?: boolean };
type ReprocessingBatchBody = { documentIds?: string[] };
type ProcessingRunParams = { id: string; runId: string };
type ProcessingRunDecisionBody = {
  decision: "PROMOTE" | "KEEP_ACTIVE";
  expectedActiveRunId: string | null;
};

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";
const EXPORT_PAGE_SIZE = 500;
const EXPORT_STREAM_TTL_MS = 10 * 60_000;
const EXPORT_QUERY_TTL_MS = 30_000;
const MAX_ACTIVE_EXPORT_STREAMS = 2;
const uuid = new RegExp(UUID_PATTERN);
const associationReadyStatuses = new Set([
  "COMPLETED", "NEEDS_REVIEW", "NEEDS_TYPE_CONFIRMATION", "REJECTED_UNSUPPORTED",
  "QUARANTINED", "FAILED_PERMANENT", "CANCELLED",
]);
const terminalImportItemStatuses = new Set(["COMPLETED", "NEEDS_REVIEW", "REJECTED", "FAILED", "CANCELLED"]);
const settlementAmountColumns = new Map([
  ["settlement.basicAmount", "basic_amount"],
  ["settlement.grossAmount", "gross_amount"],
  ["settlement.remunerativeAmount", "remunerative_amount"],
  ["settlement.nonRemunerativeAmount", "non_remunerative_amount"],
  ["settlement.netAmount", "net_amount"],
  ["settlement.deductionsAmount", "deductions_amount"],
]);
const settlementTypes = new Set([
  "NORMAL", "SAC", "VACACIONES", "BONO", "RETROACTIVO", "COMISION",
  "HORAS_EXTRA", "LIQUIDACION_FINAL", "INDEMNIZACION", "AJUSTE", "REINTEGRO", "OTRO_LABORAL",
]);
const spanishPayrollMonths = new Map([
  ["enero", "01"], ["febrero", "02"], ["marzo", "03"], ["abril", "04"],
  ["mayo", "05"], ["junio", "06"], ["julio", "07"], ["agosto", "08"],
  ["septiembre", "09"], ["setiembre", "09"], ["octubre", "10"],
  ["noviembre", "11"], ["diciembre", "12"],
]);
const settlementSearchTerms = new Map([
  ["normal", "NORMAL"], ["liquidacion normal", "NORMAL"],
  ["sac", "SAC"], ["aguinaldo", "SAC"], ["sueldo anual complementario", "SAC"],
  ["vacacion", "VACACIONES"], ["vacaciones", "VACACIONES"],
  ["bono", "BONO"], ["bonos", "BONO"], ["premio", "BONO"], ["premios", "BONO"],
  ["retroactivo", "RETROACTIVO"], ["retroactiva", "RETROACTIVO"],
  ["retroactivos", "RETROACTIVO"], ["retroactivas", "RETROACTIVO"],
  ["comision", "COMISION"], ["comisiones", "COMISION"],
  ["hora extra", "HORAS_EXTRA"], ["horas extra", "HORAS_EXTRA"], ["horas extras", "HORAS_EXTRA"],
  ["liquidacion final", "LIQUIDACION_FINAL"],
  ["indemnizacion", "INDEMNIZACION"], ["indemnizaciones", "INDEMNIZACION"],
  ["ajuste", "AJUSTE"], ["ajustes", "AJUSTE"],
  ["reintegro", "REINTEGRO"], ["reintegros", "REINTEGRO"],
  ["devolucion", "REINTEGRO"], ["devoluciones", "REINTEGRO"],
  ["credito", "REINTEGRO"], ["creditos", "REINTEGRO"],
  ["otra liquidacion", "OTRO_LABORAL"], ["otro laboral", "OTRO_LABORAL"],
  ["otro_laboral", "OTRO_LABORAL"],
]);

function documentSearchTerms(input: string): { month?: string; period?: string; settlementType?: string; year?: string } {
  const normalized = input.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const monthMatch = /^([a-z]+)(?: (?:de )?(20\d{2}))?$/.exec(normalized);
  const numericPeriod = /^(20\d{2})-(0[1-9]|1[0-2])$/.test(normalized) ? normalized : undefined;
  const year = /^20\d{2}$/.test(normalized) ? normalized : undefined;
  const month = monthMatch?.[1] ? spanishPayrollMonths.get(monthMatch[1]) : undefined;
  const settlementType = settlementSearchTerms.get(normalized);
  return {
    ...(month ? { month } : {}),
    ...(numericPeriod ? { period: numericPeriod } : month && monthMatch?.[2] ? { period: `${monthMatch[2]}-${month}` } : {}),
    ...(settlementType ? { settlementType } : {}),
    ...(year ? { year } : {}),
  };
}
const manualCorrectionPaths = new Set([
  "employer.name", "settlement.type", "settlement.payrollPeriod", ...settlementAmountColumns.keys(),
]);
const documentProcessingStatuses = new Set([
  "CREATED", "UPLOADED", "SECURITY_VALIDATION", "DOCUMENT_CLASSIFICATION",
  "NEEDS_TYPE_CONFIRMATION", "TEXT_EXTRACTION", "OCR", "PARSING", "NORMALIZATION",
  "VALIDATION", "COMPLETED", "NEEDS_REVIEW", "REJECTED_UNSUPPORTED", "QUARANTINED",
  "FAILED_RETRYABLE", "RETRY_SCHEDULED", "FAILED_PERMANENT", "CANCELLED", "DELETED",
]);
const documentStatusGroups = new Set(["ALL", "READY", "REVIEW", "PROCESSING", "ERROR"]);
const requiredPayrollReviewPaths = [
  "settlement.payrollPeriod",
  "settlement.grossAmount",
  "settlement.netAmount",
  "settlement.deductionsAmount",
];
const componentReviewPaths = ["settlement.remunerativeAmount", "settlement.nonRemunerativeAmount"];
const missingFieldReasons = ["LABEL_OR_LAYOUT_NOT_RECOGNIZED", "VALUE_NOT_INTERPRETABLE"] as const;
type MissingFieldReason = (typeof missingFieldReasons)[number];
const exportSections = [
  ["authenticationMethods", `SELECT provider AS "method", created_at AS "linkedAt",
      last_login_at AS "lastUsedAt"
      FROM auth_accounts WHERE user_id = $1 ORDER BY provider`],
  ["employers", `SELECT employer.name, employer.country_code AS "countryCode",
      CASE WHEN employer.created_by_user_id = $1 THEN employer.status ELSE NULL END AS status,
      CASE WHEN employer.created_by_user_id = $1 THEN employer.created_at ELSE NULL END AS "createdAt",
      min(employment.created_at) AS "firstLinkedAt"
      FROM employers employer
      LEFT JOIN employments employment
        ON employment.employer_id = employer.id AND employment.user_id = $1
      WHERE employer.created_by_user_id = $1
         OR (employment.id IS NOT NULL AND employer.status IN ('PENDING', 'VERIFIED'))
         OR (employer.status IN ('PENDING', 'VERIFIED') AND EXISTS (
           SELECT 1
             FROM documents document
            WHERE document.user_id = $1
              AND document.deleted_at IS NULL
              AND document.detected_employer_id = employer.id
         ))
      GROUP BY employer.id, employer.name, employer.country_code, employer.status,
               employer.created_by_user_id, employer.created_at
      ORDER BY lower(employer.name), employer.name`],
  ["employments", `SELECT employer.name AS "employerName",
      employer.country_code AS "employerCountryCode", employment.status,
      employment.start_date AS "startDate", employment.end_date AS "endDate", employment.role,
      employment.category, employment.modality, employment.country_code AS "countryCode",
      employment.currency_code AS "currencyCode", employment.created_at AS "createdAt"
      FROM employments employment
      JOIN employers employer ON employer.id = employment.employer_id
      WHERE employment.user_id = $1
      ORDER BY employment.start_date, lower(employer.name), employment.created_at, employment.id`],
  ["imports", `SELECT batch.created_at AS "startedAt", batch.completed_at AS "completedAt",
      batch.status AS "importStatus", item.ordinal + 1 AS "fileNumber",
      item.original_filename AS "filename", item.declared_mime_type AS "mediaType",
      item.expected_size_bytes AS "sizeBytes", item.status,
      employer.name AS "employerName", employment.start_date AS "employmentStartDate",
      employment.currency_code AS "employmentCurrencyCode"
      FROM import_batch_items item
      JOIN import_batches batch ON batch.id = item.batch_id AND batch.user_id = item.user_id
      LEFT JOIN employments employment ON employment.id = item.employment_id AND employment.user_id = item.user_id
      LEFT JOIN employers employer ON employer.id = employment.employer_id
      WHERE item.user_id = $1 ORDER BY batch.created_at, item.ordinal, item.id`],
  ["documents", `SELECT document.original_filename AS "filename",
      COALESCE(document.detected_mime_type, document.declared_mime_type) AS "mediaType",
      document.size_bytes AS "sizeBytes", document.page_count AS "pageCount",
      document.document_type AS "documentType", document.processing_status AS "processingStatus",
      document.retention_policy AS "retentionPolicy",
      (document.original_deleted_at IS NULL) AS "originalAvailable",
      document.created_at AS "importedAt", document.processed_at AS "processedAt",
      document.original_deleted_at AS "originalDeletedAt", employer.name AS "employerName",
      document.unsupported_feedback AS "unsupportedFeedback",
      employment.start_date AS "employmentStartDate", employment.end_date AS "employmentEndDate",
      employment.currency_code AS "employmentCurrencyCode"
      FROM documents document
      LEFT JOIN employments employment ON employment.id = document.employment_id AND employment.user_id = document.user_id
      LEFT JOIN employers employer ON employer.id = COALESCE(employment.employer_id, document.detected_employer_id)
      WHERE document.user_id = $1 AND document.deleted_at IS NULL
      ORDER BY document.created_at, document.id`],
  ["settlements", `SELECT document.original_filename AS "documentFilename",
      document.created_at AS "documentImportedAt",
      run.processing_version AS "documentRevision",
      (run.id = document.active_extraction_run_id) AS active,
      run.promotion_outcome AS "promotionOutcome",
      settlement.settlement_ordinal AS "settlementNumber", employer.name AS "employerName",
      employment.start_date AS "employmentStartDate", settlement.payroll_period AS "payrollPeriod",
      settlement.payment_date AS "paymentDate", settlement.issue_date AS "issueDate",
      settlement.settlement_type AS "settlementType", settlement.is_recurring AS "isRecurring",
      settlement.currency_code AS "currencyCode", settlement.basic_amount AS "basicAmount",
      settlement.gross_amount AS "grossAmount", settlement.net_amount AS "netAmount",
      settlement.remunerative_amount AS "remunerativeAmount",
      settlement.non_remunerative_amount AS "nonRemunerativeAmount",
      settlement.deductions_amount AS "deductionsAmount", settlement.created_at AS "createdAt"
      FROM payroll_settlements settlement
      JOIN documents document ON document.id = settlement.document_id AND document.user_id = settlement.user_id
      JOIN extraction_runs run
        ON run.id = settlement.extraction_run_id AND run.user_id = settlement.user_id
      LEFT JOIN employments employment ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
      LEFT JOIN employers employer ON employer.id = COALESCE(employment.employer_id, run.detected_employer_id)
      WHERE settlement.user_id = $1
      ORDER BY document.created_at, run.processing_version, settlement.settlement_ordinal, settlement.id`],
  ["concepts", `SELECT document.original_filename AS "documentFilename",
      document.created_at AS "documentImportedAt",
      run.processing_version AS "documentRevision",
      (run.id = document.active_extraction_run_id) AS active,
      run.promotion_outcome AS "promotionOutcome",
      settlement.settlement_ordinal AS "settlementNumber", item.item_ordinal AS "conceptNumber",
      item.raw_description AS "description", item.normalized_concept_code AS "normalizedConcept",
      item.amount, item.currency_code AS "currencyCode", item.item_type AS "type",
      item.is_recurring AS "isRecurring", item.confidence, item.source_page AS "sourcePage",
      item.created_at AS "createdAt"
      FROM payroll_line_items item
      JOIN payroll_settlements settlement ON settlement.id = item.settlement_id AND settlement.user_id = item.user_id
      JOIN documents document ON document.id = settlement.document_id AND document.user_id = settlement.user_id
      JOIN extraction_runs run
        ON run.id = settlement.extraction_run_id AND run.user_id = settlement.user_id
      WHERE item.user_id = $1
      ORDER BY document.created_at, run.processing_version, settlement.settlement_ordinal, item.item_ordinal, item.id`],
  ["processingRuns", `SELECT document.original_filename AS "documentFilename",
      document.created_at AS "documentImportedAt", run.processing_version AS "documentRevision",
      run.status, run.trigger_kind AS "triggerKind", run.classifier_version AS "classifierVersion",
      run.extractor_version AS "extractorVersion", run.parser_version AS "parserVersion",
      run.normalizer_version AS "normalizerVersion", run.result_schema_version AS "resultSchemaVersion",
      run.pipeline_fingerprint AS "pipelineFingerprint", run.promotion_outcome AS "promotionOutcome",
      (run.id = document.active_extraction_run_id) AS active,
      run.started_at AS "startedAt", run.finished_at AS "finishedAt", run.promoted_at AS "promotedAt"
      FROM extraction_runs run
      JOIN documents document ON document.id = run.document_id AND document.user_id = run.user_id
      WHERE run.user_id = $1
      ORDER BY document.created_at, run.processing_version, run.id`],
  ["processingIssues", `SELECT document.original_filename AS "documentFilename",
      document.created_at AS "documentImportedAt", run.processing_version AS "documentRevision",
      issue.code, issue.severity, issue.recoverable,
      issue.affected_field_path AS "affectedField", issue.created_at AS "createdAt"
      FROM extraction_run_issues issue
      JOIN extraction_runs run
        ON run.id = issue.extraction_run_id AND run.user_id = issue.user_id
       AND run.document_id = issue.document_id
      JOIN documents document ON document.id = run.document_id AND document.user_id = run.user_id
      WHERE issue.user_id = $1
      ORDER BY document.created_at, run.processing_version, issue.code, issue.affected_field_path`],
  ["corrections", `SELECT document.original_filename AS "documentFilename",
      document.created_at AS "documentImportedAt", run.processing_version AS "documentRevision",
      correction.field_path AS "field", correction.correction_version AS "correctionVersion",
      correction.extracted_value AS "extractedValue", correction.corrected_value AS "correctedValue",
      (correction.inherited_from_correction_id IS NOT NULL) AS "inheritedFromEarlierProcessing",
      correction.created_at AS "correctedAt"
      FROM user_corrections correction
      JOIN documents document ON document.id = correction.document_id AND document.user_id = correction.user_id
      JOIN extraction_runs run ON run.id = correction.extraction_run_id AND run.user_id = correction.user_id
      WHERE correction.user_id = $1
      ORDER BY document.created_at, run.processing_version, correction.field_path,
        correction.correction_version, correction.created_at`],
  ["legalAcknowledgements", `SELECT version.document_type AS "documentType", version.version,
      version.locale, acknowledgement.accepted_at AS "acceptedAt"
      FROM legal_acknowledgements acknowledgement
      JOIN legal_document_versions version ON version.id = acknowledgement.document_version_id
      WHERE acknowledgement.user_id = $1 ORDER BY version.document_type, version.version`],
  ["sessions", `SELECT CASE
        WHEN revoked_at IS NOT NULL THEN 'REVOKED'
        WHEN expires_at <= now() THEN 'EXPIRED'
        ELSE 'ACTIVE'
      END AS status, created_at AS "createdAt", last_seen_at AS "lastSeenAt",
      expires_at AS "expiresAt", revoked_at AS "revokedAt",
      mfa_verified_at AS "secondFactorVerifiedAt", device_type AS "deviceType",
      browser_family AS browser, os_family AS "operatingSystem"
      FROM sessions WHERE user_id = $1 ORDER BY created_at, id`],
  ["privacyRequests", `SELECT operation_type AS "type", status,
      created_at AS "requestedAt", started_at AS "startedAt", completed_at AS "completedAt"
      FROM privacy_operations WHERE user_id = $1 ORDER BY created_at, id`],
] as const;
const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

function value(row: Record<string, unknown>, key: string): string | null {
  const current = row[key];
  return current === null || current === undefined ? null : String(current);
}

function timestamp(current: unknown): string {
  return current instanceof Date ? current.toISOString() : new Date(String(current)).toISOString();
}

function exportOperationView(row: Record<string, unknown>) {
  const id = String(row.id);
  const status = String(row.status);
  return {
    id,
    status,
    createdAt: timestamp(row.created_at),
    startedAt: row.started_at === null ? null : timestamp(row.started_at),
    expiresAt: row.output_expires_at === null ? null : timestamp(row.output_expires_at),
    completedAt: row.completed_at === null ? null : timestamp(row.completed_at),
    downloadUrl: status === "READY" ? `/api/v1/privacy/exports/${id}/download` : null,
  };
}

function cleanFilename(input: string): string {
  const cleaned = input.replace(/[\\/\0\r\n]/g, "_").trim();
  if (!cleaned || cleaned.length > 255 || !cleaned.toLowerCase().endsWith(".pdf")) {
    throw new Error("INVALID_FILENAME");
  }
  return cleaned;
}

function safeFilenamePart(input: string): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned) return "";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `document-${cleaned}` : cleaned;
}

export function derivedDocumentFilename(
  originalFilename: string,
  payrollPeriod?: string | null,
  employerName?: string | null,
): string {
  const original = safeFilenamePart(originalFilename.replace(/\.pdf$/i, "")) || "document";
  const period = /^(20\d{2})-(0[1-9]|1[0-2])\b/.exec(payrollPeriod ?? "")?.[0];
  const employer = safeFilenamePart(employerName ?? "");
  const stem = period ? `${period}${employer ? ` - ${employer}` : ""}` : original;
  return `${stem.slice(0, 246).replace(/[. ]+$/g, "") || "document"}.pdf`;
}

const documentProjectionJoin = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        max(COALESCE(correction.corrected_value, field.interpreted_value) #>> '{}')
          FILTER (WHERE field.field_path = 'settlement.payrollPeriod'),
        (SELECT to_char(settlement.payroll_period, 'YYYY-MM')
           FROM payroll_settlements settlement
          WHERE settlement.user_id = document.user_id AND settlement.document_id = document.id
            AND settlement.extraction_run_id = document.active_extraction_run_id
          ORDER BY settlement.created_at DESC LIMIT 1)
      ) AS payroll_period,
      (SELECT settlement.settlement_type
         FROM payroll_settlements settlement
        WHERE settlement.user_id = document.user_id AND settlement.document_id = document.id
          AND settlement.extraction_run_id = document.active_extraction_run_id
        ORDER BY settlement.created_at DESC LIMIT 1) AS settlement_type,
      (SELECT correction.corrected_value #>> '{}'
         FROM user_corrections correction
        WHERE correction.user_id = document.user_id
          AND correction.document_id = document.id
          AND correction.extraction_run_id = document.active_extraction_run_id
           AND correction.field_path = 'employer.name'
        ORDER BY correction.correction_version DESC LIMIT 1) AS corrected_employer_name,
      max(field.interpreted_value #>> '{}')
        FILTER (WHERE field.field_path = 'employer.name') AS extracted_employer_name
      FROM extracted_fields field
      LEFT JOIN LATERAL (
        SELECT corrected_value FROM user_corrections
         WHERE user_id = document.user_id AND extracted_field_id = field.id
         ORDER BY correction_version DESC LIMIT 1
      ) correction ON true
     WHERE field.user_id = document.user_id
       AND field.extraction_run_id = document.active_extraction_run_id
  ) projection ON true`;

const processingRunDecisionRequiredSql = (runAlias: "review_run" | "run") => `(
  ${runAlias}.id IS DISTINCT FROM document.active_extraction_run_id
  AND ${runAlias}.status IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REVIEW_REQUIRED')
  AND ${runAlias}.promotion_outcome = 'REVIEW_REQUIRED'
  AND ${runAlias}.pipeline_fingerprint = '${currentPipelineFingerprint}'
  AND ${runAlias}.base_extraction_run_id IS NOT DISTINCT FROM document.active_extraction_run_id
)`;

const documentDecisionRequiredSql = `EXISTS (
    SELECT 1 FROM extraction_runs review_run
     WHERE review_run.user_id = document.user_id
       AND review_run.document_id = document.id
       AND ${processingRunDecisionRequiredSql("review_run")}
  )`;

const documentNeedsReviewSql = `(document.processing_status IN ('NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION')
  OR ${documentDecisionRequiredSql})`;

function importItem(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    clientItemKey: String(row.client_item_key),
    originalFilename: String(row.original_filename),
    expectedSizeBytes: Number(row.expected_size_bytes),
    employmentId: value(row, "employment_id"),
    status: String(row.status),
    errorCode: value(row, "error_code"),
  };
}

function importBatchView(batch: Record<string, unknown>, itemRows: Record<string, unknown>[]) {
  const items = itemRows.map(importItem);
  const discardedDuplicates = Number(batch.discarded_duplicate_count ?? 0);
  const totals = items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  if (discardedDuplicates) totals.DUPLICATE = discardedDuplicates;
  const resolved = items.filter((item) => terminalImportItemStatuses.has(item.status)).length
    + discardedDuplicates;
  const total = items.length + discardedDuplicates;
  return {
    id: String(batch.id),
    status: String(batch.status),
    createdAt: timestamp(batch.created_at),
    progress: {
      total,
      resolved,
      percentage: total ? Math.floor((resolved * 100) / total) : 100,
    },
    totals,
    items,
  };
}

function documentView(row: Record<string, unknown>) {
  const originalFilename = String(row.original_filename);
  return {
    id: String(row.id),
    employmentId: value(row, "employment_id"),
    originalFilename,
    displayFilename: derivedDocumentFilename(
      originalFilename,
      value(row, "payroll_period"),
      value(row, "employer_name"),
    ),
    createdAt: timestamp(row.created_at),
    processingStatus: String(row.processing_status),
    documentType: value(row, "document_type"),
    payrollPeriod: value(row, "payroll_period"),
    settlementType: value(row, "settlement_type"),
    employerName: value(row, "employer_name"),
    confidence: value(row, "classification_confidence"),
    errorCode: value(row, "error_code"),
    originalAvailable: row.original_deleted_at === null && row.deleted_at === null,
    needsReview: row.processing_status === "NEEDS_REVIEW" || row.decision_required === true,
    decisionRequired: row.decision_required === true,
  };
}

function deductionViews(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const amount = value(row, "amount");
    const rawDescription = value(row, "rawDescription");
    if (!amount || !rawDescription) return [];
    return [{
      normalizedConceptCode: value(row, "normalizedConceptCode"),
      rawDescription,
      amount,
      grossPercentage: value(row, "grossPercentage"),
      confidence: value(row, "confidence"),
    }];
  });
}

function earningDetailViews(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const rawDescription = value(row, "rawDescription");
    const amount = value(row, "amount");
    if (!rawDescription || !amount) return [];
    return [{
      normalizedConceptCode: value(row, "normalizedConceptCode"),
      rawDescription,
      amount,
      isRecurring: typeof row.isRecurring === "boolean" ? row.isRecurring : null,
      confidence: value(row, "confidence"),
    }];
  });
}

function settlementView(row: Record<string, unknown>) {
  const deductionsAmount = value(row, "deductions_amount");
  const reimbursementsAmount = deductionsAmount?.startsWith("-") ? deductionsAmount.slice(1) : null;
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    employmentId: value(row, "employment_id"),
    payrollPeriod: String(row.payroll_period),
    employerName: value(row, "employer_name"),
    settlementType: String(row.settlement_type),
    isRecurring: row.is_recurring === true,
    currencyCode: String(row.currency_code),
    basicAmount: value(row, "basic_amount"),
    grossAmount: value(row, "gross_amount"),
    netAmount: value(row, "net_amount"),
    remunerativeAmount: value(row, "remunerative_amount"),
    nonRemunerativeAmount: value(row, "non_remunerative_amount"),
    deductionsAmount,
    deductionsChargedAmount: reimbursementsAmount ? "0.00" : deductionsAmount,
    reimbursementsAmount,
    confidence: value(row, "confidence"),
    deductionsPercentage: reimbursementsAmount ? null : value(row, "deductions_percentage"),
    deductions: deductionViews(row.deductions),
    earnings: earningDetailViews(row.earnings),
    totalsBalance: row.totals_balance === true,
    deductionsMatchTotal: row.deductions_match_total === true,
    deductionsDifferenceAmount: value(row, "deductions_difference_amount"),
    deductionsDifferenceKind: String(row.deductions_difference_kind),
  };
}

async function audit(
  client: PoolClient,
  userId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, string | number | boolean> = {},
) {
  await client.query(
    `INSERT INTO audit_events (
       id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
     ) VALUES ($1, $2, $2, $3, $4, $5, 'SUCCESS', $6::jsonb)`,
    [randomUUID(), userId, action, resourceType, resourceId, JSON.stringify(metadata)],
  );
}

async function completeDocumentBatch(client: PoolClient, userId: string, documentId: string) {
  await client.query(
    `UPDATE import_batches AS batch
        SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE batch.user_id = $1
        AND batch.id = (SELECT import_batch_id FROM documents WHERE id = $2 AND user_id = $1)
        AND batch.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM import_batch_items AS item
           WHERE item.user_id = batch.user_id AND item.batch_id = batch.id
             AND item.status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
        )`,
    [userId, documentId],
  );
}

function displayExtracted(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") return String(input);
  if (typeof input === "object" && "amount" in input && typeof input.amount === "string") return input.amount;
  return JSON.stringify(input);
}

function readMissingFieldReason(signals: unknown): MissingFieldReason | undefined {
  if (!signals || typeof signals !== "object") return undefined;
  const value = (signals as { missingReason?: unknown }).missingReason;
  return missingFieldReasons.find((reason) => reason === value);
}

type SourceRegion = {
  version: 1;
  space: "PAGE_NORMALIZED";
  origin: "TOP_LEFT";
  x: number;
  y: number;
  width: number;
  height: number;
};

function validatedSourceRegion(input: unknown): SourceRegion | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const region = input as Record<string, unknown>;
  if (region.version !== 1 || region.space !== "PAGE_NORMALIZED" || region.origin !== "TOP_LEFT") return null;
  const { x, y, width, height } = region;
  if (typeof x !== "number" || !Number.isFinite(x)
    || typeof y !== "number" || !Number.isFinite(y)
    || typeof width !== "number" || !Number.isFinite(width)
    || typeof height !== "number" || !Number.isFinite(height)) return null;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x > 1 || y > 1 || width > 1 || height > 1
    || x + width > 1.000001 || y + height > 1.000001) return null;
  return { version: 1, space: "PAGE_NORMALIZED", origin: "TOP_LEFT", x, y, width, height };
}

function normalizeDecimal(input: string): string | null {
  const compact = input.trim().replace(/[\s$]/g, "");
  const normalized = compact.includes(",")
    ? compact.replaceAll(".", "").replace(",", ".")
    : /^-?\d{1,3}(?:\.\d{3})+$/.test(compact)
      ? compact.replaceAll(".", "")
      : compact;
  return /^-?\d{1,18}(?:\.\d{1,2})?$/.test(normalized) ? normalized : null;
}

function earningViews(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const code = value(row, "code");
    const amount = value(row, "amount");
    if (!code || !amount) return [];
    return [{ code, amount, isRecurring: typeof row.isRecurring === "boolean" ? row.isRecurring : null }];
  });
}

type DocumentCursor = { createdAtMicros: string; id: string };

function documentCursor(cursor: DocumentCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAtMicros, cursor.id])).toString("base64url");
}

function parseDocumentCursor(input: string): DocumentCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(input)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== "string" || !/^\d{1,30}$/.test(parsed[0])
      || typeof parsed[1] !== "string" || !uuid.test(parsed[1])) return null;
    return { createdAtMicros: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

type SalaryConceptCursor = {
  period: string;
  settlementCreatedMicros: string;
  settlementOrdinal: number;
  settlementId: string;
  itemOrdinal: number;
  itemId: string;
};

function salaryConceptCursor(cursor: SalaryConceptCursor): string {
  return Buffer.from(JSON.stringify([
    cursor.period,
    cursor.settlementCreatedMicros,
    cursor.settlementOrdinal,
    cursor.settlementId,
    cursor.itemOrdinal,
    cursor.itemId,
  ])).toString("base64url");
}

function parseSalaryConceptCursor(input: string): SalaryConceptCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(input)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 6
      || typeof parsed[0] !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(parsed[0])
      || typeof parsed[1] !== "string" || !/^\d{1,30}$/.test(parsed[1])
      || typeof parsed[2] !== "number" || !Number.isSafeInteger(parsed[2]) || parsed[2] < 1 || parsed[2] > 2_147_483_647
      || typeof parsed[3] !== "string" || !uuid.test(parsed[3])
      || typeof parsed[4] !== "number" || !Number.isSafeInteger(parsed[4]) || parsed[4] < 1 || parsed[4] > 2_147_483_647
      || typeof parsed[5] !== "string" || !uuid.test(parsed[5])) return null;
    return {
      period: parsed[0],
      settlementCreatedMicros: parsed[1],
      settlementOrdinal: parsed[2],
      settlementId: parsed[3],
      itemOrdinal: parsed[4],
      itemId: parsed[5],
    };
  } catch {
    return null;
  }
}

function detectedEmploymentIdentity(employerName: string) {
  const key = normalizeEmployerNameConservative(employerName);
  if (!key || key.includes("\0")) return null;
  return {
    key,
    context: `detected:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
  };
}

const salaryConceptCategorySql = `CASE
  WHEN item.normalized_concept_code = 'NORMAL' THEN 'NORMAL'
  WHEN item.normalized_concept_code = 'SAC' THEN 'SAC'
  WHEN item.normalized_concept_code IN ('BONO', 'BONUS', 'PREMIO') THEN 'BONO'
  WHEN item.normalized_concept_code IN ('RETROACTIVO', 'RETROACTIVE') THEN 'RETROACTIVO'
  WHEN item.normalized_concept_code IN ('VACACIONES', 'VACATION') THEN 'VACACIONES'
  WHEN item.normalized_concept_code IN ('HORAS_EXTRA', 'OVERTIME') THEN 'HORAS_EXTRA'
  WHEN item.normalized_concept_code IN ('AJUSTE', 'ADJUSTMENT') THEN 'AJUSTE'
  WHEN item.normalized_concept_code IN ('REINTEGRO', 'REIMBURSEMENT') THEN 'REINTEGRO'
  WHEN item.normalized_concept_code IN ('COMISION', 'COMMISSION') THEN 'COMISION'
  WHEN item.normalized_concept_code IN ('LIQUIDACION_FINAL', 'FINAL_SETTLEMENT') THEN 'LIQUIDACION_FINAL'
  WHEN item.normalized_concept_code IN ('INDEMNIZACION', 'INDEMNITY', 'SEVERANCE') THEN 'INDEMNIZACION'
  WHEN item.is_recurring IS TRUE THEN 'NORMAL'
  ELSE 'OTRO'
END`;

const detectedEmployerNameJoin = `LEFT JOIN LATERAL (
  SELECT COALESCE(
           (SELECT employer.name FROM employers employer WHERE employer.id = document.detected_employer_id),
           (SELECT correction.corrected_value #>> '{}'
              FROM user_corrections correction
             WHERE correction.user_id = settlement.user_id
               AND correction.extraction_run_id = settlement.extraction_run_id
               AND correction.field_path = 'employer.name'
             ORDER BY correction.correction_version DESC LIMIT 1),
           (SELECT field.interpreted_value #>> '{}'
              FROM extracted_fields field
             WHERE field.user_id = settlement.user_id
               AND field.extraction_run_id = settlement.extraction_run_id
               AND field.field_path = 'employer.name'
             LIMIT 1)
         ) AS name
) detected_employer ON true`;

async function loadSalaryHistory(userId: string) {
  const candidatePredicate = reprocessingCandidateExistsSql("document", "$2", "$3", "$4");
  const [result, coverageResult, reprocessingCandidateCount] = await Promise.all([
    pool.query(
      `SELECT settlement.id, settlement.document_id, settlement.employment_id,
              document.detected_employer_id,
              to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
              settlement.settlement_type, settlement.is_recurring, settlement.currency_code,
              settlement.basic_amount, settlement.gross_amount, settlement.net_amount,
              settlement.deductions_amount, settlement.remunerative_amount,
              settlement.non_remunerative_amount, employment.status AS employment_status,
              to_char(employment.start_date, 'YYYY-MM-DD') AS employment_start_date,
              to_char(employment.end_date, 'YYYY-MM-DD') AS employment_end_date,
              COALESCE(employer.name, detected_employer.name) AS employer_name,
              COALESCE(earnings.items, '[]'::jsonb) AS earnings,
              COALESCE(earnings.earning_count, 0)::integer AS earning_count,
              COALESCE(earnings.unknown_count, 0)::integer AS unknown_earning_count,
              EXISTS (
                SELECT 1 FROM extraction_run_issues issue
                 WHERE issue.user_id = document.user_id
                   AND issue.document_id = document.id
                   AND issue.extraction_run_id = document.active_extraction_run_id
                   AND issue.severity IN ('WARNING', 'ERROR')
              ) AS has_incomplete_analysis,
              (${candidatePredicate}) AS reprocess_available
         FROM documents document
         JOIN extraction_runs run
           ON run.id = document.active_extraction_run_id
          AND run.document_id = document.id
          AND run.user_id = document.user_id
         JOIN payroll_settlements settlement
           ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
         LEFT JOIN employments employment
           ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
         LEFT JOIN employers employer
           ON employer.id = employment.employer_id
         ${detectedEmployerNameJoin}
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
                    'code', item.normalized_concept_code,
                    'amount', item.amount::text,
                    'isRecurring', item.is_recurring
                  ) ORDER BY item.item_ordinal) FILTER (WHERE item.normalized_concept_code IS NOT NULL) AS items,
                  count(*) AS earning_count,
                  count(*) FILTER (WHERE item.normalized_concept_code IS NULL) AS unknown_count
             FROM payroll_line_items item
            WHERE item.user_id = settlement.user_id
              AND item.settlement_id = settlement.id
              AND item.item_type = 'EARNING'
         ) earnings ON true
        WHERE document.user_id = $1 AND document.deleted_at IS NULL
          AND document.security_status = 'CLEAN'
          AND document.document_type = 'PAYROLL'
          AND document.processing_status = 'COMPLETED'
        ORDER BY settlement.payroll_period, settlement.created_at, settlement.id`,
      [
        userId,
        JSON.stringify(parserFixCatalog),
        processingPipelineVersions.parser,
        currentPipelineFingerprint,
      ],
    ),
    pool.query(
      `SELECT count(*)::integer AS documents,
              count(*) FILTER (WHERE processing_status = 'COMPLETED')::integer AS completed_documents,
              count(*) FILTER (WHERE processing_status = 'NEEDS_REVIEW')::integer AS needs_review_documents,
              count(*) FILTER (WHERE processing_status IN ('NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION'))::integer
                AS pending_review_documents,
              count(*) FILTER (WHERE processing_status = 'COMPLETED' AND employment_id IS NULL)::integer
                AS unassociated_documents,
              (SELECT count(*)::integer FROM employments
                WHERE user_id = $1 AND status = 'ACTIVE') AS active_employments,
              (SELECT count(DISTINCT job.document_id)::integer FROM processing_jobs job
                WHERE job.user_id = $1
                  AND job.trigger_kind IN ('USER_REPROCESS', 'ADMIN_REPROCESS', 'PARSER_UPGRADE', 'AUTOMATIC_RECOVERY')
                  AND (job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                       OR job.execution_owner IS NOT NULL)) AS reprocessing_documents,
              (SELECT count(DISTINCT run.document_id)::integer FROM extraction_runs run
                WHERE run.user_id = $1 AND run.promotion_outcome = 'REVIEW_REQUIRED') AS reprocessing_review_required_documents
         FROM documents
        WHERE user_id = $1 AND deleted_at IS NULL AND document_type = 'PAYROLL'`,
      [userId],
    ),
    countReprocessingCandidates(pool, userId),
  ]);

  const contextMetadata = new Map<string, {
    employmentContext: string;
    employmentId: string | null;
    employerName: string | null;
    state: "CONFIRMED" | "DETECTED" | "UNCONFIRMED";
    currencyCode: string;
    employmentStatus: string | null;
    startDate: string | null;
    endDate: string | null;
  }>();
  const qualityByScopePeriod = new Map<string, { incomplete: Set<string>; reprocessable: Set<string> }>();
  const settlements: SalarySettlement[] = result.rows.map((row) => {
    const employmentId = value(row, "employment_id");
    const detectedEmployerId = value(row, "detected_employer_id");
    const employerName = value(row, "employer_name")?.trim() || null;
    const currency = String(row.currency_code);
    const documentId = String(row.document_id);
    const employmentContext = employmentId
      ?? (detectedEmployerId
        ? `detected:${detectedEmployerId}`
        : employerName
        ? detectedEmploymentIdentity(employerName)!.context
        : `unconfirmed:${documentId}`);
    const metadataKey = JSON.stringify([employmentContext, currency]);
    if (!contextMetadata.has(metadataKey)) {
      contextMetadata.set(metadataKey, {
        employmentContext,
        employmentId,
        employerName,
        state: employmentId ? "CONFIRMED" : employerName ? "DETECTED" : "UNCONFIRMED",
        currencyCode: currency,
        employmentStatus: value(row, "employment_status"),
        startDate: value(row, "employment_start_date"),
        endDate: value(row, "employment_end_date"),
      });
    }
    const qualityKey = JSON.stringify([employmentContext, currency, String(row.payroll_period)]);
    const quality = qualityByScopePeriod.get(qualityKey) ?? {
      incomplete: new Set<string>(),
      reprocessable: new Set<string>(),
    };
    if (row.has_incomplete_analysis === true) quality.incomplete.add(documentId);
    if (row.reprocess_available === true) quality.reprocessable.add(documentId);
    qualityByScopePeriod.set(qualityKey, quality);
    return {
      id: String(row.id),
      documentId,
      employmentContext,
      employmentStartPeriod: value(row, "employment_start_date")?.slice(0, 7) ?? null,
      employmentEndPeriod: value(row, "employment_end_date")?.slice(0, 7) ?? null,
      employmentStatus: value(row, "employment_status"),
      currencyCode: currency,
      payrollPeriod: String(row.payroll_period),
      settlementType: String(row.settlement_type),
      isRecurring: row.is_recurring === true,
      basicAmount: value(row, "basic_amount"),
      grossAmount: value(row, "gross_amount"),
      netAmount: value(row, "net_amount"),
      deductionsAmount: value(row, "deductions_amount"),
      remunerativeAmount: value(row, "remunerative_amount"),
      nonRemunerativeAmount: value(row, "non_remunerative_amount"),
      ...(Number(row.earning_count) > 0 && Number(row.unknown_earning_count) === 0
        ? { earnings: earningViews(row.earnings) }
        : {}),
    };
  });
  const analytics = analyzeSalaryHistory(settlements);
  const publicAnalytics = {
    ...analytics,
    scopes: analytics.scopes.map((scope) => ({
      ...scope,
      evolution: scope.evolution.map((point) => ({
        period: point.period,
        totals: point.totals,
        regular: point.regular,
        comparableSalary: point.comparableSalary,
        quality: (() => {
          const quality = qualityByScopePeriod.get(JSON.stringify([
            scope.employmentContext,
            scope.currencyCode,
            point.period,
          ]));
          return {
            incompleteDocuments: quality?.incomplete.size ?? 0,
            reprocessableDocuments: quality?.reprocessable.size ?? 0,
          };
        })(),
      })),
    })),
  };
  const coverage = coverageResult.rows[0] ?? {};
  return {
    response: {
      calculationVersion: "salary-analytics-v1",
      contexts: analytics.scopes.map((scope) => {
        const metadata = contextMetadata.get(JSON.stringify([scope.employmentContext, scope.currencyCode]));
        if (!metadata) throw new Error("SALARY_CONTEXT_METADATA_MISSING");
        return {
          ...metadata,
          firstPeriod: scope.evolution[0]?.period ?? null,
          lastPeriod: scope.evolution.at(-1)?.period ?? null,
        };
      }),
      coverage: {
        documents: Number(coverage.documents ?? 0),
        completedDocuments: Number(coverage.completed_documents ?? 0),
        needsReviewDocuments: Number(coverage.needs_review_documents ?? 0),
        pendingReviewDocuments: Number(coverage.pending_review_documents ?? 0),
        unassociatedDocuments: Number(coverage.unassociated_documents ?? 0),
        activeEmployments: Number(coverage.active_employments ?? 0),
        analyzedSettlements: settlements.length,
        reprocessing: {
          candidateDocuments: reprocessingCandidateCount,
          processingDocuments: Number(coverage.reprocessing_documents ?? 0),
          reviewRequiredDocuments: Number(coverage.reprocessing_review_required_documents ?? 0),
        },
      },
      analytics: publicAnalytics,
    },
    analytics,
    settlements,
  };
}

function authenticatedRateKey(request: FastifyRequest, cookieName: string): string {
  const token = request.cookies[cookieName];
  return token && new RegExp(TOKEN_PATTERN).test(token) ? tokenHash(token) : request.ip;
}

function privacyExportStream(
  operationId: string,
  userId: string,
  sessionHash: string,
  signal: AbortSignal,
  onStarted: () => void,
  onFailure: () => void,
  onFinished: (completed: boolean) => void,
): Readable {
  return Readable.from((async function* () {
    onStarted();
    let client: PoolClient | undefined;
    let completed = false;
    try {
      client = await pool.connect();
      const keepAuthorized = async () => {
        if (signal.aborted) throw new Error("EXPORT_ABORTED");
        const active = await pool.query(
          `UPDATE privacy_operations AS operation SET updated_at = now()
            WHERE operation.id = $1 AND operation.user_id = $2
              AND operation.operation_type = 'DATA_EXPORT' AND operation.status = 'RUNNING'
              AND EXISTS (SELECT 1 FROM users WHERE id = $2 AND status = 'ACTIVE')
              AND EXISTS (
                SELECT 1 FROM sessions
                 WHERE token_hash = $3 AND user_id = $2 AND revoked_at IS NULL
                   AND expires_at > now() AND step_up_expires_at > now()
              )
            RETURNING operation.id`,
          [operationId, userId, sessionHash],
        );
        if (active.rowCount !== 1) throw new Error("EXPORT_REVOKED");
      };
      await keepAuthorized();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [String(EXPORT_QUERY_TTL_MS), String(EXPORT_STREAM_TTL_MS)],
      );
      const account = await client.query(
        `SELECT app_user.email, app_user.display_name, app_user.default_retention_policy,
                app_user.email_verified_at, app_user.onboarding_completed_at,
                app_user.last_login_at, app_user.created_at,
                factor.enabled_at AS mfa_enabled_at,
                COALESCE(recovery.codes_remaining, 0)::integer AS recovery_codes_remaining
           FROM users app_user
           LEFT JOIN LATERAL (
             SELECT id, enabled_at FROM mfa_factors
              WHERE user_id = app_user.id AND status = 'ACTIVE'
              LIMIT 1
           ) factor ON true
           LEFT JOIN LATERAL (
             SELECT count(*)::integer AS codes_remaining FROM mfa_recovery_codes
              WHERE user_id = app_user.id AND factor_id = factor.id AND used_at IS NULL
           ) recovery ON true
          WHERE app_user.id = $1 AND app_user.status = 'ACTIVE'`,
        [userId],
      );
      if (account.rowCount !== 1) throw new Error("EXPORT_ACCOUNT_NOT_FOUND");
      const row = account.rows[0];
      yield JSON.stringify({
        format: "salarivo-user-export-v4",
        exportedAt: new Date().toISOString(),
        account: {
          email: row.email,
          displayName: row.display_name,
          defaultRetentionPolicy: row.default_retention_policy,
          emailVerifiedAt: row.email_verified_at,
          onboardingCompletedAt: row.onboarding_completed_at,
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
          secondFactor: {
            enabled: row.mfa_enabled_at !== null,
            enabledAt: row.mfa_enabled_at,
            recoveryCodesRemaining: row.recovery_codes_remaining,
          },
        },
      }).slice(0, -1);

      for (const [name, sql] of exportSections) {
        yield `,"${name}":[`;
        let first = true;
        for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
          // ponytail: OFFSET keeps this dependency-free; switch to per-table keyset cursors only if export latency proves it necessary.
          await keepAuthorized();
          const page = await client.query(`${sql} LIMIT $2 OFFSET $3`, [userId, EXPORT_PAGE_SIZE, offset]);
          for (const item of page.rows) {
            yield `${first ? "" : ","}${JSON.stringify(item)}`;
            first = false;
          }
          if (page.rows.length < EXPORT_PAGE_SIZE) break;
        }
        yield "]";
      }
      yield "}\n";
      await client.query("COMMIT");
      completed = true;
    } catch (error) {
      onFailure();
      throw error;
    } finally {
      if (client && !completed) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve the stream error. */ }
      }
      client?.release();
      onFinished(completed);
    }
  })(), { signal });
}

export async function registerDataRoutes(app: FastifyInstance, options: RegisterOptions) {
  const { config, requireAuth, requireStepUp, ApiError } = options;
  const sessionCookie = sessionCookieName(config.appEnv);
  const rateKey = (request: FastifyRequest) => authenticatedRateKey(request, sessionCookie);
  const storage = options.storage ?? createStorage(config);
  const claimedExports = new WeakSet<FastifyRequest>();
  const failedExports = new WeakSet<FastifyRequest>();
  const exportReservations = new WeakSet<FastifyRequest>();
  const settledExports = new WeakSet<FastifyRequest>();
  const startedExportStreams = new WeakSet<FastifyRequest>();
  const successfulExportStreams = new WeakSet<FastifyRequest>();
  const activeExportStreams = new Map<string, AbortController>();
  const exportStreams = new WeakMap<FastifyRequest, { controller: AbortController; timer: NodeJS.Timeout }>();
  // ponytail: this per-process ceiling protects the local pool; use a distributed lease only when replicas are introduced.
  let activeExportCount = 0;
  const releaseExportResources = (request: FastifyRequest) => {
    if (exportReservations.has(request)) {
      exportReservations.delete(request);
      activeExportCount = Math.max(0, activeExportCount - 1);
    }
    const stream = exportStreams.get(request);
    if (stream) {
      clearTimeout(stream.timer);
      if (request.authUser && activeExportStreams.get(request.authUser.id) === stream.controller) {
        activeExportStreams.delete(request.authUser.id);
      }
      exportStreams.delete(request);
    }
  };
  const settleExport = async (request: FastifyRequest, succeeded: boolean) => {
    if (!claimedExports.has(request) || settledExports.has(request) || !request.authUser) return;
    settledExports.add(request);
    releaseExportResources(request);
    try {
      if (succeeded) {
        await pool.query(
          `UPDATE privacy_operations
              SET status = 'COMPLETED', completed_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'RUNNING'`,
          [(request.params as IdParams).id, request.authUser.id],
        );
      } else {
        await pool.query(
          `UPDATE privacy_operations
              SET status = CASE WHEN output_expires_at > now() THEN 'READY' ELSE 'EXPIRED' END,
                  completed_at = CASE WHEN output_expires_at > now() THEN NULL ELSE now() END,
                  updated_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'RUNNING'`,
          [(request.params as IdParams).id, request.authUser.id],
        );
      }
    } catch {
      settledExports.delete(request);
      request.log.error({ requestId: request.id, errorCode: "EXPORT_RELEASE_FAILED" }, "export release failed");
    }
  };
  if (options.provisionStorage) await storage.ensureBucket();
  app.addHook("onClose", async () => storage.destroy());

  app.post<{ Body: ImportBody }>(
    "/api/v1/imports",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              minItems: 1,
              maxItems: config.maxFilesPerBatch,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["clientItemKey", "originalFilename", "declaredMimeType", "expectedSizeBytes"],
                properties: {
                  clientItemKey: { type: "string", minLength: 1, maxLength: 128 },
                  originalFilename: { type: "string", minLength: 1, maxLength: 255 },
                  declaredMimeType: { type: "string", const: "application/pdf" },
                  expectedSizeBytes: { type: "integer", minimum: 1, maximum: config.maxFileBytes },
                  employmentId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const seen = new Set<string>();
      let normalized: ImportItemInput[];
      try {
        normalized = request.body.items.map((item) => {
          if (seen.has(item.clientItemKey)) throw new Error("DUPLICATE_ITEM_KEY");
          seen.add(item.clientItemKey);
          return { ...item, originalFilename: cleanFilename(item.originalFilename) };
        });
      } catch {
        throw new ApiError(400, "INVALID_IMPORT_ITEMS", "La lista de archivos no es válida.");
      }
      const newBatchBytes = normalized.reduce((total, item) => total + item.expectedSizeBytes, 0);
      if (newBatchBytes > config.maxBatchBytes) {
        throw new ApiError(413, "IMPORT_BATCH_TOO_LARGE", "El lote supera el tamaño máximo permitido.");
      }
      const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      const result = await withTransaction(async (client) => {
        const activeUser = await client.query(
          "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [request.authUser!.id],
        );
        if (!activeUser.rowCount) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
        const existing = await client.query(
          `SELECT id, request_fingerprint FROM import_batches
            WHERE user_id = $1 AND idempotency_key = $2`,
          [request.authUser!.id, idempotencyKey],
        );
        if (existing.rowCount) {
          if (existing.rows[0].request_fingerprint !== fingerprint) {
            throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "La clave ya fue usada con otro lote.");
          }
          const rows = await client.query(
            `SELECT id, employment_id, client_item_key, original_filename, expected_size_bytes, status, error_code
               FROM import_batch_items WHERE batch_id = $1 ORDER BY ordinal`,
            [existing.rows[0].id],
          );
          return { id: String(existing.rows[0].id), items: rows.rows.map(importItem) };
        }
        const active = await client.query(
          `SELECT count(*)::integer AS count FROM import_batches
            WHERE user_id = $1 AND status IN ('ACTIVE', 'PAUSED')`,
          [request.authUser!.id],
        );
        if (Number(active.rows[0].count) >= config.maxActiveImportsPerUser) {
          throw new ApiError(409, "TOO_MANY_ACTIVE_IMPORTS", "Terminá un lote antes de iniciar otro.");
        }
        const usage = await client.query(
          `SELECT
             (SELECT count(*) FROM documents
               WHERE user_id = $1 AND deleted_at IS NULL)
             +
             (SELECT count(*) FROM import_batch_items item
                JOIN import_batches batch ON batch.id = item.batch_id AND batch.user_id = item.user_id
                LEFT JOIN documents document ON document.import_batch_item_id = item.id
               WHERE item.user_id = $1 AND batch.status IN ('ACTIVE', 'PAUSED')
                 AND item.status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
                 AND document.id IS NULL) AS document_count,
             (SELECT COALESCE(sum(size_bytes), 0) FROM documents
               WHERE user_id = $1 AND deleted_at IS NULL AND original_deleted_at IS NULL)
             +
             (SELECT COALESCE(sum(item.expected_size_bytes), 0) FROM import_batch_items item
                JOIN import_batches batch ON batch.id = item.batch_id AND batch.user_id = item.user_id
                LEFT JOIN documents document ON document.import_batch_item_id = item.id
               WHERE item.user_id = $1 AND batch.status IN ('ACTIVE', 'PAUSED')
                 AND item.status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
                 AND document.id IS NULL) AS storage_bytes`,
          [request.authUser!.id],
        );
        if (Number(usage.rows[0].document_count) + normalized.length > config.maxUserDocuments) {
          throw new ApiError(409, "USER_DOCUMENT_QUOTA_EXCEEDED", "Alcanzaste el límite de documentos de tu cuenta.");
        }
        if (Number(usage.rows[0].storage_bytes) + newBatchBytes > config.maxUserStorageBytes) {
          throw new ApiError(413, "USER_STORAGE_QUOTA_EXCEEDED", "El lote supera el espacio disponible en tu cuenta.");
        }
        for (const item of normalized) {
          if (item.employmentId) {
            const owned = await client.query(
              "SELECT 1 FROM employments WHERE id = $1 AND user_id = $2",
              [item.employmentId, request.authUser!.id],
            );
            if (!owned.rowCount) throw new ApiError(404, "NOT_FOUND", "Empleo no encontrado.");
          }
        }
        const batchId = randomUUID();
        await client.query(
          `INSERT INTO import_batches (id, user_id, idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, $4)`,
          [batchId, request.authUser!.id, idempotencyKey, fingerprint],
        );
        const created = [];
        for (let ordinal = 0; ordinal < normalized.length; ordinal += 1) {
          const item = normalized[ordinal]!;
          const id = randomUUID();
          await client.query(
            `INSERT INTO import_batch_items (
               id, user_id, batch_id, employment_id, client_item_key, ordinal,
               original_filename, declared_mime_type, expected_size_bytes
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', $8)`,
            [id, request.authUser!.id, batchId, item.employmentId ?? null, item.clientItemKey, ordinal, item.originalFilename, item.expectedSizeBytes],
          );
          created.push({
            id,
            clientItemKey: item.clientItemKey,
            originalFilename: item.originalFilename,
            expectedSizeBytes: item.expectedSizeBytes,
            employmentId: item.employmentId ?? null,
            status: "PENDING_UPLOAD",
            errorCode: null,
          });
        }
        await audit(client, request.authUser!.id, "IMPORT_CREATED", "IMPORT_BATCH", batchId, { itemCount: normalized.length });
        return { id: batchId, items: created };
      });
      return reply.code(201).send({ data: result });
    },
  );

  app.get(
    "/api/v1/imports/active",
    { preHandler: requireAuth },
    async (request) => {
      const batch = await pool.query(
        `SELECT id, status, created_at, discarded_duplicate_count FROM import_batches
          WHERE user_id = $1 AND status IN ('ACTIVE', 'PAUSED')
          ORDER BY created_at DESC LIMIT 1`,
        [request.authUser!.id],
      );
      if (!batch.rowCount) return { data: null };
      const items = await pool.query(
        `SELECT id, employment_id, client_item_key, original_filename, expected_size_bytes, status, error_code
           FROM import_batch_items WHERE batch_id = $1 AND user_id = $2 ORDER BY ordinal`,
        [batch.rows[0].id, request.authUser!.id],
      );
      return { data: importBatchView(batch.rows[0], items.rows) };
    },
  );

  app.post<{ Params: IdParams }>(
    "/api/v1/imports/:id/cancel",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      const data = await withTransaction(async (client) => {
        const batch = await client.query(
          `SELECT id, status, created_at FROM import_batches
            WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!batch.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (!['ACTIVE', 'PAUSED'].includes(String(batch.rows[0].status))) {
          throw new ApiError(409, "IMPORT_NOT_ACTIVE", "El lote ya terminó.");
        }
        const cancelled = await client.query(
          `WITH cancelled_items AS (
             UPDATE import_batch_items SET status = 'CANCELLED', error_code = 'IMPORT_CANCELLED_BY_USER', updated_at = now()
              WHERE batch_id = $1 AND user_id = $2 AND status = 'PENDING_UPLOAD'
              RETURNING id
           ), cancelled_sessions AS (
             UPDATE upload_sessions SET status = 'EXPIRED'
              WHERE user_id = $2 AND status = 'OPEN' AND item_id IN (SELECT id FROM cancelled_items)
              RETURNING item_id
           )
           SELECT count(*)::integer AS count FROM cancelled_items`,
          [request.params.id, request.authUser!.id],
        );
        await client.query(
          `UPDATE import_batches SET status = 'CANCELLED', completed_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2
              AND NOT EXISTS (
                SELECT 1 FROM import_batch_items
                 WHERE batch_id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
              )`,
          [request.params.id, request.authUser!.id],
        );
        await audit(client, request.authUser!.id, "IMPORT_PENDING_CANCELLED", "IMPORT_BATCH", request.params.id, {
          itemCount: Number(cancelled.rows[0].count),
        });
        const currentBatch = await client.query(
          "SELECT id, status, created_at, discarded_duplicate_count FROM import_batches WHERE id = $1 AND user_id = $2",
          [request.params.id, request.authUser!.id],
        );
        const items = await client.query(
          `SELECT id, employment_id, client_item_key, original_filename, expected_size_bytes, status, error_code
             FROM import_batch_items WHERE batch_id = $1 AND user_id = $2 ORDER BY ordinal`,
          [request.params.id, request.authUser!.id],
        );
        return importBatchView(currentBatch.rows[0], items.rows);
      });
      return { data };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/imports/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      const batch = await pool.query(
        `SELECT id, status, created_at, discarded_duplicate_count FROM import_batches WHERE id = $1 AND user_id = $2`,
        [request.params.id, request.authUser!.id],
      );
      if (!batch.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const items = await pool.query(
        `SELECT id, employment_id, client_item_key, original_filename, expected_size_bytes, status, error_code
           FROM import_batch_items WHERE batch_id = $1 AND user_id = $2 ORDER BY ordinal`,
        [request.params.id, request.authUser!.id],
      );
      return { data: importBatchView(batch.rows[0], items.rows) };
    },
  );

  app.post<{ Body: UploadBody }>(
    "/api/v1/upload-sessions",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["itemId"],
          properties: { itemId: { type: "string", pattern: UUID_PATTERN } },
        },
      },
    },
    async (request, reply) => {
      const prepared = await withTransaction(async (client) => {
        const activeUser = await client.query(
          "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [request.authUser!.id],
        );
        if (!activeUser.rowCount) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
        const item = await client.query(
          `SELECT item.id, item.batch_id, item.expected_size_bytes, item.status, batch.status AS batch_status
             FROM import_batch_items item
             JOIN import_batches batch ON batch.id = item.batch_id AND batch.user_id = item.user_id
            WHERE item.id = $1 AND item.user_id = $2 FOR UPDATE OF batch, item`,
          [request.body.itemId, request.authUser!.id],
        );
        if (!item.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (item.rows[0].batch_status !== "ACTIVE" || item.rows[0].status !== "PENDING_UPLOAD") {
          throw new ApiError(409, "ITEM_NOT_UPLOADABLE", "El archivo ya no admite una carga.");
        }
        await client.query(
          "UPDATE import_batches SET updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'",
          [item.rows[0].batch_id, request.authUser!.id],
        );
        await client.query(
          `UPDATE upload_sessions SET status = 'EXPIRED'
            WHERE item_id = $1 AND status = 'OPEN' AND expires_at < now() + interval '1 second'`,
          [request.body.itemId],
        );
        const current = await client.query(
          `SELECT id, object_key, expected_size_bytes, expires_at, upload_marker_etag
             FROM upload_sessions WHERE item_id = $1 AND status = 'OPEN'`,
          [request.body.itemId],
        );
        if (current.rowCount) {
          const row = current.rows[0];
          if (config.storageProvider === "r2") return { ...row, signed: null };
          const expiresIn = Math.max(1, Math.floor((new Date(row.expires_at).valueOf() - Date.now()) / 1_000));
          const signed = await storage.authorizeUpload(
            String(row.id),
            String(row.object_key),
            Number(row.expected_size_bytes),
            expiresIn,
          );
          return { ...row, signed };
        }
        const id = randomUUID();
        const objectKey = `incoming/${randomUUID()}.pdf`;
        const expiresAt = new Date(Date.now() + config.uploadTtlSeconds * 1000);
        if (
          config.storageProvider === "r2"
          && !await lockR2UploadCapacity(client, Number(item.rows[0].expected_size_bytes))
        ) {
          throw new ApiError(503, "R2_STORAGE_CAPACITY_EXCEEDED", "El almacenamiento no tiene capacidad disponible temporalmente.");
        }
        await client.query(
          `INSERT INTO upload_sessions (
             id, user_id, batch_id, item_id, object_key, expected_size_bytes,
             expected_mime_type, expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'application/pdf', $7)`,
          [id, request.authUser!.id, item.rows[0].batch_id, request.body.itemId, objectKey, item.rows[0].expected_size_bytes, expiresAt],
        );
        if (config.storageProvider === "r2") {
          return {
            id,
            object_key: objectKey,
            expected_size_bytes: item.rows[0].expected_size_bytes,
            expires_at: expiresAt,
            upload_marker_etag: null,
            signed: null,
          };
        }
        const signed = await storage.authorizeUpload(
          id,
          objectKey,
          Number(item.rows[0].expected_size_bytes),
          Math.floor((expiresAt.valueOf() - Date.now()) / 1_000),
        );
        return {
          id,
          object_key: objectKey,
          expected_size_bytes: item.rows[0].expected_size_bytes,
          expires_at: expiresAt,
          upload_marker_etag: null,
          signed,
        };
      });
      let upload = prepared;
      if (config.storageProvider === "r2") {
        let markerEtag = typeof prepared.upload_marker_etag === "string"
          ? prepared.upload_marker_etag
          : null;
        if (!markerEtag) {
          try {
            markerEtag = await storage.createUploadMarker(String(prepared.id), String(prepared.object_key));
          } catch {
            throw new ApiError(503, "STORAGE_UNAVAILABLE", "El almacenamiento no está disponible temporalmente.");
          }
        }
        // Keep the R2 same-key write window outside every database/advisory lock.
        await waitForR2WriteWindow();
        const finalized = await withTransaction(async (client) => {
          const locked = await client.query(
            `SELECT session.id, session.object_key, session.expected_size_bytes,
                    session.status, session.expires_at, session.upload_marker_etag,
                    item.status AS item_status, batch.status AS batch_status
               FROM upload_sessions AS session
               JOIN import_batch_items AS item
                 ON item.id = session.item_id AND item.user_id = session.user_id
               JOIN import_batches AS batch
                 ON batch.id = session.batch_id AND batch.user_id = session.user_id
               JOIN users ON users.id = session.user_id AND users.status = 'ACTIVE'
              WHERE session.id = $1 AND session.user_id = $2
              FOR UPDATE OF users, batch, item, session`,
            [prepared.id, request.authUser!.id],
          );
          if (!locked.rowCount) return { kind: "not-found" as const };
          const row = locked.rows[0];
          if (
            row.item_status !== "PENDING_UPLOAD"
            || row.batch_status !== "ACTIVE"
            || row.status !== "OPEN"
            || new Date(row.expires_at).valueOf() <= Date.now() + 1_000
          ) {
            return { kind: "not-uploadable" as const };
          }
          if (row.upload_marker_etag && row.upload_marker_etag !== markerEtag) {
            return { kind: "storage-error" as const };
          }
          if (!row.upload_marker_etag) {
            await client.query(
              `UPDATE upload_sessions SET upload_marker_etag = $2
                WHERE id = $1 AND user_id = $3 AND status = 'OPEN'`,
              [prepared.id, markerEtag, request.authUser!.id],
            );
          }
          if (!await lockR2UploadCapacity(client, 0)) {
            return { kind: "capacity" as const };
          }
          const expiresIn = Math.floor((new Date(row.expires_at).valueOf() - Date.now()) / 1_000);
          try {
            const signed = await storage.authorizeUpload(
              String(row.id),
              String(row.object_key),
              Number(row.expected_size_bytes),
              expiresIn,
              markerEtag,
            );
            return { kind: "ready" as const, row, signed };
          } catch {
            return { kind: "storage-error" as const };
          }
        });
        if (finalized.kind === "not-found") {
          throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        }
        if (finalized.kind === "not-uploadable") {
          throw new ApiError(409, "ITEM_NOT_UPLOADABLE", "El archivo ya no admite una carga.");
        }
        if (finalized.kind === "capacity") {
          throw new ApiError(503, "R2_STORAGE_CAPACITY_EXCEEDED", "El almacenamiento no tiene capacidad disponible temporalmente.");
        }
        if (finalized.kind === "storage-error") {
          throw new ApiError(503, "STORAGE_UNAVAILABLE", "El almacenamiento no está disponible temporalmente.");
        }
        upload = { ...finalized.row, signed: finalized.signed };
      }
      return reply.code(201).send({
        data: {
          id: String(upload.id),
          url: upload.signed.url,
          fields: upload.signed.fields,
          method: upload.signed.method,
          headers: upload.signed.headers,
          expiresAt: timestamp(upload.expires_at),
        },
      });
    },
  );

  app.post<{ Params: IdParams }>(
    "/api/v1/upload-sessions/:id/complete",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      const found = await pool.query(
        `SELECT session.id, session.item_id, session.object_key, session.expected_size_bytes,
                session.status, session.expires_at
           FROM upload_sessions session
          WHERE session.id = $1 AND session.user_id = $2`,
        [request.params.id, request.authUser!.id],
      );
      if (!found.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const session = found.rows[0];
      if (session.status === "CONFIRMED") {
        const existing = await pool.query(
          `SELECT document.id, document.processing_status, job.id AS job_id, job.state AS job_state
             FROM documents document JOIN processing_jobs job ON job.document_id = document.id
            WHERE document.upload_session_id = $1 AND document.user_id = $2
            ORDER BY job.created_at LIMIT 1`,
          [request.params.id, request.authUser!.id],
        );
        return { data: { id: String(existing.rows[0].id), processingStatus: String(existing.rows[0].processing_status), job: { id: String(existing.rows[0].job_id), state: String(existing.rows[0].job_state) } } };
      }
      if (session.status !== "OPEN" || new Date(session.expires_at).valueOf() <= Date.now()) {
        await pool.query(
          "UPDATE upload_sessions SET status = 'EXPIRED' WHERE id = $1 AND user_id = $2 AND status = 'OPEN'",
          [request.params.id, request.authUser!.id],
        );
        throw new ApiError(409, "UPLOAD_SESSION_EXPIRED", "La autorización de carga venció.");
      }
      const canonicalKey = storage.canonicalKey(request.params.id);
      const created = await withTransaction(async (client) => {
        const locked = await client.query(
          `SELECT session.id, session.item_id, session.batch_id, session.status, session.expires_at,
                  item.original_filename, item.declared_mime_type, item.expected_size_bytes,
                  item.employment_id, users.default_retention_policy
             FROM upload_sessions session
             JOIN import_batch_items item ON item.id = session.item_id AND item.user_id = session.user_id
             JOIN users ON users.id = session.user_id AND users.status = 'ACTIVE'
            WHERE session.id = $1 AND session.user_id = $2 FOR UPDATE OF users, session, item`,
          [request.params.id, request.authUser!.id],
        );
        if (!locked.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = locked.rows[0];
        if (row.status === "CONFIRMED") {
          const current = await client.query(
            `SELECT document.id, document.processing_status, job.id AS job_id, job.state AS job_state
               FROM documents document JOIN processing_jobs job ON job.document_id = document.id
              WHERE document.upload_session_id = $1 ORDER BY job.created_at LIMIT 1`,
            [request.params.id],
          );
          return { id: String(current.rows[0].id), processingStatus: String(current.rows[0].processing_status), job: { id: String(current.rows[0].job_id), state: String(current.rows[0].job_state) } };
        }
        if (row.status !== "OPEN" || new Date(row.expires_at).valueOf() <= Date.now()) {
          throw new ApiError(409, "UPLOAD_SESSION_EXPIRED", "La autorización de carga venció.");
        }
        let etag: string;
        try {
          etag = await storage.inspectUpload(request.params.id, String(session.object_key), Number(session.expected_size_bytes));
        } catch {
          throw new ApiError(409, "UPLOAD_OBJECT_MISMATCH", "El archivo recibido no coincide con la autorización.");
        }
        try {
          await storage.makeCanonical(
            request.params.id,
            String(session.object_key),
            canonicalKey,
            etag,
            Number(session.expected_size_bytes),
          );
        } catch {
          throw new ApiError(503, "STORAGE_UNAVAILABLE", "El almacenamiento no está disponible temporalmente.");
        }
        const documentId = String(row.item_id);
        const jobId = randomUUID();
        await client.query(
          `INSERT INTO documents (
             id, user_id, import_batch_id, import_batch_item_id, upload_session_id,
             employment_id, object_key, original_filename, declared_mime_type,
             size_bytes, processing_status, retention_policy
           ) VALUES ($1, $2, $3, $1, $4, $5, $6, $7, $8, $9, 'UPLOADED', $10)`,
          [documentId, request.authUser!.id, row.batch_id, request.params.id, row.employment_id, canonicalKey, row.original_filename, row.declared_mime_type, row.expected_size_bytes, row.default_retention_policy],
        );
        await client.query(
          `INSERT INTO processing_jobs (
             id, user_id, document_id, stage, processing_version, idempotency_key,
             trigger_kind, requested_by_user_id, pipeline_fingerprint
           ) VALUES ($1, $2, $3, 'DOCUMENT_PIPELINE_V2', 1, $4,
             'INITIAL_UPLOAD', $2, $5)`,
          [jobId, request.authUser!.id, documentId, `security:${documentId}:v1`, currentPipelineFingerprint],
        );
        await client.query(
          "UPDATE upload_sessions SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1",
          [request.params.id],
        );
        await client.query(
          "UPDATE import_batch_items SET status = 'UPLOADED', updated_at = now() WHERE id = $1",
          [documentId],
        );
        await audit(client, request.authUser!.id, "UPLOAD_CONFIRMED", "DOCUMENT", documentId);
        return { id: documentId, processingStatus: "UPLOADED", job: { id: jobId, state: "PENDING" } };
      });
      try {
        await storage.deleteObject(String(session.object_key));
        if (config.storageProvider === "r2") {
          await pool.query(
            `UPDATE upload_sessions SET object_key = $2
              WHERE id = $1 AND status = 'CONFIRMED' AND object_key = $3`,
            [request.params.id, canonicalKey, session.object_key],
          );
        }
      } catch {
        // El reconciliador reintenta; la respuesta no depende de este cleanup.
      }
      return { data: created };
    },
  );

  app.get(
    "/api/v1/dashboard",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.authUser!.id;
      const [counts, history] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT count(*)::integer FROM employments WHERE user_id = $1 AND status = 'ACTIVE') AS active_employments,
             (SELECT count(*)::integer FROM documents WHERE user_id = $1 AND deleted_at IS NULL) AS documents,
             (SELECT count(*)::integer FROM documents WHERE user_id = $1 AND deleted_at IS NULL
                AND processing_status IN ('NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION')) AS pending_review`,
          [userId],
        ),
        loadSalaryHistory(userId),
      ]);
      const row = counts.rows[0];
      const eligibleScopes = history.response.analytics.scopes.filter((_, index) => (
        history.response.contexts[index]?.state !== "UNCONFIRMED"
      ));
      const scope = eligibleScopes.length === 1 ? eligibleScopes[0] : null;
      return { data: {
        activeEmployments: Number(row.active_employments),
        documents: Number(row.documents),
        pendingReview: Number(row.pending_review),
        latestNetAmount: scope?.current?.amounts.netAmount ?? null,
        currencyCode: scope?.currencyCode ?? null,
        evolution: (scope?.evolution ?? []).slice(-18).map((point) => ({
          period: point.period, gross: point.regular.grossAmount, net: point.regular.netAmount,
        })),
      } };
    },
  );

  app.get(
    "/api/v1/salary-history",
    { preHandler: requireAuth },
    async (request) => ({ data: (await loadSalaryHistory(request.authUser!.id)).response }),
  );

  app.get<{ Querystring: SalaryConceptQuery }>(
    "/api/v1/salary-history/concepts",
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["employmentContext", "currencyCode"],
          properties: {
            employmentContext: { type: "string", minLength: 1, maxLength: 128 },
            currencyCode: { type: "string", pattern: "^[A-Z]{3}$" },
            employerName: { type: "string", minLength: 1, maxLength: 160 },
            year: { type: "string", pattern: "^20\\d{2}$" },
            category: { type: "string", enum: [...SALARY_CATEGORIES] },
            limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" },
            cursor: { type: "string", pattern: "^[A-Za-z0-9_-]{1,512}$" },
          },
        },
      },
    },
    async (request) => {
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      const cursor = request.query.cursor === undefined ? null : parseSalaryConceptCursor(request.query.cursor);
      if (request.query.cursor !== undefined && cursor === null) {
        throw new ApiError(400, "VALIDATION_ERROR", "El cursor no es válido.");
      }
      const parameters: unknown[] = [request.authUser!.id, request.query.currencyCode];
      const parameter = (input: unknown) => {
        parameters.push(input);
        return `$${parameters.length}`;
      };
      const conditions = [
        "document.user_id = $1",
        "document.deleted_at IS NULL",
        "document.document_type = 'PAYROLL'",
        "document.processing_status = 'COMPLETED'",
        "document.active_extraction_run_id IS NOT NULL",
        "settlement.currency_code = $2",
        "item.item_type = 'EARNING'",
        "item.normalized_concept_code IS NOT NULL",
      ];
      let includeDetectedEmployer = false;
      const stableDetectedContext = /^detected:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(request.query.employmentContext);
      const legacyDetectedContext = /^detected:[0-9a-f]{24}$/.test(request.query.employmentContext);
      const unconfirmedContext = /^unconfirmed:([0-9a-f-]{36})$/.exec(request.query.employmentContext);
      if (uuid.test(request.query.employmentContext)) {
        conditions.push(`settlement.employment_id = ${parameter(request.query.employmentContext)}::uuid`);
      } else if (stableDetectedContext) {
        conditions.push("settlement.employment_id IS NULL");
        conditions.push(`document.detected_employer_id = ${parameter(stableDetectedContext[1])}::uuid`);
      } else if (legacyDetectedContext) {
        const identity = request.query.employerName === undefined
          ? null
          : detectedEmploymentIdentity(request.query.employerName);
        if (identity === null || identity.context !== request.query.employmentContext) {
          throw new ApiError(400, "VALIDATION_ERROR", "El contexto laboral no es válido.");
        }
        includeDetectedEmployer = true;
        conditions.push("settlement.employment_id IS NULL");
        conditions.push(`normalize_employer_name_conservative(detected_employer.name) = ${parameter(identity.key)}`);
      } else if (unconfirmedContext !== null && uuid.test(unconfirmedContext[1]!)) {
        includeDetectedEmployer = true;
        conditions.push("settlement.employment_id IS NULL");
        conditions.push(`document.id = ${parameter(unconfirmedContext[1])}::uuid`);
        conditions.push("NULLIF(btrim(normalize(detected_employer.name, NFKC)), '') IS NULL");
      } else {
        return { data: { items: [], nextCursor: null } };
      }
      if (request.query.year !== undefined) {
        conditions.push(`settlement.payroll_period >= ${parameter(`${request.query.year}-01-01`)}::date`);
        conditions.push(`settlement.payroll_period < ${parameter(`${Number(request.query.year) + 1}-01-01`)}::date`);
      }
      if (request.query.category !== undefined) {
        conditions.push(`(${salaryConceptCategorySql}) = ${parameter(request.query.category)}`);
      }
      if (cursor !== null) {
        const cursorPeriod = parameter(`${cursor.period}-01`);
        const cursorCreated = parameter(cursor.settlementCreatedMicros);
        const cursorOrdinal = parameter(cursor.settlementOrdinal);
        const cursorSettlementId = parameter(cursor.settlementId);
        const cursorItemOrdinal = parameter(cursor.itemOrdinal);
        const cursorItemId = parameter(cursor.itemId);
        const createdMicros = "extract(epoch FROM settlement.created_at) * 1000000";
        conditions.push(`(
          settlement.payroll_period < ${cursorPeriod}::date
          OR (settlement.payroll_period = ${cursorPeriod}::date
            AND ${createdMicros} < ${cursorCreated}::numeric)
          OR (settlement.payroll_period = ${cursorPeriod}::date
            AND ${createdMicros} = ${cursorCreated}::numeric
            AND (settlement.settlement_ordinal, settlement.id, item.item_ordinal, item.id)
              > (${cursorOrdinal}::integer, ${cursorSettlementId}::uuid, ${cursorItemOrdinal}::integer, ${cursorItemId}::uuid))
        )`);
      }
      parameters.push(limit + 1);
      const result = await pool.query(
        `SELECT to_char(settlement.payroll_period, 'YYYY-MM') AS period,
                (extract(epoch FROM settlement.created_at) * 1000000)::numeric(30, 0)::text
                  AS settlement_created_micros,
                settlement.settlement_ordinal, settlement.id AS settlement_id,
                settlement.settlement_type, item.item_ordinal, item.id AS item_id,
                item.normalized_concept_code, item.is_recurring, item.amount
           FROM documents document
           JOIN extraction_runs run
             ON run.id = document.active_extraction_run_id
            AND run.document_id = document.id
            AND run.user_id = document.user_id
           JOIN payroll_settlements settlement
             ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
           JOIN payroll_line_items item
             ON item.settlement_id = settlement.id AND item.user_id = settlement.user_id
           ${includeDetectedEmployer ? detectedEmployerNameJoin : ""}
          WHERE ${conditions.join(" AND ")}
          ORDER BY settlement.payroll_period DESC, settlement.created_at DESC,
                   settlement.settlement_ordinal, settlement.id, item.item_ordinal, item.id
          LIMIT $${parameters.length}`,
        parameters,
      );
      const page = result.rows.slice(0, limit);
      const items = page.map((row) => ({
        period: String(row.period),
        settlementId: String(row.settlement_id),
        settlementType: String(row.settlement_type),
        earningIndex: Number(row.item_ordinal),
        category: salaryCategoryForEarning(String(row.normalized_concept_code), row.is_recurring as boolean | null),
        code: String(row.normalized_concept_code),
        isRecurring: typeof row.is_recurring === "boolean" ? row.is_recurring : null,
        amount: String(row.amount),
      }));
      const last = page.at(-1);
      return { data: {
        items,
        nextCursor: last && result.rows.length > limit ? salaryConceptCursor({
          period: String(last.period),
          settlementCreatedMicros: String(last.settlement_created_micros),
          settlementOrdinal: Number(last.settlement_ordinal),
          settlementId: String(last.settlement_id),
          itemOrdinal: Number(last.item_ordinal),
          itemId: String(last.item_id),
        }) : null,
      } };
    },
  );

  app.get<{ Querystring: SalaryComparisonQuery }>(
    "/api/v1/salary-history/comparison",
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["employmentContext", "currencyCode", "fromPeriod", "toPeriod"],
          properties: {
            employmentContext: { type: "string", minLength: 1, maxLength: 128 },
            currencyCode: { type: "string", pattern: "^[A-Z]{3}$" },
            fromPeriod: { type: "string", pattern: "^20\\d{2}-(0[1-9]|1[0-2])$" },
            toPeriod: { type: "string", pattern: "^20\\d{2}-(0[1-9]|1[0-2])$" },
          },
        },
      },
    },
    async (request) => {
      const history = await loadSalaryHistory(request.authUser!.id);
      const comparison = compareSalaryPeriods(history.settlements, request.query);
      return { data: comparison };
    },
  );

  app.get<{ Querystring: { limit?: string; page?: string } }>(
    "/api/v1/reprocessing/candidates",
    {
      preHandler: requireAuth,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" },
            page: { type: "string", pattern: "^[1-9][0-9]{0,4}$" },
          },
        },
      },
    },
    async (request) => {
      const pageSize = request.query.limit === undefined ? 100 : Number(request.query.limit);
      const page = request.query.page === undefined ? 1 : Number(request.query.page);
      const [candidates, total] = await Promise.all([
        findReprocessingCandidates(pool, request.authUser!.id, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        countReprocessingCandidates(pool, request.authUser!.id),
      ]);
      return {
        data: {
          items: candidates.map((candidate) => ({
            ...candidate,
            available: !candidate.inProgress,
            message: "Hay una versión más reciente del análisis que puede mejorar este resultado.",
          })),
          page,
          pageSize,
          total,
          batchLimit: 100,
        },
      };
    },
  );

  app.post<{ Body: ReprocessingBatchBody }>(
    "/api/v1/reprocessing-batches",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            documentIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: "string", pattern: UUID_PATTERN },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const requestedKey = request.headers["idempotency-key"];
      if (typeof requestedKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestedKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const result = await withTransaction(async (client) => {
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.authUser!.id]);
        const idempotencyKey = `reprocess-batch:${createHash("sha256").update(requestedKey).digest("hex")}`;
        const existing = await client.query(
          `SELECT id FROM reprocessing_batches WHERE user_id = $1 AND idempotency_key = $2`,
          [request.authUser!.id, idempotencyKey],
        );
        if (existing.rowCount) {
          return { created: false, batch: await loadReprocessingBatch(client, request.authUser!.id, String(existing.rows[0].id)) };
        }
        const activeBatch = await client.query(
          `SELECT id FROM reprocessing_batches
            WHERE user_id = $1 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
          [request.authUser!.id],
        );
        if (activeBatch.rowCount) {
          throw new ApiError(409, "REPROCESSING_BATCH_ALREADY_ACTIVE", "Esperá a que termine el lote actual.");
        }
        const requestedIds = request.body?.documentIds;
        const foundCandidates = await findReprocessingCandidates(client, request.authUser!.id, {
          ...(requestedIds ? { documentIds: requestedIds } : {}),
          limit: requestedIds?.length ?? 100,
        });
        if (requestedIds && foundCandidates.length !== requestedIds.length) {
          throw new ApiError(409, "BATCH_CONTAINS_UNAVAILABLE_DOCUMENT", "Uno o más documentos no están disponibles para reprocesar.");
        }
        const candidates = foundCandidates.filter((candidate) => !candidate.inProgress);
        if (!candidates.length) {
          throw new ApiError(409, "NO_REPROCESSING_CANDIDATES", "No hay recibos que puedan mejorarse en este momento.");
        }
        const batchId = randomUUID();
        await client.query(
          `INSERT INTO reprocessing_batches (
             id, user_id, requested_by_user_id, trigger_kind, idempotency_key
           ) VALUES ($1, $2, $2, 'USER_REPROCESS', $3)`,
          [batchId, request.authUser!.id, idempotencyKey],
        );
        await enqueueReprocessingBatch(client, {
          userId: request.authUser!.id,
          requestedByUserId: request.authUser!.id,
          documentIds: candidates.map((candidate) => candidate.documentId),
          triggerKind: "USER_REPROCESS",
          batchId,
        }, ApiError);
        await audit(client, request.authUser!.id, "REPROCESSING_BATCH_REQUESTED", "REPROCESSING_BATCH", batchId, {
          documentCount: candidates.length,
        });
        return { created: true, batch: await loadReprocessingBatch(client, request.authUser!.id, batchId) };
      });
      return reply.code(result.created ? 201 : 200).send({ data: result.batch });
    },
  );

  app.get(
    "/api/v1/reprocessing-batches/active",
    { preHandler: requireAuth },
    async (request) => {
      const active = await pool.query(
        `SELECT id FROM reprocessing_batches
          WHERE user_id = $1 AND status IN ('PENDING', 'RUNNING')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [request.authUser!.id],
      );
      return {
        data: active.rowCount
          ? await loadReprocessingBatch(pool, request.authUser!.id, String(active.rows[0].id))
          : null,
      };
    },
  );

  app.get(
    "/api/v1/reprocessing-batches/latest",
    { preHandler: requireAuth },
    async (request) => {
      const latest = await pool.query(
        `SELECT id FROM reprocessing_batches
          WHERE user_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [request.authUser!.id],
      );
      return {
        data: latest.rowCount
          ? await loadReprocessingBatch(pool, request.authUser!.id, String(latest.rows[0].id))
          : null,
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/reprocessing-batches/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      const batch = await loadReprocessingBatch(pool, request.authUser!.id, request.params.id);
      if (!batch) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: batch };
    },
  );

  app.get<{ Params: IdParams; Querystring: { limit?: string } }>(
    "/api/v1/documents/:id/processing-runs",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "string", pattern: "^(?:[1-9]|[1-4][0-9]|50)$" } },
        },
      },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT run.id, run.processing_version, run.status, run.trigger_kind,
                run.parser_version, run.result_schema_version, run.pipeline_fingerprint,
                run.promotion_outcome, run.comparison_summary, run.promoted_at,
                run.started_at, run.finished_at,
                (run.id = document.active_extraction_run_id) AS active,
                ${processingRunDecisionRequiredSql("run")} AS decision_required
           FROM documents document
           JOIN extraction_runs run
             ON run.user_id = document.user_id AND run.document_id = document.id
          WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
          ORDER BY run.processing_version DESC, run.id DESC
          LIMIT $3`,
        [request.params.id, request.authUser!.id, request.query.limit === undefined ? 25 : Number(request.query.limit)],
      );
      if (!result.rowCount) {
        const document = await pool.query(
          "SELECT 1 FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
          [request.params.id, request.authUser!.id],
        );
        if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      }
      return { data: { items: result.rows.map(processingRunView) } };
    },
  );

  app.get<{ Params: ProcessingRunParams }>(
    "/api/v1/documents/:id/processing-runs/:runId",
    {
      preHandler: requireAuth,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id", "runId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            runId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request) => {
      const [run, issues] = await Promise.all([
        pool.query(
          `SELECT run.id, run.processing_version, run.status, run.trigger_kind,
                  run.parser_version, run.result_schema_version, run.pipeline_fingerprint,
                  run.promotion_outcome, run.comparison_summary, run.promoted_at,
                  run.started_at, run.finished_at,
                  (run.id = document.active_extraction_run_id) AS active,
                  ${processingRunDecisionRequiredSql("run")} AS decision_required
             FROM documents document
             JOIN extraction_runs run
               ON run.user_id = document.user_id AND run.document_id = document.id
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
              AND run.id = $3`,
          [request.params.id, request.authUser!.id, request.params.runId],
        ),
        pool.query(
          `SELECT id, code, severity, recoverable, affected_field_path, created_at
             FROM extraction_run_issues
            WHERE document_id = $1 AND user_id = $2 AND extraction_run_id = $3
            ORDER BY severity DESC, code, affected_field_path`,
          [request.params.id, request.authUser!.id, request.params.runId],
        ),
      ]);
      if (!run.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const comparisonPreview = await loadProcessingComparisonPreview(
        pool,
        request.authUser!.id,
        request.params.id,
        request.params.runId,
      );
      return {
        data: {
          ...processingRunView(run.rows[0]),
          comparisonPreview,
          issues: issues.rows.map((issue) => ({
            id: String(issue.id),
            code: String(issue.code),
            severity: String(issue.severity),
            recoverable: issue.recoverable === true,
            affectedFieldPath: value(issue, "affected_field_path"),
            createdAt: timestamp(issue.created_at),
          })),
        },
      };
    },
  );

  app.post<{ Params: ProcessingRunParams; Body: ProcessingRunDecisionBody }>(
    "/api/v1/documents/:id/processing-runs/:runId/decision",
    {
      preHandler: requireAuth,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id", "runId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            runId: { type: "string", pattern: UUID_PATTERN },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "expectedActiveRunId"],
          properties: {
            decision: { type: "string", enum: ["PROMOTE", "KEEP_ACTIVE"] },
            expectedActiveRunId: {
              anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }],
            },
          },
        },
      },
    },
    async (request) => {
      const result = await withTransaction(async (client) => {
        const decision = await promoteProcessingRun(client, {
          userId: request.authUser!.id,
          documentId: request.params.id,
          runId: request.params.runId,
          expectedActiveRunId: request.body.expectedActiveRunId,
          decision: request.body.decision,
          requireReviewCandidate: true,
        }, ApiError);
        await audit(client, request.authUser!.id, "PROCESSING_RUN_DECIDED", "EXTRACTION_RUN", request.params.runId, {
          decision: request.body.decision,
          documentId: request.params.id,
          employmentAssociationRemoved: decision.employmentAssociationRemoved ?? false,
          previousActiveRunId: request.body.expectedActiveRunId ?? "NONE",
        });
        return decision;
      });
      return { data: result };
    },
  );

  app.get<{ Querystring: DocumentListQuery }>(
    "/api/v1/documents",
    { preHandler: requireAuth },
    async (request) => withTransaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      if (Object.values(request.query as Record<string, unknown>)
        .some((queryValue) => typeof queryValue !== "string")) {
        throw new ApiError(400, "VALIDATION_ERROR", "Los filtros no son válidos.");
      }
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new ApiError(400, "VALIDATION_ERROR", "El límite no es válido.");
      }
      const cursor = request.query.cursor === undefined ? null : parseDocumentCursor(request.query.cursor);
      if (request.query.cursor !== undefined && cursor === null) {
        throw new ApiError(400, "VALIDATION_ERROR", "El cursor no es válido.");
      }
      const search = request.query.search?.trim();
      if (search && search.length > 100) throw new ApiError(400, "VALIDATION_ERROR", "La búsqueda es demasiado larga.");
      if (request.query.year !== undefined && !/^20\d{2}$/.test(request.query.year)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El año no es válido.");
      }
      if (request.query.period !== undefined && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(request.query.period)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El período no es válido.");
      }
      if (request.query.employmentId !== undefined
        && request.query.employmentId !== "unassociated"
        && !uuid.test(request.query.employmentId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El empleo no es válido.");
      }
      const hasEmploymentContext = request.query.employmentContext !== undefined;
      const hasCurrencyCode = request.query.currencyCode !== undefined;
      if (hasEmploymentContext !== hasCurrencyCode) {
        throw new ApiError(400, "VALIDATION_ERROR", "El contexto laboral y la moneda deben informarse juntos.");
      }
      if (request.query.employmentContext !== undefined
        && (request.query.employmentContext.length < 1 || request.query.employmentContext.length > 128)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El contexto laboral no es válido.");
      }
      if (request.query.currencyCode !== undefined && !/^[A-Z]{3}$/.test(request.query.currencyCode)) {
        throw new ApiError(400, "VALIDATION_ERROR", "La moneda no es válida.");
      }
      if (request.query.employerName !== undefined
        && (request.query.employerName.length < 1 || request.query.employerName.length > 160)) {
        throw new ApiError(400, "VALIDATION_ERROR", "La empresa no es válida.");
      }
      if (request.query.employerName !== undefined && !hasEmploymentContext) {
        throw new ApiError(400, "VALIDATION_ERROR", "La empresa requiere un contexto laboral.");
      }
      if (request.query.documentType !== undefined && !["PAYROLL", "UNSUPPORTED"].includes(request.query.documentType)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El tipo de documento no es válido.");
      }
      if (request.query.settlementType !== undefined && !settlementTypes.has(request.query.settlementType)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El tipo de liquidación no es válido.");
      }
      if (request.query.processingStatus !== undefined
        && !documentProcessingStatuses.has(request.query.processingStatus)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El estado no es válido.");
      }
      if (request.query.statusGroup !== undefined && !documentStatusGroups.has(request.query.statusGroup)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El grupo de estado no es válido.");
      }
      const parameters: unknown[] = [request.authUser!.id];
      const conditions = ["document.user_id = $1", "document.deleted_at IS NULL"];
      const parameter = (input: unknown) => {
        parameters.push(input);
        return `$${parameters.length}`;
      };
      if (search) {
        const semantic = documentSearchTerms(search);
        const searchParameter = parameter(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
        const searchConditions = [
          `document.original_filename ILIKE ${searchParameter} ESCAPE '\\'`,
          `COALESCE(employer.name, projection.corrected_employer_name, projection.extracted_employer_name, '')
             ILIKE ${searchParameter} ESCAPE '\\'`,
        ];
        if (semantic.period) searchConditions.push(`projection.payroll_period = ${parameter(semantic.period)}`);
        else if (semantic.month) {
          searchConditions.push(`substring(projection.payroll_period FROM 6 FOR 2) = ${parameter(semantic.month)}`);
        }
        else if (semantic.year) searchConditions.push(`projection.payroll_period LIKE ${parameter(`${semantic.year}-%`)}`);
        if (semantic.settlementType) {
          searchConditions.push(`projection.settlement_type = ${parameter(semantic.settlementType)}`);
        }
        conditions.push(`(${searchConditions.join(" OR ")})`);
      }
      if (request.query.year) conditions.push(`projection.payroll_period LIKE ${parameter(`${request.query.year}-%`)}`);
      if (request.query.period) conditions.push(`projection.payroll_period = ${parameter(request.query.period)}`);
      if (request.query.employmentId === "unassociated") conditions.push("document.employment_id IS NULL");
      else if (request.query.employmentId) conditions.push(`document.employment_id = ${parameter(request.query.employmentId)}::uuid`);
      if (request.query.employmentContext !== undefined && request.query.currencyCode !== undefined) {
        const currencyParameter = parameter(request.query.currencyCode);
        const activeSettlementScope = (scopeCondition: string, join = "") => `EXISTS (
          SELECT 1 FROM payroll_settlements settlement
          ${join}
           WHERE settlement.user_id = document.user_id
             AND settlement.document_id = document.id
             AND settlement.extraction_run_id = document.active_extraction_run_id
             AND settlement.currency_code = ${currencyParameter}
             AND ${scopeCondition}
        )`;
        const stableDetectedContext = /^detected:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(request.query.employmentContext);
        const legacyDetectedContext = /^detected:[0-9a-f]{24}$/.test(request.query.employmentContext);
        const unconfirmedContext = /^unconfirmed:([0-9a-f-]{36})$/.exec(request.query.employmentContext);
        if (uuid.test(request.query.employmentContext)) {
          const contextParameter = parameter(request.query.employmentContext);
          conditions.push(`(
            ${activeSettlementScope(`settlement.employment_id = ${contextParameter}::uuid`)}
            OR (
              document.employment_id = ${contextParameter}::uuid
              AND NOT EXISTS (
                SELECT 1 FROM payroll_settlements active_settlement
                 WHERE active_settlement.user_id = document.user_id
                   AND active_settlement.document_id = document.id
                   AND active_settlement.extraction_run_id = document.active_extraction_run_id
              )
              AND EXISTS (
                SELECT 1 FROM employments context_employment
                 WHERE context_employment.id = ${contextParameter}::uuid
                   AND context_employment.user_id = document.user_id
                   AND context_employment.currency_code = ${currencyParameter}
              )
            )
          )`);
        } else if (stableDetectedContext) {
          const detectedEmployerParameter = parameter(stableDetectedContext[1]);
          conditions.push(activeSettlementScope(`settlement.employment_id IS NULL
            AND document.detected_employer_id = ${detectedEmployerParameter}::uuid`));
        } else if (legacyDetectedContext) {
          const identity = request.query.employerName === undefined
            ? null
            : detectedEmploymentIdentity(request.query.employerName);
          if (identity === null || identity.context !== request.query.employmentContext) {
            throw new ApiError(400, "VALIDATION_ERROR", "El contexto laboral no es válido.");
          }
          conditions.push(activeSettlementScope(
            `settlement.employment_id IS NULL
             AND normalize_employer_name_conservative(detected_employer.name) = ${parameter(identity.key)}`,
            detectedEmployerNameJoin,
          ));
        } else if (unconfirmedContext !== null && uuid.test(unconfirmedContext[1]!)) {
          conditions.push(activeSettlementScope(
            `settlement.employment_id IS NULL
             AND document.id = ${parameter(unconfirmedContext[1])}::uuid
             AND NULLIF(btrim(normalize(detected_employer.name, NFKC)), '') IS NULL`,
            detectedEmployerNameJoin,
          ));
        } else {
          return { data: { items: [], total: 0, pendingReview: 0, nextCursor: null } };
        }
      }
      if (request.query.processingStatus) conditions.push(`document.processing_status = ${parameter(request.query.processingStatus)}`);
      if (request.query.statusGroup === "READY") {
        conditions.push(`document.processing_status = 'COMPLETED' AND NOT ${documentNeedsReviewSql}`);
      }
      if (request.query.statusGroup === "REVIEW") conditions.push(documentNeedsReviewSql);
      if (request.query.statusGroup === "PROCESSING") {
        conditions.push(`document.processing_status IN (
          'CREATED', 'UPLOADED', 'SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION',
          'TEXT_EXTRACTION', 'OCR', 'PARSING', 'NORMALIZATION', 'VALIDATION',
          'FAILED_RETRYABLE', 'RETRY_SCHEDULED'
        )`);
      }
      if (request.query.statusGroup === "ERROR") {
        conditions.push("document.processing_status IN ('QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED')");
      }
      if (request.query.documentType === "PAYROLL") conditions.push("document.document_type = 'PAYROLL'");
      if (request.query.documentType === "UNSUPPORTED") conditions.push("document.processing_status = 'REJECTED_UNSUPPORTED'");
      if (request.query.settlementType) conditions.push(`projection.settlement_type = ${parameter(request.query.settlementType)}`);
      const from = `FROM documents document
            JOIN import_batch_items item
              ON item.id = document.import_batch_item_id AND item.user_id = document.user_id
            LEFT JOIN employments employment
              ON employment.id = document.employment_id AND employment.user_id = document.user_id
            LEFT JOIN employers employer
              ON employer.id = employment.employer_id
            ${documentProjectionJoin}`;
      const countFrom = search || request.query.year || request.query.period || request.query.settlementType
        ? from
        : "FROM documents document";
      const pageParameters = [...parameters];
      const pageConditions = [...conditions];
      if (cursor) {
        pageParameters.push(cursor.createdAtMicros, cursor.id);
        pageConditions.push(`(
          floor(extract(epoch FROM document.created_at) * 1000000),
          document.id
        ) < ($${pageParameters.length - 1}::numeric, $${pageParameters.length}::uuid)`);
      }
      pageParameters.push(limit + 1);
      const result = await client.query(
        `SELECT document.id, document.employment_id, document.original_filename, document.created_at,
                floor(extract(epoch FROM document.created_at) * 1000000)::bigint::text AS created_at_micros,
                document.processing_status, document.document_type,
                document.classification_confidence, document.original_deleted_at,
                document.deleted_at, item.error_code, projection.payroll_period, projection.settlement_type,
                COALESCE(employer.name, projection.corrected_employer_name,
                         projection.extracted_employer_name) AS employer_name,
                ${documentDecisionRequiredSql} AS decision_required
           ${from}
          WHERE ${pageConditions.join(" AND ")}
          ORDER BY document.created_at DESC, document.id DESC LIMIT $${pageParameters.length}`,
        pageParameters,
      );
      const counts = await client.query(
        `SELECT count(*)::integer AS total,
                count(*) FILTER (WHERE ${documentNeedsReviewSql})::integer AS pending_review
           ${countFrom}
          WHERE ${conditions.join(" AND ")}`,
        parameters,
      );
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        data: {
          items: rows.map(documentView),
          total: Number(counts.rows[0].total),
          pendingReview: Number(counts.rows[0].pending_review),
          nextCursor: last && result.rows.length > limit
            ? documentCursor({ createdAtMicros: String(last.created_at_micros), id: String(last.id) })
            : null,
        },
      };
    }),
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/documents/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => withTransaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const document = await client.query(
        `SELECT document.id, document.employment_id, document.original_filename, document.created_at,
                document.processing_status, document.document_type,
                document.classification_confidence, document.original_deleted_at,
                document.deleted_at, document.declared_mime_type, document.detected_mime_type,
                document.size_bytes, document.page_count, document.security_status,
                document.classification_status, document.retention_policy, document.processed_at,
                document.unsupported_feedback,
                item.error_code, projection.payroll_period, projection.settlement_type,
                COALESCE(employer.name, projection.corrected_employer_name,
                         projection.extracted_employer_name) AS employer_name
           FROM documents document
           JOIN import_batch_items item
             ON item.id = document.import_batch_item_id AND item.user_id = document.user_id
           LEFT JOIN employments employment
             ON employment.id = document.employment_id AND employment.user_id = document.user_id
           LEFT JOIN employers employer
             ON employer.id = employment.employer_id
           ${documentProjectionJoin}
          WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL`,
        [request.params.id, request.authUser!.id],
      );
      if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const activeRun = await client.query(
        `SELECT id, processing_version, extractor_name, extractor_version, parser_version,
                normalizer_version, ocr_provider, ocr_version, confidence, finished_at,
                status, trigger_kind, result_schema_version, pipeline_fingerprint,
                promotion_outcome, comparison_summary, promoted_at
           FROM extraction_runs run
          WHERE run.id = (SELECT active_extraction_run_id FROM documents
                           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)
            AND run.document_id = $1 AND run.user_id = $2`,
        [request.params.id, request.authUser!.id],
      );
      const lastReprocessJob = await client.query(
        `SELECT state, processing_version, error_code, completed_at
           FROM processing_jobs
          WHERE document_id = $1 AND user_id = $2
            AND previous_document_status IS NOT NULL
          ORDER BY processing_version DESC LIMIT 1`,
        [request.params.id, request.authUser!.id],
      );
      const extractionRunId = activeRun.rowCount ? String(activeRun.rows[0].id) : null;
      const fields = extractionRunId ? await client.query(
        `SELECT field.id, field.field_path, field.raw_value, field.interpreted_value,
                field.confidence, field.source, field.page_number, field.source_region,
                field.extractor_version, field.signals, correction.id AS correction_id,
                correction.corrected_value, correction.correction_version, correction.created_at AS corrected_at
           FROM extracted_fields field
           LEFT JOIN LATERAL (
             SELECT COALESCE(root.id, correction.id) AS id, correction.corrected_value,
                    COALESCE(root.correction_version, correction.correction_version) AS correction_version,
                    COALESCE(root.created_at, correction.created_at) AS created_at
               FROM user_corrections correction
               LEFT JOIN user_corrections root
                 ON root.id = correction.inherited_from_correction_id
                AND root.user_id = correction.user_id
                AND root.document_id = correction.document_id
                AND root.field_path = correction.field_path
              WHERE correction.user_id = field.user_id
                AND correction.extraction_run_id = field.extraction_run_id
                AND correction.field_path = field.field_path
              ORDER BY correction.correction_version DESC LIMIT 1
           ) correction ON true
          WHERE field.document_id = $1 AND field.user_id = $2 AND field.extraction_run_id = $3
          ORDER BY field.field_path`,
        [request.params.id, request.authUser!.id, extractionRunId],
      ) : { rows: [] as Record<string, unknown>[] };
      const manual = extractionRunId ? await client.query(
        `SELECT DISTINCT ON (correction.field_path)
                COALESCE(root.id, correction.id) AS id,
                correction.field_path, correction.corrected_value,
                COALESCE(root.correction_version, correction.correction_version) AS correction_version,
                COALESCE(root.created_at, correction.created_at) AS corrected_at
           FROM user_corrections correction
           LEFT JOIN user_corrections root
             ON root.id = correction.inherited_from_correction_id
            AND root.user_id = correction.user_id
            AND root.document_id = correction.document_id
            AND root.field_path = correction.field_path
          WHERE correction.user_id = $1 AND correction.document_id = $2
            AND correction.extraction_run_id = $3
          ORDER BY correction.field_path, correction.correction_version DESC`,
        [request.authUser!.id, request.params.id, extractionRunId],
      ) : { rows: [] as Record<string, unknown>[] };
      const settlement = extractionRunId ? await client.query(
        `SELECT settlement.id, settlement.document_id, settlement.employment_id,
                to_char(settlement.payroll_period, 'YYYY-MM-DD') AS payroll_period,
                settlement.settlement_type, settlement.is_recurring, settlement.currency_code,
                settlement.basic_amount, settlement.gross_amount, settlement.net_amount,
                settlement.remunerative_amount, settlement.non_remunerative_amount,
                settlement.deductions_amount, run.confidence,
                settlement.gross_amount IS NOT NULL AND settlement.net_amount IS NOT NULL
                  AND settlement.deductions_amount IS NOT NULL
                  AND settlement.gross_amount - settlement.deductions_amount = settlement.net_amount AS totals_balance,
                CASE
                  WHEN settlement.remunerative_amount IS NULL AND settlement.non_remunerative_amount IS NULL THEN true
                  ELSE settlement.gross_amount IS NOT NULL
                    AND settlement.remunerative_amount IS NOT NULL
                    AND settlement.non_remunerative_amount IS NOT NULL
                    AND settlement.remunerative_amount + settlement.non_remunerative_amount = settlement.gross_amount
                END AS components_balance,
                CASE WHEN settlement.gross_amount > 0 AND settlement.deductions_amount > 0
                  THEN round(settlement.deductions_amount * 100 / settlement.gross_amount, 2)::text
                  ELSE NULL END AS deductions_percentage,
                COALESCE(items.deductions, '[]'::jsonb) AS deductions,
                COALESCE(items.earnings, '[]'::jsonb) AS earnings,
                settlement.deductions_amount IS NOT NULL
                  AND COALESCE(items.deductions_total, 0) = settlement.deductions_amount AS deductions_match_total,
                CASE WHEN settlement.deductions_amount IS NULL AND items.deductions_total IS NULL THEN NULL
                  ELSE abs(COALESCE(items.deductions_total, 0) - COALESCE(settlement.deductions_amount, 0))::text
                  END AS deductions_difference_amount,
                CASE
                  WHEN settlement.deductions_amount IS NULL THEN 'TOTAL_MISSING'
                  WHEN COALESCE(items.deductions_total, 0) = COALESCE(settlement.deductions_amount, 0) THEN 'MATCHED'
                  WHEN COALESCE(items.deductions_total, 0) < COALESCE(settlement.deductions_amount, 0) THEN 'MISSING_ITEMS'
                  ELSE 'ITEMS_EXCEED_TOTAL'
                END AS deductions_difference_kind
           FROM payroll_settlements settlement
           JOIN extraction_runs run ON run.id = settlement.extraction_run_id AND run.user_id = settlement.user_id
           LEFT JOIN LATERAL (
             SELECT sum(item.amount) FILTER (WHERE item.item_type = 'DEDUCTION') AS deductions_total,
                    jsonb_agg(jsonb_build_object(
                      'normalizedConceptCode', item.normalized_concept_code,
                      'rawDescription', item.raw_description,
                      'amount', item.amount::text,
                      'grossPercentage', CASE WHEN settlement.gross_amount > 0
                        THEN round(item.amount * 100 / settlement.gross_amount, 2)::text ELSE NULL END,
                      'confidence', item.confidence::text
                    ) ORDER BY item.item_ordinal) FILTER (WHERE item.item_type = 'DEDUCTION') AS deductions,
                    jsonb_agg(jsonb_build_object(
                      'normalizedConceptCode', item.normalized_concept_code,
                      'rawDescription', item.raw_description,
                      'amount', item.amount::text,
                      'isRecurring', item.is_recurring,
                      'confidence', item.confidence::text
                    ) ORDER BY item.item_ordinal) FILTER (WHERE item.item_type = 'EARNING') AS earnings
               FROM payroll_line_items item
              WHERE item.user_id = settlement.user_id AND item.settlement_id = settlement.id
           ) items ON true
          WHERE settlement.user_id = $1 AND settlement.document_id = $2 AND settlement.extraction_run_id = $3
          ORDER BY settlement.settlement_ordinal LIMIT 1`,
        [request.authUser!.id, request.params.id, extractionRunId],
      ) : { rows: [] as Record<string, unknown>[] };
      const lineItems = extractionRunId ? await client.query(
        `SELECT item.id, item.item_ordinal, item.raw_description, item.normalized_concept_code,
                item.amount, item.currency_code, item.item_type, item.is_recurring,
                item.confidence, item.source_page, item.source_field
           FROM payroll_line_items item
           JOIN payroll_settlements settlement
             ON settlement.id = item.settlement_id AND settlement.user_id = item.user_id
          WHERE settlement.document_id = $1 AND settlement.user_id = $2
            AND settlement.extraction_run_id = $3
          ORDER BY settlement.settlement_ordinal, item.item_ordinal`,
        [request.params.id, request.authUser!.id, extractionRunId],
      ) : { rows: [] as Record<string, unknown>[] };
      const manualValues = new Map(manual.rows.map((row) => [String(row.field_path), row]));
      const effectiveSettlement = settlement.rows[0] ?? {};
      const componentReviewRequired = (effectiveSettlement.remunerative_amount !== null
        && effectiveSettlement.remunerative_amount !== undefined)
        || (effectiveSettlement.non_remunerative_amount !== null
          && effectiveSettlement.non_remunerative_amount !== undefined);
      const effectiveReviewPaths = componentReviewRequired
        ? [...requiredPayrollReviewPaths, ...componentReviewPaths]
        : requiredPayrollReviewPaths;
      const missingEffectivePaths = new Set([
        ...(!effectiveSettlement.payroll_period ? ["settlement.payrollPeriod"] : []),
        ...(!effectiveSettlement.gross_amount ? ["settlement.grossAmount"] : []),
        ...(!effectiveSettlement.net_amount ? ["settlement.netAmount"] : []),
        ...(!effectiveSettlement.deductions_amount && effectiveSettlement.deductions_amount !== "0.00"
          ? ["settlement.deductionsAmount"] : []),
        ...(componentReviewRequired && effectiveSettlement.remunerative_amount === null
          ? ["settlement.remunerativeAmount"] : []),
        ...(componentReviewRequired && effectiveSettlement.non_remunerative_amount === null
          ? ["settlement.nonRemunerativeAmount"] : []),
      ]);
      const extractedFields: Array<{
        id: string | null;
        fieldPath: string;
        rawValue: string | null;
        interpretedValue: string | null;
        correctedValue: string | null;
        effectiveValue: string | null;
        confidence: string;
        source: string;
        pageNumber: number | null;
        sourceRegion: SourceRegion | null;
        extractorVersion: string | null;
        correction: { id: string; version: number; correctedAt: string } | null;
        missingReason?: MissingFieldReason;
      }> = fields.rows.map((field) => {
        const missingReason = readMissingFieldReason(field.signals);
        const correctedValue = displayExtracted(field.corrected_value);
        const interpretedValue = displayExtracted(field.interpreted_value);
        return {
          id: String(field.id), fieldPath: String(field.field_path),
          rawValue: value(field, "raw_value"), interpretedValue, correctedValue,
          effectiveValue: correctedValue ?? interpretedValue,
          confidence: String(field.confidence), source: String(field.source),
          pageNumber: field.page_number === null ? null : Number(field.page_number),
          sourceRegion: validatedSourceRegion(field.source_region),
          extractorVersion: value(field, "extractor_version"),
          correction: field.correction_id === null ? null : {
            id: String(field.correction_id),
            version: Number(field.correction_version),
            correctedAt: timestamp(field.corrected_at),
          },
          ...(missingReason ? { missingReason } : {}),
        };
      });
      if (document.rows[0].document_type === "PAYROLL") {
        const existingPaths = new Set(extractedFields.map(({ fieldPath }) => fieldPath));
        for (const fieldPath of effectiveReviewPaths) {
          const existing = extractedFields.find((field) => field.fieldPath === fieldPath);
          if (existing && missingEffectivePaths.has(fieldPath)) existing.source = "MANUAL_REQUIRED";
          if (!existingPaths.has(fieldPath)) {
            const correction = manualValues.get(fieldPath);
            const correctedValue = displayExtracted(correction?.corrected_value);
            extractedFields.push({
              id: null,
              fieldPath,
              rawValue: null,
              interpretedValue: null,
              correctedValue,
              effectiveValue: correctedValue,
              confidence: "0",
              source: "MANUAL_REQUIRED",
              pageNumber: null,
              sourceRegion: null,
              extractorVersion: null,
              correction: correction ? {
                id: String(correction.id),
                version: Number(correction.correction_version),
                correctedAt: timestamp(correction.corrected_at),
              } : null,
            });
          }
        }
        if (!existingPaths.has("employer.name") && manualValues.has("employer.name")) {
          const correction = manualValues.get("employer.name")!;
          const correctedValue = displayExtracted(correction.corrected_value);
          extractedFields.push({
            id: null, fieldPath: "employer.name", rawValue: null, interpretedValue: null,
            correctedValue, effectiveValue: correctedValue, confidence: "0", source: "MANUAL_REQUIRED",
            pageNumber: null, sourceRegion: null, extractorVersion: null,
            correction: {
              id: String(correction.id),
              version: Number(correction.correction_version),
              correctedAt: timestamp(correction.corrected_at),
            },
          });
        }
        extractedFields.sort((left, right) => left.fieldPath.localeCompare(right.fieldPath));
      }
      const analysis = await loadProcessingAnalysis(client, request.authUser!.id, request.params.id);
      const row = document.rows[0];
      return { data: {
        ...documentView(row),
        declaredMimeType: String(row.declared_mime_type),
        detectedMimeType: value(row, "detected_mime_type"),
        sizeBytes: Number(row.size_bytes),
        pageCount: row.page_count === null ? null : Number(row.page_count),
        securityStatus: String(row.security_status),
        classificationStatus: String(row.classification_status),
        retentionPolicy: String(row.retention_policy),
        unsupportedFeedback: value(row, "unsupported_feedback"),
        processedAt: row.processed_at === null ? null : timestamp(row.processed_at),
        lastReprocessError: lastReprocessJob.rows[0]?.state === "FAILED" ? {
          code: String(lastReprocessJob.rows[0].error_code),
          processingVersion: Number(lastReprocessJob.rows[0].processing_version),
          failedAt: timestamp(lastReprocessJob.rows[0].completed_at),
        } : null,
        reviewSettlement: settlement.rows.length ? {
          totalsBalance: settlement.rows[0].totals_balance === true,
          componentsBalance: settlement.rows[0].components_balance === true,
          deductionsMatchTotal: settlement.rows[0].deductions_match_total === true,
        } : null,
        extractionRun: activeRun.rowCount ? {
          id: String(activeRun.rows[0].id),
          processingVersion: Number(activeRun.rows[0].processing_version),
          extractorName: String(activeRun.rows[0].extractor_name),
          extractorVersion: String(activeRun.rows[0].extractor_version),
          parserVersion: String(activeRun.rows[0].parser_version),
          normalizerVersion: String(activeRun.rows[0].normalizer_version),
          ocrProvider: value(activeRun.rows[0], "ocr_provider"),
          ocrVersion: value(activeRun.rows[0], "ocr_version"),
          confidence: value(activeRun.rows[0], "confidence"),
          finishedAt: timestamp(activeRun.rows[0].finished_at),
        } : null,
        extractedFields,
        settlement: settlement.rows.length ? settlementView(settlement.rows[0]!) : null,
        lineItems: lineItems.rows.map((item) => ({
          id: String(item.id),
          itemOrdinal: Number(item.item_ordinal),
          rawDescription: String(item.raw_description),
          normalizedConceptCode: value(item, "normalized_concept_code"),
          amount: String(item.amount),
          currencyCode: String(item.currency_code),
          itemType: String(item.item_type),
          isRecurring: item.is_recurring === null ? null : Boolean(item.is_recurring),
          confidence: value(item, "confidence"),
          sourcePage: item.source_page === null ? null : Number(item.source_page),
          sourceField: value(item, "source_field"),
        })),
        analysis,
      } };
    }),
  );

  app.patch<{ Body: DocumentEmploymentBody }>(
    "/api/v1/documents/employment",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["documentIds", "employmentId"],
          properties: {
            documentIds: {
              type: "array", minItems: 1, maxItems: 500, uniqueItems: true,
              items: { type: "string", pattern: UUID_PATTERN },
            },
            employmentId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
          },
        },
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const { documentIds, employmentId } = request.body;
      const result = await withTransaction(async (client) => {
        await lockEmployerMutation(client);
        if (employmentId) {
          const employment = await client.query(
            "SELECT 1 FROM employments WHERE id = $1 AND user_id = $2 FOR KEY SHARE",
            [employmentId, userId],
          );
          if (!employment.rowCount) throw new ApiError(404, "NOT_FOUND", "Empleo no encontrado.");
        }
        const documents = await client.query(
          `SELECT id, processing_status FROM documents
            WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
            ORDER BY id FOR UPDATE`,
          [userId, documentIds],
        );
        if (documents.rowCount !== documentIds.length) {
          throw new ApiError(404, "NOT_FOUND", "Uno o más documentos no están disponibles.");
        }
        if (documents.rows.some((row) => !associationReadyStatuses.has(String(row.processing_status)))) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que terminen todos los documentos seleccionados.");
        }
        await client.query(
          "UPDATE documents SET employment_id = $1 WHERE user_id = $2 AND id = ANY($3::uuid[])",
          [employmentId, userId, documentIds],
        );
        await client.query(
          "UPDATE payroll_settlements SET employment_id = $1 WHERE user_id = $2 AND document_id = ANY($3::uuid[])",
          [employmentId, userId, documentIds],
        );
        await client.query(
          `UPDATE import_batch_items AS item
              SET employment_id = $1, updated_at = now()
             FROM documents AS document
            WHERE document.id = ANY($3::uuid[])
              AND document.user_id = $2
              AND document.import_batch_item_id = item.id
              AND item.user_id = $2`,
          [employmentId, userId, documentIds],
        );
        await audit(client, userId, "DOCUMENTS_EMPLOYMENT_UPDATED", "DOCUMENT_BATCH", null, {
          documentCount: documentIds.length,
          associated: employmentId !== null,
        });
        return { updatedCount: documentIds.length, employmentId };
      });
      return { data: result };
    },
  );

  app.get(
    "/api/v1/settlements",
    { preHandler: requireAuth },
    async (request) => {
      const result = await pool.query(
        `SELECT settlement.id, settlement.document_id, settlement.employment_id,
                to_char(settlement.payroll_period, 'YYYY-MM-DD') AS payroll_period,
                COALESCE(employer.name, extracted_employer.corrected_name,
                          extracted_employer.extracted_name) AS employer_name,
                settlement.settlement_type, settlement.is_recurring, settlement.currency_code,
                settlement.basic_amount, settlement.gross_amount, settlement.net_amount,
                settlement.remunerative_amount, settlement.non_remunerative_amount,
                settlement.deductions_amount, run.confidence,
                settlement.gross_amount IS NOT NULL AND settlement.net_amount IS NOT NULL
                  AND settlement.deductions_amount IS NOT NULL
                  AND settlement.gross_amount - settlement.deductions_amount = settlement.net_amount AS totals_balance,
                CASE WHEN settlement.gross_amount > 0 AND settlement.deductions_amount IS NOT NULL
                  THEN round(settlement.deductions_amount * 100 / settlement.gross_amount, 2)::text
                  ELSE NULL END AS deductions_percentage,
                COALESCE(breakdown.deductions, '[]'::jsonb) AS deductions,
                COALESCE(breakdown.earnings, '[]'::jsonb) AS earnings,
                settlement.deductions_amount IS NOT NULL
                  AND COALESCE(breakdown.total_amount, 0) = settlement.deductions_amount AS deductions_match_total,
                CASE WHEN settlement.deductions_amount IS NULL AND breakdown.total_amount IS NULL THEN NULL
                  ELSE abs(COALESCE(breakdown.total_amount, 0) - COALESCE(settlement.deductions_amount, 0))::text
                  END AS deductions_difference_amount,
                CASE
                  WHEN settlement.deductions_amount IS NULL THEN 'TOTAL_MISSING'
                  WHEN COALESCE(breakdown.total_amount, 0) = COALESCE(settlement.deductions_amount, 0)
                    THEN 'MATCHED'
                  WHEN COALESCE(breakdown.total_amount, 0) < COALESCE(settlement.deductions_amount, 0)
                    THEN 'MISSING_ITEMS'
                  ELSE 'ITEMS_EXCEED_TOTAL'
                END AS deductions_difference_kind
           FROM payroll_settlements settlement
           JOIN extraction_runs run ON run.id = settlement.extraction_run_id
           JOIN documents document
             ON document.id = settlement.document_id
            AND document.user_id = settlement.user_id
            AND document.active_extraction_run_id = run.id
           LEFT JOIN employments employment ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
           LEFT JOIN employers employer ON employer.id = employment.employer_id
           LEFT JOIN LATERAL (
             SELECT correction.corrected_value #>> '{}' AS corrected_name,
                    field.interpreted_value #>> '{}' AS extracted_name
               FROM extracted_fields field
               LEFT JOIN LATERAL (
                 SELECT corrected_value FROM user_corrections
                  WHERE user_id = settlement.user_id AND extracted_field_id = field.id
                  ORDER BY correction_version DESC LIMIT 1
               ) correction ON true
              WHERE field.user_id = settlement.user_id
                AND field.extraction_run_id = settlement.extraction_run_id
                AND field.field_path = 'employer.name'
              LIMIT 1
           ) extracted_employer ON true
           LEFT JOIN LATERAL (
             SELECT sum(item.amount) FILTER (WHERE item.item_type = 'DEDUCTION') AS total_amount,
                    jsonb_agg(jsonb_build_object(
                      'normalizedConceptCode', item.normalized_concept_code,
                      'rawDescription', item.raw_description,
                      'amount', item.amount::text,
                      'grossPercentage', CASE WHEN settlement.gross_amount > 0
                        THEN round(item.amount * 100 / settlement.gross_amount, 2)::text
                        ELSE NULL END,
                      'confidence', item.confidence::text
                    ) ORDER BY item.item_ordinal) FILTER (WHERE item.item_type = 'DEDUCTION') AS deductions,
                    jsonb_agg(jsonb_build_object(
                      'normalizedConceptCode', item.normalized_concept_code,
                      'rawDescription', item.raw_description,
                      'amount', item.amount::text,
                      'isRecurring', item.is_recurring,
                      'confidence', item.confidence::text
                    ) ORDER BY item.item_ordinal) FILTER (WHERE item.item_type = 'EARNING') AS earnings
               FROM payroll_line_items item
              WHERE item.user_id = settlement.user_id
                AND item.settlement_id = settlement.id
            ) breakdown ON true
          WHERE settlement.user_id = $1
          ORDER BY settlement.payroll_period DESC, settlement.created_at DESC LIMIT 500`,
        [request.authUser!.id],
      );
      return { data: result.rows.map(settlementView) };
    },
  );

  app.post<{ Params: IdParams; Body: { documentType: "PAYROLL" | "UNSUPPORTED" } }>(
    "/api/v1/documents/:id/type-confirmation",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["documentType"],
          properties: { documentType: { type: "string", enum: ["PAYROLL", "UNSUPPORTED"] } },
        },
      },
    },
    async (request, reply) => {
      const result = await withTransaction(async (client) => {
        const document = await client.query(
          `SELECT document.id, document.import_batch_id, document.import_batch_item_id,
                  document.processing_status, document.original_deleted_at, document.object_key,
                  document.retention_policy, session.object_key AS incoming_object_key, session.expires_at
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
            FOR UPDATE OF document, session`,
          [request.params.id, request.authUser!.id],
        );
        if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = document.rows[0];
        if (row.processing_status !== "NEEDS_TYPE_CONFIRMATION") {
          throw new ApiError(409, "TYPE_CONFIRMATION_NOT_REQUIRED", "El documento no requiere confirmación.");
        }
        if (request.body.documentType === "UNSUPPORTED") {
          await client.query(
            `UPDATE documents
                SET classification_status = 'UNSUPPORTED', document_type = NULL,
                    processing_status = 'REJECTED_UNSUPPORTED', processed_at = now(),
                    retention_policy = 'DELETE_AFTER_PROCESSING'
              WHERE id = $1 AND user_id = $2`,
            [request.params.id, request.authUser!.id],
          );
          await client.query(
            `UPDATE import_batch_items SET status = 'REJECTED',
                    error_code = 'DOCUMENT_UNSUPPORTED', updated_at = now()
              WHERE id = $1 AND user_id = $2`,
            [row.import_batch_item_id, request.authUser!.id],
          );
          if (row.original_deleted_at === null) {
            await client.query(
              `INSERT INTO storage_deletion_tombstones (
                 id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
               ) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (canonical_object_key) DO NOTHING`,
              [randomUUID(), request.authUser!.id, row.object_key, row.incoming_object_key, row.expires_at],
            );
            await client.query(
              `UPDATE documents SET original_deleted_at = now()
                WHERE id = $1 AND user_id = $2
                  AND EXISTS (SELECT 1 FROM storage_deletion_tombstones WHERE canonical_object_key = $3)`,
              [request.params.id, request.authUser!.id, row.object_key],
            );
          }
          await completeDocumentBatch(client, request.authUser!.id, request.params.id);
          await audit(client, request.authUser!.id, "DOCUMENT_TYPE_REJECTED", "DOCUMENT", request.params.id);
          return { processingStatus: "REJECTED_UNSUPPORTED", job: null };
        }
        if (row.original_deleted_at !== null) {
          throw new ApiError(409, "ORIGINAL_NOT_AVAILABLE", "El original ya no está disponible para procesarlo.");
        }
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.authUser!.id]);
        const otherActive = await client.query(
          `SELECT count(*)::integer AS count FROM import_batches
            WHERE user_id = $1 AND id <> $2 AND status IN ('ACTIVE', 'PAUSED')`,
          [request.authUser!.id, row.import_batch_id],
        );
        if (Number(otherActive.rows[0].count) >= config.maxActiveImportsPerUser) {
          throw new ApiError(409, "TOO_MANY_ACTIVE_IMPORTS", "Terminá el lote activo antes de continuar este documento.");
        }
        const version = await client.query(
          "SELECT COALESCE(max(processing_version), 0)::integer + 1 AS version FROM processing_jobs WHERE document_id = $1",
          [request.params.id],
        );
        const processingVersion = Number(version.rows[0].version);
        const jobId = randomUUID();
        await client.query(
          `INSERT INTO processing_jobs (
             id, user_id, document_id, stage, processing_version, idempotency_key,
             trigger_kind, requested_by_user_id, pipeline_fingerprint
           ) VALUES ($1, $2, $3, 'DOCUMENT_PIPELINE_V2', $4, $5,
             'USER_TYPE_CONFIRMATION', $2, $6)`,
          [jobId, request.authUser!.id, request.params.id, processingVersion,
            `confirmed-type:${request.params.id}:v${processingVersion}`, currentPipelineFingerprint],
        );
        await client.query(
          `UPDATE documents
              SET classification_status = 'SUPPORTED', document_type = 'PAYROLL',
                  processing_status = 'UPLOADED', processed_at = NULL
            WHERE id = $1 AND user_id = $2`,
          [request.params.id, request.authUser!.id],
        );
        await client.query(
          `UPDATE import_batch_items SET status = 'PROCESSING', error_code = NULL, updated_at = now()
            WHERE id = $1 AND user_id = $2`,
          [row.import_batch_item_id, request.authUser!.id],
        );
        await client.query(
          `UPDATE import_batches SET status = 'ACTIVE', completed_at = NULL, updated_at = now()
            WHERE id = (SELECT import_batch_id FROM documents WHERE id = $1 AND user_id = $2)
              AND user_id = $2`,
          [request.params.id, request.authUser!.id],
        );
        await audit(client, request.authUser!.id, "DOCUMENT_TYPE_CONFIRMED", "DOCUMENT", request.params.id);
        return { processingStatus: "UPLOADED", job: { id: jobId, state: "PENDING" } };
      });
      return reply.code(201).send({ data: result });
    },
  );

  app.put<{ Params: IdParams; Body: UnsupportedFeedbackBody }>(
    "/api/v1/documents/:id/unsupported-feedback",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["comment"],
          properties: { comment: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const comment = request.body.comment.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (comment.length > 500 || /[\u0000-\u001f\u007f]/u.test(comment)) {
        throw new ApiError(400, "INVALID_UNSUPPORTED_FEEDBACK", "El comentario no es válido.");
      }
      return { data: await withTransaction(async (client) => {
        const updated = await client.query<{ unsupported_feedback: string | null }>(
          `UPDATE documents
              SET unsupported_feedback = $3
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
              AND processing_status = 'REJECTED_UNSUPPORTED'
          RETURNING unsupported_feedback`,
          [request.params.id, request.authUser!.id, comment || null],
        );
        if (!updated.rowCount) throw new ApiError(404, "NOT_FOUND", "Documento no soportado no encontrado.");
        await audit(client, request.authUser!.id, "UNSUPPORTED_FEEDBACK_UPDATED", "DOCUMENT", request.params.id, {
          commentProvided: Boolean(comment),
        });
        return { comment: updated.rows[0]!.unsupported_feedback };
      }) };
    },
  );

  app.post<{ Params: IdParams; Body: ReprocessBody }>(
    "/api/v1/documents/:id/reprocess",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { retry: { type: "boolean" } },
            },
            { type: "null" },
          ],
        },
      },
    },
    async (request, reply) => {
      const requestedKey = request.headers["idempotency-key"];
      if (typeof requestedKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestedKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const result = await withTransaction(async (client) => {
        const queued = await enqueueReprocessing(client, {
          userId: request.authUser!.id,
          requestedByUserId: request.authUser!.id,
          documentId: request.params.id,
          requestedKey,
          triggerKind: "USER_REPROCESS",
          allowRetry: request.body?.retry === true,
        }, ApiError);
        await audit(client, request.authUser!.id, "DOCUMENT_REPROCESS_REQUESTED", "DOCUMENT", request.params.id, {
          processingVersion: queued.job.processingVersion,
          activeRunId: queued.activeRunId ?? "NONE",
          triggerKind: "USER_REPROCESS",
        });
        return queued;
      });
      const { created, ...data } = result;
      return reply.code(created ? 201 : 200).send({ data });
    },
  );

  app.post<{ Params: IdParams; Body: CorrectionBody }>(
    "/api/v1/documents/:id/corrections",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false,
          required: ["correctedValue", "extractionRunId"],
          anyOf: [{ required: ["extractedFieldId"] }, { required: ["fieldPath"] }],
          properties: {
            extractedFieldId: { type: "string", pattern: UUID_PATTERN },
            fieldPath: { type: "string", minLength: 1, maxLength: 300 },
            correctedValue: { type: "string", minLength: 1, maxLength: 500 },
            extractionRunId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const corrected = request.body.correctedValue.trim();
      if ((request.body.extractedFieldId === undefined) === (request.body.fieldPath === undefined)) {
        throw new ApiError(400, "INVALID_CORRECTION_TARGET", "Elegí un único campo para corregir.");
      }
      const targetPath = request.body.fieldPath ?? (await pool.query<{ field_path: string }>(
        `SELECT field_path FROM extracted_fields
          WHERE id = $1 AND document_id = $2 AND user_id = $3 AND extraction_run_id = $4`,
        [request.body.extractedFieldId, request.params.id, request.authUser!.id, request.body.extractionRunId],
      )).rows[0]?.field_path;
      const employerNameTarget = targetPath === "employer.name";
      const result = await withTransaction(async (client) => {
        if (employerNameTarget) await lockEmployerMutation(client);
        const observedDocument = await client.query(
          `SELECT processing_status, import_batch_item_id, employment_id FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [request.params.id, request.authUser!.id],
        );
        if (!observedDocument.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        let resolvedEmployer: Awaited<ReturnType<typeof resolveEmployer>> | null = null;
        let resolutionError: EmployerResolutionError | null = null;
        let currentCanonicalEmployerId: string | null = null;
        if (employerNameTarget) {
          if (!corrected || corrected.length > 200) {
            throw new ApiError(400, "INVALID_EMPLOYER_NAME", "El nombre del empleador no es válido.");
          }
          const observedEmploymentId = observedDocument.rows[0].employment_id === null
            ? null
            : String(observedDocument.rows[0].employment_id);
          if (observedEmploymentId) {
            const observedEmployment = await client.query<{ employer_id: string }>(
              `SELECT employer_id FROM employments WHERE id = $1 AND user_id = $2`,
              [observedEmploymentId, request.authUser!.id],
            );
            const observedEmployerId = observedEmployment.rows[0]?.employer_id;
            const currentEmployer = observedEmployerId
              ? await followMergedEmployer(client, observedEmployerId)
              : null;
            const lockedEmployment = await client.query<{ employer_id: string }>(
              `SELECT employer_id FROM employments
                WHERE id = $1 AND user_id = $2 FOR UPDATE`,
              [observedEmploymentId, request.authUser!.id],
            );
            if (!lockedEmployment.rows[0]
              || !observedEmployerId
              || ![observedEmployerId, currentEmployer?.id].includes(lockedEmployment.rows[0].employer_id)) {
              throw new ApiError(409, "EMPLOYMENT_CHANGED", "El empleo cambió; recargá e intentá nuevamente.");
            }
            currentCanonicalEmployerId = currentEmployer?.id ?? null;
          }
          try {
            resolvedEmployer = await resolveEmployer(client, {
              name: corrected,
              countryCode: "AR",
              createdByUserId: request.authUser!.id,
              createdSource: "DOCUMENT",
              ...(currentCanonicalEmployerId ? { preferredEmployerId: currentCanonicalEmployerId } : {}),
            });
          } catch (error) {
            if (!(error instanceof EmployerResolutionError)) throw error;
            if (error.code === "INVALID_NAME") {
              throw new ApiError(400, "INVALID_EMPLOYER_NAME", "El nombre del empleador no es válido.");
            }
            resolutionError = error;
          }
        }
        const correctionDocument = await client.query(
          `SELECT processing_status, import_batch_item_id, employment_id FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!correctionDocument.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (employerNameTarget
          && String(correctionDocument.rows[0].employment_id) !== String(observedDocument.rows[0].employment_id)) {
          throw new ApiError(409, "EMPLOYMENT_CHANGED", "El empleo cambió; recargá e intentá nuevamente.");
        }
        if (!["NEEDS_REVIEW", "COMPLETED"].includes(String(correctionDocument.rows[0].processing_status))) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para corregirlo.");
        }
        const activeRun = await client.query(
          `SELECT run.id FROM documents document
            JOIN extraction_runs run
              ON run.id = document.active_extraction_run_id
             AND run.document_id = document.id AND run.user_id = document.user_id
           WHERE document.id = $1 AND document.user_id = $2
           FOR UPDATE OF document, run`,
          [request.params.id, request.authUser!.id],
        );
        if (!activeRun.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const activeRunId = String(activeRun.rows[0].id);
        if (request.body.extractionRunId !== activeRunId) {
          throw new ApiError(409, "STALE_EXTRACTION_RUN", "La extracción cambió; recargá el documento antes de corregirlo.");
        }
        const field = request.body.extractedFieldId ? await client.query(
          `SELECT field.id, field.field_path, field.interpreted_value, field.extraction_run_id,
                  settlement.currency_code
             FROM extracted_fields field
             LEFT JOIN payroll_settlements settlement
               ON settlement.extraction_run_id = field.extraction_run_id
              AND settlement.user_id = field.user_id AND settlement.settlement_ordinal = 1
             WHERE field.id = $1 AND field.document_id = $2 AND field.user_id = $3
               AND field.extraction_run_id = $4
             FOR UPDATE OF field`,
          [request.body.extractedFieldId, request.params.id, request.authUser!.id, activeRunId],
        ) : await client.query(
          `SELECT NULL::uuid AS id, $3::text AS field_path, NULL::jsonb AS interpreted_value,
                   run.id AS extraction_run_id, settlement.currency_code
             FROM extraction_runs run
             LEFT JOIN payroll_settlements settlement
               ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
              AND settlement.settlement_ordinal = 1
            WHERE run.id = $4 AND run.document_id = $1 AND run.user_id = $2
            FOR UPDATE OF run`,
          [request.params.id, request.authUser!.id, request.body.fieldPath, activeRunId],
        );
        if (!field.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = field.rows[0];
        const fieldPath = String(row.field_path);
        if (!manualCorrectionPaths.has(fieldPath)) {
          throw new ApiError(400, "INVALID_FIELD_PATH", "Ese campo no admite carga manual.");
        }
        if (fieldPath === "employer.name" && (!corrected || corrected.length > 200)) {
          throw new ApiError(400, "INVALID_EMPLOYER_NAME", "El nombre del empleador no es válido.");
        }
        let correctedJson: unknown = corrected;
        const amountColumn = settlementAmountColumns.get(fieldPath);
        if (amountColumn) {
          const amount = normalizeDecimal(corrected);
          if (!amount || (amount.startsWith("-") && fieldPath !== "settlement.deductionsAmount")) {
            throw new ApiError(400, "INVALID_AMOUNT", "El monto corregido no es válido.");
          }
          const interpreted = row.interpreted_value && typeof row.interpreted_value === "object"
            ? row.interpreted_value as Record<string, unknown>
            : {};
          correctedJson = { ...interpreted, amount, currencyCode: value(row, "currency_code") ?? interpreted.currencyCode ?? "ARS" };
        }
        if (fieldPath === "settlement.payrollPeriod" && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(corrected)) {
          throw new ApiError(400, "INVALID_PERIOD", "El período corregido no es válido.");
        }
        if (fieldPath === "settlement.type") {
          const normalizedType = corrected.toUpperCase();
          if (!settlementTypes.has(normalizedType)) {
            throw new ApiError(400, "INVALID_SETTLEMENT_TYPE", "El tipo de liquidación no es válido.");
          }
          correctedJson = normalizedType;
        }
        if (!row.currency_code && amountColumn) {
          throw new ApiError(409, "PAYROLL_PERIOD_REQUIRED", "Completá primero el período del recibo.");
        }
        const version = await client.query(
          `SELECT COALESCE(max(correction_version), 0)::integer + 1 AS version
             FROM user_corrections WHERE extraction_run_id = $1 AND field_path = $2`,
          [row.extraction_run_id, fieldPath],
        );
        const id = randomUUID();
        await client.query(
          `INSERT INTO user_corrections (
             id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
             correction_version, extracted_value, corrected_value
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
          [id, request.authUser!.id, row.id, request.params.id, row.extraction_run_id, fieldPath,
            version.rows[0].version, JSON.stringify(row.interpreted_value ?? null), JSON.stringify(correctedJson)],
        );
        if (fieldPath === "employer.name") {
          const resolvedEmployerId = resolvedEmployer?.id ?? null;
          if (resolvedEmployer) {
            request.log.info({
              event: resolvedEmployer.outcome === "CREATED"
                ? "employer.pending.created"
                : resolvedEmployer.status === "PENDING"
                  ? "employer.pending.reused"
                  : "employer.reused",
              employerId: resolvedEmployer.id,
              employerStatus: resolvedEmployer.status,
              employerSource: resolvedEmployer.createdSource,
              resolutionOutcome: resolvedEmployer.outcome,
              userId: request.authUser!.id,
            }, "employer resolution completed");
          } else if (resolutionError) {
            request.log.warn({
              event: resolutionError.code === "AMBIGUOUS" ? "employer.match.ambiguous" : "employer.identifier.rejected",
              resolutionErrorCode: resolutionError.code,
              userId: request.authUser!.id,
            }, "employer resolution needs review");
          }
          const currentEmploymentId = correctionDocument.rows[0].employment_id === null
            ? null
            : String(correctionDocument.rows[0].employment_id);
          const sameCanonical = currentEmploymentId === null
            || (resolvedEmployerId !== null && currentCanonicalEmployerId === resolvedEmployerId);
          await client.query(
            `UPDATE extraction_runs SET detected_employer_id = $1
              WHERE id = $2 AND user_id = $3 AND document_id = $4`,
            [resolvedEmployerId, activeRunId, request.authUser!.id, request.params.id],
          );
          if (resolvedEmployerId !== null && sameCanonical) {
            await client.query(
              `UPDATE documents SET detected_employer_id = $1
                WHERE id = $2 AND user_id = $3`,
              [resolvedEmployerId, request.params.id, request.authUser!.id],
            );
          } else {
            await client.query(
              `UPDATE documents SET employment_id = NULL, detected_employer_id = $1
                WHERE id = $2 AND user_id = $3`,
              [resolvedEmployerId, request.params.id, request.authUser!.id],
            );
            await client.query(
              `UPDATE payroll_settlements SET employment_id = NULL
                WHERE document_id = $1 AND user_id = $2`,
              [request.params.id, request.authUser!.id],
            );
            await client.query(
              `UPDATE import_batch_items SET employment_id = NULL, updated_at = now()
                WHERE id = $1 AND user_id = $2`,
              [correctionDocument.rows[0].import_batch_item_id, request.authUser!.id],
            );
          }
        }
        if (amountColumn) {
          await client.query(
            `UPDATE payroll_settlements SET ${amountColumn} = $1
              WHERE extraction_run_id = $2 AND user_id = $3 AND settlement_ordinal = 1`,
            [(correctedJson as { amount: string }).amount, row.extraction_run_id, request.authUser!.id],
          );
        } else if (fieldPath === "settlement.type") {
          await client.query(
            `UPDATE payroll_settlements
                SET settlement_type = $1, is_recurring = ($1 = 'NORMAL')
              WHERE extraction_run_id = $2 AND user_id = $3 AND settlement_ordinal = 1`,
            [correctedJson, row.extraction_run_id, request.authUser!.id],
          );
        } else if (fieldPath === "settlement.payrollPeriod") {
          await client.query(
            `INSERT INTO payroll_settlements (
               id, user_id, document_id, extraction_run_id, employment_id, settlement_ordinal,
               payroll_period, settlement_type, is_recurring, currency_code
             )
             SELECT $1, document.user_id, document.id, $2, document.employment_id, 1,
                    $3, COALESCE(candidate.settlement_type, 'OTRO_LABORAL'),
                    COALESCE(candidate.settlement_type = 'NORMAL', false), 'ARS'
               FROM documents document
               LEFT JOIN LATERAL (
                 SELECT COALESCE(
                   (SELECT correction.corrected_value #>> '{}'
                      FROM user_corrections correction
                     WHERE correction.user_id = document.user_id
                       AND correction.document_id = document.id
                       AND correction.extraction_run_id = $2
                       AND correction.field_path = 'settlement.type'
                     ORDER BY correction.correction_version DESC LIMIT 1),
                   (SELECT field.interpreted_value #>> '{}'
                      FROM extracted_fields field
                     WHERE field.user_id = document.user_id AND field.document_id = document.id
                       AND field.extraction_run_id = $2 AND field.field_path = 'settlement.type'
                     LIMIT 1)
                 ) AS settlement_type
               ) candidate ON true
              WHERE document.id = $4 AND document.user_id = $5
             ON CONFLICT (extraction_run_id, settlement_ordinal)
             DO UPDATE SET payroll_period = EXCLUDED.payroll_period`,
            [randomUUID(), row.extraction_run_id, `${corrected}-01`, request.params.id, request.authUser!.id],
          );
        }
        if (correctionDocument.rows[0].processing_status === "COMPLETED") {
          await client.query(
            "UPDATE documents SET processing_status = 'NEEDS_REVIEW' WHERE id = $1 AND user_id = $2",
            [request.params.id, request.authUser!.id],
          );
          await client.query(
            `UPDATE import_batch_items SET status = 'NEEDS_REVIEW', error_code = NULL, updated_at = now()
              WHERE id = $1 AND user_id = $2`,
            [correctionDocument.rows[0].import_batch_item_id, request.authUser!.id],
          );
        }
        await audit(client, request.authUser!.id, "FIELD_CORRECTED", row.id ? "EXTRACTED_FIELD" : "MANUAL_FIELD", row.id ? String(row.id) : request.params.id, { fieldPath, extractionRunId: activeRunId });
        return { id, extractionRunId: activeRunId, fieldPath, correctedValue: displayExtracted(correctedJson) };
      });
      return reply.code(201).send({ data: result });
    },
  );

  app.post<{ Params: IdParams; Body: ReviewCompleteBody }>(
    "/api/v1/documents/:id/review-complete",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false,
          required: ["extractionRunId"],
          properties: {
            acceptDeductionsMismatch: { type: "boolean" },
            extractionRunId: { type: "string", pattern: UUID_PATTERN },
          },
        },
      },
    },
    async (request) => {
      const result = await withTransaction(async (client) => {
        const document = await client.query(
          `SELECT id, import_batch_item_id, processing_status FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (document.rows[0].processing_status !== "NEEDS_REVIEW") {
          throw new ApiError(409, "REVIEW_NOT_REQUIRED", "El documento no requiere revisión.");
        }
        const activeRun = await client.query(
          `SELECT active_extraction_run_id AS id FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [request.params.id, request.authUser!.id],
        );
        if (!activeRun.rowCount || String(activeRun.rows[0].id) !== request.body.extractionRunId) {
          throw new ApiError(409, "STALE_EXTRACTION_RUN", "La extracción cambió; recargá el documento antes de finalizar la revisión.");
        }
        const settlement = await client.query(
          `SELECT settlement.id, settlement.extraction_run_id, settlement.payroll_period,
                  settlement.gross_amount, settlement.net_amount, settlement.deductions_amount,
                  settlement.gross_amount IS NOT NULL AND settlement.net_amount IS NOT NULL
                    AND settlement.deductions_amount IS NOT NULL
                    AND settlement.gross_amount - settlement.deductions_amount = settlement.net_amount AS totals_balance,
                  CASE
                    WHEN settlement.remunerative_amount IS NULL AND settlement.non_remunerative_amount IS NULL THEN true
                    ELSE settlement.gross_amount IS NOT NULL
                      AND settlement.remunerative_amount IS NOT NULL
                      AND settlement.non_remunerative_amount IS NOT NULL
                      AND settlement.remunerative_amount + settlement.non_remunerative_amount = settlement.gross_amount
                  END AS components_balance,
                  settlement.deductions_amount IS NOT NULL
                    AND COALESCE(breakdown.total_amount, 0) = settlement.deductions_amount AS deductions_match_total
             FROM payroll_settlements settlement
             JOIN extraction_runs run ON run.id = settlement.extraction_run_id
             LEFT JOIN LATERAL (
               SELECT sum(item.amount) AS total_amount FROM payroll_line_items item
                WHERE item.user_id = settlement.user_id AND item.settlement_id = settlement.id
                  AND item.item_type = 'DEDUCTION'
             ) breakdown ON true
            WHERE settlement.document_id = $1 AND settlement.user_id = $2
              AND settlement.extraction_run_id = $3
            ORDER BY settlement.settlement_ordinal LIMIT 1
            FOR UPDATE OF settlement`,
          [request.params.id, request.authUser!.id, request.body.extractionRunId],
        );
        if (!settlement.rowCount || settlement.rows[0].payroll_period === null || settlement.rows[0].gross_amount === null
          || settlement.rows[0].net_amount === null || settlement.rows[0].deductions_amount === null) {
          throw new ApiError(409, "REVIEW_INCOMPLETE", "Completá período, bruto, descuentos y neto antes de finalizar.");
        }
        const reviewed = await client.query(
          `SELECT count(DISTINCT field_path)::integer AS count FROM (
             SELECT field_path FROM extracted_fields
              WHERE user_id = $1 AND extraction_run_id = $2 AND interpreted_value <> 'null'::jsonb
             UNION
             SELECT field_path FROM user_corrections
              WHERE user_id = $1 AND extraction_run_id = $2
           ) reviewed_fields WHERE field_path = ANY($3::text[])`,
          [request.authUser!.id, settlement.rows[0].extraction_run_id, requiredPayrollReviewPaths],
        );
        if (Number(reviewed.rows[0].count) !== requiredPayrollReviewPaths.length) {
          throw new ApiError(409, "REVIEW_INCOMPLETE", "Revisá todos los campos obligatorios antes de finalizar.");
        }
        if (settlement.rows[0].totals_balance !== true) {
          throw new ApiError(409, "TOTALS_MISMATCH_REQUIRES_CORRECTION", "Corregí bruto, descuentos o neto para que los totales coincidan.");
        }
        if (settlement.rows[0].components_balance !== true) {
          throw new ApiError(409, "COMPONENTS_MISMATCH_REQUIRES_CORRECTION", "Corregí remunerativo, no remunerativo o bruto para que los componentes coincidan.");
        }
        const acceptedDeductionsMismatch = settlement.rows[0].deductions_match_total !== true;
        if (acceptedDeductionsMismatch && request.body?.acceptDeductionsMismatch !== true) {
          throw new ApiError(409, "DEDUCTIONS_MISMATCH_REQUIRES_CONFIRMATION", "Confirmá la diferencia del desglose antes de finalizar.");
        }
        await client.query(
          "UPDATE documents SET processing_status = 'COMPLETED', processed_at = now() WHERE id = $1 AND user_id = $2",
          [request.params.id, request.authUser!.id],
        );
        await client.query(
          `UPDATE extraction_runs run
              SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM extraction_run_issues issue
                     WHERE issue.user_id = run.user_id
                       AND issue.document_id = run.document_id
                       AND issue.extraction_run_id = run.id
                  ) THEN 'COMPLETED_WITH_WARNINGS' ELSE 'COMPLETED' END
            WHERE run.id = $1 AND run.user_id = $2 AND run.document_id = $3
              AND run.status = 'REVIEW_REQUIRED'`,
          [request.body.extractionRunId, request.authUser!.id, request.params.id],
        );
        await client.query(
          "UPDATE import_batch_items SET status = 'COMPLETED', error_code = NULL, updated_at = now() WHERE id = $1 AND user_id = $2",
          [document.rows[0].import_batch_item_id, request.authUser!.id],
        );
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           )
           SELECT $3, document.user_id, document.object_key, session.object_key, session.expires_at
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.id = $1 AND document.user_id = $2
              AND document.retention_policy = 'DELETE_AFTER_PROCESSING'
              AND document.original_deleted_at IS NULL
           ON CONFLICT (canonical_object_key) DO NOTHING`,
          [request.params.id, request.authUser!.id, randomUUID()],
        );
        const retentionDeletion = await client.query(
          `UPDATE documents AS document SET original_deleted_at = now()
            WHERE document.id = $1 AND document.user_id = $2
              AND document.retention_policy = 'DELETE_AFTER_PROCESSING'
              AND document.original_deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM storage_deletion_tombstones AS tombstone
                 WHERE tombstone.canonical_object_key = document.object_key
              )
            RETURNING document.id`,
          [request.params.id, request.authUser!.id],
        );
        await completeDocumentBatch(client, request.authUser!.id, request.params.id);
        await audit(client, request.authUser!.id, "DOCUMENT_REVIEW_COMPLETED", "DOCUMENT", request.params.id, {
          acceptedDeductionsMismatch,
          extractionRunId: request.body.extractionRunId,
          originalDeletionScheduled: retentionDeletion.rowCount === 1,
        });
        return { processingStatus: "COMPLETED" };
      });
      return { data: result };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/documents/:id/original",
    { preHandler: requireStepUp, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const keys = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.authUser!.id]);
        const lockedJobs = await client.query(
          `SELECT execution_owner FROM processing_jobs
            WHERE document_id = $1 AND user_id = $2
            ORDER BY id
            FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (lockedJobs.rows.some((job) => job.execution_owner !== null)) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para eliminar el documento.");
        }
        const found = await client.query(
          `SELECT document.object_key, document.original_deleted_at, document.processing_status,
                  session.object_key AS incoming_object_key, session.expires_at,
                  EXISTS (
                    SELECT 1 FROM processing_jobs job
                     WHERE job.document_id = document.id AND job.user_id = document.user_id
                       AND (job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
                            OR job.execution_owner IS NOT NULL)
                  ) AS has_active_job
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
            FOR UPDATE OF document, session`,
          [request.params.id, request.authUser!.id],
        );
        if (!found.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (found.rows[0].has_active_job === true) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine o eliminá el documento completo.");
        }
        if (![
          "COMPLETED", "NEEDS_REVIEW", "NEEDS_TYPE_CONFIRMATION", "REJECTED_UNSUPPORTED",
          "QUARANTINED", "FAILED_PERMANENT", "CANCELLED",
        ].includes(String(found.rows[0].processing_status))) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine o eliminá el documento completo.");
        }
        if (found.rows[0].original_deleted_at !== null) return null;
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), request.authUser!.id, found.rows[0].object_key, found.rows[0].incoming_object_key, found.rows[0].expires_at],
        );
        const updated = await client.query(
          `UPDATE documents SET original_deleted_at = now()
            WHERE id = $1 AND user_id = $2
              AND EXISTS (
                SELECT 1 FROM storage_deletion_tombstones
                 WHERE canonical_object_key = $3 AND user_id = $2
              )`,
          [request.params.id, request.authUser!.id, found.rows[0].object_key],
        );
        if (updated.rowCount !== 1) throw new Error("DELETION_TOMBSTONE_NOT_CREATED");
        await audit(client, request.authUser!.id, "DOCUMENT_ORIGINAL_DELETION_SCHEDULED", "DOCUMENT", request.params.id);
        return [String(found.rows[0].object_key), String(found.rows[0].incoming_object_key)];
      });
      if (keys) {
        const results = await Promise.allSettled([...new Set(keys)].map((key) => storage.deleteObject(key)));
        if (results.some(({ status }) => status === "rejected")) {
          request.log.warn({ requestId: request.id, errorCode: "STORAGE_DELETION_DEFERRED" }, "storage deletion deferred");
        }
        return reply.code(202).send({ data: null });
      }
      return { data: null };
    },
  );

  app.get<{ Params: IdParams; Querystring: OriginalQuery }>(
    "/api/v1/documents/:id/original",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { disposition: { type: "string", enum: ["inline", "attachment"] } },
        },
      },
    },
    async (request) => {
      const disposition = request.query.disposition ?? "attachment";
      const mfaInline = disposition === "inline" && request.authUser!.mfaEnabled;
      const objectKey = await withTransaction(async (client) => {
        if (!mfaInline && !await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const document = await client.query(
          `SELECT document.object_key FROM documents document
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
              AND document.original_deleted_at IS NULL AND document.security_status = 'CLEAN'
            FOR UPDATE OF document`,
          [request.params.id, request.authUser!.id],
        );
        if (document.rowCount !== 1) throw new ApiError(404, "ORIGINAL_NOT_FOUND", "El original no está disponible.");
        return String(document.rows[0].object_key);
      });
      try {
        return { data: await storage.authorizeDownload(objectKey, { disposition }) };
      } catch {
        throw new ApiError(503, "STORAGE_UNAVAILABLE", "El almacenamiento no está disponible temporalmente.");
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/documents/:id",
    { preHandler: requireStepUp, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const keys = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.authUser!.id]);
        const lockedJobs = await client.query(
          `SELECT execution_owner FROM processing_jobs
            WHERE document_id = $1 AND user_id = $2
            ORDER BY id
            FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (lockedJobs.rows.some((job) => job.execution_owner !== null)) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para eliminar el documento.");
        }
        const found = await client.query(
          `SELECT document.object_key, document.import_batch_id, document.import_batch_item_id,
                  session.object_key AS incoming_object_key, session.expires_at
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
            FOR UPDATE OF document, session`,
          [request.params.id, request.authUser!.id],
        );
        if (!found.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), request.authUser!.id, found.rows[0].object_key, found.rows[0].incoming_object_key, found.rows[0].expires_at],
        );
        const tombstone = await client.query(
          `SELECT 1 FROM storage_deletion_tombstones
            WHERE canonical_object_key = $1 AND user_id = $2`,
          [found.rows[0].object_key, request.authUser!.id],
        );
        if (!tombstone.rowCount) throw new Error("DELETION_TOMBSTONE_NOT_CREATED");
        const cancelledJobs = await client.query(
          `UPDATE processing_jobs
              SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                  lease_expires_at = NULL, error_code = 'DOCUMENT_DELETED', updated_at = now()
            WHERE document_id = $1 AND user_id = $2
              AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
            RETURNING reprocessing_batch_id`,
          [request.params.id, request.authUser!.id],
        );
        const reprocessingBatchIds = new Set(
          cancelledJobs.rows
            .map((job) => value(job, "reprocessing_batch_id"))
            .filter((batchId): batchId is string => batchId !== null),
        );
        for (const batchId of reprocessingBatchIds) {
          await refreshReprocessingBatch(client, request.authUser!.id, batchId);
        }
        await audit(client, request.authUser!.id, "DOCUMENT_DELETION_SCHEDULED", "DOCUMENT", request.params.id);
        await client.query(
          `DELETE FROM import_batch_items WHERE id = $1 AND user_id = $2`,
          [found.rows[0].import_batch_item_id, request.authUser!.id],
        );
        const deletedBatch = await client.query(
          `DELETE FROM import_batches AS batch
            WHERE batch.id = $1 AND batch.user_id = $2
              AND NOT EXISTS (SELECT 1 FROM import_batch_items item WHERE item.batch_id = batch.id)
            RETURNING id`,
          [found.rows[0].import_batch_id, request.authUser!.id],
        );
        if (!deletedBatch.rowCount) {
          await client.query(
            `UPDATE import_batches
                SET idempotency_key = $3, request_fingerprint = $4, updated_at = now()
              WHERE id = $1 AND user_id = $2`,
            [
              found.rows[0].import_batch_id,
              request.authUser!.id,
              randomUUID(),
              createHash("sha256").update(randomUUID()).digest("hex"),
            ],
          );
        }
        return [String(found.rows[0].object_key), String(found.rows[0].incoming_object_key)];
      });
      const results = await Promise.allSettled([...new Set(keys)].map((key) => storage.deleteObject(key)));
      if (results.some(({ status }) => status === "rejected")) {
        request.log.warn({ requestId: request.id, errorCode: "STORAGE_DELETION_DEFERRED" }, "storage deletion deferred");
      }
      return reply.code(202).send({ data: null });
    },
  );

  app.post(
    "/api/v1/privacy/exports",
    {
      preHandler: requireStepUp,
      config: { rateLimit: { max: 3, timeWindow: "15 minutes", keyGenerator: rateKey } },
    },
    async (request, reply) => {
      const result = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const activeUser = await client.query(
          "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [request.authUser!.id],
        );
        if (!activeUser.rowCount) {
          throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
        }
        await client.query(
          `UPDATE privacy_operations
              SET status = 'EXPIRED', completed_at = now(), updated_at = now()
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
              AND status IN ('READY', 'RUNNING') AND output_expires_at <= now()`,
          [request.authUser!.id],
        );
        // ponytail: libera un claim abandonado; reemplazar por lease si exportar deja de ser síncrono.
        await client.query(
          `UPDATE privacy_operations SET status = 'READY', updated_at = now()
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT' AND status = 'RUNNING'
              AND updated_at < now() - interval '15 minutes' AND output_expires_at > now()`,
          [request.authUser!.id],
        );
        await client.query(
          `WITH keep AS (
             SELECT id FROM privacy_operations
              WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
                AND status IN ('PENDING', 'RUNNING', 'READY')
              ORDER BY created_at DESC LIMIT 1
           )
           UPDATE privacy_operations
              SET status = 'CANCELLED', completed_at = now(), updated_at = now()
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
              AND status IN ('PENDING', 'RUNNING', 'READY')
              AND id <> (SELECT id FROM keep)`,
          [request.authUser!.id],
        );
        const existing = await client.query(
          `SELECT id, status, output_expires_at, created_at, started_at, completed_at
             FROM privacy_operations
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
              AND status IN ('PENDING', 'RUNNING', 'READY')
            ORDER BY created_at DESC LIMIT 1`,
          [request.authUser!.id],
        );
        if (existing.rowCount) {
          return { created: false, operation: existing.rows[0] };
        }
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const created = await client.query(
          `INSERT INTO privacy_operations (
             id, user_id, operation_type, idempotency_key, status, output_expires_at
           ) VALUES ($1, $2, 'DATA_EXPORT', $3, 'READY', $4)
           RETURNING id, status, output_expires_at, created_at, started_at, completed_at`,
          [id, request.authUser!.id, `export:${id}`, expiresAt],
        );
        await audit(client, request.authUser!.id, "DATA_EXPORT_CREATED", "PRIVACY_OPERATION", id);
        return { created: true, operation: created.rows[0] };
      });
      return reply.code(result.created ? 201 : 200).send({
        data: { created: result.created, ...exportOperationView(result.operation) },
      });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/privacy/exports/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      let result = await pool.query(
        `SELECT id, status, output_expires_at, created_at, updated_at, started_at, completed_at
           FROM privacy_operations
          WHERE id = $1 AND user_id = $2 AND operation_type = 'DATA_EXPORT'`,
        [request.params.id, request.authUser!.id],
      );
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = result.rows[0];
      const status = String(row.status);
      if (["READY", "RUNNING"].includes(status)
        && new Date(row.output_expires_at).valueOf() <= Date.now()) {
        result = await pool.query(
          `UPDATE privacy_operations
              SET status = 'EXPIRED', completed_at = COALESCE(completed_at, now()), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND operation_type = 'DATA_EXPORT'
              AND status IN ('READY', 'RUNNING') AND output_expires_at <= now()
            RETURNING id, status, output_expires_at, created_at, started_at, completed_at`,
          [request.params.id, request.authUser!.id],
        );
      } else if (status === "RUNNING"
        && new Date(row.updated_at).valueOf() < Date.now() - 15 * 60 * 1000) {
        result = await pool.query(
          `UPDATE privacy_operations SET status = 'READY', completed_at = NULL, updated_at = now()
            WHERE id = $1 AND user_id = $2 AND operation_type = 'DATA_EXPORT'
              AND status = 'RUNNING' AND updated_at < now() - interval '15 minutes'
              AND output_expires_at > now()
            RETURNING id, status, output_expires_at, created_at, started_at, completed_at`,
          [request.params.id, request.authUser!.id],
        );
      }
      if (!result.rowCount) {
        result = await pool.query(
          `SELECT id, status, output_expires_at, created_at, started_at, completed_at
             FROM privacy_operations
            WHERE id = $1 AND user_id = $2 AND operation_type = 'DATA_EXPORT'`,
          [request.params.id, request.authUser!.id],
        );
      }
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: exportOperationView(result.rows[0]) };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/privacy/exports/:id/download",
    {
      preHandler: requireStepUp,
      config: { rateLimit: { max: 2, timeWindow: "15 minutes", keyGenerator: rateKey } },
      onResponse: async (request, reply) => {
        await settleExport(
          request,
          successfulExportStreams.has(request) && !failedExports.has(request)
            && reply.statusCode >= 200 && reply.statusCode < 300,
        );
      },
      schema: { params: idParamsSchema },
    },
    async (request, reply) => {
      if (activeExportCount >= MAX_ACTIVE_EXPORT_STREAMS) {
        throw new ApiError(503, "EXPORT_CAPACITY", "La exportación está ocupada. Reintentá en unos minutos.");
      }
      activeExportCount += 1;
      exportReservations.add(request);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        if (!startedExportStreams.has(request)) void settleExport(request, false);
      }, EXPORT_STREAM_TTL_MS);
      timer.unref();
      exportStreams.set(request, { controller, timer });
      request.raw.once("aborted", () => {
        controller.abort();
        if (!startedExportStreams.has(request)) void settleExport(request, false);
      });
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) controller.abort();
        if (!startedExportStreams.has(request)) void settleExport(request, false);
        else if (reply.raw.writableFinished && successfulExportStreams.has(request)) void settleExport(request, true);
      });
      try {
        await withTransaction(async (client) => {
          if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
            throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
          }
          const activeUser = await client.query(
            "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
            [request.authUser!.id],
          );
          if (!activeUser.rowCount) {
            throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
          }
          const busy = await client.query(
            `SELECT 1 FROM privacy_operations
              WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
                AND status = 'RUNNING' AND id <> $2`,
            [request.authUser!.id, request.params.id],
          );
          if (busy.rowCount) {
            throw new ApiError(409, "EXPORT_IN_PROGRESS", "Ya hay otra exportación descargándose.");
          }
          const operation = await client.query(
            `SELECT operation.id
               FROM privacy_operations AS operation
              WHERE operation.id = $1 AND operation.user_id = $2
                AND operation.operation_type = 'DATA_EXPORT'
                AND operation.status = 'READY' AND operation.output_expires_at > now()
              FOR UPDATE OF operation`,
            [request.params.id, request.authUser!.id],
          );
          if (!operation.rowCount) {
            throw new ApiError(409, "EXPORT_NOT_READY", "La exportación no existe, venció o está siendo descargada.");
          }
          await client.query(
            `UPDATE privacy_operations SET status = 'RUNNING', started_at = COALESCE(started_at, now()),
                    updated_at = now()
              WHERE id = $1 AND user_id = $2 AND status = 'READY'`,
            [request.params.id, request.authUser!.id],
          );
        });
      } catch (error) {
        releaseExportResources(request);
        throw error;
      }
      claimedExports.add(request);
      if (controller.signal.aborted) {
        failedExports.add(request);
        await settleExport(request, false);
        throw new ApiError(409, "EXPORT_ABORTED", "La descarga se interrumpió. Podés reintentarlo.");
      }
      const userId = request.authUser!.id;
      activeExportStreams.set(userId, controller);
      reply.header("Cache-Control", "no-store");
      reply.header("Content-Disposition", `attachment; filename="salarivo-export-${new Date().toISOString().slice(0, 10)}.json"`);
      reply.type("application/json; charset=utf-8");
      return reply.send(privacyExportStream(
        request.params.id,
        userId,
        request.authSessionHash!,
        controller.signal,
        () => startedExportStreams.add(request),
        () => failedExports.add(request),
        (completed) => {
          if (completed) {
            successfulExportStreams.add(request);
            releaseExportResources(request);
          }
          else void settleExport(request, false);
        },
      ));
    },
  );

  app.post<{ Body: { token: string } }>(
    "/api/v1/privacy/account-deletion/status",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", pattern: TOKEN_PATTERN } },
        },
      },
    },
    async (request) => {
      const receipt = await pool.query(
        `SELECT operation_id, status, requested_at, completed_at
           FROM account_deletion_receipts WHERE token_hash = $1`,
        [tokenHash(request.body.token)],
      );
      if (receipt.rowCount !== 1) {
        throw new ApiError(404, "DELETION_RECEIPT_NOT_FOUND", "El comprobante no existe.");
      }
      return {
        data: {
          id: String(receipt.rows[0].operation_id),
          status: String(receipt.rows[0].status),
          requestedAt: timestamp(receipt.rows[0].requested_at),
          completedAt: receipt.rows[0].completed_at === null ? null : timestamp(receipt.rows[0].completed_at),
        },
      };
    },
  );

  app.delete<{ Body: { confirmation: string; receiptToken: string } }>(
    "/api/v1/privacy/account",
    {
      preHandler: requireStepUp,
      config: { rateLimit: { max: 3, timeWindow: "15 minutes", keyGenerator: rateKey } },
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["confirmation", "receiptToken"],
          properties: {
            confirmation: { type: "string", const: "ELIMINAR" },
            receiptToken: { type: "string", pattern: TOKEN_PATTERN },
          },
        },
      },
    },
    async (request, reply) => {
      const operationId = randomUUID();
      const receiptToken = request.body.receiptToken;
      await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const current = await client.query(
          `SELECT id, role FROM users
            WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE`,
          [request.authUser!.id],
        );
        if (!current.rowCount) {
          throw new ApiError(401, "INVALID_CREDENTIALS", "No se pudo verificar la cuenta.");
        }
        if (current.rows[0].role === "ADMIN") {
          throw new ApiError(409, "ADMIN_ACCOUNT_DELETION_NOT_ALLOWED", "Otra persona autorizada debe retirar primero el acceso administrativo.");
        }
        await client.query(
          `INSERT INTO privacy_operations (
             id, user_id, operation_type, idempotency_key, status
           ) VALUES ($1, $2, 'ACCOUNT_DELETION', $3, 'PENDING')`,
          [operationId, request.authUser!.id, `account-deletion:${operationId}`],
        );
        await client.query(
          `INSERT INTO account_deletion_receipts (id, operation_id, token_hash)
           VALUES ($1, $2, $3)`,
          [randomUUID(), operationId, tokenHash(receiptToken)],
        );
        await audit(client, request.authUser!.id, "ACCOUNT_DELETION_REQUESTED", "PRIVACY_OPERATION", operationId);
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           )
           SELECT gen_random_uuid(), document.user_id, document.object_key,
                  session.object_key, session.expires_at
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.user_id = $1
           ON CONFLICT DO NOTHING`,
          [request.authUser!.id],
        );
        await client.query(
          `INSERT INTO storage_deletion_tombstones (
             id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
           )
           SELECT gen_random_uuid(), session.user_id,
                  'documents/' || encode(sha256(convert_to(session.id::text, 'UTF8')), 'hex') || '.pdf',
                  session.object_key, session.expires_at
             FROM upload_sessions AS session
            WHERE session.user_id = $1
           ON CONFLICT DO NOTHING`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE processing_jobs
              SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                  lease_expires_at = NULL, error_code = 'ACCOUNT_DELETION', updated_at = now()
            WHERE user_id = $1 AND state IN ('PENDING', 'PUBLISHED', 'RETRYABLE')`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE documents SET processing_status = 'CANCELLED'
            WHERE user_id = $1 AND deleted_at IS NULL
              AND processing_status NOT IN ('COMPLETED', 'NEEDS_REVIEW', 'REJECTED_UNSUPPORTED',
                'QUARANTINED', 'FAILED_PERMANENT', 'CANCELLED')`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE import_batch_items SET status = 'CANCELLED',
                  error_code = 'ACCOUNT_DELETION', updated_at = now()
            WHERE user_id = $1 AND status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE import_batches SET status = 'CANCELLED', completed_at = now(), updated_at = now()
            WHERE user_id = $1 AND status IN ('ACTIVE', 'PAUSED')`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE privacy_operations SET status = 'CANCELLED', completed_at = now(), updated_at = now()
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
              AND status IN ('PENDING', 'READY')`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1`,
          [request.authUser!.id],
        );
        await client.query(
          `UPDATE users SET status = 'DELETION_PENDING', updated_at = now() WHERE id = $1`,
          [request.authUser!.id],
        );
      });
      activeExportStreams.get(request.authUser!.id)?.abort();
      reply.clearCookie(sessionCookie, {
        httpOnly: true, secure: config.appEnv === "production", sameSite: "lax", path: "/",
      });
      if (sessionCookie !== "salarivo_session") {
        reply.clearCookie("salarivo_session", {
          httpOnly: true, secure: true, sameSite: "lax", path: "/",
        });
      }
      return reply.code(202).send({ data: { id: operationId, status: "PENDING", receiptToken } });
    },
  );
}
