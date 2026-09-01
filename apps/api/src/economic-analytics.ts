import {
  ARGENTINA_ARS_PROFILE,
  MAX_DAILY_OBSERVATION_LOOKBACK_DAYS,
  adjustForPriceIndex,
  convertMoney,
  economicProfileFor,
  percentageChange,
  selectExchangeRateDate,
  type EconomicProfile,
  type ExchangeRateDateSelectionMethod,
} from "@salarivo/economic-data";
import type {
  MonthlyEvolution,
  PeriodComparisonOptions,
  SalaryAmounts,
  SalaryScopeAnalytics,
  SalarySettlement,
} from "./salary-analytics.ts";

const AMOUNT_KEYS = [
  "basicAmount",
  "grossAmount",
  "netAmount",
  "deductionsAmount",
  "remunerativeAmount",
  "nonRemunerativeAmount",
] as const satisfies readonly (keyof SalaryAmounts)[];

const ACTIVE_JOB_STATES = new Set(["PENDING", "RUNNING", "RETRYABLE"]);
const MONEY = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

export type EconomicAvailabilityStatus = "AVAILABLE" | "PARTIAL" | "PENDING" | "UNAVAILABLE";
export type EconomicUnavailableReason =
  | "NOT_CONFIGURED"
  | "SYNC_PENDING"
  | "PROVIDER_UNAVAILABLE"
  | "NO_COVERAGE";

export interface EconomicSalarySettlement extends SalarySettlement {
  countryCode: string | null;
  paymentDate: string | null;
  issueDate: string | null;
}

export interface EconomicObservationReference {
  observationId: string;
  seriesCode: string;
  externalSeriesId: string;
  observationDate: string;
  requestedDate: string;
  selectionMethod: ExchangeRateDateSelectionMethod | "EXACT_PERIOD" | "LATEST_AVAILABLE";
  revision: number;
  source: string;
  sourceUrl: string;
  provider: string;
  methodology: string;
  licenseUrl: string;
  fetchedAt: string;
}

export interface EconomicProjection {
  status: EconomicAvailabilityStatus;
  reason: EconomicUnavailableReason | null;
  currencyCode: string;
  referencePeriod: string | null;
  amounts: SalaryAmounts | null;
  comparableSalary: string | null;
  observations: EconomicObservationReference[];
}

export interface EconomicPeriodProjection {
  historicalUsd: EconomicProjection;
  purchasingPower: EconomicProjection;
}

export interface EconomicComparisonProjection {
  status: EconomicAvailabilityStatus;
  reason: EconomicUnavailableReason | null;
  currencyCode: string;
  earlierComparableNetCents: string | null;
  laterComparableNetCents: string | null;
  changeCents: string | null;
  changeBasisPoints: string | null;
  referencePeriod: string | null;
  observations: EconomicObservationReference[];
}

export interface EconomicComparison {
  historicalUsd: EconomicComparisonProjection;
  purchasingPower: EconomicComparisonProjection;
  inflation: {
    status: EconomicAvailabilityStatus;
    reason: EconomicUnavailableReason | null;
    changeBasisPoints: string | null;
    observations: EconomicObservationReference[];
  };
}

export interface EconomicPeriodResult {
  public: EconomicPeriodProjection;
  sourcePriceIndex: string | null;
  sourcePriceIndexStatus: EconomicAvailabilityStatus;
  sourcePriceIndexReason: EconomicUnavailableReason | null;
  sourcePriceIndexObservations: EconomicObservationReference[];
}

export interface EconomicAnalyticsResult {
  byScopePeriod: ReadonlyMap<string, EconomicPeriodResult>;
}

export interface EconomicDataQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

type ObservationSelection = "PREVIOUS" | "EXACT" | "LATEST";
type ObservationRequest = {
  requestKey: string;
  seriesCode: string;
  selection: ObservationSelection;
  targetDate: string | null;
  lookbackDays: number;
};

type Snapshot = {
  request: ObservationRequest;
  seriesPresent: boolean;
  seriesStatus: string | null;
  seriesValidFrom: string | null;
  seriesValidTo: string | null;
  jobState: string | null;
  jobErrorCode: string | null;
  observation: {
    id: string;
    date: string;
    value: string;
    revision: number;
    fetchedAt: string;
    seriesCode: string;
    externalSeriesId: string;
    name: string;
    providerCode: string;
    sourceUrl: string;
    methodology: string;
    licenseUrl: string;
  } | null;
};

type RequiredObservation = {
  snapshot: Snapshot;
  requestedDate: string;
  method: EconomicObservationReference["selectionMethod"];
};

const observationSql = `WITH requested AS (
  SELECT *
    FROM jsonb_to_recordset($1::jsonb) AS request(
      request_key text,
      series_code text,
      selection text,
      target_date date,
      lookback_days integer
    )
)
SELECT request.request_key, request.series_code AS requested_series_code,
       request.selection, to_char(request.target_date, 'YYYY-MM-DD') AS target_date,
       request.lookback_days,
       series.id AS series_id, series.external_series_id, series.name, series.provider_code,
       series.source_url, series.methodology, series.status AS series_status,
       to_char(series.valid_from, 'YYYY-MM-DD') AS series_valid_from,
       to_char(series.valid_to, 'YYYY-MM-DD') AS series_valid_to,
       series.metadata_no_sensitive AS series_metadata,
       observation.id AS observation_id,
       to_char(observation.observation_date, 'YYYY-MM-DD') AS observation_date,
       observation.value::text AS observation_value, observation.revision,
       observation.metadata_no_sensitive AS observation_metadata,
       to_char(observation.fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS fetched_at,
       latest_job.state AS job_state, latest_job.error_code AS job_error_code
  FROM requested request
  LEFT JOIN economic_series series
    ON series.code = request.series_code
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.observation_date, candidate.value,
           candidate.revision, candidate.fetched_at, candidate.metadata_no_sensitive
      FROM economic_observations candidate
     WHERE candidate.series_id = series.id
       AND CASE request.selection
         WHEN 'LATEST' THEN true
         WHEN 'EXACT' THEN candidate.observation_date = request.target_date
         WHEN 'PREVIOUS' THEN candidate.observation_date <= request.target_date
           AND candidate.observation_date >= request.target_date - make_interval(days => request.lookback_days)
         ELSE false
       END
     ORDER BY candidate.observation_date DESC, candidate.revision DESC
     LIMIT 1
  ) observation ON true
  LEFT JOIN LATERAL (
    SELECT job.state, job.error_code
      FROM economic_sync_jobs job
     WHERE job.series_id = series.id
       AND (request.selection = 'LATEST'
         OR request.target_date BETWEEN job.range_start AND job.range_end)
     ORDER BY job.created_at DESC, job.id DESC
     LIMIT 1
  ) latest_job ON true
 ORDER BY request.request_key`;

function textValue(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function integerValue(row: Record<string, unknown>, key: string): number | null {
  const value = Number(row[key]);
  return Number.isSafeInteger(value) ? value : null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function loadEconomicSnapshot(
  queryable: EconomicDataQueryable,
  requests: readonly ObservationRequest[],
): Promise<ReadonlyMap<string, Snapshot>> {
  if (requests.length === 0) return new Map();
  const result = await queryable.query(observationSql, [JSON.stringify(requests.map((request) => ({
    request_key: request.requestKey,
    series_code: request.seriesCode,
    selection: request.selection,
    target_date: request.targetDate,
    lookback_days: request.lookbackDays,
  })))]);
  const byKey = new Map<string, Snapshot>();
  for (const row of result.rows) {
    const requestKey = textValue(row, "request_key");
    const seriesCode = textValue(row, "requested_series_code");
    const selection = textValue(row, "selection") as ObservationSelection | null;
    const lookbackDays = integerValue(row, "lookback_days");
    if (!requestKey || !seriesCode || !selection || lookbackDays === null) {
      throw new Error("ECONOMIC_SNAPSHOT_ROW_INVALID");
    }
    const seriesMetadata = parseMetadata(row.series_metadata);
    const observationMetadata = parseMetadata(row.observation_metadata);
    const observationId = textValue(row, "observation_id");
    const observationDate = textValue(row, "observation_date");
    const observationValue = textValue(row, "observation_value");
    const revision = integerValue(row, "revision");
    const fetchedAt = textValue(row, "fetched_at");
    byKey.set(requestKey, {
      request: {
        requestKey,
        seriesCode,
        selection,
        targetDate: textValue(row, "target_date"),
        lookbackDays,
      },
      seriesPresent: textValue(row, "series_id") !== null,
      seriesStatus: textValue(row, "series_status"),
      seriesValidFrom: textValue(row, "series_valid_from"),
      seriesValidTo: textValue(row, "series_valid_to"),
      jobState: textValue(row, "job_state"),
      jobErrorCode: textValue(row, "job_error_code"),
      observation: observationId && observationDate && observationValue && revision !== null && fetchedAt
        ? {
            id: observationId,
            date: observationDate,
            value: observationValue,
            revision,
            fetchedAt,
            seriesCode,
            externalSeriesId: textValue(row, "external_series_id") ?? "",
            name: typeof observationMetadata.source === "string"
              ? observationMetadata.source
              : textValue(row, "name") ?? seriesCode,
            providerCode: textValue(row, "provider_code") ?? "",
            sourceUrl: textValue(row, "source_url") ?? "",
            methodology: textValue(row, "methodology") ?? "",
            licenseUrl: typeof seriesMetadata.licenseUrl === "string" ? seriesMetadata.licenseUrl : "",
          }
        : null,
    });
  }
  return byKey;
}

export function scopePeriodKey(context: string | null | undefined, currencyCode: string, period: string): string {
  return JSON.stringify([context ?? null, currencyCode, period]);
}

function fxRequestKey(seriesCode: string, date: string): string {
  return `FX:${seriesCode}:${date}`;
}

function priceIndexRequestKey(seriesCode: string, period: string): string {
  return `CPI:${seriesCode}:${period}`;
}

function latestPriceIndexRequestKey(seriesCode: string): string {
  return `CPI:${seriesCode}:LATEST`;
}

function unavailableProjection(
  currencyCode: string,
  reason: EconomicUnavailableReason,
  status: EconomicAvailabilityStatus = reason === "SYNC_PENDING" ? "PENDING" : "UNAVAILABLE",
): EconomicProjection {
  return {
    status,
    reason,
    currencyCode,
    referencePeriod: null,
    amounts: null,
    comparableSalary: null,
    observations: [],
  };
}

function missingReason(required: readonly RequiredObservation[]): EconomicUnavailableReason | null {
  const missing = required.filter((item) => item.snapshot.observation === null);
  if (missing.length === 0) return null;
  if (missing.some((item) => item.snapshot.seriesStatus === "DISCONTINUED")) return "NO_COVERAGE";
  if (missing.some((item) => !item.snapshot.seriesPresent)) return "SYNC_PENDING";
  if (missing.some(({ snapshot }) => {
    const target = snapshot.request.targetDate;
    return target !== null && (
      (snapshot.seriesValidFrom !== null && target < snapshot.seriesValidFrom)
      || (snapshot.seriesValidTo !== null && target > snapshot.seriesValidTo)
    );
  })) return "NO_COVERAGE";
  if (missing.some((item) => ACTIVE_JOB_STATES.has(item.snapshot.jobState ?? ""))) {
    return "SYNC_PENDING";
  }
  if (missing.some((item) => item.snapshot.jobState === "FAILED" || item.snapshot.jobErrorCode !== null)) {
    return "PROVIDER_UNAVAILABLE";
  }
  if (missing.some((item) => item.snapshot.seriesStatus === "ACTIVE" && item.snapshot.jobState === null)) {
    return "SYNC_PENDING";
  }
  return "NO_COVERAGE";
}

function projectionStatus(required: readonly RequiredObservation[]): {
  status: EconomicAvailabilityStatus;
  reason: EconomicUnavailableReason | null;
} {
  const reason = missingReason(required);
  if (reason === null) return { status: "AVAILABLE", reason: null };
  const anyAvailable = required.some((item) => item.snapshot.observation !== null);
  return {
    status: anyAvailable ? "PARTIAL" : reason === "SYNC_PENDING" ? "PENDING" : "UNAVAILABLE",
    reason,
  };
}

function reference(required: RequiredObservation): EconomicObservationReference | null {
  const observation = required.snapshot.observation;
  if (!observation) return null;
  return {
    observationId: observation.id,
    seriesCode: observation.seriesCode,
    externalSeriesId: observation.externalSeriesId,
    observationDate: observation.date,
    requestedDate: required.requestedDate,
    selectionMethod: required.method,
    revision: observation.revision,
    source: observation.name,
    sourceUrl: observation.sourceUrl,
    provider: observation.providerCode,
    methodology: observation.methodology,
    licenseUrl: observation.licenseUrl,
    fetchedAt: observation.fetchedAt,
  };
}

function uniqueReferences(required: readonly RequiredObservation[]): EconomicObservationReference[] {
  const result = new Map<string, EconomicObservationReference>();
  for (const item of required) {
    const value = reference(item);
    if (!value) continue;
    result.set(JSON.stringify([
      value.observationId,
      value.revision,
      value.requestedDate,
      value.selectionMethod,
    ]), value);
  }
  return [...result.values()].sort((left, right) => (
    left.seriesCode.localeCompare(right.seriesCode)
      || left.requestedDate.localeCompare(right.requestedDate)
      || left.observationDate.localeCompare(right.observationDate)
  ));
}

function moneyCents(value: string): bigint {
  const match = MONEY.exec(value);
  const whole = match?.[2];
  if (!match || whole === undefined) throw new TypeError("money must have at most two decimal places");
  const cents = BigInt(whole) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

function formatMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function sumTransformed(
  settlements: readonly EconomicSalarySettlement[],
  key: keyof SalaryAmounts,
  transform: (settlement: EconomicSalarySettlement, amount: string) => string | null,
): string | null {
  let total = 0n;
  for (const settlement of settlements) {
    const amount = settlement[key];
    if (amount === null || amount === undefined) return null;
    const transformed = transform(settlement, amount);
    if (transformed === null) return null;
    total += moneyCents(transformed);
  }
  return formatMoney(total);
}

function transformedAmounts(
  settlements: readonly EconomicSalarySettlement[],
  transform: (settlement: EconomicSalarySettlement, amount: string) => string | null,
): SalaryAmounts {
  return Object.fromEntries(AMOUNT_KEYS.map((key) => [
    key,
    sumTransformed(settlements, key, transform),
  ])) as unknown as SalaryAmounts;
}

function comparableSalary(
  settlements: readonly EconomicSalarySettlement[],
  transform: (settlement: EconomicSalarySettlement, amount: string) => string | null,
): string | null {
  const regular = settlements.filter((settlement) => (
    settlement.settlementType.toUpperCase() === "NORMAL" && settlement.isRecurring
  ));
  if (regular.length === 0 || regular.some((settlement) => settlement.basicAmount === null
    || settlement.basicAmount === undefined)) return null;
  if (new Set(regular.map((settlement) => settlement.basicAmount)).size !== 1) return null;
  const converted = regular.map((settlement) => transform(settlement, settlement.basicAmount!));
  if (converted.some((amount) => amount === null) || new Set(converted).size !== 1) return null;
  return converted[0] ?? null;
}

function makeRequests(settlements: readonly EconomicSalarySettlement[]): ObservationRequest[] {
  const requests = new Map<string, ObservationRequest>();
  for (const settlement of settlements) {
    const profile = economicProfileFor(settlement.countryCode, settlement.currencyCode);
    if (!profile) continue;
    const selected = selectExchangeRateDate(settlement);
    requests.set(fxRequestKey(profile.exchangeRateSeriesCode, selected.targetDate), {
      requestKey: fxRequestKey(profile.exchangeRateSeriesCode, selected.targetDate),
      seriesCode: profile.exchangeRateSeriesCode,
      selection: "PREVIOUS",
      targetDate: selected.targetDate,
      lookbackDays: MAX_DAILY_OBSERVATION_LOOKBACK_DAYS,
    });
    requests.set(priceIndexRequestKey(profile.priceIndexSeriesCode, settlement.payrollPeriod), {
      requestKey: priceIndexRequestKey(profile.priceIndexSeriesCode, settlement.payrollPeriod),
      seriesCode: profile.priceIndexSeriesCode,
      selection: "EXACT",
      targetDate: `${settlement.payrollPeriod}-01`,
      lookbackDays: 0,
    });
    requests.set(latestPriceIndexRequestKey(profile.priceIndexSeriesCode), {
      requestKey: latestPriceIndexRequestKey(profile.priceIndexSeriesCode),
      seriesCode: profile.priceIndexSeriesCode,
      selection: "LATEST",
      targetDate: null,
      lookbackDays: 0,
    });
  }
  return [...requests.values()];
}

function requiredFx(
  settlement: EconomicSalarySettlement,
  profile: EconomicProfile,
  snapshot: ReadonlyMap<string, Snapshot>,
): RequiredObservation {
  const selected = selectExchangeRateDate(settlement);
  const resolved = snapshot.get(fxRequestKey(profile.exchangeRateSeriesCode, selected.targetDate));
  if (!resolved) throw new Error("ECONOMIC_SNAPSHOT_REQUEST_MISSING");
  return { snapshot: resolved, requestedDate: selected.targetDate, method: selected.method };
}

function requiredPriceIndex(
  settlement: EconomicSalarySettlement,
  profile: EconomicProfile,
  snapshot: ReadonlyMap<string, Snapshot>,
): RequiredObservation {
  const resolved = snapshot.get(priceIndexRequestKey(profile.priceIndexSeriesCode, settlement.payrollPeriod));
  if (!resolved) throw new Error("ECONOMIC_SNAPSHOT_REQUEST_MISSING");
  return { snapshot: resolved, requestedDate: `${settlement.payrollPeriod}-01`, method: "EXACT_PERIOD" };
}

function latestPriceIndex(
  profile: EconomicProfile,
  snapshot: ReadonlyMap<string, Snapshot>,
): RequiredObservation {
  const resolved = snapshot.get(latestPriceIndexRequestKey(profile.priceIndexSeriesCode));
  if (!resolved) throw new Error("ECONOMIC_SNAPSHOT_REQUEST_MISSING");
  return {
    snapshot: resolved,
    requestedDate: resolved.observation?.date ?? "latest",
    method: "LATEST_AVAILABLE",
  };
}

function makePeriodResult(
  settlements: readonly EconomicSalarySettlement[],
  snapshot: ReadonlyMap<string, Snapshot>,
): EconomicPeriodResult {
  const profiles = settlements.map((settlement) => economicProfileFor(
    settlement.countryCode,
    settlement.currencyCode,
  ));
  const profile = profiles[0] ?? null;
  if (!profile || profiles.some((candidate) => candidate?.code !== profile.code)) {
    return {
      public: {
        historicalUsd: unavailableProjection(ARGENTINA_ARS_PROFILE.referenceCurrencyCode, "NOT_CONFIGURED"),
        purchasingPower: unavailableProjection(settlements[0]?.currencyCode ?? ARGENTINA_ARS_PROFILE.currencyCode, "NOT_CONFIGURED"),
      },
      sourcePriceIndex: null,
      sourcePriceIndexStatus: "UNAVAILABLE",
      sourcePriceIndexReason: "NOT_CONFIGURED",
      sourcePriceIndexObservations: [],
    };
  }

  const fxRequired = settlements.map((settlement) => requiredFx(settlement, profile, snapshot));
  const fxAvailability = projectionStatus(fxRequired);
  const fxFor = (settlement: EconomicSalarySettlement, amount: string) => {
    const observation = requiredFx(settlement, profile, snapshot).snapshot.observation;
    return convertMoney({
      amount,
      fromCurrencyCode: profile.currencyCode,
      toCurrencyCode: profile.referenceCurrencyCode,
      rate: observation && {
        baseCurrencyCode: profile.referenceCurrencyCode,
        quoteCurrencyCode: profile.currencyCode,
        value: observation.value,
      },
    });
  };
  const historicalUsd: EconomicProjection = {
    ...fxAvailability,
    currencyCode: profile.referenceCurrencyCode,
    referencePeriod: null,
    amounts: fxRequired.some((required) => required.snapshot.observation !== null)
      ? transformedAmounts(settlements, fxFor)
      : null,
    comparableSalary: comparableSalary(settlements, fxFor),
    observations: uniqueReferences(fxRequired),
  };

  const sourceRequired = settlements.map((settlement) => requiredPriceIndex(settlement, profile, snapshot));
  const sourcePriceAvailability = projectionStatus(sourceRequired);
  const targetRequired = latestPriceIndex(profile, snapshot);
  const priceRequired = [...sourceRequired, targetRequired];
  const priceAvailability = projectionStatus(priceRequired);
  const priceFor = (settlement: EconomicSalarySettlement, amount: string) => adjustForPriceIndex({
    nominalAmount: amount,
    sourceIndex: requiredPriceIndex(settlement, profile, snapshot).snapshot.observation?.value ?? null,
    targetIndex: targetRequired.snapshot.observation?.value ?? null,
  });
  const purchasingPower: EconomicProjection = {
    ...priceAvailability,
    currencyCode: profile.currencyCode,
    referencePeriod: targetRequired.snapshot.observation?.date.slice(0, 7) ?? null,
    amounts: priceRequired.some((required) => required.snapshot.observation !== null)
      ? transformedAmounts(settlements, priceFor)
      : null,
    comparableSalary: comparableSalary(settlements, priceFor),
    observations: uniqueReferences(priceRequired),
  };

  return {
    public: { historicalUsd, purchasingPower },
    sourcePriceIndex: sourceRequired[0]?.snapshot.observation?.value ?? null,
    sourcePriceIndexStatus: sourcePriceAvailability.status,
    sourcePriceIndexReason: sourcePriceAvailability.reason,
    sourcePriceIndexObservations: uniqueReferences(sourceRequired),
  };
}

export async function buildEconomicAnalytics(
  queryable: EconomicDataQueryable,
  settlements: readonly EconomicSalarySettlement[],
): Promise<EconomicAnalyticsResult> {
  const requests = makeRequests(settlements);
  const snapshot = await loadEconomicSnapshot(queryable, requests);
  const grouped = new Map<string, EconomicSalarySettlement[]>();
  for (const settlement of settlements) {
    const key = scopePeriodKey(settlement.employmentContext, settlement.currencyCode, settlement.payrollPeriod);
    const group = grouped.get(key) ?? [];
    group.push(settlement);
    grouped.set(key, group);
  }
  return {
    byScopePeriod: new Map([...grouped].map(([key, entries]) => [key, makePeriodResult(entries, snapshot)])),
  };
}

export function addEconomicProjections(
  scopes: readonly SalaryScopeAnalytics[],
  economics: EconomicAnalyticsResult,
): Array<SalaryScopeAnalytics & { evolution: Array<MonthlyEvolution & { economic: EconomicPeriodProjection }> }> {
  return scopes.map((scope) => ({
    ...scope,
    evolution: scope.evolution.map((point) => ({
      ...point,
      economic: economics.byScopePeriod.get(scopePeriodKey(
        scope.employmentContext,
        scope.currencyCode,
        point.period,
      ))?.public ?? {
        historicalUsd: unavailableProjection(ARGENTINA_ARS_PROFILE.referenceCurrencyCode, "NOT_CONFIGURED"),
        purchasingPower: unavailableProjection(scope.currencyCode, "NOT_CONFIGURED"),
      },
    })),
  }));
}

function moneyAsCents(value: string | null): string | null {
  return value === null ? null : moneyCents(value).toString();
}

function subtractMoneyCents(from: string | null, to: string | null): string | null {
  return from === null || to === null ? null : (moneyCents(to) - moneyCents(from)).toString();
}

function percentageAsBasisPoints(value: string | null): string | null {
  return value === null ? null : moneyCents(value).toString();
}

function moneyPercentage(from: string | null, to: string | null): string | null {
  if (from === null || to === null || moneyCents(from) <= 0n || moneyCents(to) < 0n) return null;
  return percentageChange({ fromValue: from, toValue: to });
}

function combineProjection(
  from: EconomicProjection,
  to: EconomicProjection,
): Pick<EconomicComparisonProjection, "status" | "reason"> {
  if (from.status === "AVAILABLE" && to.status === "AVAILABLE"
    && from.comparableSalary !== null && to.comparableSalary !== null) {
    return { status: "AVAILABLE", reason: null };
  }
  if (from.status === "PENDING" || to.status === "PENDING") {
    return { status: "PENDING", reason: "SYNC_PENDING" };
  }
  const reason = from.reason ?? to.reason;
  if (from.status === "UNAVAILABLE" && to.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reason };
  return { status: "PARTIAL", reason };
}

function uniqueObservationReferences(
  references: readonly EconomicObservationReference[],
): EconomicObservationReference[] {
  return [...new Map(references.map((reference) => [JSON.stringify([
    reference.observationId,
    reference.revision,
    reference.requestedDate,
    reference.selectionMethod,
  ]), reference])).values()];
}

export function compareEconomicPeriods(
  economics: EconomicAnalyticsResult,
  options: PeriodComparisonOptions,
): EconomicComparison | null {
  const from = economics.byScopePeriod.get(scopePeriodKey(
    options.employmentContext,
    options.currencyCode,
    options.fromPeriod,
  ));
  const to = economics.byScopePeriod.get(scopePeriodKey(
    options.employmentContext,
    options.currencyCode,
    options.toPeriod,
  ));
  if (!from || !to) return null;

  const comparison = (key: keyof EconomicPeriodProjection): EconomicComparisonProjection => {
    const earlier = from.public[key];
    const later = to.public[key];
    const earlierNet = earlier.amounts?.netAmount ?? null;
    const laterNet = later.amounts?.netAmount ?? null;
    return {
      ...combineProjection(
        { ...earlier, comparableSalary: earlierNet },
        { ...later, comparableSalary: laterNet },
      ),
      currencyCode: later.currencyCode,
      earlierComparableNetCents: moneyAsCents(earlierNet),
      laterComparableNetCents: moneyAsCents(laterNet),
      changeCents: subtractMoneyCents(earlierNet, laterNet),
      changeBasisPoints: percentageAsBasisPoints(moneyPercentage(earlierNet, laterNet)),
      referencePeriod: later.referencePeriod ?? earlier.referencePeriod,
      observations: uniqueObservationReferences([...earlier.observations, ...later.observations]),
    };
  };

  const fromPrice = from.public.purchasingPower;
  const toPrice = to.public.purchasingPower;
  const inflationChange = percentageChange({ fromValue: from.sourcePriceIndex, toValue: to.sourcePriceIndex });
  const inflationAvailability = combineProjection(
    {
      ...fromPrice,
      status: from.sourcePriceIndexStatus,
      reason: from.sourcePriceIndexReason,
      comparableSalary: from.sourcePriceIndex,
    },
    {
      ...toPrice,
      status: to.sourcePriceIndexStatus,
      reason: to.sourcePriceIndexReason,
      comparableSalary: to.sourcePriceIndex,
    },
  );
  return {
    historicalUsd: comparison("historicalUsd"),
    purchasingPower: comparison("purchasingPower"),
    inflation: {
      ...inflationAvailability,
      changeBasisPoints: percentageAsBasisPoints(inflationChange),
      observations: uniqueObservationReferences([
        ...from.sourcePriceIndexObservations,
        ...to.sourcePriceIndexObservations,
      ]),
    },
  };
}
