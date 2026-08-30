import { createHash } from "node:crypto";

export type MoneyAmount = string;

export const MAX_COVERAGE_MONTHS = 1200;

export interface NormalizedEarning {
  code: string;
  amount: MoneyAmount;
  isRecurring?: boolean | null;
}

export interface SalarySettlement {
  id: string;
  documentId: string;
  employmentId?: string | null;
  employmentContext?: string | null;
  employmentStartPeriod?: string | null;
  employmentEndPeriod?: string | null;
  employmentStatus?: string | null;
  currencyCode: string;
  payrollPeriod: string;
  settlementType: string;
  isRecurring: boolean;
  basicAmount?: MoneyAmount | null;
  grossAmount?: MoneyAmount | null;
  netAmount?: MoneyAmount | null;
  deductionsAmount?: MoneyAmount | null;
  remunerativeAmount?: MoneyAmount | null;
  nonRemunerativeAmount?: MoneyAmount | null;
  earnings?: readonly NormalizedEarning[];
}

export const SALARY_CATEGORIES = [
  "NORMAL",
  "SAC",
  "BONO",
  "RETROACTIVO",
  "VACACIONES",
  "HORAS_EXTRA",
  "AJUSTE",
  "REINTEGRO",
  "COMISION",
  "LIQUIDACION_FINAL",
  "INDEMNIZACION",
  "OTRO",
] as const;

export type SalaryCategory = (typeof SALARY_CATEGORIES)[number];

export interface SalaryAmounts {
  basicAmount: MoneyAmount | null;
  grossAmount: MoneyAmount | null;
  netAmount: MoneyAmount | null;
  deductionsAmount: MoneyAmount | null;
  remunerativeAmount: MoneyAmount | null;
  nonRemunerativeAmount: MoneyAmount | null;
}

export interface MoneyChange {
  fromAmount: MoneyAmount;
  toAmount: MoneyAmount;
  deltaAmount: MoneyAmount;
  percentage: string | null;
}

export interface SalaryChange extends MoneyChange {
  fromPeriod: string;
  toPeriod: string;
}

export interface SettlementView extends SalaryAmounts {
  id: string;
  documentId: string;
  payrollPeriod: string;
  settlementType: string;
  category: SalaryCategory;
  isRecurring: boolean;
  comparableSalary: MoneyAmount | null;
  earnings: readonly NormalizedEarning[] | null;
}

export interface MonthlyEvolution {
  period: string;
  totals: SalaryAmounts;
  regular: SalaryAmounts;
  comparableSalary: MoneyAmount | null;
  settlements: SettlementView[];
}

export interface CurrentSalary {
  period: string;
  amounts: SalaryAmounts;
  comparableSalary: MoneyAmount | null;
  settlementCount: number;
  documentCount: number;
  changes: {
    latest: SalaryChange | null;
    ytd: SalaryChange | null;
    rolling12: SalaryChange | null;
    yearOverYear: SalaryChange | null;
  };
}

export interface AnnualCategorySummary {
  settlementCount: number;
  documentCount: number;
  totals: SalaryAmounts;
}

export interface AnnualSalarySummary {
  year: string;
  periodCount: number;
  settlementCount: number;
  documentCount: number;
  totals: SalaryAmounts;
  averages: SalaryAmounts;
  byCategory: Record<SalaryCategory, AnnualCategorySummary>;
  normalizedEarningsByCategory: Record<SalaryCategory, MoneyAmount> | null;
  comparableChange: SalaryChange | null;
}

export interface SalaryScopeAnalytics {
  employmentContext: string | null;
  currencyCode: string;
  current: CurrentSalary | null;
  evolution: MonthlyEvolution[];
  annual: AnnualSalarySummary[];
  increases: SalaryChange[];
  coverage: SalaryCoverage;
  events: SalaryEvent[];
}

export interface SalaryCoverageYear {
  year: string;
  expectedPeriods: string[];
  availablePeriods: string[];
  possibleMissingPeriods: string[];
}

export interface SalaryCoverage {
  basis: "CONFIRMED_EMPLOYMENT" | "OBSERVED" | "INDETERMINATE_CONTEXT";
  boundaryContradiction: boolean;
  employmentStartPeriod: string | null;
  employmentEndPeriod: string | null;
  employmentStatus: string | null;
  rangeStartPeriod: string | null;
  rangeEndPeriod: string | null;
  expectedPeriods: string[];
  availablePeriods: string[];
  possibleMissingPeriods: string[];
  byYear: SalaryCoverageYear[];
}

export type ExtraordinarySalaryCategory = Exclude<SalaryCategory, "NORMAL" | "OTRO">;

export interface ComparableIncreaseEvent {
  type: "COMPARABLE_INCREASE";
  period: string;
  category: "NORMAL";
  change: SalaryChange;
}

export interface ExtraordinarySalaryEvent {
  type: "EXTRAORDINARY";
  period: string;
  category: ExtraordinarySalaryCategory;
  amount: MoneyAmount | null;
  amountBasis: "NORMALIZED_EARNING" | "SETTLEMENT_GROSS" | "UNAVAILABLE";
  settlementId: string;
  documentId: string;
}

export type SalaryEvent = ComparableIncreaseEvent | ExtraordinarySalaryEvent;

export interface PossibleDuplicate {
  signature: string;
  employmentContext: string;
  currencyCode: string;
  payrollPeriod: string;
  settlementIds: string[];
  documentIds: string[];
}

export interface SalaryAnalytics {
  settlementCount: number;
  documentCount: number;
  employmentContextCount: number;
  periodCount: number;
  firstPeriod: string | null;
  lastPeriod: string | null;
  scopes: SalaryScopeAnalytics[];
  possibleDuplicates: PossibleDuplicate[];
}

export interface PeriodComparisonOptions {
  employmentContext: string;
  currencyCode: string;
  fromPeriod: string;
  toPeriod: string;
}

export interface EarningChange {
  code: string;
  change: MoneyChange;
}

export interface PeriodComparisonDriver {
  type: "EXTRAORDINARY_EARNING" | "DEDUCTIONS";
  code: string;
  category: ExtraordinarySalaryCategory | "DEDUCTIONS";
  change: MoneyChange;
}

export type PeriodComparisonConclusionCode =
  | "NET_UNAVAILABLE"
  | "NET_UNCHANGED"
  | "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY"
  | "NET_VARIATION_RECONCILED_BY_DEDUCTIONS"
  | "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY_AND_DEDUCTIONS"
  | "NET_VARIATION_INSUFFICIENT_DATA"
  | "NET_VARIATION_UNEXPLAINED";

export interface PeriodComparison {
  employmentContext: string;
  currencyCode: string;
  fromPeriod: string;
  toPeriod: string;
  changes: {
    basicAmount: MoneyChange | null;
    comparableSalary: MoneyChange | null;
    grossAmount: MoneyChange | null;
    netAmount: MoneyChange | null;
    deductionsAmount: MoneyChange | null;
    remunerativeAmount: MoneyChange | null;
    nonRemunerativeAmount: MoneyChange | null;
  };
  earnings: EarningChange[] | null;
  drivers: PeriodComparisonDriver[];
  driversComplete: boolean;
  conclusionCode: PeriodComparisonConclusionCode;
}

type AmountKey = keyof SalaryAmounts;

interface InternalEarning {
  code: string;
  amount: bigint;
  isRecurring: boolean | null;
}

interface InternalSettlement {
  id: string;
  documentId: string;
  employmentContext: string | null;
  employmentStartPeriod: string | null;
  employmentEndPeriod: string | null;
  employmentStatus: string | null;
  currencyCode: string;
  payrollPeriod: string;
  settlementType: string;
  category: SalaryCategory;
  isRecurring: boolean;
  basicAmount: bigint | null;
  grossAmount: bigint | null;
  netAmount: bigint | null;
  deductionsAmount: bigint | null;
  remunerativeAmount: bigint | null;
  nonRemunerativeAmount: bigint | null;
  earnings: InternalEarning[] | null;
}

const AMOUNT_KEYS: readonly AmountKey[] = [
  "basicAmount",
  "grossAmount",
  "netAmount",
  "deductionsAmount",
  "remunerativeAmount",
  "nonRemunerativeAmount",
];

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function parseAmount(value: MoneyAmount | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new TypeError(`${field} must be a decimal with at most two fraction digits`);
  const whole = match[2];
  if (whole === undefined) throw new TypeError(`${field} is invalid`);
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(fraction || "0");
  return match[1] === "-" ? -cents : cents;
}

function formatAmount(cents: bigint): MoneyAmount {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function formatPercentage(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function normalizePeriod(value: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new TypeError("payrollPeriod must be YYYY-MM or YYYY-MM-01");
  }
  return `${match[1]}-${match[2]}`;
}

function normalizeEmploymentPeriod(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.exec(value.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new TypeError(`${field} must contain a valid year and month`);
  }
  return `${match[1]}-${match[2]}`;
}

function monthIndex(period: string): number {
  return Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7)) - 1;
}

function periodFromMonthIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = index % 12 + 1;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}

function categoryOf(type: string): SalaryCategory {
  switch (type) {
    case "NORMAL": return "NORMAL";
    case "SAC": return "SAC";
    case "BONO":
    case "BONUS":
    case "PREMIO": return "BONO";
    case "RETROACTIVO":
    case "RETROACTIVE": return "RETROACTIVO";
    case "VACACIONES":
    case "VACATION": return "VACACIONES";
    case "HORAS_EXTRA":
    case "OVERTIME": return "HORAS_EXTRA";
    case "AJUSTE":
    case "ADJUSTMENT": return "AJUSTE";
    case "REINTEGRO":
    case "REIMBURSEMENT": return "REINTEGRO";
    case "COMISION":
    case "COMMISSION": return "COMISION";
    case "LIQUIDACION_FINAL":
    case "FINAL_SETTLEMENT": return "LIQUIDACION_FINAL";
    case "INDEMNIZACION":
    case "INDEMNITY":
    case "SEVERANCE": return "INDEMNIZACION";
    default: return "OTRO";
  }
}

export function salaryCategoryForEarning(code: string, isRecurring?: boolean | null): SalaryCategory {
  const semanticCategory = categoryOf(requireText(code, "earning.code").toUpperCase());
  return semanticCategory === "OTRO" && isRecurring === true ? "NORMAL" : semanticCategory;
}

function categoryOfEarning(earning: InternalEarning): SalaryCategory {
  return salaryCategoryForEarning(earning.code, earning.isRecurring);
}

function normalizeSettlement(settlement: SalarySettlement): InternalSettlement {
  const id = requireText(settlement.id, "id");
  const documentId = requireText(settlement.documentId, "documentId");
  const currencyCode = requireText(settlement.currencyCode, "currencyCode").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError("currencyCode must be a three-letter code");
  const settlementType = requireText(settlement.settlementType, "settlementType").toUpperCase();
  const rawContext = settlement.employmentId ?? settlement.employmentContext;
  const employmentContext = rawContext === null || rawContext === undefined
    ? null
    : requireText(rawContext, "employmentContext");
  const earnings = settlement.earnings === undefined
    ? null
    : settlement.earnings.map((earning, index) => {
        const code = requireText(earning.code, `earnings[${index}].code`).toUpperCase();
        if (!/^[A-Z0-9_]{1,80}$/.test(code)) throw new TypeError(`earnings[${index}].code is invalid`);
        return {
          code,
          amount: parseAmount(earning.amount, `earnings[${index}].amount`)!,
          isRecurring: earning.isRecurring ?? null,
        };
      });

  return {
    id,
    documentId,
    employmentContext,
    employmentStartPeriod: normalizeEmploymentPeriod(settlement.employmentStartPeriod, "employmentStartPeriod"),
    employmentEndPeriod: normalizeEmploymentPeriod(settlement.employmentEndPeriod, "employmentEndPeriod"),
    employmentStatus: settlement.employmentStatus === null || settlement.employmentStatus === undefined
      ? null
      : requireText(settlement.employmentStatus, "employmentStatus").toUpperCase(),
    currencyCode,
    payrollPeriod: normalizePeriod(settlement.payrollPeriod),
    settlementType,
    category: categoryOf(settlementType),
    isRecurring: settlement.isRecurring,
    basicAmount: parseAmount(settlement.basicAmount, "basicAmount"),
    grossAmount: parseAmount(settlement.grossAmount, "grossAmount"),
    netAmount: parseAmount(settlement.netAmount, "netAmount"),
    deductionsAmount: parseAmount(settlement.deductionsAmount, "deductionsAmount"),
    remunerativeAmount: parseAmount(settlement.remunerativeAmount, "remunerativeAmount"),
    nonRemunerativeAmount: parseAmount(settlement.nonRemunerativeAmount, "nonRemunerativeAmount"),
    earnings,
  };
}

function isRegular(settlement: InternalSettlement): boolean {
  return settlement.category === "NORMAL" && settlement.isRecurring;
}

function sumField(settlements: readonly InternalSettlement[], key: AmountKey): bigint | null {
  if (settlements.length === 0) return 0n;
  let total = 0n;
  for (const settlement of settlements) {
    const amount = settlement[key];
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

function internalAmounts(settlements: readonly InternalSettlement[]): Record<AmountKey, bigint | null> {
  return Object.fromEntries(AMOUNT_KEYS.map((key) => [key, sumField(settlements, key)])) as Record<
    AmountKey,
    bigint | null
  >;
}

function publicAmounts(amounts: Record<AmountKey, bigint | null>): SalaryAmounts {
  return Object.fromEntries(
    AMOUNT_KEYS.map((key) => [key, amounts[key] === null ? null : formatAmount(amounts[key])]),
  ) as unknown as SalaryAmounts;
}

function averageAmounts(
  amounts: Record<AmountKey, bigint | null>,
  periodCount: number,
): SalaryAmounts {
  const divisor = BigInt(periodCount);
  return Object.fromEntries(AMOUNT_KEYS.map((key) => {
    const amount = amounts[key];
    return [key, amount === null ? null : formatAmount(roundDivide(amount, divisor))];
  })) as unknown as SalaryAmounts;
}

function comparableSalary(settlements: readonly InternalSettlement[]): bigint | null {
  const regular = settlements.filter(isRegular);
  if (regular.length === 0 || regular.some((settlement) => settlement.basicAmount === null)) return null;
  const values = new Set(regular.map((settlement) => settlement.basicAmount!.toString()));
  return values.size === 1 ? regular[0]!.basicAmount : null;
}

function toSettlementView(settlement: InternalSettlement): SettlementView {
  const comparable = isRegular(settlement) ? settlement.basicAmount : null;
  return {
    id: settlement.id,
    documentId: settlement.documentId,
    payrollPeriod: settlement.payrollPeriod,
    settlementType: settlement.settlementType,
    category: settlement.category,
    isRecurring: settlement.isRecurring,
    basicAmount: settlement.basicAmount === null ? null : formatAmount(settlement.basicAmount),
    grossAmount: settlement.grossAmount === null ? null : formatAmount(settlement.grossAmount),
    netAmount: settlement.netAmount === null ? null : formatAmount(settlement.netAmount),
    deductionsAmount: settlement.deductionsAmount === null ? null : formatAmount(settlement.deductionsAmount),
    remunerativeAmount: settlement.remunerativeAmount === null ? null : formatAmount(settlement.remunerativeAmount),
    nonRemunerativeAmount: settlement.nonRemunerativeAmount === null
      ? null
      : formatAmount(settlement.nonRemunerativeAmount),
    comparableSalary: comparable === null ? null : formatAmount(comparable),
    earnings: settlement.earnings === null
      ? null
      : settlement.earnings.map((earning) => ({
          code: earning.code,
          amount: formatAmount(earning.amount),
          isRecurring: earning.isRecurring,
        })),
  };
}

function groupByPeriod(settlements: readonly InternalSettlement[]): Map<string, InternalSettlement[]> {
  const grouped = new Map<string, InternalSettlement[]>();
  for (const settlement of settlements) {
    const period = grouped.get(settlement.payrollPeriod) ?? [];
    period.push(settlement);
    grouped.set(settlement.payrollPeriod, period);
  }
  for (const period of grouped.values()) period.sort((a, b) => a.id.localeCompare(b.id));
  return grouped;
}

function makeEvolution(settlements: readonly InternalSettlement[]): MonthlyEvolution[] {
  return [...groupByPeriod(settlements)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([period, entries]) => {
      const regular = entries.filter(isRegular);
      const comparable = comparableSalary(entries);
      return {
        period,
        totals: publicAmounts(internalAmounts(entries)),
        regular: {
          ...publicAmounts(internalAmounts(regular)),
          basicAmount: comparable === null ? null : formatAmount(comparable),
        },
        comparableSalary: comparable === null ? null : formatAmount(comparable),
        settlements: entries.map(toSettlementView),
      };
    });
}

function makeMoneyChange(from: bigint | null, to: bigint | null): MoneyChange | null {
  if (from === null || to === null) return null;
  const hundredths = from > 0n ? roundDivide((to - from) * 10_000n, from) : null;
  return {
    fromAmount: formatAmount(from),
    toAmount: formatAmount(to),
    deltaAmount: formatAmount(to - from),
    percentage: hundredths === null ? null : formatPercentage(hundredths),
  };
}

function makeSalaryChange(
  from: { period: string; amount: bigint },
  to: { period: string; amount: bigint },
): SalaryChange {
  return {
    ...makeMoneyChange(from.amount, to.amount)!,
    fromPeriod: from.period,
    toPeriod: to.period,
  };
}

function makeAnnual(
  settlements: readonly InternalSettlement[],
  comparablePoints: readonly { period: string; amount: bigint }[],
  canCompare: boolean,
): AnnualSalarySummary[] {
  const years = new Map<string, InternalSettlement[]>();
  for (const settlement of settlements) {
    const year = settlement.payrollPeriod.slice(0, 4);
    const entries = years.get(year) ?? [];
    entries.push(settlement);
    years.set(year, entries);
  }
  return [...years]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([year, entries]) => {
      const periods = new Set(entries.map((entry) => entry.payrollPeriod));
      const totals = internalAmounts(entries);
      const points = comparablePoints.filter((point) => point.period.startsWith(`${year}-`));
      const byCategory = Object.fromEntries(SALARY_CATEGORIES.map((category) => {
        const categoryEntries = entries.filter((entry) => entry.category === category);
        return [category, {
          settlementCount: categoryEntries.length,
          documentCount: new Set(categoryEntries.map((entry) => entry.documentId)).size,
          totals: publicAmounts(internalAmounts(categoryEntries)),
        }];
      })) as Record<SalaryCategory, AnnualCategorySummary>;
      const normalizedEarningsByCategory = entries.some((entry) => entry.earnings === null)
        ? null
        : Object.fromEntries(SALARY_CATEGORIES.map((category) => [
            category,
            formatAmount(entries
              .flatMap((entry) => entry.earnings!)
              .filter((earning) => categoryOfEarning(earning) === category)
              .reduce((total, earning) => total + earning.amount, 0n)),
          ])) as Record<SalaryCategory, MoneyAmount>;
      return {
        year,
        periodCount: periods.size,
        settlementCount: entries.length,
        documentCount: new Set(entries.map((entry) => entry.documentId)).size,
        totals: publicAmounts(totals),
        averages: averageAmounts(totals, periods.size),
        byCategory,
        normalizedEarningsByCategory,
        comparableChange: canCompare && points.length > 1
          ? makeSalaryChange(points[0]!, points.at(-1)!)
          : null,
      };
    });
}

function consistentMetadata(values: readonly (string | null)[]): string | null {
  const present = [...new Set(values.filter((value): value is string => value !== null))];
  return present.length === 1 ? present[0]! : null;
}

function conflictingMetadata(values: readonly (string | null)[]): boolean {
  return new Set(values.filter((value): value is string => value !== null)).size > 1;
}

function makeCoverage(settlements: readonly InternalSettlement[]): SalaryCoverage {
  const observedPeriods = [...new Set(settlements.map((settlement) => settlement.payrollPeriod))].sort();
  const startPeriods = settlements.map((settlement) => settlement.employmentStartPeriod);
  const endPeriods = settlements.map((settlement) => settlement.employmentEndPeriod);
  const employmentStartPeriod = consistentMetadata(startPeriods);
  const employmentEndPeriod = consistentMetadata(endPeriods);
  const employmentStatus = consistentMetadata(settlements.map((settlement) => settlement.employmentStatus));
  if (settlements[0]!.employmentContext === null) {
    return {
      basis: "INDETERMINATE_CONTEXT",
      boundaryContradiction: false,
      employmentStartPeriod,
      employmentEndPeriod,
      employmentStatus,
      rangeStartPeriod: null,
      rangeEndPeriod: null,
      expectedPeriods: [],
      availablePeriods: [],
      possibleMissingPeriods: [],
      byYear: [],
    };
  }
  const firstObserved = observedPeriods[0]!;
  const lastObserved = observedPeriods.at(-1)!;
  const declaredStart = employmentStartPeriod ?? firstObserved;
  const declaredEnd = employmentEndPeriod ?? lastObserved;
  const boundaryContradiction = conflictingMetadata(startPeriods) || conflictingMetadata(endPeriods)
    || declaredStart > firstObserved || declaredEnd < lastObserved || declaredStart > declaredEnd;
  const rangeStartPeriod = declaredStart < firstObserved ? declaredStart : firstObserved;
  const rangeEndPeriod = declaredEnd > lastObserved ? declaredEnd : lastObserved;
  const rangeStartIndex = monthIndex(rangeStartPeriod);
  const rangeEndIndex = monthIndex(rangeEndPeriod);
  if (rangeEndIndex - rangeStartIndex + 1 > MAX_COVERAGE_MONTHS) {
    throw new RangeError(`salary coverage cannot exceed ${MAX_COVERAGE_MONTHS} months`);
  }
  const expectedPeriods: string[] = [];
  for (let index = rangeStartIndex; index <= rangeEndIndex; index += 1) {
    expectedPeriods.push(periodFromMonthIndex(index));
  }
  const expected = new Set(expectedPeriods);
  const availablePeriods = [...new Set(settlements
    .filter(isRegular)
    .map((settlement) => settlement.payrollPeriod)
    .filter((period) => expected.has(period)))].sort();
  const available = new Set(availablePeriods);
  const possibleMissingPeriods = expectedPeriods.filter((period) => !available.has(period));
  const years = new Map<string, SalaryCoverageYear>();
  for (const period of expectedPeriods) {
    const year = period.slice(0, 4);
    const summary = years.get(year) ?? {
      year, expectedPeriods: [], availablePeriods: [], possibleMissingPeriods: [],
    };
    summary.expectedPeriods.push(period);
    (available.has(period) ? summary.availablePeriods : summary.possibleMissingPeriods).push(period);
    years.set(year, summary);
  }
  return {
    basis: employmentStartPeriod !== null || employmentEndPeriod !== null ? "CONFIRMED_EMPLOYMENT" : "OBSERVED",
    boundaryContradiction,
    employmentStartPeriod,
    employmentEndPeriod,
    employmentStatus,
    rangeStartPeriod,
    rangeEndPeriod,
    expectedPeriods,
    availablePeriods,
    possibleMissingPeriods,
    byYear: [...years.values()],
  };
}

function isExtraordinaryCategory(category: SalaryCategory): category is ExtraordinarySalaryCategory {
  return category !== "NORMAL" && category !== "OTRO";
}

function makeEvents(
  settlements: readonly InternalSettlement[],
  increases: readonly SalaryChange[],
): SalaryEvent[] {
  const events: SalaryEvent[] = increases.map((change) => ({
    type: "COMPARABLE_INCREASE",
    period: change.toPeriod,
    category: "NORMAL",
    change,
  }));
  for (const settlement of settlements) {
    const normalized = new Map<ExtraordinarySalaryCategory, bigint>();
    for (const earning of settlement.earnings ?? []) {
      const category = categoryOf(earning.code);
      if (isExtraordinaryCategory(category)) {
        normalized.set(category, (normalized.get(category) ?? 0n) + earning.amount);
      }
    }
    for (const [category, amount] of normalized) {
      events.push({
        type: "EXTRAORDINARY",
        period: settlement.payrollPeriod,
        category,
        amount: formatAmount(amount),
        amountBasis: "NORMALIZED_EARNING",
        settlementId: settlement.id,
        documentId: settlement.documentId,
      });
    }
    if (isExtraordinaryCategory(settlement.category) && !normalized.has(settlement.category)) {
      events.push({
        type: "EXTRAORDINARY",
        period: settlement.payrollPeriod,
        category: settlement.category,
        amount: settlement.grossAmount === null ? null : formatAmount(settlement.grossAmount),
        amountBasis: settlement.grossAmount === null ? "UNAVAILABLE" : "SETTLEMENT_GROSS",
        settlementId: settlement.id,
        documentId: settlement.documentId,
      });
    }
  }
  return events.sort((left, right) => left.period.localeCompare(right.period)
    || left.type.localeCompare(right.type)
    || left.category.localeCompare(right.category)
    || (left.type === "EXTRAORDINARY" ? left.settlementId : "")
      .localeCompare(right.type === "EXTRAORDINARY" ? right.settlementId : ""));
}

function makeScope(settlements: readonly InternalSettlement[]): SalaryScopeAnalytics {
  const employmentContext = settlements[0]!.employmentContext;
  const currencyCode = settlements[0]!.currencyCode;
  const canCompare = employmentContext !== null;
  const evolution = makeEvolution(settlements);
  const comparablePoints = evolution
    .filter((point): point is MonthlyEvolution & { comparableSalary: string } => point.comparableSalary !== null)
    .map((point) => ({ period: point.period, amount: parseAmount(point.comparableSalary, "comparableSalary")! }));
  const currentPoint = [...evolution].reverse().find((point) => point.settlements.some((entry) => (
    entry.category === "NORMAL" && entry.isRecurring
  ))) ?? null;
  let current: CurrentSalary | null = null;

  if (currentPoint !== null) {
    const regular = currentPoint.settlements.filter((entry) => entry.category === "NORMAL" && entry.isRecurring);
    const currentComparable = comparablePoints.find((point) => point.period === currentPoint.period) ?? null;
    const previous = currentComparable === null
      ? null
      : [...comparablePoints].reverse().find((point) => point.period < currentComparable.period) ?? null;
    const currentYear = currentPoint.period.slice(0, 4);
    const ytdStart = currentComparable === null
      ? null
      : comparablePoints.find((point) => point.period.startsWith(`${currentYear}-`)) ?? null;
    const rollingStartIndex = monthIndex(currentPoint.period) - 12;
    const rollingStart = currentComparable === null
      ? null
      : comparablePoints.find((point) => monthIndex(point.period) >= rollingStartIndex) ?? null;
    const yearOverYear = currentComparable === null
      ? null
      : comparablePoints.find((point) => monthIndex(point.period) === monthIndex(currentPoint.period) - 12) ?? null;
    const change = (from: { period: string; amount: bigint } | null): SalaryChange | null => (
      canCompare && from !== null && currentComparable !== null && from.period !== currentComparable.period
        ? makeSalaryChange(from, currentComparable)
        : null
    );
    current = {
      period: currentPoint.period,
      amounts: currentPoint.regular,
      comparableSalary: currentPoint.comparableSalary,
      settlementCount: regular.length,
      documentCount: new Set(regular.map((entry) => entry.documentId)).size,
      changes: {
        latest: change(previous),
        ytd: change(ytdStart),
        rolling12: change(rollingStart),
        yearOverYear: change(yearOverYear),
      },
    };
  }

  const increases: SalaryChange[] = [];
  if (canCompare) {
    for (let index = 1; index < comparablePoints.length; index += 1) {
      const from = comparablePoints[index - 1]!;
      const to = comparablePoints[index]!;
      if (to.amount > from.amount) increases.push(makeSalaryChange(from, to));
    }
  }

  return {
    employmentContext,
    currencyCode,
    current,
    evolution,
    annual: makeAnnual(settlements, comparablePoints, canCompare),
    increases,
    coverage: makeCoverage(settlements),
    events: makeEvents(settlements, increases),
  };
}

function duplicateSignature(settlement: InternalSettlement): string {
  const earnings = settlement.earnings === null
    ? null
    : [...settlement.earnings]
        .sort((left, right) => left.code.localeCompare(right.code)
          || left.amount.toString().localeCompare(right.amount.toString())
          || String(left.isRecurring).localeCompare(String(right.isRecurring)))
        .map((earning) => [earning.code, earning.amount.toString(), earning.isRecurring]);
  const raw = JSON.stringify([
    settlement.employmentContext,
    settlement.currencyCode,
    settlement.payrollPeriod,
    settlement.category === "OTRO" ? settlement.settlementType : settlement.category,
    settlement.isRecurring,
    ...AMOUNT_KEYS.map((key) => settlement[key]?.toString() ?? null),
    earnings,
  ]);
  return createHash("sha256").update(raw).digest("hex");
}

function findPossibleDuplicates(settlements: readonly InternalSettlement[]): PossibleDuplicate[] {
  const signatures = new Map<string, InternalSettlement[]>();
  for (const settlement of settlements) {
    if (settlement.employmentContext === null) continue;
    const signature = duplicateSignature(settlement);
    const entries = signatures.get(signature) ?? [];
    entries.push(settlement);
    signatures.set(signature, entries);
  }
  return [...signatures]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.documentId)).size > 1)
    .map(([signature, entries]) => ({
      signature,
      employmentContext: entries[0]!.employmentContext!,
      currencyCode: entries[0]!.currencyCode,
      payrollPeriod: entries[0]!.payrollPeriod,
      settlementIds: entries.map((entry) => entry.id).sort(),
      documentIds: [...new Set(entries.map((entry) => entry.documentId))].sort(),
    }))
    .sort((left, right) => left.payrollPeriod.localeCompare(right.payrollPeriod)
      || left.employmentContext.localeCompare(right.employmentContext)
      || left.currencyCode.localeCompare(right.currencyCode)
      || left.signature.localeCompare(right.signature));
}

export function analyzeSalaryHistory(settlements: readonly SalarySettlement[]): SalaryAnalytics {
  const normalized = settlements.map(normalizeSettlement);
  const scopes = new Map<string, InternalSettlement[]>();
  for (const settlement of normalized) {
    const key = JSON.stringify([settlement.employmentContext, settlement.currencyCode]);
    const entries = scopes.get(key) ?? [];
    entries.push(settlement);
    scopes.set(key, entries);
  }
  const periods = [...new Set(normalized.map((settlement) => settlement.payrollPeriod))].sort();
  return {
    settlementCount: normalized.length,
    documentCount: new Set(normalized.map((settlement) => settlement.documentId)).size,
    employmentContextCount: new Set(
      normalized.flatMap((settlement) => settlement.employmentContext === null ? [] : [settlement.employmentContext]),
    ).size,
    periodCount: periods.length,
    firstPeriod: periods[0] ?? null,
    lastPeriod: periods.at(-1) ?? null,
    scopes: [...scopes.values()]
      .map((entries) => makeScope(entries))
      .sort((left, right) => (left.employmentContext ?? "\uffff").localeCompare(right.employmentContext ?? "\uffff")
        || left.currencyCode.localeCompare(right.currencyCode)),
    possibleDuplicates: findPossibleDuplicates(normalized),
  };
}

function aggregateEarnings(settlements: readonly InternalSettlement[]): Map<string, bigint> | null {
  if (settlements.some((settlement) => settlement.earnings === null)) return null;
  const totals = new Map<string, bigint>();
  for (const earning of settlements.flatMap((settlement) => settlement.earnings!)) {
    totals.set(earning.code, (totals.get(earning.code) ?? 0n) + earning.amount);
  }
  return totals;
}

function extraordinaryEvidence(settlements: readonly InternalSettlement[]): {
  complete: boolean;
  totals: Map<ExtraordinarySalaryCategory, bigint>;
} {
  const totals = new Map<ExtraordinarySalaryCategory, bigint>();
  let complete = true;
  for (const settlement of settlements) {
    if (settlement.earnings === null) complete = false;
    const normalizedCategories = new Set<ExtraordinarySalaryCategory>();
    for (const earning of settlement.earnings ?? []) {
      const category = categoryOf(earning.code);
      if (!isExtraordinaryCategory(category)) continue;
      normalizedCategories.add(category);
      totals.set(category, (totals.get(category) ?? 0n) + earning.amount);
    }
    if (isExtraordinaryCategory(settlement.category) && !normalizedCategories.has(settlement.category)) {
      if (settlement.grossAmount === null) complete = false;
      else totals.set(settlement.category, (totals.get(settlement.category) ?? 0n) + settlement.grossAmount);
    }
  }
  return { complete, totals };
}

export function compareSalaryPeriods(
  settlements: readonly SalarySettlement[],
  options: PeriodComparisonOptions,
): PeriodComparison | null {
  const employmentContext = requireText(options.employmentContext, "employmentContext");
  const currencyCode = requireText(options.currencyCode, "currencyCode").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw new TypeError("currencyCode must be a three-letter code");
  const fromPeriod = normalizePeriod(options.fromPeriod);
  const toPeriod = normalizePeriod(options.toPeriod);
  const normalized = settlements.map(normalizeSettlement).filter((settlement) => (
    settlement.employmentContext === employmentContext && settlement.currencyCode === currencyCode
  ));
  const periods = groupByPeriod(normalized);
  const from = periods.get(fromPeriod);
  const to = periods.get(toPeriod);
  if (from === undefined || to === undefined) return null;
  const fromAmounts = internalAmounts(from);
  const toAmounts = internalAmounts(to);
  const fromComparable = comparableSalary(from);
  const toComparable = comparableSalary(to);
  const fromEarnings = aggregateEarnings(from);
  const toEarnings = aggregateEarnings(to);
  const earnings = fromEarnings === null || toEarnings === null
    ? null
    : [...new Set([...fromEarnings.keys(), ...toEarnings.keys()])]
        .sort()
        .map((code) => ({ code, change: makeMoneyChange(fromEarnings.get(code) ?? 0n, toEarnings.get(code) ?? 0n)! }));
  const fromExtraordinary = extraordinaryEvidence(from);
  const toExtraordinary = extraordinaryEvidence(to);
  const fromExtraordinaryTotal = [...fromExtraordinary.totals.values()]
    .reduce((total, amount) => total + amount, 0n);
  const toExtraordinaryTotal = [...toExtraordinary.totals.values()]
    .reduce((total, amount) => total + amount, 0n);
  const candidateDrivers: PeriodComparisonDriver[] = [];
  let extraordinaryDelta = 0n;
  for (const category of [...new Set([
    ...fromExtraordinary.totals.keys(),
    ...toExtraordinary.totals.keys(),
  ])].sort()) {
    const fromAmount = fromExtraordinary.totals.get(category) ?? 0n;
    const toAmount = toExtraordinary.totals.get(category) ?? 0n;
    extraordinaryDelta += toAmount - fromAmount;
    if (fromAmount !== toAmount) {
      candidateDrivers.push({
        type: "EXTRAORDINARY_EARNING",
        code: category,
        category,
        change: makeMoneyChange(fromAmount, toAmount)!,
      });
    }
  }
  let deductionsDelta: bigint | null = null;
  if (fromAmounts.deductionsAmount !== null && toAmounts.deductionsAmount !== null
    && fromAmounts.deductionsAmount !== toAmounts.deductionsAmount) {
    deductionsDelta = toAmounts.deductionsAmount - fromAmounts.deductionsAmount;
    candidateDrivers.push({
      type: "DEDUCTIONS",
      code: "DEDUCTIONS",
      category: "DEDUCTIONS",
      change: makeMoneyChange(fromAmounts.deductionsAmount, toAmounts.deductionsAmount)!,
    });
  } else if (fromAmounts.deductionsAmount !== null && toAmounts.deductionsAmount !== null) {
    deductionsDelta = 0n;
  }
  const regularEvidenceComplete = fromComparable !== null && toComparable !== null
    && fromAmounts.grossAmount !== null && toAmounts.grossAmount !== null;
  const regularEvidenceUnchanged = regularEvidenceComplete
    && fromComparable === toComparable
    && fromAmounts.grossAmount! - fromExtraordinaryTotal === toAmounts.grossAmount! - toExtraordinaryTotal;
  const driversComplete = fromExtraordinary.complete && toExtraordinary.complete
    && deductionsDelta !== null && regularEvidenceComplete;
  const netDelta = fromAmounts.netAmount === null || toAmounts.netAmount === null
    ? null
    : toAmounts.netAmount - fromAmounts.netAmount;
  const reconciled = netDelta !== null && netDelta !== 0n && driversComplete && regularEvidenceUnchanged
    && extraordinaryDelta - deductionsDelta! === netDelta;
  const drivers = reconciled ? candidateDrivers : [];
  const hasExtraordinaryDriver = candidateDrivers.some((driver) => driver.type === "EXTRAORDINARY_EARNING");
  const hasDeductionsDriver = candidateDrivers.some((driver) => driver.type === "DEDUCTIONS");
  const conclusionCode: PeriodComparisonConclusionCode = netDelta === null
    ? "NET_UNAVAILABLE"
    : netDelta === 0n
      ? "NET_UNCHANGED"
      : !driversComplete
        ? "NET_VARIATION_INSUFFICIENT_DATA"
        : !reconciled
          ? "NET_VARIATION_UNEXPLAINED"
          : hasExtraordinaryDriver && hasDeductionsDriver
            ? "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY_AND_DEDUCTIONS"
            : hasExtraordinaryDriver
              ? "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY"
              : hasDeductionsDriver
                ? "NET_VARIATION_RECONCILED_BY_DEDUCTIONS"
                : "NET_VARIATION_UNEXPLAINED";
  return {
    employmentContext,
    currencyCode,
    fromPeriod,
    toPeriod,
    changes: {
      basicAmount: makeMoneyChange(fromComparable, toComparable),
      comparableSalary: makeMoneyChange(fromComparable, toComparable),
      grossAmount: makeMoneyChange(fromAmounts.grossAmount, toAmounts.grossAmount),
      netAmount: makeMoneyChange(fromAmounts.netAmount, toAmounts.netAmount),
      deductionsAmount: makeMoneyChange(fromAmounts.deductionsAmount, toAmounts.deductionsAmount),
      remunerativeAmount: makeMoneyChange(fromAmounts.remunerativeAmount, toAmounts.remunerativeAmount),
      nonRemunerativeAmount: makeMoneyChange(fromAmounts.nonRemunerativeAmount, toAmounts.nonRemunerativeAmount),
    },
    earnings,
    drivers,
    driversComplete,
    conclusionCode,
  };
}
