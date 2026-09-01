import assert from "node:assert/strict";
import test from "node:test";

import {
  ARGENTINA_ARS_PROFILE,
  ECONOMIC_SERIES_CODES,
  ECONOMIC_PROFILES,
  MAX_DAILY_OBSERVATION_LOOKBACK_DAYS,
  adjustForPriceIndex,
  convertMoney,
  economicProfileFor,
  percentageChange,
  resolveMonthlyObservation,
  resolvePreviousDailyObservation,
  selectExchangeRateDate,
  validateEconomicDateRange,
  validateEconomicObservation,
  validateEconomicSeries,
  type EconomicObservation,
  type ExchangeRateProvider,
  type ExchangeRateSeries,
  type PriceIndexProvider,
  type PriceIndexSeries,
} from "../src/index.ts";

const fxSeries: ExchangeRateSeries = {
  code: ECONOMIC_SERIES_CODES.AR_REFERENCE_USD_ARS,
  type: "EXCHANGE_RATE",
  frequency: "DAILY",
  countryCode: "AR",
  baseCurrencyCode: "USD",
  quoteCurrencyCode: "ARS",
  variantCode: "REFERENCE",
  providerCode: "OFFICIAL_PROVIDER",
  externalSeriesId: "synthetic-fx-series",
  name: "Synthetic USD/ARS reference",
  methodology: "Synthetic fixture for deterministic unit tests.",
};

const priceIndexSeries: PriceIndexSeries = {
  code: ECONOMIC_SERIES_CODES.AR_GENERAL_PRICE_INDEX,
  type: "PRICE_INDEX",
  frequency: "MONTHLY",
  countryCode: "AR",
  variantCode: "GENERAL",
  providerCode: "OFFICIAL_PROVIDER",
  externalSeriesId: "synthetic-price-index",
  name: "Synthetic general price index",
  methodology: "Synthetic fixture for deterministic unit tests.",
};

function observation(
  date: string,
  value = "1000.000000000000",
  revision = 1,
  extra: Partial<EconomicObservation> = {},
): EconomicObservation {
  return {
    seriesCode: fxSeries.code,
    date,
    value,
    revision,
    observedAt: "2026-09-01T12:00:00-03:00",
    ...extra,
  };
}

test("keeps the initial AR/ARS profile generic and provider-independent", () => {
  assert.deepEqual(ARGENTINA_ARS_PROFILE, {
    code: "PROFILE.AR.ARS",
    countryCode: "AR",
    currencyCode: "ARS",
    referenceCurrencyCode: "USD",
    exchangeRateSeriesCode: "FX.AR.USD.ARS.REFERENCE",
    priceIndexSeriesCode: "PRICE_INDEX.AR.GENERAL",
  });
  assert.equal(Object.isFrozen(ARGENTINA_ARS_PROFILE), true);
  assert.equal(ARGENTINA_ARS_PROFILE.exchangeRateSeriesCode.includes("PROVIDER"), false);
  assert.deepEqual(ECONOMIC_PROFILES, [ARGENTINA_ARS_PROFILE]);
  assert.equal(economicProfileFor("AR", "ARS"), ARGENTINA_ARS_PROFILE);
  assert.equal(economicProfileFor("AR", "USD"), null);
  assert.equal(economicProfileFor(null, "ARS"), null);
});

test("provider contracts fetch only a series range and receive the caller AbortSignal", async () => {
  const controller = new AbortController();
  const fxProvider: ExchangeRateProvider = {
    async fetchRange(series, range, signal) {
      assert.equal(series, fxSeries);
      assert.deepEqual(validateEconomicDateRange(range), range);
      assert.equal(signal, controller.signal);
      return [];
    },
  };
  const cpiProvider: PriceIndexProvider = {
    async fetchRange(series, range, signal) {
      assert.equal(series, priceIndexSeries);
      assert.deepEqual(validateEconomicDateRange(range), range);
      assert.equal(signal, controller.signal);
      return [];
    },
  };
  const range = { from: "2024-01-01", to: "2024-12-31" };
  await fxProvider.fetchRange(fxSeries, range, controller.signal);
  await cpiProvider.fetchRange(priceIndexSeries, range, controller.signal);
});

test("validates series, observations and ordered date ranges", () => {
  assert.equal(validateEconomicSeries(fxSeries), fxSeries);
  assert.equal(validateEconomicSeries(priceIndexSeries), priceIndexSeries);
  assert.throws(
    () => validateEconomicSeries({ ...fxSeries, baseCurrencyCode: "ARS", quoteCurrencyCode: "ARS" }),
    /currencies must differ/,
  );
  assert.throws(() => validateEconomicSeries({ ...fxSeries, countryCode: "arg" }), /ISO 3166/);
  assert.throws(() => validateEconomicSeries({ ...fxSeries, sourceUrl: "https://secret@example.test" }), /credentials/);
  assert.throws(() => validateEconomicSeries({ ...fxSeries, sourceUrl: "http://example.test" }), /HTTPS/);
  assert.throws(() => validateEconomicSeries({
    ...priceIndexSeries,
    baseCurrencyCode: "ARS",
  } as PriceIndexSeries), /must not define currencies/);
  assert.throws(() => validateEconomicDateRange({ from: "2025-01-01", to: "2024-12-31" }), /must not be after/);
  assert.throws(() => validateEconomicDateRange({ from: "2024-02-30", to: "2024-03-01" }), /valid/);
  assert.throws(() => validateEconomicObservation(observation("2024-01-01", "0")), /positive/);
  assert.throws(() => validateEconomicObservation(observation("2024-01-01", "1.0000000000001")), /at most 12/);
  assert.throws(() => validateEconomicObservation(observation("2024-01-01", "1234567890123456789")), /18 integer/);
  assert.throws(() => validateEconomicObservation({ ...observation("2024-01-01"), revision: 0 }), /positive/);
  assert.throws(() => validateEconomicObservation({
    ...observation("2024-01-01"),
    observedAt: "2024-02-30T00:00:00Z",
  }), /valid YYYY-MM-DD/);
  assert.throws(() => validateEconomicObservation({
    ...observation("2024-01-01"),
    metadataNoSensitive: "not-an-object" as unknown as Readonly<Record<string, unknown>>,
  }), /must be an object/);
});

test("selects payment date, then issue date, then the civil month end", () => {
  assert.deepEqual(selectExchangeRateDate({
    paymentDate: "2024-12-05",
    issueDate: "2024-11-29",
    payrollPeriod: "2024-11-01",
  }), { targetDate: "2024-12-05", method: "PAYMENT_DATE" });
  assert.deepEqual(selectExchangeRateDate({
    paymentDate: null,
    issueDate: "2025-01-02",
    payrollPeriod: "2024-12",
  }), { targetDate: "2025-01-02", method: "ISSUE_DATE" });
  assert.deepEqual(selectExchangeRateDate({ payrollPeriod: "2024-02" }), {
    targetDate: "2024-02-29",
    method: "PAYROLL_PERIOD_END",
  });
  assert.deepEqual(selectExchangeRateDate({ payrollPeriod: "2100-02" }), {
    targetDate: "2100-02-28",
    method: "PAYROLL_PERIOD_END",
  });
  assert.throws(() => selectExchangeRateDate({
    paymentDate: "2024-12-05",
    issueDate: "2024-02-30",
    payrollPeriod: "2024-11",
  }), /issueDate/);
});

test("date selection is timezone-free and rejects timestamps instead of shifting their day", () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati";
    const east = selectExchangeRateDate({ payrollPeriod: "2024-12" });
    process.env.TZ = "America/Argentina/Buenos_Aires";
    assert.deepEqual(selectExchangeRateDate({ payrollPeriod: "2024-12" }), east);
    assert.deepEqual(east, { targetDate: "2024-12-31", method: "PAYROLL_PERIOD_END" });
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
  assert.throws(() => selectExchangeRateDate({
    paymentDate: "2025-01-01T00:30:00+14:00",
    payrollPeriod: "2024-12",
  }), /YYYY-MM-DD/);
});

test("resolves the previous daily observation across weekends and keeps latest-revision metadata", () => {
  const olderRevision = observation("2024-11-29", "1000", 1, { id: "old" });
  const metadataNoSensitive = { providerRecord: "synthetic-2" };
  const latestRevision = observation("2024-11-29", "1001", 2, { id: "latest", metadataNoSensitive });
  const resolved = resolvePreviousDailyObservation(
    [observation("2024-12-02"), olderRevision, latestRevision],
    "2024-12-01",
    MAX_DAILY_OBSERVATION_LOOKBACK_DAYS,
  );
  assert.equal(resolved, latestRevision);
  assert.equal(resolved?.id, "latest");
  assert.equal(resolved?.revision, 2);
  assert.equal(resolved?.metadataNoSensitive, metadataNoSensitive);
});

test("daily lookback handles year changes, never looks forward and is capped at seven days", () => {
  const previousYear = observation("2024-12-30");
  assert.equal(resolvePreviousDailyObservation(
    [observation("2025-01-02"), previousYear],
    "2025-01-01",
    7,
  ), previousYear);
  assert.equal(resolvePreviousDailyObservation([observation("2024-12-24")], "2025-01-01", 7), null);
  assert.equal(resolvePreviousDailyObservation([], "2025-01-01", 7), null);
  assert.throws(() => resolvePreviousDailyObservation([], "2025-01-01", 8), /between 0 and 7/);
  assert.throws(() => resolvePreviousDailyObservation([
    observation("2025-01-01"),
    observation("2025-01-01", "1", 1, { seriesCode: "FX.US.EUR.USD.REFERENCE" }),
  ], "2025-01-01", 7), /one series/);
});

test("monthly resolution requires the exact period and does not interpolate", () => {
  const firstRevision = observation("2024-11-01", "200", 1, { seriesCode: priceIndexSeries.code });
  const latestRevision = observation("2024-11-01", "201", 2, {
    id: "cpi-latest",
    seriesCode: priceIndexSeries.code,
  });
  assert.equal(resolveMonthlyObservation([
    observation("2024-10-01", "190", 1, { seriesCode: priceIndexSeries.code }),
    firstRevision,
    latestRevision,
  ], "2024-11"), latestRevision);
  assert.equal(resolveMonthlyObservation([firstRevision], "2024-12-01"), null);
  assert.throws(() => resolveMonthlyObservation([
    observation("2024-11-15", "201", 1, { seriesCode: priceIndexSeries.code }),
  ], "2024-11"), /first day/);
});

test("converts quotes defined as one base currency equals value quote currency in both directions", () => {
  const rate = { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "1000" };
  assert.equal(convertMoney({ amount: "1000000.00", fromCurrencyCode: "ARS", toCurrencyCode: "USD", rate }), "1000.00");
  assert.equal(convertMoney({ amount: "1000.00", fromCurrencyCode: "USD", toCurrencyCode: "ARS", rate }), "1000000.00");
});

test("conversion keeps twelve-decimal precision, rounds half away from zero and supports huge amounts", () => {
  assert.equal(convertMoney({
    amount: "1.00",
    fromCurrencyCode: "USD",
    toCurrencyCode: "ARS",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "1234.567890123456" },
  }), "1234.57");
  assert.equal(convertMoney({
    amount: "1.00",
    fromCurrencyCode: "ARS",
    toCurrencyCode: "USD",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "200" },
  }), "0.01");
  assert.equal(convertMoney({
    amount: "-1.00",
    fromCurrencyCode: "USD",
    toCurrencyCode: "ARS",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "1.005" },
  }), "-1.01");
  assert.equal(convertMoney({
    amount: "9007199254740993.99",
    fromCurrencyCode: "USD",
    toCurrencyCode: "ARS",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "2" },
  }), "18014398509481987.98");
});

test("conversion reports missing data without inventing a rate and rejects invalid pairs and decimals", () => {
  assert.equal(convertMoney({ amount: "1.00", fromCurrencyCode: "ARS", toCurrencyCode: "USD", rate: null }), null);
  assert.throws(() => convertMoney({
    amount: "1.001",
    fromCurrencyCode: "ARS",
    toCurrencyCode: "USD",
    rate: null,
  }), /at most 2/);
  assert.throws(() => convertMoney({
    amount: "1.00",
    fromCurrencyCode: "EUR",
    toCurrencyCode: "ARS",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "1000" },
  }), /do not match/);
  assert.throws(() => convertMoney({
    amount: "1.00",
    fromCurrencyCode: "ARS",
    toCurrencyCode: "USD",
    rate: { baseCurrencyCode: "USD", quoteCurrencyCode: "ARS", value: "0" },
  }), /positive/);
});

test("adjusts nominal money with nominal × target index / source index", () => {
  assert.equal(adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: "100", targetIndex: "150" }), "150.00");
  assert.equal(adjustForPriceIndex({ nominalAmount: "123.45", sourceIndex: "250.125", targetIndex: "250.125" }), "123.45");
  assert.equal(adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: "3", targetIndex: "2" }), "66.67");
  assert.equal(adjustForPriceIndex({ nominalAmount: "9007199254740993.99", sourceIndex: "100", targetIndex: "200" }), "18014398509481987.98");
});

test("real change is ratio-based rather than nominal change minus inflation", () => {
  const oldAtNewPrices = adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: "100", targetIndex: "150" });
  assert.equal(oldAtNewPrices, "150.00");
  assert.equal(percentageChange({ fromValue: oldAtNewPrices, toValue: "120.00" }), "-20.00");
  assert.equal(percentageChange({ fromValue: oldAtNewPrices, toValue: "180.00" }), "20.00");
  assert.equal(percentageChange({ fromValue: "100.00", toValue: "100.00" }), "0.00");
});

test("percentage change is exact for large values and missing indexes remain missing", () => {
  assert.equal(percentageChange({
    fromValue: "9007199254740993.00",
    toValue: "9907919180215092.30",
  }), "10.00");
  assert.equal(percentageChange({ fromValue: null, toValue: "100" }), null);
  assert.equal(percentageChange({ fromValue: "100", toValue: null }), null);
  assert.equal(adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: null, targetIndex: "150" }), null);
  assert.equal(adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: "100", targetIndex: null }), null);
  assert.throws(() => adjustForPriceIndex({ nominalAmount: "100.00", sourceIndex: "0", targetIndex: "150" }), /positive/);
  assert.throws(() => percentageChange({ fromValue: "0", toValue: "1" }), /positive/);
});
