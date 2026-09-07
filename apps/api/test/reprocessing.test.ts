import assert from "node:assert/strict";
import test from "node:test";

test("compatible processing runs keep only the same comparison shape", async () => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  const { findCompatibleProcessingRuns } = await import("../src/reprocessing.ts");
  const userId = "00000000-0000-4000-8000-000000000001";
  const source = { documentId: "00000000-0000-4000-8000-000000000002", runId: "00000000-0000-4000-8000-000000000003", baseRunId: "00000000-0000-4000-8000-000000000004" };
  const peer = { documentId: "00000000-0000-4000-8000-000000000005", runId: "00000000-0000-4000-8000-000000000006", baseRunId: "00000000-0000-4000-8000-000000000007" };
  const different = { documentId: "00000000-0000-4000-8000-000000000008", runId: "00000000-0000-4000-8000-000000000009", baseRunId: "00000000-0000-4000-8000-000000000010" };
  const structural = { documentId: "00000000-0000-4000-8000-000000000011", runId: "00000000-0000-4000-8000-000000000012", baseRunId: "00000000-0000-4000-8000-000000000013" };
  const candidates = [source, peer, different, structural];
  const query = async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes("WITH source AS")) {
      assert.match(sql, /source_transition\.signature AS line_item_transition_signature/);
      assert.match(sql, /peer_transition\.signature = source\.line_item_transition_signature/);
      assert.match(sql, /base_item\.amount IS DISTINCT FROM candidate_item\.amount/);
      assert.match(sql, /lower\(btrim\(COALESCE\(base_item\.raw_description/);
      assert.match(sql, /source_transition\.descriptions_unchanged/);
      assert.match(sql, /sum\(item\.amount\).*IS NOT DISTINCT FROM source_settlement\.gross_amount/s);
      assert.match(sql, /source_run\.parser_version = \$5/);
      assert.match(sql, /SELECT count\(\*\) FROM payroll_settlements settlement_count/);
      assert.match(sql, /source_settlement\.is_recurring IS NOT DISTINCT FROM source_base_settlement\.is_recurring/);
      assert.match(sql, /settlement\.payment_date IS NOT DISTINCT FROM base_settlement\.payment_date/);
      assert.match(sql, /source_base_settlement\.employment_id = source_document\.employment_id/);
      assert.match(sql, /base_settlement\.employment_id = document\.employment_id/);
      return { rows: candidates.filter((candidate) => candidate !== structural).map(({ documentId, runId, baseRunId }) => ({
        document_id: documentId, run_id: runId, expected_active_run_id: baseRunId,
      })) };
    }
    const [runId, requestedUserId, documentId] = parameters as string[];
    assert.equal(requestedUserId, userId);
    const candidate = candidates.find((entry) => entry.runId === runId && entry.documentId === documentId)!;
    const count = 2;
    return { rows: [
      {
        id: candidate.runId, base_extraction_run_id: candidate.baseRunId, settlement_id: candidate.runId,
        payroll_period: "2026-08", settlement_type: "NORMAL", currency_code: "ARS",
        basic_amount: candidate === source ? "100.00" : "200.00",
        gross_amount: candidate === different ? "310.00" : "300.00",
        net_amount: "250.00", remunerative_amount: "300.00", non_remunerative_amount: "0.00",
        deductions_amount: "50.00", employer_name: "Empresa sintética", item_count: count,
        line_items_fingerprint: `candidate-${candidate.runId}`,
      },
      {
        id: candidate.baseRunId, base_extraction_run_id: null, settlement_id: candidate.baseRunId,
        payroll_period: "2026-08", settlement_type: "NORMAL", currency_code: "ARS",
        basic_amount: candidate === source ? "100.00" : "200.00", gross_amount: "300.00",
        net_amount: "250.00", remunerative_amount: "300.00", non_remunerative_amount: "0.00",
        deductions_amount: "50.00", employer_name: "Empresa sintética", item_count: count,
        line_items_fingerprint: `base-${candidate.runId}`,
      },
    ] };
  };

  assert.deepEqual(
    await findCompatibleProcessingRuns({ query } as never, {
      userId, documentId: source.documentId, runId: source.runId,
    }),
    [
      { documentId: source.documentId, runId: source.runId, expectedActiveRunId: source.baseRunId },
      { documentId: peer.documentId, runId: peer.runId, expectedActiveRunId: peer.baseRunId },
    ],
  );
});

test("processing comparison preserves unknown and non-recurring line items", async () => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  const { loadProcessingComparisonPreview } = await import("../src/reprocessing.ts");
  const lineItem = (isRecurring: boolean | null) => ({
    itemOrdinal: 1, rawDescription: "Synthetic concept", normalizedConceptCode: "UNKNOWN",
    amount: "100.00", currencyCode: "ARS", itemType: "EARNING", isRecurring,
  });
  const query = async () => ({ rows: [
    {
      id: "candidate", base_extraction_run_id: "base", settlement_id: "candidate-settlement",
      item_count: 1, line_items_fingerprint: "candidate", line_items: [lineItem(false)],
    },
    {
      id: "base", base_extraction_run_id: null, settlement_id: "base-settlement",
      item_count: 1, line_items_fingerprint: "base", line_items: [lineItem(null)],
    },
  ] });
  const preview = await loadProcessingComparisonPreview(
    { query } as never, "owner", "document", "candidate", true,
  );
  assert.equal(preview?.lineItems.changes[0]?.before?.isRecurring, null);
  assert.equal(preview?.lineItems.changes[0]?.after?.isRecurring, false);
});
