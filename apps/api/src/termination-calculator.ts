import { formatAmount, parseAmount, roundDivide, type SalarySettlement } from "./salary-analytics.ts";

export interface LegalRuleVersion {
  code: string;
  version: string;
  countryCode: string;
  subdivisionCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reviewedAt: string;
  references: readonly { name: string; url: string }[];
  reviewRequiredPeriods?: readonly { from: string; to: string; reason: string }[];
}

export interface CollectiveAgreementVersion {
  version: string;
  cctCode: string;
  category?: string | null;
  effectiveFrom: string;
  effectiveTo: string;
  sourceUrl: string;
  capAmount: string;
  probationMonths?: 6 | 8 | 12;
  noticeMonths?: number;
  annualVacationDays?: number;
  terminationSystem?: "STANDARD" | "CESSATION_FUND";
}

export interface TerminationOverrides {
  startDate?: string;
  monthlyRemuneration?: string;
  cctCode?: string;
  cctCategory?: string;
  cctCapVersion?: CollectiveAgreementVersion;
  probationWaived?: boolean;
  employerEmployeeCount?: number;
  vacationDaysTaken?: string;
  priorVacationDays?: string;
  sacAlreadyPaid?: string;
}

export interface TerminationEmployment {
  id: string;
  employerName: string;
  countryCode: string | null;
  currencyCode: string;
  subdivisionCode?: string | null;
  legalRegimeCode?: string | null;
  countryConfirmedAt?: string | null;
  startDate: string | null;
  startDateSource?: "CONFIRMED" | "EXTRACTED" | "UNKNOWN";
  cctCode?: string | null;
  cctCategory?: string | null;
}

export interface TerminationSalarySettlement extends SalarySettlement {
  /** Issue/payment date, when available; never the upload timestamp. */
  knownOn?: string | null;
}

export interface TerminationInput {
  employment: TerminationEmployment;
  terminationDate: string;
  today: string;
  terminationType?: string;
  settlements: readonly TerminationSalarySettlement[];
  overrides?: TerminationOverrides;
}

export interface SalaryConceptTrace {
  documentId: string;
  settlementId: string;
  period: string;
  code: string;
  amount: string;
  treatment: "INCLUDED" | "EXCLUDED" | "AVERAGED" | "REVIEW_REQUIRED";
  explanation: string;
}

export interface TerminationSalaryBase {
  amount: string | null;
  currentMonthlyRemuneration: string | null;
  vacationMonthlyRemuneration: string | null;
  selectedPeriod: string | null;
  source: "DOCUMENTS" | "SIMULATION_OVERRIDE" | "UNAVAILABLE";
  analyzedDocumentIds: string[];
  analyzedSettlementIds: string[];
  analyzedPeriods: string[];
  missingPeriods: string[];
  variableAverage: { sixMonths: string | null; twelveMonths: string | null; selected: string };
  trace: SalaryConceptTrace[];
}

export interface TerminationBreakdownLine {
  code: "SENIORITY" | "NOTICE" | "MONTH_INTEGRATION" | "EARNED_SALARY" | "PROPORTIONAL_SAC" | "UNUSED_VACATION" | "SAC_ON_NOTICE" | "SAC_ON_INTEGRATION";
  name: string;
  amount: string;
  explanation: string;
  ruleOrigin: string;
}

export interface TerminationScenario {
  code: "WITH_NOTICE" | "WITHOUT_NOTICE";
  total: string;
  breakdown: TerminationBreakdownLine[];
  notice: { unit: "MONTHS" | "DAYS"; value: number; fulfilled: "FULL" | "NONE" };
}

export interface TerminationEstimate {
  status: "AVAILABLE" | "UNAVAILABLE" | "UNSUPPORTED";
  currencyCode: string;
  legalRuleVersion: LegalRuleVersion | null;
  calculationVersion: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  warnings: string[];
  assumptions: string[];
  disclaimer: string;
  salaryBase: TerminationSalaryBase;
  scenarios: TerminationScenario[];
  inputs: {
    employment: TerminationEmployment;
    startDate: string | null;
    startDateSource: "CONFIRMED" | "EXTRACTED" | "UNKNOWN" | "SIMULATION_OVERRIDE";
    terminationDate: string;
    today: string;
    terminationType: string;
    isProjection: boolean;
    seniority: { years: number; months: number; days: number; indemnityYears: number } | null;
    probation: { months: number; applies: boolean } | null;
    cappedSalaryBase: string | null;
    capFloorApplied: boolean;
    collectiveAgreement: (CollectiveAgreementVersion & { source: "CATALOG" | "SIMULATION_OVERRIDE" }) | null;
    overrides: TerminationOverrides;
    salaryInputs: readonly Omit<TerminationSalarySettlement, "netAmount" | "deductionsAmount">[];
  };
}

const LCT = "https://www.argentina.gob.ar/normativa/nacional/ley-20744-25552/actualizacion";
const BASES = "https://www.argentina.gob.ar/normativa/nacional/ley-27742-401266/texto";
const REFORM = "https://www.argentina.gob.ar/normativa/nacional/ley-27802-423680/texto";
const LEGACY = "https://www.argentina.gob.ar/normativa/nacional/ley-25877-93595/texto";
const VIZZOTI = "https://sj.csjn.gov.ar/homeSJ/suplementos/suplemento/67/documento";
const REVIEWED_AT = "2026-09-05";
const references = Object.freeze([
  Object.freeze({ name: "LCT 20.744, arts. 92 bis, 123, 150, 155–156, 231–233 y 245", url: LCT }),
  Object.freeze({ name: "Ley 25.877, arts. 2–5; régimen anterior a las reformas", url: LEGACY }),
  Object.freeze({ name: "CSJN, Vizzoti, 14/09/2004, Fallos 327:3677", url: VIZZOTI }),
]);

/** Append a version when legislation changes; never rewrite an effective historical version. */
export const TERMINATION_LEGAL_RULES: readonly LegalRuleVersion[] = Object.freeze([
  Object.freeze({ code: "AR_LCT_GENERAL", version: "2023-01-01", countryCode: "AR", subdivisionCode: null,
    effectiveFrom: "2023-01-01", effectiveTo: "2024-07-08", reviewedAt: REVIEWED_AT, references }),
  Object.freeze({ code: "AR_LCT_GENERAL", version: "2024-07-09", countryCode: "AR", subdivisionCode: null,
    effectiveFrom: "2024-07-09", effectiveTo: "2026-03-05", reviewedAt: REVIEWED_AT,
    references: Object.freeze([...references, Object.freeze({ name: "Ley 27.742, arts. 91, 96 y 237", url: BASES }),
      Object.freeze({ name: "Decreto 847/2024, anexo II, art. 4 (fecha de contratación)", url: "https://www.argentina.gob.ar/normativa/nacional/decreto-847-2024-404509/texto" })]) }),
  Object.freeze({ code: "AR_LCT_GENERAL", version: "2026-03-06", countryCode: "AR", subdivisionCode: null,
    effectiveFrom: "2026-03-06", effectiveTo: null, reviewedAt: REVIEWED_AT,
    references: Object.freeze([...references, Object.freeze({ name: "Ley 27.802, arts. 48, 51 y 217", url: REFORM }),
      Object.freeze({ name: "Cautelar del 30/03/2026, CNT 10308/2026; BO 06/04/2026, pp. 81–89", url: "https://otslist.boletinoficial.gob.ar/ots/download/02e1923e56b278dee85803d3e8dfc8e8c9030e1f321c21363f00455b314fb60c/0/" }),
      Object.freeze({ name: "CNAT Sala VIII, 23/04/2026, efecto suspensivo; sentencia primaria republicada", url: "https://abogados.com.ar/archivos/2026-04-23-041426-rescamara.pdf" })]),
    reviewRequiredPeriods: Object.freeze([Object.freeze({ from: "2026-03-30", to: "2026-04-22",
      reason: "La fecha coincide con la cautelar que suspendió disposiciones de la Ley 27.802. Se requiere revisar su aplicación temporal al caso; no se devuelve un monto con reglas inciertas." })]) }),
]);

/** No verified cap dataset is bundled. Never seed illustrative caps into production. */
export const COLLECTIVE_AGREEMENT_VERSIONS: readonly CollectiveAgreementVersion[] = Object.freeze([]);

export function resolveTerminationRule(countryCode: string | null, regimeCode: string | null | undefined,
  terminationDate: string, subdivisionCode?: string | null): LegalRuleVersion | null {
  date(terminationDate);
  if (subdivisionCode && !subdivisionCode.startsWith(`${countryCode}-`)) return null;
  return TERMINATION_LEGAL_RULES.find(rule => rule.countryCode === countryCode
    && rule.code === regimeCode && terminationDate >= rule.effectiveFrom
    && (rule.effectiveTo === null || terminationDate <= rule.effectiveTo)) ?? null;
}

function date(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("INVALID_TERMINATION_DATE");
  const result = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value
    || Number(value.slice(0, 4)) < 1900 || Number(value.slice(0, 4)) > 2199) {
    throw new TypeError("INVALID_TERMINATION_DATE");
  }
  return result;
}

function monthLength(period: string): number {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
}

function monthEnd(period: string): string { return `${period}-${monthLength(period)}`; }
function iso(value: Date): string { return value.toISOString().slice(0, 10); }

function addMonths(value: string, months: number): string {
  const original = date(value);
  const result = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth() + months, 1));
  result.setUTCDate(Math.min(original.getUTCDate(), monthLength(iso(result).slice(0, 7))));
  return iso(result);
}

function daysBetween(from: string, to: string): number { return (date(to).getTime() - date(from).getTime()) / 86_400_000; }
function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }

function money(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (!/^-?\d{1,18}(?:\.\d{1,2})?$/.test(value)) throw new TypeError("INVALID_TERMINATION_AMOUNT");
  return parseAmount(value, "terminationAmount");
}

function positiveMoney(value: string, allowZero = false): bigint {
  const amount = money(value);
  if (amount === null || amount < 0n || (!allowZero && amount === 0n)) throw new TypeError("INVALID_TERMINATION_AMOUNT");
  return amount;
}

function periods(from: string, to: string): string[] {
  const result: string[] = [];
  for (let current = `${from.slice(0, 7)}-01`; current.slice(0, 7) <= to.slice(0, 7); current = addMonths(current, 1)) {
    result.push(current.slice(0, 7));
  }
  return result;
}

function validateOverrides(overrides: TerminationOverrides): void {
  if (overrides.startDate !== undefined) date(overrides.startDate);
  if (overrides.monthlyRemuneration !== undefined) positiveMoney(overrides.monthlyRemuneration);
  if (overrides.sacAlreadyPaid !== undefined) positiveMoney(overrides.sacAlreadyPaid, true);
  for (const value of [overrides.vacationDaysTaken, overrides.priorVacationDays]) {
    if (value !== undefined && positiveMoney(value, true) > 36600n) throw new TypeError("INVALID_VACATION_DAYS");
  }
  if (overrides.probationWaived !== undefined && typeof overrides.probationWaived !== "boolean") throw new TypeError("INVALID_PROBATION");
  if (overrides.employerEmployeeCount !== undefined && (!Number.isSafeInteger(overrides.employerEmployeeCount)
    || overrides.employerEmployeeCount < 1 || overrides.employerEmployeeCount > 10_000_000)) throw new TypeError("INVALID_EMPLOYER_SIZE");
  for (const value of [overrides.cctCode, overrides.cctCategory]) {
    if (value !== undefined && (!value.trim() || value.length > 100 || /[\u0000-\u001f]/.test(value))) throw new TypeError("INVALID_CCT");
  }
  if (overrides.cctCapVersion !== undefined) validateAgreement(overrides.cctCapVersion);
}

function validateAgreement(agreement: CollectiveAgreementVersion): void {
  date(agreement.effectiveFrom); date(agreement.effectiveTo);
  if (agreement.effectiveTo < agreement.effectiveFrom) throw new TypeError("INVALID_CCT_VALIDITY");
  for (const value of [agreement.version, agreement.cctCode, agreement.category ?? "category"]) {
    if (!value || value.length > 100 || /[\u0000-\u001f]/.test(value)) throw new TypeError("INVALID_CCT");
  }
  let source: URL;
  try { source = new URL(agreement.sourceUrl); } catch { throw new TypeError("INVALID_CCT_SOURCE"); }
  if (source.protocol !== "https:" || source.username || source.password || agreement.sourceUrl.length > 2048) throw new TypeError("INVALID_CCT_SOURCE");
  positiveMoney(agreement.capAmount);
  if (agreement.probationMonths !== undefined && ![6, 8, 12].includes(agreement.probationMonths)) throw new TypeError("INVALID_PROBATION");
  for (const [value, limit] of [[agreement.noticeMonths, 12], [agreement.annualVacationDays, 366]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > limit)) throw new TypeError("INVALID_CCT_RULE");
  }
  if (agreement.terminationSystem !== undefined && !["STANDARD", "CESSATION_FUND"].includes(agreement.terminationSystem)) throw new TypeError("INVALID_CCT_RULE");
}

function seniority(start: string, end: string): NonNullable<TerminationEstimate["inputs"]["seniority"]> {
  let years = Number(end.slice(0, 4)) - Number(start.slice(0, 4));
  if (addMonths(start, years * 12) > end) years -= 1;
  const anniversary = addMonths(start, years * 12);
  let months = 0;
  while (months < 11 && addMonths(anniversary, months + 1) <= end) months += 1;
  return { years, months, days: daysBetween(addMonths(anniversary, months), end),
    indemnityYears: Math.max(1, years + (end > addMonths(anniversary, 3) ? 1 : 0)) };
}

interface SalaryMonth {
  period: string;
  fixed: bigint;
  variables: Map<string, bigint>;
  remuneration: bigint;
  usable: boolean;
  projected: boolean;
}

const FIXED_CODES = new Set(["BASIC_SALARY", "BASICO", "SENIORITY", "ANTIGUEDAD", "ATTENDANCE", "ADDITIONAL", "ADICIONAL"]);
const VARIABLE_CODES = new Set(["OVERTIME", "HORAS_EXTRA", "COMMISSION", "COMISION", "MONTHLY_BONUS"]);
const NON_MONTHLY_CODES = new Set(["SAC", "AGUINALDO", "VACATION", "VACACIONES", "ANNUAL_BONUS", "REIMBURSEMENT", "REINTEGRO", "NON_REMUNERATIVE", "NO_REMUNERATIVO", "RETROACTIVE", "RETROACTIVO"]);

function salaryMonths(input: TerminationInput, result: TerminationEstimate): SalaryMonth[] {
  const cutoff = input.terminationDate < input.today ? input.terminationDate : input.today;
  const start = result.inputs.startDate!;
  const from = addMonths(`${cutoff.slice(0, 7)}-01`, -12);
  const byPeriod = new Map<string, SalaryMonth>();
  const normalCount = new Map<string, number>();
  const snapshot: Omit<TerminationSalarySettlement, "netAmount" | "deductionsAmount">[] = [];
  const seen = new Set<string>();
  for (const settlement of [...input.settlements].sort((a, b) => a.payrollPeriod.localeCompare(b.payrollPeriod) || a.id.localeCompare(b.id))) {
    if (settlement.employmentId !== input.employment.id || settlement.currencyCode !== input.employment.currencyCode) continue;
    if (!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(settlement.payrollPeriod)) throw new TypeError("INVALID_PAYROLL_PERIOD");
    const period = settlement.payrollPeriod.slice(0, 7);
    if (period < from.slice(0, 7) || period < start.slice(0, 7) || period > cutoff.slice(0, 7)) continue;
    if (settlement.knownOn) { date(settlement.knownOn); if (settlement.knownOn > cutoff) continue; }
    if (monthEnd(period) > cutoff) continue;
    if (seen.has(settlement.id)) continue;
    seen.add(settlement.id);
    const { netAmount: _net, deductionsAmount: _deductions, ...salaryInput } = settlement;
    snapshot.push(salaryInput);
    result.salaryBase.analyzedDocumentIds.push(settlement.documentId);
    result.salaryBase.analyzedSettlementIds.push(settlement.id);
    const month = byPeriod.get(period) ?? { period, fixed: 0n, variables: new Map<string, bigint>(), remuneration: 0n, usable: true, projected: false };
    const extraType = !["NORMAL", "HORAS_EXTRA", "OVERTIME", "COMISION", "COMMISSION"].includes(settlement.settlementType);
    const trace = (code: string, amount: bigint, treatment: SalaryConceptTrace["treatment"], explanation: string) =>
      result.salaryBase.trace.push({ documentId: settlement.documentId, settlementId: settlement.id, period, code, amount: formatAmount(amount), treatment, explanation });
    if (extraType) {
      trace(settlement.settlementType, money(settlement.remunerativeAmount ?? settlement.grossAmount) ?? 0n, "EXCLUDED", "Liquidación no mensual: no integra la base del artículo 245.");
      // SAC accrual includes remunerative extraordinary pay, except SAC itself and compensation/reimbursements.
      if (["BONO", "VACACIONES", "RETROACTIVO", "AJUSTE"].includes(settlement.settlementType)) {
        month.remuneration += money(settlement.remunerativeAmount) ?? 0n;
        byPeriod.set(period, month);
      }
      continue;
    }
    if (settlement.settlementType === "NORMAL") normalCount.set(period, (normalCount.get(period) ?? 0) + 1);
    const remunerative = money(settlement.remunerativeAmount);
    const nonRemunerative = money(settlement.nonRemunerativeAmount);
    const gross = money(settlement.grossAmount);
    const earnings = settlement.earnings ?? [];
    const earningsTotal = earnings.reduce((sum, item) => sum + (money(item.amount) ?? 0n), 0n);
    const knownRemunerative = remunerative ?? (nonRemunerative === 0n ? gross : null);
    if (knownRemunerative !== null) month.remuneration += knownRemunerative;
    if (earnings.length === 0) {
      if (knownRemunerative !== null && knownRemunerative > 0n && settlement.settlementType === "NORMAL") {
        month.fixed += knownRemunerative;
        trace("REMUNERATIVE_TOTAL", knownRemunerative, "REVIEW_REQUIRED", "Total remunerativo mensual sin conceptos suficientes: revisar que no incluya pagos extraordinarios o variables.");
        result.warnings.push("Falta el detalle de conceptos de algunos recibos: se supone que su total remunerativo es mensual, normal y habitual.");
      } else {
        month.usable = false;
        trace("MISSING_REMUNERATIVE", 0n, "REVIEW_REQUIRED", "No hay remuneración bruta clasificable. El neto nunca se utiliza.");
      }
      byPeriod.set(period, month);
      continue;
    }
    const completeRemunerative = knownRemunerative !== null && earningsTotal === knownRemunerative
      && (nonRemunerative === null || nonRemunerative === 0n);
    if (!completeRemunerative) {
      month.usable = false;
      result.warnings.push("Hay conceptos sin atribución remunerativa inequívoca o un detalle que no concilia. Revisá el recibo o ingresá una remuneración para esta simulación.");
    }
    for (const earning of earnings) {
      const amount = money(earning.amount) ?? 0n;
      const code = earning.code.toUpperCase();
      if (!completeRemunerative) { trace(code, amount, "REVIEW_REQUIRED", "El detalle no permite separar o conciliar los conceptos remunerativos."); continue; }
      if (amount < 0n) { month.usable = false; trace(code, amount, "REVIEW_REQUIRED", "Ajuste negativo: requiere confirmar la base mensual."); continue; }
      if (code === "BONUS" && earning.isRecurring !== true) {
        // The parser's generic BONUS flag does not distinguish monthly awards from annual bonuses.
        month.usable = false;
        trace(code, amount, "REVIEW_REQUIRED", "Bono o premio de un recibo mensual sin periodicidad inequívoca: requiere revisar si integra la remuneración habitual.");
        result.warnings.push("Hay bonos o premios de recibos mensuales cuya periodicidad no está confirmada. Revisá su clasificación o ingresá una remuneración bruta para esta simulación.");
      } else if (NON_MONTHLY_CODES.has(code)) {
        trace(code, amount, "EXCLUDED", "Concepto no mensual, no remunerativo o reintegro: excluido de la base por antigüedad.");
      } else if (VARIABLE_CODES.has(code) || (code === "BONUS" && earning.isRecurring === true)) {
        month.variables.set(code, (month.variables.get(code) ?? 0n) + amount);
        trace(code, amount, "INCLUDED", "Concepto variable remunerativo; su tratamiento se resuelve con la versión legal y la cobertura mensual.");
      } else if (FIXED_CODES.has(code) || earning.isRecurring === true) {
        month.fixed += amount;
        trace(code, amount, "INCLUDED", "Concepto remunerativo mensual recurrente incluido; la clasificación requiere revisión si no refleja el recibo.");
      } else {
        month.usable = false;
        trace(code, amount, "REVIEW_REQUIRED", "Concepto sin clasificación mensual/habitual: no se fuerza una base legal.");
        result.warnings.push("Hay conceptos cuya normalidad o habitualidad requiere confirmación.");
      }
    }
    byPeriod.set(period, month);
  }
  for (const [period, count] of normalCount) {
    if (count > 1) {
      byPeriod.get(period)!.usable = false;
      result.warnings.push("Hay más de una liquidación normal en un período: resolvé la posible duplicación antes de usarla como base.");
    }
  }
  result.inputs.salaryInputs = snapshot;
  result.salaryBase.analyzedDocumentIds = [...new Set(result.salaryBase.analyzedDocumentIds)];
  result.salaryBase.analyzedPeriods = [...byPeriod.keys()].sort();
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function resolveSalary(input: TerminationInput, result: TerminationEstimate, months: SalaryMonth[]): void {
  const override = input.overrides?.monthlyRemuneration;
  const usable = months.filter(month => month.usable && (month.fixed > 0n || month.variables.size > 0));
  const latest = usable.at(-1);
  const cutoff = input.terminationDate < input.today ? input.terminationDate : input.today;
  const lastCompletedPeriod = monthEnd(cutoff.slice(0, 7)) === cutoff ? cutoff.slice(0, 7) : addMonths(`${cutoff.slice(0, 7)}-01`, -1).slice(0, 7);
  const expectedStart = addMonths(`${lastCompletedPeriod}-01`, -11);
  const expected = periods(expectedStart > result.inputs.startDate! ? expectedStart : result.inputs.startDate!, `${lastCompletedPeriod}-01`);
  result.salaryBase.missingPeriods = expected.filter(period => !usable.some(month => month.period === period));
  if (result.salaryBase.missingPeriods.length > 0) result.warnings.push("Faltan meses completos o clasificables del historial: completá recibos para revisar la mejor remuneración y los componentes variables.");
  if (usable.length < 6) result.warnings.push("No hay seis meses de recibos clasificables para acreditar la habitualidad de todos los conceptos.");
  if (latest && latest.period < lastCompletedPeriod) result.warnings.push("La última remuneración disponible es anterior al último mes completo: revisá si sigue vigente.");
  if (override !== undefined) {
    result.salaryBase.amount = formatAmount(positiveMoney(override));
    result.salaryBase.currentMonthlyRemuneration = result.salaryBase.amount;
    result.salaryBase.vacationMonthlyRemuneration = result.salaryBase.amount;
    result.salaryBase.source = "SIMULATION_OVERRIDE";
    result.salaryBase.selectedPeriod = null;
    result.assumptions.push("La remuneración ingresada se usa como base mensual bruta de esta simulación; los documentos originales conservan sus datos.");
    return;
  }
  if (!latest) {
    result.warnings.push("No se pudo reconstruir una remuneración bruta mensual. Agregá recibos remunerativos completos o ingresá un override de simulación.");
    return;
  }
  const variableTotal = (month: SalaryMonth) => [...month.variables.values()].reduce((sum, value) => sum + value, 0n);
  const lastAmount = latest.fixed + variableTotal(latest);
  result.salaryBase.currentMonthlyRemuneration = formatAmount(lastAmount);
  result.salaryBase.source = "DOCUMENTS";
  const referencePeriod = monthEnd(input.terminationDate.slice(0, 7)) === input.terminationDate
    ? input.terminationDate.slice(0, 7) : addMonths(`${input.terminationDate.slice(0, 7)}-01`, -1).slice(0, 7);
  const candidates = [...usable];
  if (result.inputs.isProjection) {
    const projectionStart = addMonths(`${lastCompletedPeriod}-01`, 1);
    for (const period of periods(projectionStart, `${referencePeriod}-01`)) {
      if (!candidates.some(month => month.period === period)) candidates.push({ ...latest, period, projected: true });
    }
  }
  const windowStart = addMonths(`${referencePeriod}-01`, -11).slice(0, 7);
  const annual = candidates.filter(month => month.period >= windowStart && month.period <= referencePeriod);
  if (annual.length === 0) annual.push(latest);
  const sixStart = addMonths(`${referencePeriod}-01`, -5).slice(0, 7);
  const six = annual.filter(month => month.period >= sixStart);
  // Missing months are never counted as zero: averages use observed months and lower completeness.
  const average = (window: SalaryMonth[], codes?: Set<string>) => window.length === 0 ? null : roundDivide(window.reduce((sum, month) => sum
    + [...month.variables].reduce((total, [code, value]) => total + (!codes || codes.has(code) ? value : 0n), 0n), 0n), BigInt(window.length));
  const vacationSix = average(six) ?? 0n;
  const yearWindow = annual.filter(month => month.period.slice(0, 4) === input.terminationDate.slice(0, 4));
  const vacationYear = average(yearWindow) ?? vacationSix;
  result.salaryBase.vacationMonthlyRemuneration = formatAmount(latest.fixed + max(vacationSix, vacationYear));
  const newRule = result.legalRuleVersion!.effectiveFrom >= "2026-03-06";
  let variableAverage = 0n;
  if (newRule) {
    const occurrences = new Map<string, number>();
    for (const month of annual) for (const [code, amount] of month.variables) {
      if (amount > 0n) occurrences.set(code, (occurrences.get(code) ?? 0) + 1);
    }
    const habitualCodes = new Set([...occurrences].filter(([, count]) => count >= 6).map(([code]) => code));
    const sixAverage = average(six, habitualCodes);
    const annualAverage = average(annual, habitualCodes);
    variableAverage = max(sixAverage ?? 0n, annualAverage ?? 0n);
    result.salaryBase.variableAverage = { sixMonths: sixAverage === null ? null : formatAmount(sixAverage),
      twelveMonths: annualAverage === null ? null : formatAmount(annualAverage), selected: formatAmount(variableAverage) };
    for (const entry of result.salaryBase.trace) {
      if (!occurrences.has(entry.code) || entry.treatment !== "INCLUDED") continue;
      entry.treatment = habitualCodes.has(entry.code) ? "AVERAGED" : "EXCLUDED";
      entry.explanation = habitualCodes.has(entry.code)
        ? "Variable habitual: promedio de los últimos seis o doce meses, el más favorable (art. 245, Ley 27.802)."
        : "No se acreditan seis meses de devengamiento de este variable en el último año; excluido bajo la versión 2026. Revisá la cobertura.";
    }
    if ([...occurrences].some(([, count]) => count < 6)) result.warnings.push("Algunos conceptos variables no acreditan seis meses de habitualidad y quedaron excluidos de antigüedad; completá o revisá los recibos.");
  }
  let selected = annual[0]!;
  const baseFor = (month: SalaryMonth) => month.fixed + (newRule ? variableAverage : variableTotal(month));
  for (const month of annual) if (baseFor(month) >= baseFor(selected)) selected = month;
  if (baseFor(selected) > 0n) result.salaryBase.amount = formatAmount(baseFor(selected));
  result.salaryBase.selectedPeriod = selected.period;
  if (!newRule && annual.some(month => month.variables.size > 0)) result.assumptions.push("La versión anterior a marzo de 2026 toma el mejor mes normal y habitual observado, sin aplicar retroactivamente el promedio legal nuevo.");
  if (newRule) result.assumptions.push("La habitualidad se evalúa en la ventana móvil del último año hasta el egreso; la clasificación recurrente de conceptos fijos requiere que el recibo sea correcto.");
}

export function calculateTerminationEstimate(input: TerminationInput,
  collectiveAgreements: readonly CollectiveAgreementVersion[] = COLLECTIVE_AGREEMENT_VERSIONS): TerminationEstimate {
  date(input.terminationDate); date(input.today);
  const overrides = input.overrides ?? {};
  validateOverrides(overrides);
  const startDate = overrides.startDate ?? input.employment.startDate;
  if (startDate !== null) { date(startDate); if (startDate > input.terminationDate) throw new TypeError("TERMINATION_BEFORE_START"); }
  if (!/^[A-Z]{3}$/.test(input.employment.currencyCode)) throw new TypeError("INVALID_TERMINATION_CURRENCY");
  const rule = resolveTerminationRule(input.employment.countryCode, input.employment.legalRegimeCode,
    input.terminationDate, input.employment.subdivisionCode);
  const result: TerminationEstimate = {
    status: "UNAVAILABLE", currencyCode: input.employment.currencyCode, legalRuleVersion: rule,
    calculationVersion: "termination-estimate-v1", confidence: "LOW", warnings: [], assumptions: [],
    disclaimer: "Estimación informativa basada en los datos disponibles y la normativa configurada en Salarivo. El monto real puede variar según convenio, régimen, conceptos salariales, circunstancias de la desvinculación y cambios normativos.",
    salaryBase: { amount: null, currentMonthlyRemuneration: null, vacationMonthlyRemuneration: null, selectedPeriod: null,
      source: "UNAVAILABLE", analyzedDocumentIds: [], analyzedSettlementIds: [], analyzedPeriods: [], missingPeriods: [],
      variableAverage: { sixMonths: null, twelveMonths: null, selected: "0.00" }, trace: [] }, scenarios: [],
    inputs: { employment: structuredClone(input.employment), startDate,
      startDateSource: overrides.startDate ? "SIMULATION_OVERRIDE" : input.employment.startDateSource ?? "UNKNOWN",
      terminationDate: input.terminationDate, today: input.today,
      terminationType: input.terminationType ?? "DISMISSAL_WITHOUT_CAUSE", isProjection: input.terminationDate > input.today,
      seniority: null, probation: null, cappedSalaryBase: null, capFloorApplied: false, collectiveAgreement: null,
      overrides: structuredClone(overrides), salaryInputs: [] },
  };
  if (!rule || result.currencyCode !== "ARS" || result.inputs.terminationType !== "DISMISSAL_WITHOUT_CAUSE") {
    result.status = "UNSUPPORTED";
    result.warnings.push("No hay reglas verificadas para este país, jurisdicción, régimen, moneda, modalidad o fecha. Seleccioná el régimen real del empleo; no se aplica Argentina automáticamente.");
    return result;
  }
  const historicalReview = rule.reviewRequiredPeriods?.find(period => period.from <= input.terminationDate && period.to >= input.terminationDate);
  if (historicalReview) { result.warnings.push(historicalReview.reason); return result; }
  if (!input.employment.countryConfirmedAt) result.warnings.push("Confirmá el país del empleo antes de interpretar esta estimación como correspondiente a su jurisdicción.");
  if (!startDate) { result.warnings.push("Confirmá la fecha de ingreso o ingresá otra para esta simulación."); return result; }
  if (result.inputs.startDateSource !== "CONFIRMED" && result.inputs.startDateSource !== "SIMULATION_OVERRIDE") result.warnings.push("La fecha de ingreso no está confirmada: revisala porque determina antigüedad, preaviso y vacaciones.");
  const cctCode = overrides.cctCode ?? overrides.cctCapVersion?.cctCode ?? input.employment.cctCode;
  const cctCategory = overrides.cctCategory ?? input.employment.cctCategory ?? null;
  const agreements = overrides.cctCapVersion ? [overrides.cctCapVersion] : collectiveAgreements;
  const applicable = agreements.filter(agreement => agreement.cctCode === cctCode
    && (!agreement.category || agreement.category === cctCategory)
    && agreement.effectiveFrom <= input.terminationDate && agreement.effectiveTo >= input.terminationDate);
  applicable.forEach(validateAgreement);
  if (applicable.length === 1) result.inputs.collectiveAgreement = { ...applicable[0]!, source: overrides.cctCapVersion ? "SIMULATION_OVERRIDE" : "CATALOG" };
  else result.warnings.push("Estimación sin tope de convenio confirmado. Completá el convenio, categoría, tope, vigencia y fuente para revisarlo.");
  const agreement = result.inputs.collectiveAgreement;
  if (overrides.cctCapVersion && !agreement) result.warnings.push("El tope ingresado no coincide con el convenio/categoría o no está vigente en la fecha de egreso; no se aplicó.");
  if (agreement?.source === "SIMULATION_OVERRIDE") result.warnings.push("El convenio y tope son un override proporcionado para la simulación; Salarivo no verificó su fuente ni su aplicabilidad.");
  if (agreement?.terminationSystem === "CESSATION_FUND") {
    result.status = "UNSUPPORTED"; result.warnings.push("Este convenio declara un fondo o sistema de cese: requiere sus reglas específicas y no admite la fórmula general de antigüedad."); return result;
  }
  result.inputs.seniority = seniority(startDate, input.terminationDate);
  let probationMonths = startDate < "2024-07-09" ? 3 : 6;
  if (agreement?.probationMonths && agreement.probationMonths > probationMonths) {
    const count = overrides.employerEmployeeCount;
    const validExtension = startDate >= "2024-07-09" && count !== undefined
      && (agreement.probationMonths === 8 ? count <= 100 && count >= 6 : agreement.probationMonths === 12 && count <= 5);
    if (!validExtension) { result.warnings.push("La ampliación convencional del período de prueba requiere tamaño de empresa compatible y contratación desde el 09/07/2024."); return result; }
    probationMonths = agreement.probationMonths;
  }
  const inProbation = !overrides.probationWaived && input.terminationDate < addMonths(startDate, probationMonths);
  result.inputs.probation = { months: probationMonths, applies: inProbation };
  if (inProbation) result.assumptions.push("Se supone un período de prueba válido y empleo registrado, sin contratación previa a prueba ni renuncia del empleador. Podés indicar que el período no aplica.");
  const months = salaryMonths(input, result);
  resolveSalary(input, result, months);
  const base = money(result.salaryBase.amount);
  const current = money(result.salaryBase.currentMonthlyRemuneration);
  if (current === null || (base === null && !inProbation)) return result;
  if (result.inputs.isProjection) {
    result.assumptions.push(overrides.monthlyRemuneration ? "Esta proyección mantiene la remuneración ingresada para la simulación."
      : "Esta simulación supone que tu remuneración se mantiene igual a la última conocida.");
    result.warnings.push("La fecha es futura: se aplican las reglas publicadas y revisadas, sin anticipar cambios normativos posteriores.");
  }
  const rawBase = base ?? current;
  const cap = agreement ? positiveMoney(agreement.capAmount) : rawBase;
  const floor = roundDivide(rawBase * 67n, 100n);
  const cappedBase = max(min(rawBase, cap), floor);
  result.inputs.cappedSalaryBase = formatAmount(cappedBase);
  result.inputs.capFloorApplied = cap < floor;
  const indemnity = inProbation ? 0n : max(cappedBase * BigInt(result.inputs.seniority.indemnityYears),
    rule.effectiveFrom < "2026-03-06" ? rawBase : cappedBase);
  const moreThanFive = input.terminationDate > addMonths(startDate, 60);
  const notice = inProbation ? { unit: "DAYS" as const, value: rule.effectiveFrom >= "2026-03-06" ? 0 : 15 }
    : { unit: "MONTHS" as const, value: Math.max(moreThanFive ? 2 : 1, agreement?.noticeMonths ?? 0) };
  const period = input.terminationDate.slice(0, 7);
  const monthDays = monthLength(period);
  const employmentDay = startDate.slice(0, 7) === period ? Number(startDate.slice(8, 10)) : 1;
  const elapsedDays = Number(input.terminationDate.slice(8, 10));
  const earned = roundDivide(current * BigInt(elapsedDays - employmentDay + 1), BigInt(monthDays));
  const integration = inProbation ? 0n : roundDivide(current * BigInt(monthDays - elapsedDays), BigInt(monthDays));
  const year = input.terminationDate.slice(0, 4);
  const semesterStart = `${year}-${Number(period.slice(5, 7)) <= 6 ? "01" : "07"}-01`;
  const accrualStart = startDate > semesterStart ? startDate : semesterStart;
  let semesterRemuneration = 0n;
  let inferredSac = false;
  for (const accrualPeriod of periods(accrualStart, input.terminationDate)) {
    if (accrualPeriod === period) { semesterRemuneration += earned; continue; }
    const observed = months.find(month => month.period === accrualPeriod && month.usable);
    if (observed) semesterRemuneration += observed.remuneration;
    else {
      const firstDay = startDate.slice(0, 7) === accrualPeriod ? Number(startDate.slice(8, 10)) : 1;
      semesterRemuneration += roundDivide(current * BigInt(monthLength(accrualPeriod) - firstDay + 1), BigInt(monthLength(accrualPeriod)));
      inferredSac = true;
    }
  }
  if (inferredSac) result.warnings.push("Faltan remuneraciones del semestre: el SAC usa la remuneración mensual de la simulación en esos meses. Completá los recibos para reemplazar ese supuesto.");
  const proportionalSac = max(0n, roundDivide(semesterRemuneration, 12n) - (money(overrides.sacAlreadyPaid) ?? 0n));
  const vacationReference = `${year}-12-31`;
  const statutoryVacation = vacationReference <= addMonths(startDate, 60) ? 14 : vacationReference <= addMonths(startDate, 120) ? 21
    : vacationReference <= addMonths(startDate, 240) ? 28 : 35;
  const annualVacation = Math.max(statutoryVacation, agreement?.annualVacationDays ?? 0);
  const vacationStart = startDate > `${year}-01-01` ? startDate : `${year}-01-01`;
  const workedDays = daysBetween(vacationStart, input.terminationDate) + 1;
  const yearDays = monthLength(`${year}-02`) === 29 ? 366 : 365;
  const takenHundredths = money(overrides.vacationDaysTaken) ?? 0n;
  const priorHundredths = money(overrides.priorVacationDays) ?? 0n;
  const vacationDayNumerator = max(0n, BigInt(annualVacation * workedDays * 100) - takenHundredths * BigInt(yearDays)) + priorHundredths * BigInt(yearDays);
  const vacationBase = money(result.salaryBase.vacationMonthlyRemuneration) ?? current;
  const vacation = roundDivide(vacationBase * vacationDayNumerator, BigInt(25 * yearDays * 100));
  result.assumptions.push("Importes brutos antes de retenciones; salario del mes pendiente de pago. Los días de sueldo e integración se prorratean por días calendario reales del mes.",
    "Vacaciones proporcionales por días calendario de servicio del año, sin ausencias que reduzcan el derecho; divisor 25. Revisá días ya gozados y saldos anteriores.",
    "SAC proporcional: doceava parte de la remuneración devengada en el semestre, menos el SAC ya pagado que indiques (art. 123).",
    "Se incluye incidencia SAC sobre preaviso e integración como criterio indemnizatorio (arts. 232–233); no SAC sobre vacaciones indemnizadas, cuya procedencia puede depender del criterio judicial.",
    "No se cuantifican agravantes por tutela especial, discriminación, multas, intereses, deudas previas ni períodos anteriores reingresados no reflejados en la fecha de antigüedad.");
  result.scenarios = (["WITH_NOTICE", "WITHOUT_NOTICE"] as const).map(code => {
    const omitted = code === "WITHOUT_NOTICE";
    const noticeAmount = !omitted ? 0n : notice.unit === "MONTHS" ? current * BigInt(notice.value) : roundDivide(current * BigInt(notice.value), 30n);
    const monthIntegration = omitted ? integration : 0n;
    const line = (lineCode: TerminationBreakdownLine["code"], name: string, amount: bigint, explanation: string, ruleOrigin: string): TerminationBreakdownLine =>
      ({ code: lineCode, name, amount: formatAmount(amount), explanation, ruleOrigin });
    const breakdown = [
      line("SENIORITY", "Indemnización por antigüedad", indemnity, inProbation ? "No corresponde durante un período de prueba válido."
        : `${result.inputs.seniority!.indemnityYears} mes(es) indemnizatorio(s) por años de servicio y fracción mayor de tres meses; mínimo un mes ${rule.effectiveFrom < "2026-03-06" ? "de base sin tope" : "de base con el tope y piso aplicables"}.`, "LCT art. 245"),
      line("NOTICE", "Preaviso", noticeAmount, omitted ? `Preaviso requerido: ${notice.value} ${notice.unit === "MONTHS" ? "mes(es)" : "día(s)"}. Remuneración vigente sin tope de CCT.` : "Se supone cumplido completamente antes de la fecha efectiva de egreso; no se agrega otro salario a la liquidación.", "LCT arts. 231–232"),
      line("MONTH_INTEGRATION", "Integración del mes", monthIntegration, inProbation ? "No corresponde en período de prueba." : omitted ? `${monthDays - elapsedDays} días hasta fin de mes, sin tope salarial.` : "No corresponde cuando el preaviso fue cumplido.", "LCT art. 233"),
      line("EARNED_SALARY", "Salario devengado", earned, `${elapsedDays - employmentDay + 1} días de servicio del mes; se supone pendiente de pago.`, "LCT arts. 103 y 126"),
      line("PROPORTIONAL_SAC", "SAC proporcional", proportionalSac, "Remuneraciones devengadas del semestre / 12, descontando el SAC informado como ya pagado.", "LCT art. 123"),
      line("UNUSED_VACATION", "Vacaciones no gozadas/proporcionales", vacation, `${annualVacation} días anuales según antigüedad al 31/12, proporcionales al servicio, menos días gozados y más saldo anterior informado; remuneración / 25.`, "LCT arts. 150, 155 y 156"),
      line("SAC_ON_NOTICE", "Incidencia SAC sobre preaviso", roundDivide(noticeAmount, 12n), "Doceava parte del preaviso sustitutivo; criterio de reparación de remuneración frustrada.", "LCT art. 232; criterio judicial indicado"),
      line("SAC_ON_INTEGRATION", "Incidencia SAC sobre integración", roundDivide(monthIntegration, 12n), "Doceava parte de la integración; criterio de reparación de remuneración frustrada.", "LCT art. 233; criterio judicial indicado"),
    ];
    return { code, total: formatAmount(breakdown.reduce((sum, item) => sum + parseAmount(item.amount, "calculatedAmount")!, 0n)), breakdown,
      notice: { ...notice, fulfilled: omitted ? "NONE" as const : "FULL" as const } };
  });
  result.status = "AVAILABLE";
  result.warnings = [...new Set(result.warnings)];
  const incomplete = result.salaryBase.missingPeriods.length > 0 || result.salaryBase.trace.some(entry => entry.treatment === "REVIEW_REQUIRED")
    || inferredSac || !input.employment.countryConfirmedAt || !["CONFIRMED", "SIMULATION_OVERRIDE"].includes(result.inputs.startDateSource)
    || usableDocumentPeriods(result.salaryBase) < 6;
  result.confidence = incomplete ? "LOW" : !agreement || agreement.source === "SIMULATION_OVERRIDE" || result.inputs.isProjection || overrides.monthlyRemuneration ? "MEDIUM" : "HIGH";
  return result;
}

function usableDocumentPeriods(base: TerminationSalaryBase): number {
  return new Set(base.trace.filter(entry => entry.treatment === "INCLUDED" || entry.treatment === "AVERAGED").map(entry => entry.period)).size;
}
