import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pool, withTransaction, type PoolClient } from "@salarivo/database";
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
  before?: string;
  beforeId?: string;
  search?: string;
  year?: string;
  employmentId?: string;
  processingStatus?: string;
  documentType?: string;
  settlementType?: string;
};
type OriginalQuery = { disposition?: "inline" | "attachment" };

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
const manualCorrectionPaths = new Set([
  "employer.name", "settlement.type", "settlement.payrollPeriod", ...settlementAmountColumns.keys(),
]);
const reprocessableDocumentStatuses = new Set([
  "COMPLETED", "NEEDS_REVIEW", "FAILED_PERMANENT", "CANCELLED",
]);
const requiredPayrollReviewPaths = [
  "settlement.payrollPeriod",
  "settlement.grossAmount",
  "settlement.netAmount",
  "settlement.deductionsAmount",
];
const missingFieldReasons = ["LABEL_OR_LAYOUT_NOT_RECOGNIZED", "VALUE_NOT_INTERPRETABLE"] as const;
type MissingFieldReason = (typeof missingFieldReasons)[number];
const exportSections = [
  ["authAccounts", `SELECT provider, provider_account_id, created_at, updated_at, last_login_at
      FROM auth_accounts WHERE user_id = $1 ORDER BY provider`],
  ["employers", `SELECT id, name, country_code, tax_identifier_type,
      (tax_identifier_ciphertext IS NOT NULL) AS tax_identifier_stored, created_at, updated_at
      FROM employers WHERE user_id = $1 ORDER BY id`],
  ["employments", `SELECT id, employer_id, status, start_date, end_date, role, category,
      modality, country_code, currency_code, created_at, updated_at
      FROM employments WHERE user_id = $1 ORDER BY id`],
  ["importBatches", `SELECT id, status, created_at, updated_at, completed_at
      FROM import_batches WHERE user_id = $1 ORDER BY id`],
  ["importItems", `SELECT id, batch_id, employment_id, client_item_key, ordinal, original_filename,
      declared_mime_type, expected_size_bytes, status, error_code, created_at, updated_at
      FROM import_batch_items WHERE user_id = $1 ORDER BY id`],
  ["uploadSessions", `SELECT id, batch_id, item_id, expected_size_bytes, expected_mime_type,
      status, expires_at, confirmed_at, created_at
      FROM upload_sessions WHERE user_id = $1 ORDER BY id`],
  ["documents", `SELECT id, employment_id, original_filename, declared_mime_type, detected_mime_type,
      size_bytes, page_count, sha256, security_status, classification_status, document_type,
      classification_confidence, processing_status, retention_policy, created_at, processed_at,
      original_deleted_at FROM documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`],
  ["extractionRuns", `SELECT id, document_id, processing_version, status, classifier_name,
      classifier_version, extractor_name, extractor_version, parser_version, normalizer_version,
      ocr_provider, ocr_version, started_at, finished_at, confidence, error_code, compute_ms
      FROM extraction_runs WHERE user_id = $1 ORDER BY id`],
  ["extractedFields", `SELECT id, document_id, extraction_run_id, field_path, entity_type, raw_value,
      interpreted_value, confidence, source, page_number, source_region, extractor_version, created_at
      FROM extracted_fields WHERE user_id = $1 ORDER BY id`],
  ["settlements", `SELECT id, document_id, extraction_run_id, employment_id, settlement_ordinal,
      payroll_period, payment_date, issue_date, settlement_type, is_recurring, currency_code,
      basic_amount, gross_amount, net_amount, remunerative_amount, non_remunerative_amount,
      deductions_amount, created_at FROM payroll_settlements WHERE user_id = $1 ORDER BY id`],
  ["lineItems", `SELECT id, settlement_id, item_ordinal, raw_description, normalized_concept_code,
      amount, currency_code, item_type, is_recurring, confidence, source_page, source_field, created_at
      FROM payroll_line_items WHERE user_id = $1 ORDER BY id`],
  ["corrections", `SELECT id, extracted_field_id, document_id, extraction_run_id, field_path,
      correction_version, extracted_value, corrected_value, inherited_from_correction_id, created_at
      FROM user_corrections WHERE user_id = $1 ORDER BY id`],
  ["legalAcknowledgements", `SELECT version.document_type, version.version, version.locale,
      acknowledgement.accepted_at
      FROM legal_acknowledgements acknowledgement
      JOIN legal_document_versions version ON version.id = acknowledgement.document_version_id
      WHERE acknowledgement.user_id = $1 ORDER BY version.document_type, version.version`],
  ["sessions", `SELECT id, expires_at, revoked_at, created_at, mfa_verified_at, step_up_expires_at
      FROM sessions WHERE user_id = $1 ORDER BY id`],
  ["mfa", `SELECT factor.id, factor.status, factor.enabled_at, factor.created_at,
      count(code.id) FILTER (WHERE code.used_at IS NULL)::integer AS recovery_codes_remaining
      FROM mfa_factors factor
      LEFT JOIN mfa_recovery_codes code ON code.factor_id = factor.id AND code.user_id = factor.user_id
      WHERE factor.user_id = $1
      GROUP BY factor.id ORDER BY factor.id`],
  ["privacyOperations", `SELECT id, operation_type, status, output_expires_at, error_code,
      created_at, updated_at, started_at, completed_at
      FROM privacy_operations WHERE user_id = $1 ORDER BY id`],
  ["auditEvents", `SELECT id, action, resource_type, resource_id, result,
      metadata_no_sensitive, created_at FROM audit_events WHERE user_id = $1 ORDER BY id`],
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
          ORDER BY settlement.created_at DESC LIMIT 1)
      ) AS payroll_period,
      (SELECT settlement.settlement_type
         FROM payroll_settlements settlement
        WHERE settlement.user_id = document.user_id AND settlement.document_id = document.id
        ORDER BY settlement.created_at DESC LIMIT 1) AS settlement_type,
      (SELECT correction.corrected_value #>> '{}'
         FROM user_corrections correction
        WHERE correction.user_id = document.user_id
          AND correction.document_id = document.id
          AND correction.extraction_run_id = (
            SELECT run.id FROM extraction_runs run
             WHERE run.user_id = document.user_id AND run.document_id = document.id
               AND run.status = 'COMPLETED'
             ORDER BY run.processing_version DESC LIMIT 1
          )
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
       AND field.extraction_run_id = (
         SELECT run.id FROM extraction_runs run
          WHERE run.user_id = document.user_id AND run.document_id = document.id
            AND run.status = 'COMPLETED'
          ORDER BY run.processing_version DESC LIMIT 1
       )
  ) projection ON true`;

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
  const totals = items.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const resolved = items.filter((item) => terminalImportItemStatuses.has(item.status)).length;
  return {
    id: String(batch.id),
    status: String(batch.status),
    createdAt: timestamp(batch.created_at),
    progress: {
      total: items.length,
      resolved,
      percentage: items.length ? Math.floor((resolved * 100) / items.length) : 100,
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
    needsReview: row.processing_status === "NEEDS_REVIEW",
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
  const key = employerName.trim().normalize("NFKC").toLowerCase();
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
  SELECT COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}') AS name
    FROM extracted_fields field
    LEFT JOIN LATERAL (
      SELECT current.corrected_value FROM user_corrections current
       WHERE current.user_id = field.user_id
         AND current.extraction_run_id = field.extraction_run_id
         AND current.field_path = field.field_path
       ORDER BY current.correction_version DESC LIMIT 1
    ) correction ON true
   WHERE field.user_id = settlement.user_id
     AND field.extraction_run_id = settlement.extraction_run_id
     AND field.field_path = 'employer.name'
   LIMIT 1
) detected_employer ON true`;

async function loadSalaryHistory(userId: string) {
  const [result, coverageResult] = await Promise.all([
    pool.query(
      `WITH latest_runs AS (
         SELECT DISTINCT ON (run.document_id) run.id, run.document_id, run.user_id
           FROM extraction_runs run
          WHERE run.user_id = $1 AND run.status = 'COMPLETED'
          ORDER BY run.document_id, run.processing_version DESC
       )
       SELECT settlement.id, settlement.document_id, settlement.employment_id,
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
              COALESCE(earnings.unknown_count, 0)::integer AS unknown_earning_count
         FROM documents document
         JOIN latest_runs run ON run.document_id = document.id AND run.user_id = document.user_id
         JOIN payroll_settlements settlement
           ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
         LEFT JOIN employments employment
           ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
         LEFT JOIN employers employer
           ON employer.id = employment.employer_id AND employer.user_id = settlement.user_id
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
          AND document.document_type = 'PAYROLL' AND document.processing_status = 'COMPLETED'
        ORDER BY settlement.payroll_period, settlement.created_at, settlement.id`,
      [userId],
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
                WHERE user_id = $1 AND status = 'ACTIVE') AS active_employments
         FROM documents
        WHERE user_id = $1 AND deleted_at IS NULL AND document_type = 'PAYROLL'`,
      [userId],
    ),
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
  const settlements: SalarySettlement[] = result.rows.map((row) => {
    const employmentId = value(row, "employment_id");
    const employerName = value(row, "employer_name")?.trim() || null;
    const currency = String(row.currency_code);
    const documentId = String(row.document_id);
    const employmentContext = employmentId
      ?? (employerName
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
        `SELECT id, email, display_name, role, status, default_retention_policy,
                email_verified_at, onboarding_completed_at, last_login_at, created_at, updated_at
           FROM users WHERE id = $1 AND status = 'ACTIVE'`,
        [userId],
      );
      if (account.rowCount !== 1) throw new Error("EXPORT_ACCOUNT_NOT_FOUND");
      const row = account.rows[0];
      yield JSON.stringify({
        format: "salarivo-export-v2",
        exportedAt: new Date().toISOString(),
        account: {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          status: row.status,
          defaultRetentionPolicy: row.default_retention_policy,
          emailVerifiedAt: row.email_verified_at,
          onboardingCompletedAt: row.onboarding_completed_at,
          lastLoginAt: row.last_login_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
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
        `SELECT id, status, created_at FROM import_batches
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
          "SELECT id, status, created_at FROM import_batches WHERE id = $1 AND user_id = $2",
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
        `SELECT id, status, created_at FROM import_batches WHERE id = $1 AND user_id = $2`,
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
             id, user_id, document_id, stage, processing_version, idempotency_key
           ) VALUES ($1, $2, $3, 'SECURITY_VALIDATION', 1, $4)`,
          [jobId, request.authUser!.id, documentId, `security:${documentId}:v1`],
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
        "settlement.currency_code = $2",
        "item.item_type = 'EARNING'",
        "item.normalized_concept_code IS NOT NULL",
      ];
      let includeDetectedEmployer = false;
      const detectedContext = /^detected:[0-9a-f]{24}$/.test(request.query.employmentContext);
      const unconfirmedContext = /^unconfirmed:([0-9a-f-]{36})$/.exec(request.query.employmentContext);
      if (uuid.test(request.query.employmentContext)) {
        conditions.push(`settlement.employment_id = ${parameter(request.query.employmentContext)}::uuid`);
      } else if (detectedContext) {
        const identity = request.query.employerName === undefined
          ? null
          : detectedEmploymentIdentity(request.query.employerName);
        if (identity === null || identity.context !== request.query.employmentContext) {
          throw new ApiError(400, "VALIDATION_ERROR", "El contexto laboral no es válido.");
        }
        includeDetectedEmployer = true;
        conditions.push("settlement.employment_id IS NULL");
        conditions.push(`lower(normalize(btrim(detected_employer.name), NFKC) COLLATE "und-x-icu") = ${parameter(identity.key)}`);
      } else if (unconfirmedContext !== null && uuid.test(unconfirmedContext[1]!)) {
        includeDetectedEmployer = true;
        conditions.push("settlement.employment_id IS NULL");
        conditions.push(`document.id = ${parameter(unconfirmedContext[1])}::uuid`);
        conditions.push("NULLIF(btrim(detected_employer.name), '') IS NULL");
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
        `WITH latest_runs AS (
           SELECT DISTINCT ON (run.document_id) run.id, run.document_id, run.user_id
             FROM extraction_runs run
            WHERE run.user_id = $1 AND run.status = 'COMPLETED'
            ORDER BY run.document_id, run.processing_version DESC
         )
         SELECT to_char(settlement.payroll_period, 'YYYY-MM') AS period,
                (extract(epoch FROM settlement.created_at) * 1000000)::numeric(30, 0)::text
                  AS settlement_created_micros,
                settlement.settlement_ordinal, settlement.id AS settlement_id,
                settlement.settlement_type, item.item_ordinal, item.id AS item_id,
                item.normalized_concept_code, item.is_recurring, item.amount
           FROM documents document
           JOIN latest_runs run ON run.document_id = document.id AND run.user_id = document.user_id
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

  app.get<{ Querystring: DocumentListQuery }>(
    "/api/v1/documents",
    { preHandler: requireAuth },
    async (request) => {
      const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ApiError(400, "VALIDATION_ERROR", "El límite no es válido.");
      }
      if ((request.query.before === undefined) !== (request.query.beforeId === undefined)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El cursor no es válido.");
      }
      const before = request.query.before === undefined ? null : new Date(request.query.before);
      if (before && Number.isNaN(before.getTime())) throw new ApiError(400, "VALIDATION_ERROR", "El cursor no es válido.");
      if (request.query.beforeId !== undefined && !uuid.test(request.query.beforeId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El cursor no es válido.");
      }
      const search = request.query.search?.trim();
      if (search && search.length > 100) throw new ApiError(400, "VALIDATION_ERROR", "La búsqueda es demasiado larga.");
      if (request.query.year !== undefined && !/^20\d{2}$/.test(request.query.year)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El año no es válido.");
      }
      if (request.query.employmentId !== undefined
        && request.query.employmentId !== "unassociated"
        && !uuid.test(request.query.employmentId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El empleo no es válido.");
      }
      if (request.query.documentType !== undefined && !["PAYROLL", "UNSUPPORTED"].includes(request.query.documentType)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El tipo de documento no es válido.");
      }
      if (request.query.settlementType !== undefined && !settlementTypes.has(request.query.settlementType)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El tipo de liquidación no es válido.");
      }
      if (request.query.processingStatus !== undefined && !/^[A-Z_]{2,40}$/.test(request.query.processingStatus)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El estado no es válido.");
      }
      const parameters: unknown[] = [request.authUser!.id];
      const conditions = ["document.user_id = $1", "document.deleted_at IS NULL"];
      const parameter = (input: unknown) => {
        parameters.push(input);
        return `$${parameters.length}`;
      };
      if (before && request.query.beforeId) {
        const beforeParameter = parameter(before.toISOString());
        const idParameter = parameter(request.query.beforeId);
        conditions.push(`(document.created_at, document.id) < (${beforeParameter}::timestamptz, ${idParameter}::uuid)`);
      }
      if (search) {
        const searchParameter = parameter(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
        conditions.push(`(document.original_filename ILIKE ${searchParameter} ESCAPE '\\'
          OR COALESCE(employer.name, projection.corrected_employer_name, projection.extracted_employer_name, '')
             ILIKE ${searchParameter} ESCAPE '\\')`);
      }
      if (request.query.year) conditions.push(`projection.payroll_period LIKE ${parameter(`${request.query.year}-%`)}`);
      if (request.query.employmentId === "unassociated") conditions.push("document.employment_id IS NULL");
      else if (request.query.employmentId) conditions.push(`document.employment_id = ${parameter(request.query.employmentId)}::uuid`);
      if (request.query.processingStatus) conditions.push(`document.processing_status = ${parameter(request.query.processingStatus)}`);
      if (request.query.documentType) conditions.push(`document.document_type = ${parameter(request.query.documentType)}`);
      if (request.query.settlementType) conditions.push(`projection.settlement_type = ${parameter(request.query.settlementType)}`);
      parameters.push(limit);
      const result = await pool.query(
        `SELECT document.id, document.employment_id, document.original_filename, document.created_at,
                document.processing_status, document.document_type,
                document.classification_confidence, document.original_deleted_at,
                document.deleted_at, item.error_code, projection.payroll_period, projection.settlement_type,
                COALESCE(employer.name, projection.corrected_employer_name,
                         projection.extracted_employer_name) AS employer_name
           FROM documents document
           JOIN import_batch_items item
             ON item.id = document.import_batch_item_id AND item.user_id = document.user_id
           LEFT JOIN employments employment
             ON employment.id = document.employment_id AND employment.user_id = document.user_id
            LEFT JOIN employers employer
              ON employer.id = employment.employer_id AND employer.user_id = document.user_id
           ${documentProjectionJoin}
          WHERE ${conditions.join(" AND ")}
          ORDER BY document.created_at DESC, document.id DESC LIMIT $${parameters.length}`,
        parameters,
      );
      return { data: result.rows.map(documentView) };
    },
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
                item.error_code, projection.payroll_period, projection.settlement_type,
                COALESCE(employer.name, projection.corrected_employer_name,
                         projection.extracted_employer_name) AS employer_name
           FROM documents document
           JOIN import_batch_items item
             ON item.id = document.import_batch_item_id AND item.user_id = document.user_id
           LEFT JOIN employments employment
             ON employment.id = document.employment_id AND employment.user_id = document.user_id
           LEFT JOIN employers employer
             ON employer.id = employment.employer_id AND employer.user_id = document.user_id
           ${documentProjectionJoin}
          WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL`,
        [request.params.id, request.authUser!.id],
      );
      if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const latestRun = await client.query(
        `SELECT id, processing_version, extractor_name, extractor_version, parser_version,
                normalizer_version, ocr_provider, ocr_version, confidence, finished_at
           FROM extraction_runs
          WHERE document_id = $1 AND user_id = $2 AND status = 'COMPLETED'
          ORDER BY processing_version DESC LIMIT 1`,
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
      const extractionRunId = latestRun.rowCount ? String(latestRun.rows[0].id) : null;
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
      const missingEffectivePaths = new Set([
        ...(!effectiveSettlement.payroll_period ? ["settlement.payrollPeriod"] : []),
        ...(!effectiveSettlement.gross_amount ? ["settlement.grossAmount"] : []),
        ...(!effectiveSettlement.net_amount ? ["settlement.netAmount"] : []),
        ...(!effectiveSettlement.deductions_amount && effectiveSettlement.deductions_amount !== "0.00"
          ? ["settlement.deductionsAmount"] : []),
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
        for (const fieldPath of requiredPayrollReviewPaths) {
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
        processedAt: row.processed_at === null ? null : timestamp(row.processed_at),
        lastReprocessError: lastReprocessJob.rows[0]?.state === "FAILED" ? {
          code: String(lastReprocessJob.rows[0].error_code),
          processingVersion: Number(lastReprocessJob.rows[0].processing_version),
          failedAt: timestamp(lastReprocessJob.rows[0].completed_at),
        } : null,
        reviewSettlement: settlement.rows.length ? {
          totalsBalance: settlement.rows[0].totals_balance === true,
          deductionsMatchTotal: settlement.rows[0].deductions_match_total === true,
        } : null,
        extractionRun: latestRun.rowCount ? {
          id: String(latestRun.rows[0].id),
          processingVersion: Number(latestRun.rows[0].processing_version),
          extractorName: String(latestRun.rows[0].extractor_name),
          extractorVersion: String(latestRun.rows[0].extractor_version),
          parserVersion: String(latestRun.rows[0].parser_version),
          normalizerVersion: String(latestRun.rows[0].normalizer_version),
          ocrProvider: value(latestRun.rows[0], "ocr_provider"),
          ocrVersion: value(latestRun.rows[0], "ocr_version"),
          confidence: value(latestRun.rows[0], "confidence"),
          finishedAt: timestamp(latestRun.rows[0].finished_at),
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
           LEFT JOIN employments employment ON employment.id = settlement.employment_id AND employment.user_id = settlement.user_id
           LEFT JOIN employers employer ON employer.id = employment.employer_id AND employer.user_id = settlement.user_id
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
            AND run.processing_version = (
              SELECT max(latest.processing_version) FROM extraction_runs latest
               WHERE latest.user_id = settlement.user_id
                 AND latest.document_id = settlement.document_id
                 AND latest.status = 'COMPLETED'
            )
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
                    processing_status = 'REJECTED_UNSUPPORTED', processed_at = now()
              WHERE id = $1 AND user_id = $2`,
            [request.params.id, request.authUser!.id],
          );
          await client.query(
            `UPDATE import_batch_items SET status = 'REJECTED',
                    error_code = 'DOCUMENT_UNSUPPORTED', updated_at = now()
              WHERE id = $1 AND user_id = $2`,
            [row.import_batch_item_id, request.authUser!.id],
          );
          if (row.retention_policy === "DELETE_AFTER_PROCESSING" && row.original_deleted_at === null) {
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
             id, user_id, document_id, stage, processing_version, idempotency_key
           ) VALUES ($1, $2, $3, 'TEXT_EXTRACTION', $4, $5)`,
          [jobId, request.authUser!.id, request.params.id, processingVersion, `confirmed-type:${request.params.id}:v${processingVersion}`],
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

  app.post<{ Params: IdParams }>(
    "/api/v1/documents/:id/reprocess",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const requestedKey = request.headers["idempotency-key"];
      if (typeof requestedKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestedKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const idempotencyKey = `reprocess:${request.authUser!.id}:${request.params.id}:${createHash("sha256").update(requestedKey).digest("hex")}`;
      const result = await withTransaction(async (client) => {
        const document = await client.query(
          `SELECT processing_status, security_status, document_type, original_deleted_at
             FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const existing = await client.query(
          `SELECT id, state, processing_version FROM processing_jobs
            WHERE document_id = $1 AND user_id = $2 AND idempotency_key = $3`,
          [request.params.id, request.authUser!.id, idempotencyKey],
        );
        if (existing.rowCount) {
          return {
            created: false,
            processingStatus: String(document.rows[0].processing_status),
            job: {
              id: String(existing.rows[0].id),
              state: String(existing.rows[0].state),
              processingVersion: Number(existing.rows[0].processing_version),
            },
          };
        }
        const row = document.rows[0];
        if (!reprocessableDocumentStatuses.has(String(row.processing_status))) {
          throw new ApiError(409, "REPROCESS_NOT_ALLOWED", "El documento todavía no puede reprocesarse.");
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
              AND (state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR execution_owner IS NOT NULL)
            LIMIT 1`,
          [request.params.id, request.authUser!.id],
        );
        if (activeJob.rowCount) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento actual.");
        }
        const version = await client.query(
          `SELECT GREATEST(
                    COALESCE((SELECT max(processing_version) FROM processing_jobs
                               WHERE document_id = $1 AND user_id = $2), 0),
                    COALESCE((SELECT max(processing_version) FROM extraction_runs
                               WHERE document_id = $1 AND user_id = $2), 0)
                  )::integer + 1 AS processing_version`,
          [request.params.id, request.authUser!.id],
        );
        const processingVersion = Number(version.rows[0].processing_version);
        const jobId = randomUUID();
        await client.query(
          `INSERT INTO processing_jobs (
             id, user_id, document_id, stage, processing_version, idempotency_key,
             previous_document_status
           ) VALUES ($1, $2, $3, 'TEXT_EXTRACTION', $4, $5, $6)`,
          [jobId, request.authUser!.id, request.params.id, processingVersion, idempotencyKey, row.processing_status],
        );
        await client.query(
          `UPDATE documents SET processing_status = 'UPLOADED'
            WHERE id = $1 AND user_id = $2`,
          [request.params.id, request.authUser!.id],
        );
        await audit(client, request.authUser!.id, "DOCUMENT_REPROCESS_REQUESTED", "DOCUMENT", request.params.id, {
          processingVersion,
        });
        return {
          created: true,
          processingStatus: "UPLOADED",
          job: { id: jobId, state: "PENDING", processingVersion },
        };
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
      const result = await withTransaction(async (client) => {
        const correctionDocument = await client.query(
          `SELECT processing_status, import_batch_item_id FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!correctionDocument.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (!["NEEDS_REVIEW", "COMPLETED"].includes(String(correctionDocument.rows[0].processing_status))) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para corregirlo.");
        }
        const latestRun = await client.query(
          `SELECT id FROM extraction_runs
            WHERE document_id = $1 AND user_id = $2 AND status = 'COMPLETED'
            ORDER BY processing_version DESC LIMIT 1 FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (!latestRun.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const latestRunId = String(latestRun.rows[0].id);
        if (request.body.extractionRunId !== latestRunId) {
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
          [request.body.extractedFieldId, request.params.id, request.authUser!.id, latestRunId],
        ) : await client.query(
          `SELECT NULL::uuid AS id, $3::text AS field_path, NULL::jsonb AS interpreted_value,
                   run.id AS extraction_run_id, settlement.currency_code
             FROM extraction_runs run
             LEFT JOIN payroll_settlements settlement
               ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
              AND settlement.settlement_ordinal = 1
            WHERE run.id = $4 AND run.document_id = $1 AND run.user_id = $2
            FOR UPDATE OF run`,
          [request.params.id, request.authUser!.id, request.body.fieldPath, latestRunId],
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
        await audit(client, request.authUser!.id, "FIELD_CORRECTED", row.id ? "EXTRACTED_FIELD" : "MANUAL_FIELD", row.id ? String(row.id) : request.params.id, { fieldPath, extractionRunId: latestRunId });
        return { id, extractionRunId: latestRunId, fieldPath, correctedValue: displayExtracted(correctedJson) };
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
        const latestRun = await client.query(
          `SELECT id FROM extraction_runs
            WHERE document_id = $1 AND user_id = $2 AND status = 'COMPLETED'
            ORDER BY processing_version DESC LIMIT 1`,
          [request.params.id, request.authUser!.id],
        );
        if (!latestRun.rowCount || String(latestRun.rows[0].id) !== request.body.extractionRunId) {
          throw new ApiError(409, "STALE_EXTRACTION_RUN", "La extracción cambió; recargá el documento antes de finalizar la revisión.");
        }
        const settlement = await client.query(
          `SELECT settlement.id, settlement.extraction_run_id, settlement.payroll_period,
                  settlement.gross_amount, settlement.net_amount, settlement.deductions_amount,
                  settlement.gross_amount IS NOT NULL AND settlement.net_amount IS NOT NULL
                    AND settlement.deductions_amount IS NOT NULL
                    AND settlement.gross_amount - settlement.deductions_amount = settlement.net_amount AS totals_balance,
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
              AND settlement.extraction_run_id = $3 AND run.status = 'COMPLETED'
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
        const acceptedDeductionsMismatch = settlement.rows[0].deductions_match_total !== true;
        if (acceptedDeductionsMismatch && request.body?.acceptDeductionsMismatch !== true) {
          throw new ApiError(409, "DEDUCTIONS_MISMATCH_REQUIRES_CONFIRMATION", "Confirmá la diferencia del desglose antes de finalizar.");
        }
        await client.query(
          "UPDATE documents SET processing_status = 'COMPLETED', processed_at = now() WHERE id = $1 AND user_id = $2",
          [request.params.id, request.authUser!.id],
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
        const found = await client.query(
          `SELECT document.object_key, document.original_deleted_at, document.processing_status,
                  session.object_key AS incoming_object_key, session.expires_at
             FROM documents AS document
             JOIN upload_sessions AS session
               ON session.id = document.upload_session_id AND session.user_id = document.user_id
            WHERE document.id = $1 AND document.user_id = $2 AND document.deleted_at IS NULL
            FOR UPDATE OF document, session`,
          [request.params.id, request.authUser!.id],
        );
        if (!found.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
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
      preHandler: requireStepUp,
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
      const objectKey = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
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
        return { data: await storage.authorizeDownload(objectKey, {
          disposition: request.query.disposition ?? "attachment",
        }) };
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
        const activeExecution = await client.query(
          `SELECT 1 FROM processing_jobs
            WHERE document_id = $1 AND user_id = $2 AND execution_owner IS NOT NULL`,
          [request.params.id, request.authUser!.id],
        );
        if (activeExecution.rowCount) {
          throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine el procesamiento para eliminar el documento.");
        }
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
        await client.query(
          `UPDATE processing_jobs
              SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                  lease_expires_at = NULL, error_code = 'DOCUMENT_DELETED', updated_at = now()
            WHERE document_id = $1 AND user_id = $2
              AND state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
          [request.params.id, request.authUser!.id],
        );
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
          `SELECT id, status, output_expires_at
             FROM privacy_operations
            WHERE user_id = $1 AND operation_type = 'DATA_EXPORT'
              AND status IN ('PENDING', 'RUNNING', 'READY')
            ORDER BY created_at DESC LIMIT 1`,
          [request.authUser!.id],
        );
        if (existing.rowCount) {
          const row = existing.rows[0];
          return {
            created: false,
            id: String(row.id),
            status: String(row.status),
            expiresAt: row.output_expires_at ? timestamp(row.output_expires_at) : null,
          };
        }
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await client.query(
          `INSERT INTO privacy_operations (
             id, user_id, operation_type, idempotency_key, status, output_expires_at
           ) VALUES ($1, $2, 'DATA_EXPORT', $3, 'READY', $4)`,
          [id, request.authUser!.id, `export:${id}`, expiresAt],
        );
        await audit(client, request.authUser!.id, "DATA_EXPORT_CREATED", "PRIVACY_OPERATION", id);
        return { created: true, id, status: "READY", expiresAt: expiresAt.toISOString() };
      });
      const downloadUrl = result.status === "READY"
        ? `/api/v1/privacy/exports/${result.id}/download`
        : null;
      return reply.code(result.created ? 201 : 200).send({ data: { ...result, downloadUrl } });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/privacy/exports/:id",
    { preHandler: requireAuth, schema: { params: idParamsSchema } },
    async (request) => {
      const result = await pool.query(
        `SELECT id, status, output_expires_at, updated_at FROM privacy_operations
          WHERE id = $1 AND user_id = $2 AND operation_type = 'DATA_EXPORT'`,
        [request.params.id, request.authUser!.id],
      );
      if (!result.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      let status = String(result.rows[0].status);
      if (
        status === "RUNNING" &&
        new Date(result.rows[0].updated_at).valueOf() < Date.now() - 15 * 60 * 1000 &&
        new Date(result.rows[0].output_expires_at).valueOf() > Date.now()
      ) {
        const recovered = await pool.query(
          `UPDATE privacy_operations SET status = 'READY', updated_at = now()
            WHERE id = $1 AND user_id = $2 AND status = 'RUNNING'
              AND updated_at < now() - interval '15 minutes'
            RETURNING status`,
          [request.params.id, request.authUser!.id],
        );
        if (recovered.rowCount) status = "READY";
      }
      if (status === "READY" && new Date(result.rows[0].output_expires_at).valueOf() <= Date.now()) {
        status = "EXPIRED";
        await pool.query(
          "UPDATE privacy_operations SET status = 'EXPIRED', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'READY'",
          [request.params.id],
        );
      }
      return { data: { id: request.params.id, status, downloadUrl: status === "READY" ? `/api/v1/privacy/exports/${request.params.id}/download` : null } };
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
