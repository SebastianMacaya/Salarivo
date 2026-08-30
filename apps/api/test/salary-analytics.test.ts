import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSalaryHistory,
  compareSalaryPeriods,
  salaryCategoryForEarning,
  type SalarySettlement,
} from "../src/salary-analytics.ts";

let sequence = 0;

function settlement(overrides: Partial<SalarySettlement> = {}): SalarySettlement {
  sequence += 1;
  return {
    id: `settlement-${sequence}`,
    documentId: `document-${sequence}`,
    employmentId: "employment-a",
    currencyCode: "ARS",
    payrollPeriod: "2026-01",
    settlementType: "NORMAL",
    isRecurring: true,
    basicAmount: "5000000.00",
    grossAmount: "6000000.00",
    netAmount: "4800000.00",
    deductionsAmount: "1200000.00",
    remunerativeAmount: "6000000.00",
    nonRemunerativeAmount: "0.00",
    earnings: [],
    ...overrides,
  };
}

test("classifies normalized earnings independently from their containing settlement", () => {
  assert.equal(salaryCategoryForEarning("BONUS", false), "BONO");
  assert.equal(salaryCategoryForEarning("OVERTIME", false), "HORAS_EXTRA");
  assert.equal(salaryCategoryForEarning("BASIC_SALARY", true), "NORMAL");
  assert.equal(salaryCategoryForEarning("UNKNOWN", false), "OTRO");
});

test("uses compounded comparable salary change instead of adding monthly percentages", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ payrollPeriod: "2026-01", basicAmount: "5000000.00" }),
    settlement({ payrollPeriod: "2026-02", basicAmount: "5500000.00" }),
    settlement({ payrollPeriod: "2026-03", basicAmount: "6050000.00" }),
  ]);
  const scope = analytics.scopes[0]!;

  assert.equal(scope.current?.changes.ytd?.percentage, "21.00");
  assert.equal(scope.annual[0]?.comparableChange?.percentage, "21.00");
  assert.deepEqual(scope.increases.map((increase) => increase.percentage), ["10.00", "10.00"]);
  assert.deepEqual(
    scope.events.filter((event) => event.type === "COMPARABLE_INCREASE").map((event) => event.change.percentage),
    ["10.00", "10.00"],
  );
});

test("does not interpret a bonus or its net variation as a salary increase", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ payrollPeriod: "2026-01" }),
    settlement({
      payrollPeriod: "2026-02",
      basicAmount: "5000000.00",
      grossAmount: "7000000.00",
      netAmount: "6500000.00",
      earnings: [{ code: "BONO", amount: "1000000.00", isRecurring: true }],
    }),
    settlement({
      payrollPeriod: "2026-02",
      settlementType: "BONO",
      isRecurring: false,
      basicAmount: null,
      grossAmount: "1000000.00",
      netAmount: "1000000.00",
      deductionsAmount: "0.00",
      remunerativeAmount: "1000000.00",
    }),
  ]);
  const scope = analytics.scopes[0]!;

  assert.equal(scope.current?.comparableSalary, "5000000.00");
  assert.equal(scope.current?.changes.latest?.percentage, "0.00");
  assert.equal(scope.increases.length, 0);
  assert.equal(scope.annual[0]?.byCategory.BONO.totals.netAmount, "1000000.00");
  assert.equal(scope.annual[0]?.normalizedEarningsByCategory?.BONO, "1000000.00");
});

test("keeps employment changes out of percentage calculations", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ employmentId: "employment-a", payrollPeriod: "2026-01", basicAmount: "3000000.00" }),
    settlement({ employmentId: "employment-b", payrollPeriod: "2026-02", basicAmount: "6000000.00" }),
  ]);

  assert.equal(analytics.scopes.length, 2);
  assert.ok(analytics.scopes.every((scope) => scope.increases.length === 0));
  assert.ok(analytics.scopes.every((scope) => scope.current?.changes.latest === null));
});

test("never mixes currencies", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ currencyCode: "ARS", payrollPeriod: "2026-01", basicAmount: "1000000.00" }),
    settlement({ currencyCode: "USD", payrollPeriod: "2026-02", basicAmount: "2000000.00" }),
  ]);

  assert.deepEqual(analytics.scopes.map((scope) => scope.currencyCode), ["ARS", "USD"]);
  assert.ok(analytics.scopes.every((scope) => scope.increases.length === 0));
});

test("returns unavailable instead of zero when basic salary is missing or context is unconfirmed", () => {
  const missingBasic = analyzeSalaryHistory([
    settlement({ payrollPeriod: "2026-01", basicAmount: null }),
    settlement({ payrollPeriod: "2026-02", basicAmount: null }),
  ]).scopes[0]!;
  const unconfirmed = analyzeSalaryHistory([
    settlement({ employmentId: null, employmentContext: null, payrollPeriod: "2026-01" }),
    settlement({ employmentId: null, employmentContext: null, payrollPeriod: "2026-02", basicAmount: "6000000.00" }),
  ]).scopes[0]!;

  assert.equal(missingBasic.current?.comparableSalary, null);
  assert.equal(missingBasic.current?.period, "2026-02");
  assert.equal(missingBasic.current?.amounts.netAmount, "4800000.00");
  assert.equal(missingBasic.current?.changes.latest, null);
  assert.equal(missingBasic.current?.changes.ytd, null);
  assert.equal(unconfirmed.current?.changes.latest, null);
  assert.equal(unconfirmed.increases.length, 0);
});

test("preserves multiple settlements from the same month", () => {
  const first = settlement({ payrollPeriod: "2026-01", basicAmount: "5000000.00", netAmount: "4000000.00" });
  const second = settlement({ payrollPeriod: "2026-01", basicAmount: "5000000.00", netAmount: "500000.00" });
  const analytics = analyzeSalaryHistory([second, first]);
  const month = analytics.scopes[0]!.evolution[0]!;

  assert.equal(month.settlements.length, 2);
  assert.deepEqual(month.settlements.map((entry) => entry.id), [first.id, second.id].sort());
  assert.equal(month.totals.netAmount, "4500000.00");
  assert.equal(month.comparableSalary, "5000000.00");
});

test("separates annual regular and extraordinary settlement totals", () => {
  const inputs = [
    ["NORMAL", "100.00", true],
    ["SAC", "20.00", false],
    ["BONO", "30.00", true],
    ["RETROACTIVO", "40.00", false],
    ["VACACIONES", "50.00", false],
    ["HORAS_EXTRA", "60.00", false],
    ["AJUSTE", "70.00", false],
    ["REINTEGRO", "80.00", false],
    ["COMMISSION", "90.00", false],
    ["FINAL_SETTLEMENT", "100.00", false],
    ["INDEMNITY", "110.00", false],
  ] as const;
  const analytics = analyzeSalaryHistory(inputs.map(([settlementType, netAmount, isRecurring], index) => settlement({
    payrollPeriod: `2026-${String(index + 1).padStart(2, "0")}`,
    settlementType,
    isRecurring,
    basicAmount: settlementType === "NORMAL" ? "100.00" : null,
    grossAmount: netAmount,
    netAmount,
    deductionsAmount: "0.00",
    remunerativeAmount: netAmount,
    nonRemunerativeAmount: "0.00",
  })));
  const year = analytics.scopes[0]!.annual[0]!;

  assert.equal(year.totals.netAmount, "750.00");
  assert.equal(year.byCategory.NORMAL.totals.netAmount, "100.00");
  assert.equal(year.byCategory.SAC.totals.netAmount, "20.00");
  assert.equal(year.byCategory.BONO.totals.netAmount, "30.00");
  assert.equal(year.byCategory.RETROACTIVO.totals.netAmount, "40.00");
  assert.equal(year.byCategory.VACACIONES.totals.netAmount, "50.00");
  assert.equal(year.byCategory.HORAS_EXTRA.totals.netAmount, "60.00");
  assert.equal(year.byCategory.AJUSTE.totals.netAmount, "70.00");
  assert.equal(year.byCategory.REINTEGRO.totals.netAmount, "80.00");
  assert.equal(year.byCategory.COMISION.totals.netAmount, "90.00");
  assert.equal(year.byCategory.LIQUIDACION_FINAL.totals.netAmount, "100.00");
  assert.equal(year.byCategory.INDEMNIZACION.totals.netAmount, "110.00");
});

test("marks gaps as possible and counts only recurring normal settlements as coverage", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ payrollPeriod: "2026-01" }),
    settlement({ payrollPeriod: "2026-02", settlementType: "SAC", isRecurring: false, basicAmount: null }),
    settlement({ payrollPeriod: "2026-03" }),
  ]);
  const coverage = analytics.scopes[0]!.coverage;

  assert.equal(coverage.employmentStartPeriod, null);
  assert.equal(coverage.employmentEndPeriod, null);
  assert.equal(coverage.basis, "OBSERVED");
  assert.deepEqual(coverage.expectedPeriods, ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(coverage.availablePeriods, ["2026-01", "2026-03"]);
  assert.deepEqual(coverage.possibleMissingPeriods, ["2026-02"]);
  assert.deepEqual(coverage.byYear, [{
    year: "2026",
    expectedPeriods: ["2026-01", "2026-02", "2026-03"],
    availablePeriods: ["2026-01", "2026-03"],
    possibleMissingPeriods: ["2026-02"],
  }]);
});

test("supports partial employment years at confirmed start and end boundaries", () => {
  const analytics = analyzeSalaryHistory([
    settlement({
      payrollPeriod: "2025-11", employmentStartPeriod: "2025-11-15", employmentEndPeriod: "2026-02-10",
      employmentStatus: "ENDED",
    }),
    settlement({ payrollPeriod: "2025-12" }),
    settlement({ payrollPeriod: "2026-02" }),
  ]);
  const coverage = analytics.scopes[0]!.coverage;

  assert.equal(coverage.rangeStartPeriod, "2025-11");
  assert.equal(coverage.rangeEndPeriod, "2026-02");
  assert.equal(coverage.boundaryContradiction, false);
  assert.deepEqual(coverage.byYear, [
    {
      year: "2025",
      expectedPeriods: ["2025-11", "2025-12"],
      availablePeriods: ["2025-11", "2025-12"],
      possibleMissingPeriods: [],
    },
    {
      year: "2026",
      expectedPeriods: ["2026-01", "2026-02"],
      availablePeriods: ["2026-02"],
      possibleMissingPeriods: ["2026-01"],
    },
  ]);
});

test("does not invent coverage without context and expands contradictory confirmed boundaries", () => {
  const noContext = analyzeSalaryHistory([
    settlement({ employmentId: null, employmentContext: null, payrollPeriod: "2026-01" }),
    settlement({ employmentId: null, employmentContext: null, payrollPeriod: "2026-12" }),
  ]).scopes[0]!.coverage;
  const contradictory = analyzeSalaryHistory([
    settlement({
      payrollPeriod: "2025-12", employmentStartPeriod: "2026-01", employmentEndPeriod: "2026-02",
    }),
    settlement({ payrollPeriod: "2026-03" }),
  ]).scopes[0]!.coverage;

  assert.equal(noContext.basis, "INDETERMINATE_CONTEXT");
  assert.equal(noContext.rangeStartPeriod, null);
  assert.deepEqual(noContext.possibleMissingPeriods, []);
  assert.equal(contradictory.boundaryContradiction, true);
  assert.equal(contradictory.rangeStartPeriod, "2025-12");
  assert.equal(contradictory.rangeEndPeriod, "2026-03");
});

test("rejects coverage ranges above the hard 1200-month limit before expanding them", () => {
  assert.throws(
    () => analyzeSalaryHistory([settlement({
      employmentStartPeriod: "0001-01-01",
      employmentEndPeriod: "9999-12-31",
      employmentStatus: "ENDED",
    })]),
    /cannot exceed 1200 months/,
  );
});

test("emits bonus and reimbursement events without calling them increases", () => {
  const analytics = analyzeSalaryHistory([
    settlement({ payrollPeriod: "2026-01", basicAmount: "100.00" }),
    settlement({
      payrollPeriod: "2026-02", basicAmount: "100.00",
      earnings: [{ code: "BONUS", amount: "25.00", isRecurring: false }],
    }),
    settlement({
      payrollPeriod: "2026-02", settlementType: "REINTEGRO", isRecurring: false, basicAmount: null,
      grossAmount: "10.00", netAmount: "10.00", deductionsAmount: "0.00", earnings: [],
    }),
  ]);
  const scope = analytics.scopes[0]!;
  const extraordinary = scope.events.filter((event) => event.type === "EXTRAORDINARY");

  assert.equal(scope.increases.length, 0);
  assert.equal(scope.events.some((event) => event.type === "COMPARABLE_INCREASE"), false);
  assert.deepEqual(extraordinary.map((event) => [event.category, event.amount, event.amountBasis]), [
    ["BONO", "25.00", "NORMALIZED_EARNING"],
    ["REINTEGRO", "10.00", "SETTLEMENT_GROSS"],
  ]);
});

test("explains net variation with known extraordinary and deduction drivers without inventing missing concepts", () => {
  const known = [
    settlement({
      payrollPeriod: "2026-01", grossAmount: "120.00", netAmount: "100.00",
      deductionsAmount: "20.00", earnings: [],
    }),
    settlement({
      payrollPeriod: "2026-02", grossAmount: "150.00", netAmount: "140.00", deductionsAmount: "10.00",
      earnings: [{ code: "BONUS", amount: "30.00", isRecurring: false }],
    }),
  ];
  const comparison = compareSalaryPeriods(known, {
    employmentContext: "employment-a", currencyCode: "ARS", fromPeriod: "2026-01", toPeriod: "2026-02",
  });
  const { earnings: _missingEarnings, ...missingJanuary } = settlement({
    payrollPeriod: "2026-01", netAmount: "100.00", deductionsAmount: "20.00",
  });
  const { earnings: _missingEarningsToo, ...missingFebruary } = settlement({
    payrollPeriod: "2026-02", netAmount: "110.00", deductionsAmount: "20.00",
  });
  const unexplained = compareSalaryPeriods([missingJanuary, missingFebruary], {
    employmentContext: "employment-a", currencyCode: "ARS", fromPeriod: "2026-01", toPeriod: "2026-02",
  });
  const unreconciled = compareSalaryPeriods([
    known[0]!,
    settlement({
      payrollPeriod: "2026-02", grossAmount: "150.00", netAmount: "130.00", deductionsAmount: "10.00",
      earnings: [{ code: "BONUS", amount: "30.00", isRecurring: false }],
    }),
  ], {
    employmentContext: "employment-a", currencyCode: "ARS", fromPeriod: "2026-01", toPeriod: "2026-02",
  });
  const standalone = compareSalaryPeriods([
    settlement({
      payrollPeriod: "2026-01", grossAmount: "120.00", netAmount: "100.00",
      deductionsAmount: "20.00", earnings: [],
    }),
    settlement({
      payrollPeriod: "2026-02", grossAmount: "120.00", netAmount: "100.00",
      deductionsAmount: "20.00", earnings: [],
    }),
    settlement({
      payrollPeriod: "2026-02", settlementType: "BONO", isRecurring: false, basicAmount: null,
      grossAmount: "30.00", netAmount: "30.00", deductionsAmount: "0.00", earnings: [],
    }),
  ], {
    employmentContext: "employment-a", currencyCode: "ARS", fromPeriod: "2026-01", toPeriod: "2026-02",
  });

  assert.equal(comparison?.conclusionCode, "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY_AND_DEDUCTIONS");
  assert.deepEqual(comparison?.drivers.map((driver) => [driver.type, driver.code, driver.change.deltaAmount]), [
    ["EXTRAORDINARY_EARNING", "BONO", "30.00"],
    ["DEDUCTIONS", "DEDUCTIONS", "-10.00"],
  ]);
  assert.equal(comparison?.driversComplete, true);
  assert.equal(unexplained?.driversComplete, false);
  assert.deepEqual(unexplained?.drivers, []);
  assert.equal(unexplained?.conclusionCode, "NET_VARIATION_INSUFFICIENT_DATA");
  assert.equal(unreconciled?.conclusionCode, "NET_VARIATION_UNEXPLAINED");
  assert.deepEqual(unreconciled?.drivers, []);
  assert.equal(standalone?.conclusionCode, "NET_VARIATION_RECONCILED_BY_EXTRAORDINARY");
  assert.deepEqual(standalone?.drivers.map((driver) => [driver.code, driver.change.deltaAmount]), [["BONO", "30.00"]]);

  const hiddenRegularChange = compareSalaryPeriods([
    settlement({
      payrollPeriod: "2026-01", basicAmount: "100.00", grossAmount: "120.00",
      netAmount: "100.00", deductionsAmount: "20.00", earnings: [],
    }),
    settlement({
      payrollPeriod: "2026-02", basicAmount: "200.00", grossAmount: "130.00",
      netAmount: "110.00", deductionsAmount: "20.00",
      earnings: [{ code: "BONUS", amount: "10.00", isRecurring: false }],
    }),
  ], {
    employmentContext: "employment-a", currencyCode: "ARS", fromPeriod: "2026-01", toPeriod: "2026-02",
  });
  assert.equal(hiddenRegularChange?.driversComplete, true);
  assert.equal(hiddenRegularChange?.conclusionCode, "NET_VARIATION_UNEXPLAINED");
  assert.deepEqual(hiddenRegularChange?.drivers, []);
});

test("flags structurally identical settlements from different documents as possible duplicates", () => {
  const first = settlement({ documentId: "document-a" });
  const second = settlement({ documentId: "document-b" });
  const analytics = analyzeSalaryHistory([first, second]);

  assert.equal(analytics.possibleDuplicates.length, 1);
  assert.deepEqual(analytics.possibleDuplicates[0]?.settlementIds, [first.id, second.id].sort());
  assert.deepEqual(analytics.possibleDuplicates[0]?.documentIds, ["document-a", "document-b"]);
});

test("normalizes duplicate type aliases and orders equal-period signatures deterministically", () => {
  const bonusA = settlement({
    documentId: "bonus-a", settlementType: "BONO", isRecurring: false, basicAmount: null, netAmount: "10.00",
  });
  const bonusB = settlement({
    documentId: "bonus-b", settlementType: "BONUS", isRecurring: false, basicAmount: null, netAmount: "10.00",
  });
  const sacA = settlement({
    documentId: "sac-a", settlementType: "SAC", isRecurring: false, basicAmount: null, netAmount: "20.00",
  });
  const sacB = settlement({
    documentId: "sac-b", settlementType: "SAC", isRecurring: false, basicAmount: null, netAmount: "20.00",
  });
  const forward = analyzeSalaryHistory([bonusA, bonusB, sacA, sacB]).possibleDuplicates;
  const reverse = analyzeSalaryHistory([sacB, sacA, bonusB, bonusA]).possibleDuplicates;

  assert.equal(forward.length, 2);
  assert.deepEqual(forward.map((duplicate) => duplicate.signature), reverse.map((duplicate) => duplicate.signature));
  assert.deepEqual(forward.flatMap((duplicate) => duplicate.documentIds).sort(), ["bonus-a", "bonus-b", "sac-a", "sac-b"]);
});

test("uses the exact same month for year-over-year and compares normalized earnings deterministically", () => {
  const inputs = [
    settlement({ payrollPeriod: "2025-01", basicAmount: "100.00", earnings: [{ code: "BASICO", amount: "100.00" }] }),
    settlement({ payrollPeriod: "2025-02", basicAmount: "110.00", earnings: [{ code: "BASICO", amount: "110.00" }] }),
    settlement({ payrollPeriod: "2026-02", basicAmount: "133.10", earnings: [{ code: "BASICO", amount: "133.10" }] }),
  ];
  const scope = analyzeSalaryHistory(inputs).scopes[0]!;
  const comparison = compareSalaryPeriods(inputs, {
    employmentContext: "employment-a",
    currencyCode: "ARS",
    fromPeriod: "2025-02",
    toPeriod: "2026-02",
  });

  assert.equal(scope.current?.changes.yearOverYear?.fromPeriod, "2025-02");
  assert.equal(scope.current?.changes.yearOverYear?.percentage, "21.00");
  assert.equal(scope.current?.changes.rolling12?.percentage, "21.00");
  assert.equal(comparison?.changes.comparableSalary?.percentage, "21.00");
  assert.deepEqual(comparison?.earnings, [{
    code: "BASICO",
    change: { fromAmount: "110.00", toAmount: "133.10", deltaAmount: "23.10", percentage: "21.00" },
  }]);
});
