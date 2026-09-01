import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  compareProcessingSnapshots,
  criticalFieldsBySettlementType,
  currentPipelineFingerprint,
  parserFixCatalog,
  processingPipelineVersions,
  type ProcessingSnapshot,
} from "../src/processing.ts";

const completeSnapshot: ProcessingSnapshot = {
  settlementType: "NORMAL",
  payrollPeriod: "2026-07-01",
  employerId: "employer-1",
  currencyCode: "ARS",
  basicAmount: "5376416.94",
  grossAmount: "6000000.00",
  netAmount: "5000000.00",
  remunerativeAmount: "6000000.00",
  nonRemunerativeAmount: "0.00",
  deductionsAmount: "1000000.00",
  lineItemsFingerprint: "concepts-v1",
  issueCodes: [],
};

test("the catalog matches the parser 6 basic-layout fix", () => {
  assert.deepEqual(processingPipelineVersions, {
    classifier: "6",
    extractor: "6",
    parser: "6",
    normalizer: "6",
    resultSchema: "1",
  });
  assert.match(currentPipelineFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(parserFixCatalog, [{
    issueCode: "LABEL_OR_LAYOUT_NOT_RECOGNIZED",
    affectedFieldPath: "settlement.basicAmount",
    introducedInParserVersion: "6",
  }]);
});

test("migration 020 fences pre-versioning workers", () => {
  const migration = readFileSync(new URL("../migrations/020_versioned_reprocessing.sql", import.meta.url), "utf8");
  assert.ok(migration.includes("PROCESSING_WORKER_DRAIN_REQUIRED"));
  assert.ok(migration.includes("DOCUMENT_PIPELINE_V2"));
  assert.ok(migration.includes(currentPipelineFingerprint));
});

test("basic amount is critical only for normal settlements", () => {
  assert.ok(criticalFieldsBySettlementType.NORMAL.includes("settlement.basicAmount"));
  for (const [settlementType, fields] of Object.entries(criticalFieldsBySettlementType)) {
    const fieldNames: readonly string[] = fields;
    if (settlementType !== "NORMAL") assert.ok(!fieldNames.includes("settlement.basicAmount"));
    assert.ok(fields.includes("settlement.netAmount"));
  }
});

test("snapshot comparison is conservative and has no numeric score", () => {
  assert.equal(compareProcessingSnapshots(completeSnapshot, { ...completeSnapshot }), "UNCHANGED");

  const missingBasic: ProcessingSnapshot = {
    ...completeSnapshot,
    basicAmount: null,
    issueCodes: ["LABEL_OR_LAYOUT_NOT_RECOGNIZED"],
  };
  assert.equal(compareProcessingSnapshots(missingBasic, completeSnapshot), "IMPROVED");
  assert.equal(compareProcessingSnapshots(completeSnapshot, missingBasic), "REGRESSED");
  assert.equal(
    compareProcessingSnapshots(completeSnapshot, { ...completeSnapshot, netAmount: "5000000.01" }),
    "REVIEW_REQUIRED",
  );
});
