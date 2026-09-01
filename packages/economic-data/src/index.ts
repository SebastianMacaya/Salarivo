export type EconomicSeriesType = "EXCHANGE_RATE" | "PRICE_INDEX";
export type EconomicSeriesFrequency = "DAILY" | "MONTHLY";

interface EconomicSeriesBase {
  readonly id?: string;
  readonly code: string;
  readonly type: EconomicSeriesType;
  readonly frequency: EconomicSeriesFrequency;
  readonly countryCode: string;
  readonly variantCode: string;
  readonly providerCode: string;
  readonly externalSeriesId: string;
  readonly name: string;
  readonly methodology: string;
  readonly sourceUrl?: string;
}

export interface ExchangeRateSeries extends EconomicSeriesBase {
  readonly type: "EXCHANGE_RATE";
  readonly baseCurrencyCode: string;
  readonly quoteCurrencyCode: string;
}

export interface PriceIndexSeries extends EconomicSeriesBase {
  readonly type: "PRICE_INDEX";
  readonly baseCurrencyCode?: never;
  readonly quoteCurrencyCode?: never;
}

export type EconomicSeries = ExchangeRateSeries | PriceIndexSeries;

export interface EconomicObservation {
  readonly id?: string;
  readonly seriesCode: string;
  readonly date: string;
  readonly value: string;
  readonly revision?: number;
  readonly observedAt?: string;
  readonly metadataNoSensitive?: Readonly<Record<string, unknown>>;
}

export interface EconomicDateRange {
  readonly from: string;
  readonly to: string;
}

export interface ExchangeRateProvider {
  fetchRange(
    series: ExchangeRateSeries,
    range: EconomicDateRange,
    signal: AbortSignal,
  ): Promise<readonly EconomicObservation[]>;
}

export interface PriceIndexProvider {
  fetchRange(
    series: PriceIndexSeries,
    range: EconomicDateRange,
    signal: AbortSignal,
  ): Promise<readonly EconomicObservation[]>;
}

export interface EconomicProfile {
  readonly code: string;
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly referenceCurrencyCode: string;
  readonly exchangeRateSeriesCode: string;
  readonly priceIndexSeriesCode: string;
}

export const ECONOMIC_SERIES_CODES = Object.freeze({
  AR_REFERENCE_USD_ARS: "FX.AR.USD.ARS.REFERENCE",
  AR_GENERAL_PRICE_INDEX: "PRICE_INDEX.AR.GENERAL",
} as const);

export const ARGENTINA_ARS_PROFILE: EconomicProfile = Object.freeze({
  code: "PROFILE.AR.ARS",
  countryCode: "AR",
  currencyCode: "ARS",
  referenceCurrencyCode: "USD",
  exchangeRateSeriesCode: ECONOMIC_SERIES_CODES.AR_REFERENCE_USD_ARS,
  priceIndexSeriesCode: ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX,
});

export const ECONOMIC_PROFILES: readonly EconomicProfile[] = Object.freeze([ARGENTINA_ARS_PROFILE]);

export function economicProfileFor(
  countryCode: string | null | undefined,
  currencyCode: string,
): EconomicProfile | null {
  if (countryCode === null || countryCode === undefined) return null;
  const country = requireCountryCode(countryCode, "countryCode");
  const currency = requireCurrencyCode(currencyCode, "currencyCode");
  return ECONOMIC_PROFILES.find((profile) => (
    profile.countryCode === country && profile.currencyCode === currency
  )) ?? null;
}

export const MAX_DAILY_OBSERVATION_LOOKBACK_DAYS = 7;

export type ExchangeRateDateSelectionMethod =
  | "PAYMENT_DATE"
  | "ISSUE_DATE"
  | "PAYROLL_PERIOD_END";

export interface ExchangeRateDateSelection {
  readonly targetDate: string;
  readonly method: ExchangeRateDateSelectionMethod;
}

export interface ExchangeRateQuote {
  readonly baseCurrencyCode: string;
  readonly quoteCurrencyCode: string;
  readonly value: string;
}

interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const INTERNAL_CODE = /^[A-Z][A-Z0-9._-]{2,99}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function requireBoundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized !== value
      || !normalized
      || normalized.length > maxLength
      || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${field} must be non-empty text of at most ${maxLength} characters`);
  }
  return normalized;
}

function requireCode(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized !== value || !INTERNAL_CODE.test(normalized)) {
    throw new TypeError(`${field} must be a stable internal code`);
  }
  return normalized;
}

function requireCountryCode(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized !== value || !COUNTRY_CODE.test(normalized)) {
    throw new TypeError(`${field} must be an ISO 3166-1 alpha-2 code`);
  }
  return normalized;
}

function requireCurrencyCode(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized !== value || !CURRENCY_CODE.test(normalized)) {
    throw new TypeError(`${field} must be an ISO 4217 code`);
  }
  return normalized;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function dateParts(value: string, field: string): readonly [number, number, number] {
  const match = ISO_DATE.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  }
  return [year, month, day];
}

function epochDay(value: string, field: string): number {
  const [year, month, day] = dateParts(value, field);
  const previousYear = year - 1;
  const daysBeforeYear = 365 * previousYear
    + Math.floor(previousYear / 4)
    - Math.floor(previousYear / 100)
    + Math.floor(previousYear / 400);
  const monthOffsets = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const offset = monthOffsets[month - 1];
  if (offset === undefined) throw new TypeError(`${field} must be a valid YYYY-MM-DD date`);
  return daysBeforeYear + offset + (month > 2 && isLeapYear(year) ? 1 : 0) + day - 1;
}

function normalizeMonth(value: string, field: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/.exec(value.trim());
  if (!match?.[1] || !match[2] || Number(match[1]) < 1) {
    throw new TypeError(`${field} must be YYYY-MM or YYYY-MM-01`);
  }
  return `${match[1]}-${match[2]}`;
}

function parseDecimal(
  value: string,
  field: string,
  maxScale: number,
  maxIntegerDigits: number,
): ParsedDecimal {
  const normalized = value.trim();
  const match = DECIMAL.exec(normalized);
  const whole = match?.[2];
  const fraction = match?.[3] ?? "";
  const integerDigits = whole?.replace(/^0+/, "").length || 1;
  if (!match
      || whole === undefined
      || fraction.length > maxScale
      || integerDigits > maxIntegerDigits
      || normalized.length > maxIntegerDigits + maxScale + 3) {
    throw new TypeError(
      `${field} must be a decimal with at most ${maxScale} fraction digits and ${maxIntegerDigits} integer digits`,
    );
  }
  const coefficient = BigInt(`${match[1] ?? ""}${whole}${fraction}`);
  return { coefficient, scale: fraction.length };
}

function parsePositiveDecimal(value: string, field: string): ParsedDecimal {
  const parsed = parseDecimal(value, field, 12, 18);
  if (parsed.coefficient <= 0n) throw new RangeError(`${field} must be positive`);
  return parsed;
}

function parseMoney(value: string, field: string): bigint {
  const parsed = parseDecimal(value, field, 2, 18);
  return parsed.coefficient * 10n ** BigInt(2 - parsed.scale);
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const result = (absolute + denominator / 2n) / denominator;
  return negative ? -result : result;
}

function formatFixed(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = powerOfTen(scale);
  return `${negative ? "-" : ""}${absolute / divisor}.${(absolute % divisor).toString().padStart(scale, "0")}`;
}

export function validateEconomicSeries<T extends EconomicSeries>(series: T): T {
  if (series.id !== undefined) requireBoundedText(series.id, "series.id", 200);
  requireCode(series.code, "series.code");
  requireCountryCode(series.countryCode, "series.countryCode");
  requireCode(series.variantCode, "series.variantCode");
  requireCode(series.providerCode, "series.providerCode");
  requireBoundedText(series.externalSeriesId, "series.externalSeriesId", 200);
  requireBoundedText(series.name, "series.name", 200);
  requireBoundedText(series.methodology, "series.methodology", 4_000);
  if (series.frequency !== "DAILY" && series.frequency !== "MONTHLY") {
    throw new TypeError("series.frequency is invalid");
  }
  if (series.type === "EXCHANGE_RATE") {
    const base = requireCurrencyCode(series.baseCurrencyCode, "series.baseCurrencyCode");
    const quote = requireCurrencyCode(series.quoteCurrencyCode, "series.quoteCurrencyCode");
    if (base === quote) throw new TypeError("exchange-rate currencies must differ");
  } else if (series.type === "PRICE_INDEX") {
    if ("baseCurrencyCode" in series || "quoteCurrencyCode" in series) {
      throw new TypeError("price-index series must not define currencies");
    }
  } else {
    throw new TypeError("series.type is invalid");
  }
  if (series.sourceUrl !== undefined) {
    const sourceUrl = requireBoundedText(series.sourceUrl, "series.sourceUrl", 2_048);
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new TypeError("series.sourceUrl must be an absolute HTTPS URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new TypeError("series.sourceUrl must be an absolute HTTPS URL without credentials");
    }
  }
  return series;
}

export function validateEconomicObservation<T extends EconomicObservation>(observation: T): T {
  if (observation.id !== undefined) requireBoundedText(observation.id, "observation.id", 200);
  requireCode(observation.seriesCode, "observation.seriesCode");
  dateParts(observation.date, "observation.date");
  parsePositiveDecimal(observation.value, "observation.value");
  if (observation.revision !== undefined
      && (!Number.isSafeInteger(observation.revision) || observation.revision < 1)) {
    throw new TypeError("observation.revision must be a positive safe integer");
  }
  if (observation.observedAt !== undefined
      && (!ISO_TIMESTAMP.test(observation.observedAt) || !Number.isFinite(Date.parse(observation.observedAt)))) {
    throw new TypeError("observation.observedAt must be an ISO 8601 timestamp with timezone");
  }
  if (observation.observedAt !== undefined) dateParts(observation.observedAt.slice(0, 10), "observation.observedAt");
  if (observation.metadataNoSensitive !== undefined
      && (observation.metadataNoSensitive === null
        || typeof observation.metadataNoSensitive !== "object"
        || Array.isArray(observation.metadataNoSensitive))) {
    throw new TypeError("observation.metadataNoSensitive must be an object");
  }
  return observation;
}

export function validateEconomicDateRange(range: EconomicDateRange): EconomicDateRange {
  const from = epochDay(range.from, "range.from");
  const to = epochDay(range.to, "range.to");
  if (from > to) throw new RangeError("range.from must not be after range.to");
  return range;
}

export function selectExchangeRateDate(input: {
  readonly paymentDate?: string | null;
  readonly issueDate?: string | null;
  readonly payrollPeriod: string;
}): ExchangeRateDateSelection {
  const month = normalizeMonth(input.payrollPeriod, "payrollPeriod");
  const paymentDate = input.paymentDate ?? null;
  const issueDate = input.issueDate ?? null;
  if (paymentDate !== null) dateParts(paymentDate, "paymentDate");
  if (issueDate !== null) dateParts(issueDate, "issueDate");
  if (paymentDate !== null) {
    return { targetDate: paymentDate, method: "PAYMENT_DATE" };
  }
  if (issueDate !== null) {
    return { targetDate: issueDate, method: "ISSUE_DATE" };
  }
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return {
    targetDate: `${month}-${daysInMonth(year, monthNumber).toString().padStart(2, "0")}`,
    method: "PAYROLL_PERIOD_END",
  };
}

function assertSingleSeries(observations: readonly EconomicObservation[]): void {
  const seriesCode = observations[0]?.seriesCode;
  for (const observation of observations) {
    validateEconomicObservation(observation);
    if (observation.seriesCode !== seriesCode) throw new TypeError("observations must belong to one series");
  }
}

function newerRevision<T extends EconomicObservation>(candidate: T, current: T | null): T {
  return current === null || (candidate.revision ?? 0) > (current.revision ?? 0) ? candidate : current;
}

export function resolvePreviousDailyObservation<T extends EconomicObservation>(
  observations: readonly T[],
  targetDate: string,
  maxLookbackDays: number,
): T | null {
  if (!Number.isSafeInteger(maxLookbackDays)
      || maxLookbackDays < 0
      || maxLookbackDays > MAX_DAILY_OBSERVATION_LOOKBACK_DAYS) {
    throw new RangeError(`maxLookbackDays must be between 0 and ${MAX_DAILY_OBSERVATION_LOOKBACK_DAYS}`);
  }
  assertSingleSeries(observations);
  const target = epochDay(targetDate, "targetDate");
  let selected: T | null = null;
  let selectedDay = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const day = epochDay(observation.date, "observation.date");
    if (day > target || target - day > maxLookbackDays) continue;
    if (day > selectedDay) {
      selected = observation;
      selectedDay = day;
    } else if (day === selectedDay) {
      selected = newerRevision(observation, selected);
    }
  }
  return selected;
}

export function resolveMonthlyObservation<T extends EconomicObservation>(
  observations: readonly T[],
  payrollPeriod: string,
): T | null {
  assertSingleSeries(observations);
  const targetDate = `${normalizeMonth(payrollPeriod, "payrollPeriod")}-01`;
  let selected: T | null = null;
  for (const observation of observations) {
    if (!observation.date.endsWith("-01")) {
      throw new TypeError("monthly observations must use the first day of the month");
    }
    if (observation.date === targetDate) selected = newerRevision(observation, selected);
  }
  return selected;
}

export function convertMoney(input: {
  readonly amount: string;
  readonly fromCurrencyCode: string;
  readonly toCurrencyCode: string;
  readonly rate: ExchangeRateQuote | null;
}): string | null {
  const amount = parseMoney(input.amount, "amount");
  const from = requireCurrencyCode(input.fromCurrencyCode, "fromCurrencyCode");
  const to = requireCurrencyCode(input.toCurrencyCode, "toCurrencyCode");
  if (from === to) throw new TypeError("fromCurrencyCode and toCurrencyCode must differ");
  if (input.rate === null) return null;
  const base = requireCurrencyCode(input.rate.baseCurrencyCode, "rate.baseCurrencyCode");
  const quote = requireCurrencyCode(input.rate.quoteCurrencyCode, "rate.quoteCurrencyCode");
  if (base === quote) throw new TypeError("rate currencies must differ");
  const rate = parsePositiveDecimal(input.rate.value, "rate.value");
  if (from === base && to === quote) {
    return formatFixed(roundDivide(amount * rate.coefficient, powerOfTen(rate.scale)), 2);
  }
  if (from === quote && to === base) {
    return formatFixed(roundDivide(amount * powerOfTen(rate.scale), rate.coefficient), 2);
  }
  throw new TypeError("requested currencies do not match the exchange-rate pair");
}

export function adjustForPriceIndex(input: {
  readonly nominalAmount: string;
  readonly sourceIndex: string | null;
  readonly targetIndex: string | null;
}): string | null {
  const nominalAmount = parseMoney(input.nominalAmount, "nominalAmount");
  const source = input.sourceIndex === null ? null : parsePositiveDecimal(input.sourceIndex, "sourceIndex");
  const target = input.targetIndex === null ? null : parsePositiveDecimal(input.targetIndex, "targetIndex");
  if (source === null || target === null) return null;
  const numerator = nominalAmount * target.coefficient * powerOfTen(source.scale);
  const denominator = source.coefficient * powerOfTen(target.scale);
  return formatFixed(roundDivide(numerator, denominator), 2);
}

export function percentageChange(input: {
  readonly fromValue: string | null;
  readonly toValue: string | null;
}): string | null {
  const from = input.fromValue === null ? null : parseDecimal(input.fromValue, "fromValue", 12, 100);
  const to = input.toValue === null ? null : parseDecimal(input.toValue, "toValue", 12, 100);
  if (from === null || to === null) return null;
  const scale = Math.max(from.scale, to.scale);
  const fromCoefficient = from.coefficient * powerOfTen(scale - from.scale);
  const toCoefficient = to.coefficient * powerOfTen(scale - to.scale);
  if (fromCoefficient <= 0n) throw new RangeError("fromValue must be positive");
  if (toCoefficient < 0n) throw new RangeError("toValue must not be negative");
  return formatFixed(roundDivide((toCoefficient - fromCoefficient) * 10_000n, fromCoefficient), 2);
}
