import assert from "node:assert/strict";
import test from "node:test";

import {
  addEconomicProjections,
  buildEconomicAnalytics,
  compareEconomicPeriods,
  scopePeriodKey,
  type EconomicDataQueryable,
  type EconomicSalarySettlement,
} from "../src/economic-analytics.ts";
import { analyzeSalaryHistory } from "../src/salary-analytics.ts";

function settlement(overrides: Partial<EconomicSalarySettlement> = {}): EconomicSalarySettlement {
  return {
    id: "settlement-1",
    documentId: "document-1",
    employmentId: "employment-1",
    employmentContext: "employment-1",
    countryCode: "AR",
    currencyCode: "ARS",
    payrollPeriod: "2024-01",
    paymentDate: "2024-02-04",
    issueDate: "2024-01-31",
    settlementType: "NORMAL",
    isRecurring: true,
    basicAmount: "100000.00",
    grossAmount: "100000.00",
    netAmount: "80000.00",
    deductionsAmount: "20000.00",
    remunerativeAmount: "100000.00",
    nonRemunerativeAmount: "0.00",
    ...overrides,
  };
}

function economicRow(request: Record<string, unknown>): Record<string, unknown> {
  const seriesCode = String(request.series_code);
  const isFx = seriesCode.startsWith("FX.");
  const selection = String(request.selection);
  const targetDate = request.target_date === null ? null : String(request.target_date);
  const observationDate = selection === "LATEST"
    ? "2024-02-01"
    : isFx
      ? targetDate === "2024-02-04" ? "2024-02-02" : targetDate
      : targetDate;
  const observationValue = isFx
    ? targetDate === "2024-03-01" ? "1200.000000000000" : "1000.000000000000"
    : observationDate === "2024-01-01" ? "100.000000000000"
    : observationDate === "2024-02-01" ? "120.000000000000"
    : "150.000000000000";
  return {
    request_key: request.request_key,
    requested_series_code: seriesCode,
    selection,
    target_date: targetDate,
    lookback_days: request.lookback_days,
    series_id: isFx ? "series-fx" : "series-cpi",
    external_series_id: isFx ? "synthetic-fx" : "synthetic-cpi",
    name: isFx ? "Synthetic exchange rate" : "Synthetic price index",
    provider_code: "SYNTHETIC",
    source_url: "https://example.test/source",
    methodology: "Synthetic fixture.",
    series_status: "ACTIVE",
    series_valid_from: isFx ? "2002-03-04" : "2016-12-01",
    series_valid_to: null,
    series_metadata: { licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
    observation_id: `${seriesCode}:${observationDate}`,
    observation_date: observationDate,
    observation_value: observationValue,
    observation_metadata: {
      source: isFx
        ? "Banco Central de la República Argentina (BCRA)"
        : "Instituto Nacional de Estadística y Censos (INDEC)",
    },
    revision: 2,
    fetched_at: "2026-09-01T12:00:00.000Z",
    job_state: "COMPLETED",
    job_error_code: null,
  };
}

test("loads all observations once and keeps exact conversion, fallback and CPI provenance", async () => {
  let calls = 0;
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      calls += 1;
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map(economicRow) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [settlement()]);
  const period = result.byScopePeriod.get(scopePeriodKey("employment-1", "ARS", "2024-01"));

  assert.equal(calls, 1);
  assert.equal(period?.public.historicalUsd.status, "AVAILABLE");
  assert.equal(period?.public.historicalUsd.comparableSalary, "100.00");
  assert.equal(period?.public.historicalUsd.amounts?.netAmount, "80.00");
  assert.equal(period?.public.historicalUsd.observations[0]?.source, "Banco Central de la República Argentina (BCRA)");
  assert.deepEqual(
    period?.public.historicalUsd.observations.map((item) => [
      item.requestedDate,
      item.observationDate,
      item.selectionMethod,
      item.revision,
    ]),
    [["2024-02-04", "2024-02-02", "PAYMENT_DATE", 2]],
  );
  assert.equal(period?.public.purchasingPower.status, "AVAILABLE");
  assert.equal(period?.public.purchasingPower.referencePeriod, "2024-02");
  assert.equal(period?.public.purchasingPower.comparableSalary, "120000.00");
});

test("returns typed not-configured states without touching the economic tables", async () => {
  const queryable: EconomicDataQueryable = {
    async query() {
      throw new Error("query must not run");
    },
  };
  const result = await buildEconomicAnalytics(queryable, [settlement({
    countryCode: "UY",
    currencyCode: "UYU",
  })]);
  const period = result.byScopePeriod.get(scopePeriodKey("employment-1", "UYU", "2024-01"));
  assert.equal(period?.public.historicalUsd.status, "UNAVAILABLE");
  assert.equal(period?.public.historicalUsd.reason, "NOT_CONFIGURED");
  assert.equal(period?.public.purchasingPower.reason, "NOT_CONFIGURED");
  assert.equal(period?.public.purchasingPower.currencyCode, "UYU");
});

test("keeps salary enrichment pending while configured series are syncing", async () => {
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map((request) => ({
        ...economicRow(request),
        observation_id: null,
        observation_date: null,
        observation_value: null,
        revision: null,
        fetched_at: null,
        job_state: "RUNNING",
      })) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [settlement()]);
  const period = result.byScopePeriod.get(scopePeriodKey("employment-1", "ARS", "2024-01"));
  assert.equal(period?.public.historicalUsd.status, "PENDING");
  assert.equal(period?.public.historicalUsd.reason, "SYNC_PENDING");
  assert.equal(period?.public.historicalUsd.amounts, null);
  assert.equal(period?.public.purchasingPower.status, "PENDING");
});

test("keeps in-range gaps pending between backfill chunks and scopes job state to the requested range", async () => {
  const queryable: EconomicDataQueryable = {
    async query(text, values) {
      assert.match(text, /request\.target_date BETWEEN job\.range_start AND job\.range_end/);
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map((request) => ({
        ...economicRow(request),
        observation_id: null,
        observation_date: null,
        observation_value: null,
        revision: null,
        fetched_at: null,
        job_state: null,
        job_error_code: null,
      })) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [settlement()]);
  const period = result.byScopePeriod.get(scopePeriodKey("employment-1", "ARS", "2024-01"));
  assert.equal(period?.public.historicalUsd.status, "PENDING");
  assert.equal(period?.public.historicalUsd.reason, "SYNC_PENDING");
  assert.equal(period?.public.purchasingPower.status, "PENDING");
});

test("compares historical USD and real salary with exact ratios", async () => {
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map(economicRow) };
    },
  };
  const settlements = [
    settlement(),
    settlement({
      id: "settlement-2",
      documentId: "document-2",
      payrollPeriod: "2024-02",
      paymentDate: "2024-03-01",
      basicAmount: "120000.00",
      grossAmount: "120000.00",
      netAmount: "96000.00",
      deductionsAmount: "24000.00",
      remunerativeAmount: "120000.00",
    }),
    settlement({
      id: "settlement-3",
      documentId: "document-3",
      payrollPeriod: "2024-04",
      paymentDate: "2024-05-03",
      basicAmount: "120000.00",
      grossAmount: "120000.00",
      netAmount: "96000.00",
      deductionsAmount: "24000.00",
      remunerativeAmount: "120000.00",
    }),
  ];
  const result = await buildEconomicAnalytics(queryable, settlements);
  const comparison = compareEconomicPeriods(result, {
    employmentContext: "employment-1",
    currencyCode: "ARS",
    fromPeriod: "2024-01",
    toPeriod: "2024-02",
  });

  assert.equal(comparison?.historicalUsd.changeBasisPoints, "0");
  assert.equal(comparison?.historicalUsd.earlierComparableNetCents, "8000");
  assert.equal(comparison?.historicalUsd.laterComparableNetCents, "8000");
  assert.equal(comparison?.purchasingPower.changeBasisPoints, "0");
  assert.equal(comparison?.purchasingPower.earlierComparableNetCents, "9600000");
  assert.equal(comparison?.purchasingPower.laterComparableNetCents, "9600000");
  assert.equal(comparison?.inflation.changeBasisPoints, "2000");

  const evolution = addEconomicProjections(analyzeSalaryHistory(settlements).scopes, result)[0]?.evolution;
  assert.equal(evolution?.[0]?.economic.comparisonToPrevious, null);
  assert.deepEqual(evolution?.[1]?.economic.comparisonToPrevious, {
    fromPeriod: "2024-01",
    historicalUsd: { status: "AVAILABLE", reason: null, changeBasisPoints: "0" },
    purchasingPower: { status: "AVAILABLE", reason: null, changeBasisPoints: "0" },
    inflation: { status: "AVAILABLE", reason: null, changeBasisPoints: "2000" },
  });
  assert.equal(evolution?.[2]?.economic.comparisonToPrevious?.fromPeriod, "2024-02");
  assert.equal(evolution?.[2]?.economic.comparisonToPrevious?.inflation.changeBasisPoints, "2500");
});

test("uses the pending reason when only the later comparison period is still syncing", async () => {
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map((request) => {
        const row = economicRow(request);
        if (!String(request.series_code).startsWith("FX.")) return row;
        return {
          ...row,
          observation_id: null,
          observation_date: null,
          observation_value: null,
          revision: null,
          fetched_at: null,
          job_state: request.target_date === "2024-02-04" ? "COMPLETED" : null,
          job_error_code: null,
        };
      }) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [
    settlement(),
    settlement({
      id: "settlement-2",
      documentId: "document-2",
      payrollPeriod: "2024-02",
      paymentDate: "2024-03-01",
    }),
  ]);
  const comparison = compareEconomicPeriods(result, {
    employmentContext: "employment-1",
    currencyCode: "ARS",
    fromPeriod: "2024-01",
    toPeriod: "2024-02",
  });

  assert.equal(comparison?.historicalUsd.status, "PENDING");
  assert.equal(comparison?.historicalUsd.reason, "SYNC_PENDING");
});

test("keeps public inflation comparable when only the latest purchasing-power reference is missing", async () => {
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map((request) => String(request.selection) === "LATEST"
        ? {
            ...economicRow(request),
            observation_id: null,
            observation_date: null,
            observation_value: null,
            revision: null,
            fetched_at: null,
            job_state: "FAILED",
            job_error_code: "ECONOMIC_PROVIDER_HTTP_ERROR",
          }
        : economicRow(request)) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [
    settlement(),
    settlement({
      id: "settlement-2",
      documentId: "document-2",
      payrollPeriod: "2024-02",
      paymentDate: "2024-03-01",
      basicAmount: "120000.00",
      grossAmount: "120000.00",
      netAmount: "96000.00",
      deductionsAmount: "24000.00",
      remunerativeAmount: "120000.00",
    }),
  ]);
  const comparison = compareEconomicPeriods(result, {
    employmentContext: "employment-1",
    currencyCode: "ARS",
    fromPeriod: "2024-01",
    toPeriod: "2024-02",
  });
  assert.equal(comparison?.purchasingPower.status, "PARTIAL");
  assert.equal(comparison?.inflation.status, "AVAILABLE");
  assert.equal(comparison?.inflation.changeBasisPoints, "2000");
});

test("keeps economic amounts available when a zero net makes percentage change undefined", async () => {
  const queryable: EconomicDataQueryable = {
    async query(_text, values) {
      const requests = JSON.parse(String(values?.[0])) as Record<string, unknown>[];
      return { rows: requests.map(economicRow) };
    },
  };
  const result = await buildEconomicAnalytics(queryable, [
    settlement({ netAmount: "0.00" }),
    settlement({
      id: "settlement-2",
      documentId: "document-2",
      payrollPeriod: "2024-02",
      paymentDate: "2024-03-01",
      netAmount: "100.00",
    }),
  ]);
  const comparison = compareEconomicPeriods(result, {
    employmentContext: "employment-1",
    currencyCode: "ARS",
    fromPeriod: "2024-01",
    toPeriod: "2024-02",
  });

  assert.equal(comparison?.historicalUsd.status, "AVAILABLE");
  assert.equal(comparison?.historicalUsd.earlierComparableNetCents, "0");
  assert.equal(comparison?.historicalUsd.changeBasisPoints, null);
});
