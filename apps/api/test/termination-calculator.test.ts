import assert from "node:assert/strict";
import test from "node:test";
import { calculateTerminationEstimate, resolveTerminationRule, TERMINATION_LEGAL_RULES,
  type CollectiveAgreementVersion, type TerminationEstimate, type TerminationInput, type TerminationSalarySettlement } from "../src/termination-calculator.ts";
import { formatAmount, parseAmount } from "../src/salary-analytics.ts";

function input(startDate = "2024-01-01", terminationDate = "2026-06-15"): TerminationInput {
  return { employment: { id: "synthetic-employment", employerName: "Empresa sintética", startDate,
    startDateSource: "CONFIRMED", countryCode: "AR", currencyCode: "ARS", legalRegimeCode: "AR_LCT_GENERAL", countryConfirmedAt: "2024-01-01" },
    terminationDate, today: "2026-09-05", settlements: [], overrides: { monthlyRemuneration: "300000.00" } };
}

function settlement(period: string, amount = "300000.00", extra: Partial<TerminationSalarySettlement> = {}): TerminationSalarySettlement {
  return { id: `settlement-${period}`, documentId: `document-${period}`, employmentId: "synthetic-employment", payrollPeriod: period,
    currencyCode: "ARS", settlementType: "NORMAL", isRecurring: true, basicAmount: amount,
    grossAmount: amount, remunerativeAmount: amount, nonRemunerativeAmount: "0.00", netAmount: "1.00",
    earnings: [{ code: "BASIC_SALARY", amount, isRecurring: true }], ...extra };
}

function twelveMonths(): TerminationSalarySettlement[] {
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 5 + index, 1)).toISOString().slice(0, 7);
    return settlement(date);
  });
}

function amounts(result: TerminationEstimate, scenario = "WITHOUT_NOTICE"): Record<string, string> {
  const value = result.scenarios.find(item => item.code === scenario);
  assert.ok(value);
  assert.equal(value.breakdown.length, 8);
  const total = value.breakdown.reduce((sum, line) => {
    assert.ok(line.name && line.explanation && line.ruleOrigin);
    return sum + parseAmount(line.amount, "test")!;
  }, 0n);
  assert.equal(value.total, formatAmount(total), "total is exactly the sum of rounded visible components");
  return Object.fromEntries(value.breakdown.map(line => [line.code, line.amount]));
}

function assertComplete(result: TerminationEstimate, expected: Record<string, string>, withoutTotal: string, withTotal: string): void {
  assert.equal(result.status, "AVAILABLE");
  assert.deepEqual(amounts(result), expected);
  assert.deepEqual(amounts(result, "WITH_NOTICE"), { ...expected, NOTICE: "0.00", MONTH_INTEGRATION: "0.00", SAC_ON_NOTICE: "0.00", SAC_ON_INTEGRATION: "0.00" });
  assert.equal(result.scenarios[0]!.total, withTotal);
  assert.equal(result.scenarios[1]!.total, withoutTotal);
}

const middle = { SENIORITY: "900000.00", NOTICE: "300000.00", MONTH_INTEGRATION: "150000.00", EARNED_SALARY: "150000.00",
  PROPORTIONAL_SAC: "137500.00", UNUSED_VACATION: "76405.48", SAC_ON_NOTICE: "25000.00", SAC_ON_INTEGRATION: "12500.00" };

test("golden: mid-month dismissal has all eight components and two complete totals", () => {
  const result = calculateTerminationEstimate(input());
  assertComplete(result, middle, "1751405.48", "1263905.48");
  assert.deepEqual(result.inputs.seniority, { years: 2, months: 5, days: 14, indemnityYears: 3 });
});

test("golden: month-end has no integration and pays exactly one current monthly salary", () => {
  const result = calculateTerminationEstimate(input("2024-01-01", "2026-06-30"));
  assertComplete(result, { ...middle, MONTH_INTEGRATION: "0.00", EARNED_SALARY: "300000.00", PROPORTIONAL_SAC: "150000.00",
    UNUSED_VACATION: "83309.59", SAC_ON_INTEGRATION: "0.00" }, "1758309.59", "1433309.59");
});

test("golden: more than five years requires two notice months and the next vacation tier", () => {
  const result = calculateTerminationEstimate(input("2019-01-01"));
  assertComplete(result, { ...middle, SENIORITY: "2400000.00", NOTICE: "600000.00", UNUSED_VACATION: "114608.22", SAC_ON_NOTICE: "50000.00" }, "3614608.22", "2802108.22");
});

test("golden: valid probation in 2026 has no seniority, notice or integration compensation", () => {
  const result = calculateTerminationEstimate(input("2026-04-01"));
  assertComplete(result, { SENIORITY: "0.00", NOTICE: "0.00", MONTH_INTEGRATION: "0.00", EARNED_SALARY: "150000.00",
    PROPORTIONAL_SAC: "62500.00", UNUSED_VACATION: "34980.82", SAC_ON_NOTICE: "0.00", SAC_ON_INTEGRATION: "0.00" }, "247480.82", "247480.82");
  assert.equal(result.inputs.probation?.months, 6);
});

test("golden: December 2024 probation retains fifteen notice days and excludes month integration", () => {
  const result = calculateTerminationEstimate(input("2024-10-01", "2024-12-15"));
  assertComplete(result, { SENIORITY: "0.00", NOTICE: "150000.00", MONTH_INTEGRATION: "0.00", EARNED_SALARY: "145161.29",
    PROPORTIONAL_SAC: "62096.77", UNUSED_VACATION: "34885.25", SAC_ON_NOTICE: "12500.00", SAC_ON_INTEGRATION: "0.00" }, "404643.31", "242143.31");
  assert.equal(result.legalRuleVersion?.version, "2024-07-09");
});

test("seniority boundaries: under one year, exact anniversary and strictly more than three months", () => {
  for (const [start, units] of [["2025-11-01", 1], ["2025-06-15", 1], ["2025-03-15", 1], ["2025-03-14", 2]] as const) {
    const result = calculateTerminationEstimate(input(start));
    const expected = { ...middle, SENIORITY: formatAmount(BigInt(units) * 30000000n) };
    assert.deepEqual(amounts(result), expected);
    assert.equal(result.inputs.seniority?.indemnityYears, units);
    amounts(result, "WITH_NOTICE");
  }
});

test("exactly five years still requires one month; next day requires two", () => {
  assert.equal(calculateTerminationEstimate(input("2021-06-15")).scenarios[1]!.notice.value, 1);
  assert.equal(calculateTerminationEstimate(input("2021-06-14")).scenarios[1]!.notice.value, 2);
});

test("vacation tier uses complete civil seniority at December 31, including a fraction beyond five years", () => {
  const exactlyFiveAtYearEnd = calculateTerminationEstimate(input("2021-12-31"));
  const beyondFiveAtYearEnd = calculateTerminationEstimate(input("2021-12-30"));
  assert.equal(amounts(exactlyFiveAtYearEnd).UNUSED_VACATION, "76405.48");
  assert.equal(amounts(beyondFiveAtYearEnd).UNUSED_VACATION, "114608.22");
});

test("probation depends on hiring date, has an exact six-month boundary and supports explicit waiver", () => {
  const old = calculateTerminationEstimate(input("2024-07-08", "2024-11-08"));
  const next = calculateTerminationEstimate(input("2024-07-09", "2024-11-09"));
  assert.deepEqual(old.inputs.probation, { months: 3, applies: false });
  assert.deepEqual(next.inputs.probation, { months: 6, applies: true });
  assert.equal(calculateTerminationEstimate(input("2026-01-15")).inputs.probation?.applies, true);
  assert.equal(calculateTerminationEstimate(input("2025-12-15")).inputs.probation?.applies, false);
  const waived = input("2026-04-01"); waived.overrides!.probationWaived = true;
  assert.equal(amounts(calculateTerminationEstimate(waived)).SENIORITY, "300000.00");
});

function cap(overrides: Partial<CollectiveAgreementVersion> = {}): CollectiveAgreementVersion {
  return { version: "synthetic-cct-2026-v1", cctCode: "SYNTHETIC/TEST", capAmount: "250000.00",
    effectiveFrom: "2023-01-01", effectiveTo: "2026-12-31", sourceUrl: "https://example.org/synthetic-test-only", ...overrides };
}

test("CCT cap affects seniority only, with 67% floor, uncapped salary below cap and exact snapshots", () => {
  for (const [limit, base, seniorityAmount, floor] of [["250000.00", "250000.00", "750000.00", false],
    ["100000.00", "201000.00", "603000.00", true], ["900000.00", "300000.00", "900000.00", false]] as const) {
    const data = input(); data.overrides!.cctCapVersion = cap({ capAmount: limit });
    const result = calculateTerminationEstimate(data);
    assert.deepEqual(amounts(result), { ...middle, SENIORITY: seniorityAmount });
    amounts(result, "WITH_NOTICE");
    assert.equal(result.inputs.cappedSalaryBase, base);
    assert.equal(result.inputs.capFloorApplied, floor);
    assert.equal(result.inputs.collectiveAgreement?.source, "SIMULATION_OVERRIDE");
    assert.equal(result.inputs.collectiveAgreement?.capAmount, limit);
  }
});

test("the historical one-month minimum is uncapped, the 2026 minimum uses the cap and floor", () => {
  const old = input("2024-01-01", "2024-12-15"); old.overrides!.cctCapVersion = cap({ capAmount: "100000.00" });
  const current = input("2025-08-01", "2026-06-15"); current.overrides!.cctCapVersion = cap({ capAmount: "100000.00" });
  assert.equal(amounts(calculateTerminationEstimate(old)).SENIORITY, "300000.00");
  assert.equal(amounts(calculateTerminationEstimate(current)).SENIORITY, "201000.00");
});

test("missing, expired, mismatched and ambiguous agreements never invent a cap", () => {
  const data = input(); data.overrides = { cctCode: "SYNTHETIC/TEST" }; data.settlements = twelveMonths();
  for (const catalog of [[], [cap({ effectiveTo: "2025-12-31" })], [cap({ cctCode: "OTHER" })], [cap(), cap({ version: "ambiguous" })]]) {
    const result = calculateTerminationEstimate(data, catalog);
    assert.equal(result.inputs.collectiveAgreement, null);
    assert.equal(result.confidence, "MEDIUM");
    assert.equal(result.inputs.cappedSalaryBase, "300000.00");
    assert.ok(result.warnings.some(warning => warning.includes("sin tope de convenio confirmado")));
    assert.deepEqual(amounts(result), middle);
  }
});

test("verified CCT category and version are resolved automatically; complete payroll can reach HIGH", () => {
  const data = input(); data.overrides = { cctCode: "SYNTHETIC/TEST", cctCategory: "A" }; data.settlements = twelveMonths();
  const currentCap = cap({ category: "A", effectiveFrom: "2026-01-01" });
  const result = calculateTerminationEstimate(data, [cap({ category: "A", version: "expired", effectiveTo: "2025-12-31", capAmount: "100000.00" }), currentCap]);
  assert.equal(result.confidence, "HIGH");
  assert.equal(result.inputs.collectiveAgreement?.source, "CATALOG");
  assert.equal(result.inputs.collectiveAgreement?.version, currentCap.version);
  assert.equal(result.inputs.collectiveAgreement?.capAmount, "250000.00");
  assert.deepEqual(amounts(result), { ...middle, SENIORITY: "750000.00" });
  data.overrides.cctCapVersion = currentCap;
  const manual = calculateTerminationEstimate(data);
  assert.equal(manual.confidence, "MEDIUM", "valid-looking manual provenance never becomes a verified catalog");
  assert.equal(manual.inputs.collectiveAgreement?.source, "SIMULATION_OVERRIDE");
  assert.deepEqual(amounts(manual), amounts(result));
  delete data.overrides.cctCapVersion;
  data.overrides.cctCategory = "B";
  assert.equal(calculateTerminationEstimate(data, [cap({ category: "A" })]).inputs.collectiveAgreement, null);
});

test("CCT extension requires valid company size, can lengthen notice/vacations, and funds are unsupported", () => {
  const data = input("2025-10-01"); data.overrides!.cctCapVersion = cap({ probationMonths: 12 });
  assert.equal(calculateTerminationEstimate(data).status, "UNAVAILABLE");
  data.overrides!.employerEmployeeCount = 5;
  assert.equal(calculateTerminationEstimate(data).inputs.probation?.applies, true);
  data.overrides!.employerEmployeeCount = 6;
  assert.equal(calculateTerminationEstimate(data).status, "UNAVAILABLE");
  data.overrides!.cctCapVersion = cap({ terminationSystem: "CESSATION_FUND" });
  assert.equal(calculateTerminationEstimate(data).status, "UNSUPPORTED");
  data.employment.startDate = "2024-01-01";
  data.overrides!.cctCapVersion = cap({ noticeMonths: 3, annualVacationDays: 21 });
  const result = calculateTerminationEstimate(data);
  assert.equal(amounts(result).NOTICE, "900000.00");
  assert.equal(amounts(result).UNUSED_VACATION, "114608.22");
});

test("salary reconstruction selects the best monthly gross remuneration and never reads the net", () => {
  const data = input(); delete data.overrides; data.settlements = twelveMonths().map((row, index) => index === 4
    ? settlement(row.payrollPeriod, "400000.00", { netAmount: "999999999999999999.99" }) : row);
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.amount, "400000.00");
  assert.equal(result.salaryBase.currentMonthlyRemuneration, "300000.00");
  assert.equal(result.salaryBase.selectedPeriod, "2025-10");
  assert.deepEqual(amounts(result), { ...middle, SENIORITY: "1200000.00" });
  assert.ok(result.inputs.salaryInputs.every(row => !("netAmount" in row) && !("deductionsAmount" in row)));
  assert.equal(result.salaryBase.analyzedDocumentIds.length, 12);
});

test("2026 averages variable remuneration over six/twelve months, selecting the more favourable", () => {
  const data = input(); delete data.overrides;
  data.settlements = twelveMonths().map((row, index) => {
    const variable = index < 6 ? "60000.00" : "120000.00";
    const amount = index < 6 ? "360000.00" : "420000.00";
    return { ...row, grossAmount: amount, remunerativeAmount: amount, earnings: [row.earnings![0]!, { code: "OVERTIME", amount: variable, isRecurring: false }] };
  });
  const result = calculateTerminationEstimate(data);
  assert.deepEqual(result.salaryBase.variableAverage, { sixMonths: "120000.00", twelveMonths: "90000.00", selected: "120000.00" });
  assert.equal(result.salaryBase.amount, "420000.00");
  assert.equal(result.salaryBase.trace.filter(row => row.treatment === "AVERAGED").length, 12);
  assert.deepEqual(amounts(result), { SENIORITY: "1260000.00", NOTICE: "420000.00", MONTH_INTEGRATION: "210000.00", EARNED_SALARY: "210000.00",
    PROPORTIONAL_SAC: "192500.00", UNUSED_VACATION: "106967.67", SAC_ON_NOTICE: "35000.00", SAC_ON_INTEGRATION: "17500.00" });
  amounts(result, "WITH_NOTICE");
  const reversed = { ...data, settlements: [...data.settlements].reverse() };
  assert.deepEqual(calculateTerminationEstimate(reversed), result, "input ordering does not change selection, totals or trace");
});

test("annual average wins when the recent variable pay is lower; fewer than six observations is excluded", () => {
  const data = input(); delete data.overrides;
  data.settlements = twelveMonths().map((row, index) => ({ ...row, grossAmount: index < 6 ? "420000.00" : "360000.00",
    remunerativeAmount: index < 6 ? "420000.00" : "360000.00", earnings: [row.earnings![0]!, { code: "COMMISSION", amount: index < 6 ? "120000.00" : "60000.00" }] }));
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.variableAverage.selected, "90000.00");
  assert.equal(result.salaryBase.amount, "390000.00"); amounts(result);
  data.settlements = twelveMonths().map((row, index) => index < 5 ? { ...row, grossAmount: "400000.00", remunerativeAmount: "400000.00",
    earnings: [row.earnings![0]!, { code: "COMMISSION", amount: "100000.00" }] } : row);
  const partial = calculateTerminationEstimate(data);
  assert.equal(partial.salaryBase.amount, "300000.00");
  assert.equal(partial.salaryBase.trace.filter(row => row.code === "COMMISSION" && row.treatment === "EXCLUDED").length, 5);
  amounts(partial);
});

test("historical variable pay uses the best month, not the 2026 average; SAC and annual bonus are traced exclusions", () => {
  const data = input("2020-01-01", "2024-12-15"); delete data.overrides;
  data.settlements = [settlement("2024-10", "420000.00", { earnings: [{ code: "BASIC_SALARY", amount: "300000.00", isRecurring: true }, { code: "OVERTIME", amount: "120000.00" }] }),
    settlement("2024-11", "300000.00"), settlement("2024-11", "900000.00", { id: "bonus", documentId: "bonus-doc", settlementType: "BONO" }),
    settlement("2024-06", "150000.00", { id: "sac", documentId: "sac-doc", settlementType: "SAC" })];
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.amount, "420000.00");
  assert.equal(result.salaryBase.trace.find(row => row.code === "BONO")?.treatment, "EXCLUDED");
  assert.equal(result.salaryBase.trace.find(row => row.code === "SAC")?.treatment, "EXCLUDED");
  assert.equal(result.salaryBase.trace.find(row => row.code === "OVERTIME")?.treatment, "INCLUDED");
  amounts(result);
});

test("historical salary excludes future months, a partial termination month and receipts not yet issued", () => {
  const data = input("2020-01-01", "2024-12-15"); delete data.overrides;
  data.settlements = [settlement("2024-11"), settlement("2024-12", "900000.00", { knownOn: "2024-12-01" }),
    settlement("2025-01", "800000.00"), settlement("2024-10", "700000.00", { knownOn: "2024-12-20" }),
    settlement("2024-09", "600000.00", { employmentId: "someone-else" }), settlement("2024-08", "500000.00", { currencyCode: "USD" })];
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.amount, "300000.00");
  assert.deepEqual(result.salaryBase.analyzedPeriods, ["2024-11"]);
  assert.deepEqual(result.salaryBase.analyzedDocumentIds, ["document-2024-11"]);
  amounts(result);
});

test("net-only, unresolved earnings and mixed non-remunerative detail are unavailable, missing history is LOW", () => {
  for (const row of [settlement("2026-05", "300000.00", { earnings: [], remunerativeAmount: null, nonRemunerativeAmount: null, grossAmount: null }),
    settlement("2026-05", "300000.00", { earnings: [{ code: "UNKNOWN", amount: "300000.00" }] }),
    settlement("2026-05", "300000.00", { nonRemunerativeAmount: "50000.00", remunerativeAmount: "250000.00" })]) {
    const data = input(); delete data.overrides; data.settlements = [row];
    assert.equal(calculateTerminationEstimate(data).status, "UNAVAILABLE");
  }
  const data = input(); delete data.overrides; data.settlements = [settlement("2026-05")];
  const result = calculateTerminationEstimate(data);
  assert.equal(result.confidence, "LOW");
  assert.ok(result.salaryBase.missingPeriods.length > 0); amounts(result);
});

test("generic parser bonuses in monthly payroll require review instead of silently lowering the base", () => {
  const data = input(); data.overrides = { cctCode: "SYNTHETIC/TEST" };
  for (const recurring of [false, null]) {
    data.settlements = twelveMonths().map(row => ({ ...row, grossAmount: "310000.00", remunerativeAmount: "310000.00",
      earnings: [row.earnings![0]!, { code: "BONUS", amount: "10000.00", isRecurring: recurring }] }));
    const result = calculateTerminationEstimate(data, [cap()]);
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.salaryBase.amount, null);
    assert.equal(result.confidence, "LOW");
    assert.deepEqual(result.scenarios, []);
    assert.equal(result.salaryBase.trace.filter(row => row.code === "BONUS" && row.treatment === "REVIEW_REQUIRED").length, 12);
    assert.ok(result.warnings.some(warning => warning.includes("bonos o premios") && warning.includes("simulación")));
  }
  data.overrides.monthlyRemuneration = "310000.00";
  const manual = calculateTerminationEstimate(data, [cap()]);
  assert.equal(manual.status, "AVAILABLE");
  assert.equal(manual.salaryBase.source, "SIMULATION_OVERRIDE");
  assert.equal(manual.salaryBase.amount, "310000.00");
  assert.equal(manual.confidence, "LOW");
  amounts(manual); amounts(manual, "WITH_NOTICE");
  delete data.overrides.monthlyRemuneration;
  data.settlements = data.settlements.map(row => ({ ...row, earnings: [row.earnings![0]!, { code: "ANNUAL_BONUS", amount: "10000.00", isRecurring: false }] }));
  const annual = calculateTerminationEstimate(data, [cap()]);
  assert.equal(annual.status, "AVAILABLE");
  assert.equal(annual.salaryBase.amount, "300000.00");
  assert.equal(annual.salaryBase.trace.filter(row => row.code === "ANNUAL_BONUS" && row.treatment === "EXCLUDED").length, 12);
  amounts(annual); amounts(annual, "WITH_NOTICE");
});

test("unclassified aggregate remuneration is clearly conditional and duplicate monthly settlements do not double the base", () => {
  const data = input(); delete data.overrides;
  data.settlements = [settlement("2026-05", "300000.00", { earnings: [] })];
  const aggregate = calculateTerminationEstimate(data);
  assert.equal(aggregate.status, "AVAILABLE"); assert.equal(aggregate.confidence, "LOW");
  assert.equal(aggregate.salaryBase.trace[0]!.treatment, "REVIEW_REQUIRED");
  data.settlements = [settlement("2026-05"), settlement("2026-05", "300000.00", { id: "duplicate", documentId: "duplicate-doc" })];
  assert.equal(calculateTerminationEstimate(data).status, "UNAVAILABLE");
  data.settlements = [settlement("2026-05"), settlement("2026-05")];
  assert.equal(calculateTerminationEstimate(data).salaryBase.amount, "300000.00", "duplicate row IDs are idempotent");
});

test("future scenario projects the last known salary and leaves future documents out", () => {
  const data = input("2024-01-01", "2026-12-05"); delete data.overrides;
  data.settlements = [settlement("2026-08", "300000.00"), settlement("2026-11", "900000.00")];
  const original = structuredClone(data);
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.amount, "300000.00");
  assert.equal(result.inputs.isProjection, true);
  assert.ok(result.assumptions.includes("Esta simulación supone que tu remuneración se mantiene igual a la última conocida."));
  assert.equal(result.legalRuleVersion?.version, "2026-03-06");
  assert.deepEqual(data, original);
  assert.deepEqual(calculateTerminationEstimate(data), result);
  amounts(result); amounts(result, "WITH_NOTICE");
});

test("overrides are explicit and preserve extracted inputs; already-paid SAC and enjoyed vacation cannot go negative", () => {
  const data = input(); data.settlements = [settlement("2026-05", "123456.78")];
  data.overrides = { monthlyRemuneration: "300000.00", startDate: "2020-01-01", vacationDaysTaken: "366.00", priorVacationDays: "2.50", sacAlreadyPaid: "900000.00" };
  const result = calculateTerminationEstimate(data);
  assert.equal(result.salaryBase.source, "SIMULATION_OVERRIDE");
  assert.equal(result.inputs.startDateSource, "SIMULATION_OVERRIDE");
  assert.equal(result.inputs.salaryInputs[0]!.remunerativeAmount, "123456.78");
  assert.equal(amounts(result).PROPORTIONAL_SAC, "0.00");
  assert.equal(amounts(result).UNUSED_VACATION, "30000.00");
});

test("calendar handling validates dates, supports leap/month-end anniversaries and excludes unsupported dates/countries/regimes", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-01", "not-a-date"]) assert.throws(() => calculateTerminationEstimate(input("2024-01-01", bad)), /INVALID_TERMINATION_DATE/);
  assert.throws(() => calculateTerminationEstimate(input("2027-01-01")), /TERMINATION_BEFORE_START/);
  const leap = calculateTerminationEstimate(input("2024-02-29", "2025-02-28"));
  assert.equal(leap.inputs.seniority?.years, 1);
  assert.equal(amounts(leap).EARNED_SALARY, "300000.00");
  for (const country of ["US", "ES", "BR", "CL", "UY"]) {
    const data = input(); data.employment.countryCode = country;
    assert.equal(calculateTerminationEstimate(data).status, "UNSUPPORTED");
  }
  for (const regime of [null, "AR_CONSTRUCTION", "AR_DOMESTIC", "AR_AGRICULTURAL"]) {
    const data = input(); data.employment.legalRegimeCode = regime;
    assert.equal(calculateTerminationEstimate(data).status, "UNSUPPORTED");
  }
  assert.equal(calculateTerminationEstimate(input("2010-01-01", "2022-01-01")).status, "UNSUPPORTED");
  assert.equal(resolveTerminationRule("AR", "AR_LCT_GENERAL", "2024-07-08")?.version, "2023-01-01");
  assert.equal(resolveTerminationRule("AR", "AR_LCT_GENERAL", "2024-07-09")?.version, "2024-07-09");
  assert.equal(resolveTerminationRule("AR", "AR_LCT_GENERAL", "2026-03-05")?.version, "2024-07-09");
  assert.equal(resolveTerminationRule("AR", "AR_LCT_GENERAL", "2026-03-06")?.version, "2026-03-06");
  assert.ok(Object.isFrozen(TERMINATION_LEGAL_RULES));
});

test("bounded exact decimals reject unsafe input and preserve amounts beyond floating-point precision", () => {
  for (const value of ["NaN", "Infinity", "1e8", "-1.00", "1.001", "0", "1".repeat(19)]) {
    const data = input(); data.overrides!.monthlyRemuneration = value;
    assert.throws(() => calculateTerminationEstimate(data), /INVALID_TERMINATION_AMOUNT/);
  }
  const large = input(); large.overrides!.monthlyRemuneration = "999999999999999999.99";
  const result = calculateTerminationEstimate(large);
  assert.equal(result.salaryBase.amount, "999999999999999999.99");
  assert.equal(amounts(result).SENIORITY, "2999999999999999999.97");
  const invalidCap = input(); invalidCap.overrides!.cctCapVersion = cap({ sourceUrl: "javascript:alert(1)" });
  assert.throws(() => calculateTerminationEstimate(invalidCap), /INVALID_CCT_SOURCE/);
});

test("the verified 2026 injunction interval yields no figures and discloses its legal sources", () => {
  for (const date of ["2026-03-30", "2026-04-15", "2026-04-22"]) {
    const result = calculateTerminationEstimate(input("2024-01-01", date));
    assert.equal(result.status, "UNAVAILABLE");
    assert.deepEqual(result.scenarios, []);
    assert.ok(result.warnings.some(warning => warning.includes("cautelar")));
    assert.ok(result.legalRuleVersion!.references.some(reference => reference.url.includes("2026-04-23-041426-rescamara.pdf")));
  }
  for (const date of ["2026-03-29", "2026-04-23", "2026-09-05"]) {
    assert.equal(calculateTerminationEstimate(input("2024-01-01", date)).status, "AVAILABLE");
  }
});
