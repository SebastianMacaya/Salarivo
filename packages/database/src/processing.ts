import { createHash } from "node:crypto";

export const extractionRunStatuses = [
  "RUNNING",
  "PROCESSING",
  "COMPLETED",
  "COMPLETED_WITH_WARNINGS",
  "REVIEW_REQUIRED",
  "FAILED",
  "CANCELLED",
] as const;

export type ExtractionRunStatus = (typeof extractionRunStatuses)[number];

export const processingTriggerKinds = [
  "LEGACY_UNKNOWN",
  "INITIAL_UPLOAD",
  "USER_TYPE_CONFIRMATION",
  "USER_REPROCESS",
  "ADMIN_REPROCESS",
  "PARSER_UPGRADE",
  "AUTOMATIC_RECOVERY",
] as const;

export type ProcessingTriggerKind = (typeof processingTriggerKinds)[number];

export const promotionOutcomes = [
  "NOT_EVALUATED",
  "PROMOTED",
  "UNCHANGED",
  "REVIEW_REQUIRED",
  "REJECTED_REGRESSION",
] as const;

export type PromotionOutcome = (typeof promotionOutcomes)[number];

export const processingPipelineVersions = {
  classifier: "7",
  extractor: "7",
  parser: "9",
  normalizer: "6",
  resultSchema: "1",
} as const;

export const currentPipelineFingerprint = createHash("sha256")
  .update(JSON.stringify(processingPipelineVersions))
  .digest("hex");

export function hasDocumentCountryRecoverySql(runAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(runAlias)) throw new Error('INVALID_SQL_ALIAS');
  return `EXISTS (SELECT 1 FROM documents country_document
    LEFT JOIN employments country_employment ON country_employment.id = country_document.employment_id
      AND country_employment.user_id = country_document.user_id
    WHERE country_document.id = ${runAlias}.document_id AND country_document.user_id = ${runAlias}.user_id
      AND COALESCE(CASE WHEN country_employment.country_confirmed_at IS NOT NULL THEN country_employment.country_code END,
        CASE WHEN country_document.country_source = 'USER_CONFIRMED' THEN country_document.country_code END) = 'AR'
      AND (country_document.country_code IS NULL OR country_document.country_code = 'AR')
      AND (${runAlias}.country_code IS DISTINCT FROM 'AR'
        OR country_employment.country_confirmed_at > ${runAlias}.started_at
        OR (country_document.country_source = 'USER_CONFIRMED' AND country_document.country_snapshot_at > ${runAlias}.started_at))
      AND EXISTS (SELECT 1 FROM extraction_run_issues country_issue WHERE country_issue.extraction_run_id = ${runAlias}.id
        AND country_issue.user_id = ${runAlias}.user_id AND country_issue.document_id = ${runAlias}.document_id
        AND country_issue.code IN ('COUNTRY_UNCONFIRMED', 'COUNTRY_EMPLOYMENT_CONFLICT', 'COUNTRY_SNAPSHOT_CONFLICT', 'COUNTRY_NOT_SUPPORTED'))) `;
}

export const retryableOcrIssueCodes = [
  "OCR_DISABLED", "OCR_TIMEOUT", "OCR_RATE_LIMITED", "OCR_PROVIDER_UNAVAILABLE",
  "OCR_BUDGET_EXCEEDED", "OCR_CONCURRENCY_LIMIT", "OCR_CIRCUIT_OPEN",
  "OCR_ALREADY_ATTEMPTED", "OCR_AUTH_FAILED", "OCR_LEGAL_ACCEPTANCE_REQUIRED",
] as const;

export const parserFixCatalog = [
  {
    issueCode: "LABEL_OR_LAYOUT_NOT_RECOGNIZED",
    affectedFieldPath: "settlement.basicAmount",
    introducedInParserVersion: "7",
  },
] as const;

export type ParserFix = (typeof parserFixCatalog)[number];

export const settlementTypes = [
  "NORMAL",
  "SAC",
  "VACACIONES",
  "BONO",
  "RETROACTIVO",
  "COMISION",
  "HORAS_EXTRA",
  "LIQUIDACION_FINAL",
  "INDEMNIZACION",
  "AJUSTE",
  "REINTEGRO",
  "OTRO_LABORAL",
] as const;

export type SettlementType = (typeof settlementTypes)[number];

const commonCriticalFields = [
  "settlement.payrollPeriod",
  "settlement.grossAmount",
  "settlement.netAmount",
  "settlement.deductionsAmount",
] as const;

export const criticalFieldsBySettlementType = {
  NORMAL: [...commonCriticalFields, "settlement.basicAmount"],
  SAC: [...commonCriticalFields],
  VACACIONES: [...commonCriticalFields],
  BONO: [...commonCriticalFields],
  RETROACTIVO: [...commonCriticalFields],
  COMISION: [...commonCriticalFields],
  HORAS_EXTRA: [...commonCriticalFields],
  LIQUIDACION_FINAL: [...commonCriticalFields],
  INDEMNIZACION: [...commonCriticalFields],
  AJUSTE: [...commonCriticalFields],
  REINTEGRO: [...commonCriticalFields],
  OTRO_LABORAL: [...commonCriticalFields],
} as const satisfies Record<SettlementType, readonly string[]>;

export type SnapshotComparison = "IMPROVED" | "UNCHANGED" | "REVIEW_REQUIRED" | "REGRESSED";

export type ProcessingSnapshot = {
  settlementType: SettlementType | null;
  payrollPeriod: string | null;
  employerId: string | null;
  currencyCode: string | null;
  basicAmount: string | null;
  grossAmount: string | null;
  netAmount: string | null;
  remunerativeAmount: string | null;
  nonRemunerativeAmount: string | null;
  deductionsAmount: string | null;
  lineItemsFingerprint: string | null;
  issueCodes: readonly string[];
};

const snapshotValueKeys = [
  "settlementType",
  "payrollPeriod",
  "employerId",
  "currencyCode",
  "basicAmount",
  "grossAmount",
  "netAmount",
  "remunerativeAmount",
  "nonRemunerativeAmount",
  "deductionsAmount",
  "lineItemsFingerprint",
] as const satisfies readonly (keyof ProcessingSnapshot)[];

export function compareProcessingSnapshots(
  previous: ProcessingSnapshot,
  candidate: ProcessingSnapshot,
): SnapshotComparison {
  let improved = false;
  let requiresReview = false;
  let regressed = false;

  for (const key of snapshotValueKeys) {
    const before = previous[key];
    const after = candidate[key];
    if (before === after) continue;
    if (before !== null && after === null) {
      regressed = true;
    } else if (before === null && after !== null) {
      improved = true;
    } else {
      requiresReview = true;
    }
  }

  const previousIssues = new Set(previous.issueCodes);
  const candidateIssues = new Set(candidate.issueCodes);
  const removedIssues = [...previousIssues].some((code) => !candidateIssues.has(code));
  const addedIssues = [...candidateIssues].some((code) => !previousIssues.has(code));
  if (removedIssues && addedIssues) requiresReview = true;
  else if (addedIssues) regressed = true;
  else if (removedIssues) improved = true;

  if (regressed) return "REGRESSED";
  if (requiresReview) return "REVIEW_REQUIRED";
  if (improved) return "IMPROVED";
  return "UNCHANGED";
}
