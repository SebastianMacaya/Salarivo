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
  classifier: "6",
  extractor: "6",
  parser: "6",
  normalizer: "6",
  resultSchema: "1",
} as const;

export const currentPipelineFingerprint = createHash("sha256")
  .update(JSON.stringify(processingPipelineVersions))
  .digest("hex");

export const parserFixCatalog = [
  {
    issueCode: "LABEL_OR_LAYOUT_NOT_RECOGNIZED",
    affectedFieldPath: "settlement.basicAmount",
    introducedInParserVersion: "6",
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
