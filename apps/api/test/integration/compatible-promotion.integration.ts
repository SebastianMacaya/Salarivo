import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

test("a reviewed parser improvement promotes only compatible receipts", { timeout: 60_000 }, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: databaseUrl });
  const client = await admin.connect();
  const schema = `compatible_promotion_${randomUUID().replaceAll("-", "")}`;
  let app: Awaited<ReturnType<typeof import("../../src/app.ts")["buildApp"]>> | undefined;
  let database: typeof import("@salarivo/database") | undefined;
  try {
    assert.match(schema, /^compatible_promotion_[a-f0-9]{32}$/);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    const { loadMigrations } = await import(
      new URL("../../../../packages/database/src/migrations.ts", import.meta.url).href
    );
    for (const migration of await loadMigrations()) {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("COMMIT");
    }
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set("options", `-csearch_path=${schema},public`);
    process.env.DATABASE_URL = isolatedUrl.href;
    process.env.APP_ENV = "test";
    process.env.OCR_PROVIDER = "tesseract";
    delete process.env.ZAI_API_KEY;
    database = await import("@salarivo/database");
    const [{ buildApp }, { loadConfig }, security] = await Promise.all([
      import("../../src/app.ts"),
      import("../../src/config.ts"),
      import("../../src/security.ts"),
    ]);
    const origin = "http://localhost:3000";
    app = await buildApp(loadConfig({
      ...process.env,
      APP_ENV: "test",
      LOG_LEVEL: "silent",
      PUBLIC_ORIGIN: origin,
    }), { provisionStorage: false });
    await app.ready();

    const ownerId = randomUUID();
    const employerId = randomUUID();
    const employmentId = randomUUID();
    const importBatchId = randomUUID();
    const reprocessingBatchId = randomUUID();
    await client.query(
      `INSERT INTO users (id,email,status,role,email_verified_at,onboarding_completed_at)
       VALUES ($1,$2,'ACTIVE','USER',now(),now())`,
      [ownerId, `${ownerId}@example.test`],
    );
    await client.query(
      `INSERT INTO auth_accounts (id,user_id,provider,provider_account_id)
       VALUES ($1,$2,'GOOGLE',$3)`,
      [randomUUID(), ownerId, `compatible-${ownerId}`],
    );
    await client.query(
      `INSERT INTO legal_acknowledgements (user_id,document_version_id)
       SELECT $1,id FROM (
         SELECT DISTINCT ON (document_type) id FROM legal_document_versions
          WHERE effective_at <= now() AND published_at <= now()
          ORDER BY document_type,effective_at DESC,published_at DESC
       ) versions`,
      [ownerId],
    );
    const token = security.opaqueToken();
    await client.query(
      `INSERT INTO sessions (id,user_id,token_hash,expires_at)
       VALUES ($1,$2,$3,now()+interval '1 hour')`,
      [randomUUID(), ownerId, security.tokenHash(token)],
    );
    const cookie = `${security.sessionCookieName("test")}=${token}`;
    await client.query(
      `INSERT INTO employers (id,name,country_code,status,created_source,created_by_user_id,verified_at)
       VALUES ($1,'Empresa Sintetica Compatible SA','AR','VERIFIED','DOCUMENT',$2,now())`,
      [employerId, ownerId],
    );
    await client.query(
      `INSERT INTO employments (
         id,user_id,employer_id,status,start_date,country_code,currency_code,
         country_source,country_confidence,country_confirmed_at
       ) VALUES ($1,$2,$3,'ACTIVE','2026-01-01','AR','ARS','USER_CONFIRMED','HIGH',now())`,
      [employmentId, ownerId, employerId],
    );
    await client.query(
      `INSERT INTO import_batches (id,user_id,idempotency_key,request_fingerprint,status,completed_at)
       VALUES ($1,$2,$3,$4,'COMPLETED',now())`,
      [importBatchId, ownerId, `compatible-import-${importBatchId}`, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO reprocessing_batches (
         id,user_id,requested_by_user_id,trigger_kind,idempotency_key,status,completed_at
       ) VALUES ($1,$2,$2,'PARSER_UPGRADE',$3,'COMPLETED',now())`,
      [reprocessingBatchId, ownerId, `compatible-reprocessing-${reprocessingBatchId}`],
    );

    const layoutFingerprint = "b".repeat(64);
    const basePipeline = "c".repeat(64);
    const receipts: Array<{ baseRunId: string; candidateRunId: string; documentId: string }> = [];
    const scenarios = [
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "1000.00", extraSettlement: false },
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "1000.00", extraSettlement: false },
      { primaryFieldChanged: true, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "1000.00", extraSettlement: false },
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic bonus", candidateAmount: "1000.00", extraSettlement: false },
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "1000.00", extraSettlement: true },
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "950.00", extraSettlement: false },
      { primaryFieldChanged: false, candidateConceptCode: "BASIC_SALARY", description: "Synthetic base", candidateAmount: "1000.00", extraSettlement: false, candidateSourceField: "settlement.remunerativeAmount" },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const itemId = randomUUID();
      const uploadId = randomUUID();
      const documentId = randomUUID();
      const baseRunId = randomUUID();
      const candidateRunId = randomUUID();
      const baseSettlementId = randomUUID();
      const candidateSettlementId = randomUUID();
      const period = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"][index]!;
      await client.query(
        `INSERT INTO import_batch_items (
           id,user_id,batch_id,employment_id,client_item_key,ordinal,original_filename,
           declared_mime_type,expected_size_bytes,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'application/pdf',128,'COMPLETED')`,
        [itemId, ownerId, importBatchId, employmentId, `compatible-item-${index}`, index,
          `compatible-${index}.pdf`],
      );
      await client.query(
        `INSERT INTO upload_sessions (
           id,user_id,batch_id,item_id,object_key,expected_size_bytes,expected_mime_type,
           status,expires_at,confirmed_at
         ) VALUES ($1,$2,$3,$4,$5,128,'application/pdf','CONFIRMED',now()+interval '1 hour',now())`,
        [uploadId, ownerId, importBatchId, itemId, `compatible/${documentId}`],
      );
      await client.query(
        `INSERT INTO documents (
           id,user_id,import_batch_id,import_batch_item_id,upload_session_id,employment_id,
           object_key,original_filename,declared_mime_type,size_bytes,security_status,
           classification_status,document_type,processing_status,retention_policy,
           detected_employer_id,country_code,country_source,country_confidence,country_snapshot_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'application/pdf',128,'CLEAN','SUPPORTED',
           'PAYROLL','COMPLETED','KEEP_ORIGINAL',$9,'AR','DOCUMENT_DETECTION','HIGH',now())`,
        [documentId, ownerId, importBatchId, itemId, uploadId, employmentId,
          `compatible/${documentId}`, `compatible-${index}.pdf`, employerId],
      );
      await client.query(
        `INSERT INTO extraction_runs (
           id,user_id,document_id,processing_version,status,extractor_name,extractor_version,
           parser_version,normalizer_version,result_schema_version,pipeline_fingerprint,
           trigger_kind,detected_employer_id,layout_fingerprint,layout_fingerprint_version,
           country_code,country_source,country_confidence,promotion_outcome,promoted_at,finished_at
         ) VALUES ($1,$2,$3,1,'COMPLETED','synthetic','7','7','6','1',$4,'INITIAL_UPLOAD',
           $5,$6,'1','AR','DOCUMENT_DETECTION','HIGH','PROMOTED',now(),now())`,
        [baseRunId, ownerId, documentId, basePipeline, employerId, layoutFingerprint],
      );
      await client.query("UPDATE documents SET active_extraction_run_id=$1 WHERE id=$2", [baseRunId, documentId]);
      await client.query(
        `INSERT INTO extraction_runs (
           id,user_id,document_id,processing_version,status,extractor_name,extractor_version,
           parser_version,normalizer_version,result_schema_version,pipeline_fingerprint,
           trigger_kind,base_extraction_run_id,detected_employer_id,layout_fingerprint,
           layout_fingerprint_version,country_code,country_source,country_confidence,
           promotion_outcome,comparison_summary,finished_at
         ) VALUES ($1,$2,$3,2,'COMPLETED','synthetic','7',$8,'6','1',$4,'PARSER_UPGRADE',
           $5,$6,$7,'1','AR','DOCUMENT_DETECTION','HIGH','REVIEW_REQUIRED',
           '{"comparison":"REVIEW_REQUIRED"}'::jsonb,now())`,
        [candidateRunId, ownerId, documentId, database.currentPipelineFingerprint,
          baseRunId, employerId, layoutFingerprint, database.processingPipelineVersions.parser],
      );
      const baseBasic = "1000.00";
      const candidateBasic = scenario.primaryFieldChanged ? "1100.00" : baseBasic;
      for (const [runId, settlementId, basicAmount] of [
        [baseRunId, baseSettlementId, baseBasic],
        [candidateRunId, candidateSettlementId, candidateBasic],
      ]) {
        await client.query(
          `INSERT INTO payroll_settlements (
             id,user_id,document_id,extraction_run_id,employment_id,settlement_ordinal,
             payroll_period,settlement_type,is_recurring,currency_code,basic_amount,gross_amount,
             net_amount,remunerative_amount,non_remunerative_amount,deductions_amount
           ) VALUES ($1,$2,$3,$4,$5,1,$6,'NORMAL',true,'ARS',$7,'1000.00','900.00',
             '1000.00','0.00','100.00')`,
          [settlementId, ownerId, documentId, runId, employmentId, period, basicAmount],
        );
      }
      if (scenario.extraSettlement) {
        await client.query(
          `INSERT INTO payroll_settlements (
             id,user_id,document_id,extraction_run_id,employment_id,settlement_ordinal,
             payroll_period,settlement_type,is_recurring,currency_code,basic_amount,gross_amount,
             net_amount,remunerative_amount,non_remunerative_amount,deductions_amount
           ) VALUES ($1,$2,$3,$4,$5,2,$6,'NORMAL',true,'ARS','1000.00','1000.00',
             '900.00','1000.00','0.00','100.00')`,
          [randomUUID(), ownerId, documentId, candidateRunId, employmentId, period],
        );
      }
      await client.query(
        `INSERT INTO payroll_line_items (
           id,user_id,settlement_id,item_ordinal,raw_description,normalized_concept_code,
           amount,currency_code,item_type,is_recurring,source_field
         ) VALUES
           ($1,$2,$3,1,$7,'UNKNOWN','900.00','ARS','EARNING',true,NULL),
           ($4,$2,$5,1,$7,$6,$8,'ARS','EARNING',true,$9)`,
        [randomUUID(), ownerId, baseSettlementId, randomUUID(), candidateSettlementId,
          scenario.candidateConceptCode, scenario.description, scenario.candidateAmount,
          'candidateSourceField' in scenario ? scenario.candidateSourceField : null],
      );
      await client.query(
        `INSERT INTO processing_jobs (
           id,user_id,document_id,stage,processing_version,idempotency_key,state,attempt,
           completed_at,trigger_kind,base_extraction_run_id,reprocessing_batch_id,pipeline_fingerprint
         ) VALUES ($1,$2,$3,'DOCUMENT_PIPELINE_V2',2,$4,'COMPLETED',1,now(),
           'PARSER_UPGRADE',$5,$6,$7)`,
        [randomUUID(), ownerId, documentId, `compatible-job-${randomUUID()}`,
          baseRunId, reprocessingBatchId, database.currentPipelineFingerprint],
      );
      receipts.push({ baseRunId, candidateRunId, documentId });
    }

    const [source, peer, changed, structural, multipleSettlements, unreconciled, differentColumn] = receipts;
    assert.ok(source && peer && changed && structural && multipleSettlements && unreconciled && differentColumn);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${source.documentId}/processing-runs/${source.candidateRunId}`,
      headers: { cookie },
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().data.compatiblePromotionCount, 2);
    assert.deepEqual(detail.json().data.comparisonPreview.lineItems.changes, [{
      itemOrdinal: 1,
      before: {
        itemOrdinal: 1, rawDescription: "Synthetic base", normalizedConceptCode: "UNKNOWN",
        amount: "900.00", currencyCode: "ARS", itemType: "EARNING", isRecurring: true, sourceField: null,
      },
      after: {
        itemOrdinal: 1, rawDescription: "Synthetic base", normalizedConceptCode: "BASIC_SALARY",
        amount: "1000.00", currencyCode: "ARS", itemType: "EARNING", isRecurring: true, sourceField: null,
      },
    }]);

    const rejectedBulkFallback = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${changed.documentId}/processing-runs/${changed.candidateRunId}/decision`,
      headers: { cookie, origin },
      payload: {
        decision: "PROMOTE",
        expectedActiveRunId: changed.baseRunId,
        expectedCompatiblePromotionCount: 1,
        scope: "COMPATIBLE",
      },
    });
    assert.equal(rejectedBulkFallback.statusCode, 409, rejectedBulkFallback.body);
    assert.equal(rejectedBulkFallback.json().error.code, "COMPATIBLE_PROMOTION_COUNT_CHANGED");

    const staleCompatibleCount = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${source.documentId}/processing-runs/${source.candidateRunId}/decision`,
      headers: { cookie, origin },
      payload: {
        decision: "PROMOTE",
        expectedActiveRunId: source.baseRunId,
        expectedCompatiblePromotionCount: 3,
        scope: "COMPATIBLE",
      },
    });
    assert.equal(staleCompatibleCount.statusCode, 409, staleCompatibleCount.body);
    assert.equal(staleCompatibleCount.json().error.code, "COMPATIBLE_PROMOTION_COUNT_CHANGED");
    assert.deepEqual(
      (await client.query(
        `SELECT document.active_extraction_run_id,candidate.promotion_outcome
           FROM documents document
           JOIN extraction_runs candidate ON candidate.id=$2
          WHERE document.id=$1`,
        [source.documentId, source.candidateRunId],
      )).rows[0],
      { active_extraction_run_id: source.baseRunId, promotion_outcome: "REVIEW_REQUIRED" },
    );

    const promoted = await app.inject({
      method: "POST",
      url: `/api/v1/documents/${source.documentId}/processing-runs/${source.candidateRunId}/decision`,
      headers: { cookie, origin },
      payload: {
        decision: "PROMOTE",
        expectedActiveRunId: source.baseRunId,
        expectedCompatiblePromotionCount: 2,
        scope: "COMPATIBLE",
      },
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    assert.equal(promoted.json().data.compatiblePromotionCount, 2);
    const states = (await client.query(
      `SELECT document.id,document.active_extraction_run_id,document.processing_status,
              candidate.promotion_outcome
         FROM documents document
         JOIN extraction_runs candidate
           ON candidate.user_id=document.user_id AND candidate.document_id=document.id
          AND candidate.processing_version=2
        WHERE document.id=ANY($1::uuid[])
        ORDER BY document.id`,
      [receipts.map(({ documentId }) => documentId)],
    )).rows;
    const stateByDocument = new Map(states.map((state) => [String(state.id), state]));
    for (const compatible of [source, peer]) {
      const state = stateByDocument.get(compatible.documentId)!;
      assert.equal(String(state.active_extraction_run_id), compatible.candidateRunId);
      assert.equal(state.processing_status, "COMPLETED");
      assert.equal(state.promotion_outcome, "PROMOTED");
    }
    const changedState = stateByDocument.get(changed.documentId)!;
    assert.equal(String(changedState.active_extraction_run_id), changed.baseRunId);
    assert.equal(changedState.processing_status, "COMPLETED");
    assert.equal(changedState.promotion_outcome, "REVIEW_REQUIRED");
    const structuralState = stateByDocument.get(structural.documentId)!;
    assert.equal(String(structuralState.active_extraction_run_id), structural.baseRunId);
    assert.equal(structuralState.processing_status, "COMPLETED");
    assert.equal(structuralState.promotion_outcome, "REVIEW_REQUIRED");
    const multipleSettlementsState = stateByDocument.get(multipleSettlements.documentId)!;
    assert.equal(String(multipleSettlementsState.active_extraction_run_id), multipleSettlements.baseRunId);
    assert.equal(multipleSettlementsState.processing_status, "COMPLETED");
    assert.equal(multipleSettlementsState.promotion_outcome, "REVIEW_REQUIRED");
    const unreconciledState = stateByDocument.get(unreconciled.documentId)!;
    assert.equal(String(unreconciledState.active_extraction_run_id), unreconciled.baseRunId);
    assert.equal(unreconciledState.processing_status, "COMPLETED");
    assert.equal(unreconciledState.promotion_outcome, "REVIEW_REQUIRED");
    const differentColumnState = stateByDocument.get(differentColumn.documentId)!;
    assert.equal(String(differentColumnState.active_extraction_run_id), differentColumn.baseRunId);
    assert.equal(differentColumnState.promotion_outcome, "REVIEW_REQUIRED");
  } finally {
    process.env.DATABASE_URL = databaseUrl;
    await app?.close();
    await database?.pool.end();
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET search_path");
    assert.match(schema, /^compatible_promotion_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await admin.end();
  }
});
