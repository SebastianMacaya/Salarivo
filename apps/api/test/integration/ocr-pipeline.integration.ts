import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Real credentials may exist locally; this suite exercises persistence and a synthetic provider only.
process.env.APP_ENV = "test";
process.env.OCR_ENABLED = "true";
process.env.OCR_PROVIDER = "tesseract";
delete process.env.ZAI_API_KEY;

test("OCR versionado conserva activo, descubre recuperación y reutiliza artefacto privado sin HTTP", async (context) => {
  const [{ pool, migrate, withTransaction, currentPipelineFingerprint, processingPipelineVersions }, apiConfig,
    { createStorage }, reprocessing, worker, orchestrator, engine] = await Promise.all([
    import("@salarivo/database"), import("../../src/config.ts"), import("../../src/storage.ts"),
    import("../../src/reprocessing.ts"),
    import(new URL("../../../worker-documents/src/index.ts", import.meta.url).href),
    import(new URL("../../../worker-documents/src/extraction-orchestrator.ts", import.meta.url).href),
    import(new URL("../../../worker-documents/src/engine.ts", import.meta.url).href),
  ]);
  let cleanup = async () => {};
  context.after(async () => { try { await cleanup(); } finally { await pool.end(); } });
  await migrate();
  const config = worker.loadConfig();
  const configuredLease = process.env.JOB_TIMEOUT_MS;
  process.env.OCR_PROVIDER = "zai";
  process.env.ZAI_API_KEY = "synthetic-config-key";
  process.env.JOB_TIMEOUT_MS = "685000";
  try { assert.throws(()=>worker.loadConfig(),/local and external OCR timeouts/); }
  finally {
    process.env.OCR_PROVIDER = "tesseract";
    delete process.env.ZAI_API_KEY;
    if (configuredLease === undefined) delete process.env.JOB_TIMEOUT_MS;
    else process.env.JOB_TIMEOUT_MS = configuredLease;
  }
  const storage = createStorage(apiConfig.loadConfig({ ...process.env, APP_ENV: "test", PUBLIC_ORIGIN: "http://localhost:3000" }));
  await storage.ensureBucket();
  const s3 = new S3Client({ endpoint: config.storageEndpoint, region: config.storageRegion, forcePathStyle: true,
    credentials: { accessKeyId: config.storageAccessKey, secretAccessKey: config.storageSecretKey } });
  const [userId, otherUserId, documentId, batchId, itemId, sessionId, baselineRunId, jobId] = Array.from({ length: 8 }, () => randomUUID());
  const originalKey = `tests/${randomUUID()}/synthetic.pdf`;
  cleanup = async () => {
    try {
      const artifacts = await pool.query("SELECT object_key FROM processing_artifacts WHERE user_id = $1", [userId]);
      for (const artifact of artifacts.rows) await s3.send(new DeleteObjectCommand({ Bucket: config.storageBucket, Key: String(artifact.object_key) }));
      await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
      await pool.query("DELETE FROM employers WHERE name = $1", [`Empresa Sintética OCR ${documentId}`]);
    } finally { storage.destroy(); s3.destroy(); }
  };
  await pool.query("INSERT INTO users (id,email,password_hash) VALUES ($1,$2,NULL),($3,$4,NULL)",
    [userId, `ocr-${userId}@example.test`, otherUserId, `ocr-${otherUserId}@example.test`]);
  await pool.query(`INSERT INTO import_batches (id,user_id,idempotency_key,request_fingerprint,status,completed_at)
    VALUES ($1::uuid,$2,$1::text,'${"a".repeat(64)}','COMPLETED',now())`, [batchId, userId]);
  await pool.query(`INSERT INTO import_batch_items
    (id,user_id,batch_id,client_item_key,ordinal,original_filename,declared_mime_type,expected_size_bytes,status)
    VALUES ($1::uuid,$2,$3,$1::text,0,'synthetic.pdf','application/pdf',128,'COMPLETED')`, [itemId,userId,batchId]);
  await pool.query(`INSERT INTO upload_sessions
    (id,user_id,batch_id,item_id,object_key,expected_size_bytes,expected_mime_type,status,expires_at,confirmed_at)
    VALUES ($1,$2,$3,$4,$5,128,'application/pdf','CONFIRMED',now()+interval '1 hour',now())`, [sessionId,userId,batchId,itemId,originalKey]);
  await pool.query(`INSERT INTO documents
    (id,user_id,import_batch_id,import_batch_item_id,upload_session_id,object_key,original_filename,declared_mime_type,
     size_bytes,security_status,classification_status,document_type,processing_status,retention_policy,sha256)
    VALUES ($1,$2,$3,$4,$5,$6,'synthetic.pdf','application/pdf',128,'CLEAN','SUPPORTED','PAYROLL','COMPLETED','KEEP_ORIGINAL',$7)`,
    [documentId,userId,batchId,itemId,sessionId,originalKey,"b".repeat(64)]);
  await pool.query(`INSERT INTO extraction_runs
    (id,user_id,document_id,processing_version,status,extractor_name,extractor_version,parser_version,normalizer_version,pipeline_fingerprint,finished_at)
    VALUES ($1,$2,$3,1,'COMPLETED','synthetic','6',$4,'6',$5,now())`,
    [baselineRunId,userId,documentId,processingPipelineVersions.parser,"c".repeat(64)]);
  await pool.query("UPDATE documents SET active_extraction_run_id=$1 WHERE id=$2", [baselineRunId,documentId]);
  await pool.query(`INSERT INTO extraction_run_issues
    (id,user_id,document_id,extraction_run_id,code,severity,recoverable)
    VALUES ($1,$2,$3,$4,'UNKNOWN_LAYOUT','WARNING',true)`, [randomUUID(),userId,documentId,baselineRunId]);
  assert.equal((await reprocessing.findReprocessingCandidates(pool,userId!)).length,0);
  // Pre-layout parser 7 gets one local observation pass even when extractor 7 already produced its OCR cache.
  await pool.query("UPDATE extraction_runs SET parser_version='7',extractor_version='7' WHERE id=$1", [baselineRunId]);
  assert.equal((await reprocessing.findReprocessingCandidates(pool,userId!)).length,1);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),1);
  await pool.query("UPDATE extraction_runs SET layout_fingerprint=$2,layout_fingerprint_version='1' WHERE id=$1", [baselineRunId,"e".repeat(64)]);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),0);
  await pool.query("UPDATE extraction_runs SET parser_version=$2,extractor_version='6',layout_fingerprint=NULL,layout_fingerprint_version=NULL WHERE id=$1",
    [baselineRunId,processingPipelineVersions.parser]);
  process.env.OCR_PROVIDER = "zai";
  assert.equal((await reprocessing.findReprocessingCandidates(pool,userId!)).length,1);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),1);
  assert.equal((await reprocessing.findReprocessingCandidates(pool,otherUserId!)).length,0);
  process.env.OCR_ENABLED = "false";
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),0);
  process.env.OCR_ENABLED = "true";
  await pool.query(`INSERT INTO processing_jobs
    (id,user_id,document_id,stage,processing_version,idempotency_key,state,attempt,max_attempts,
     lease_owner,execution_owner,lease_expires_at,previous_document_status,trigger_kind,base_extraction_run_id,pipeline_fingerprint)
    VALUES ($1::uuid,$2,$3,'DOCUMENT_PIPELINE_V2',2,$1::text,'RUNNING',1,3,'synthetic-worker','synthetic-worker',now()+interval '10 minutes',
     'COMPLETED','USER_REPROCESS',$4,$5)`, [jobId,userId,documentId,baselineRunId,currentPipelineFingerprint]);
  const job = (await pool.query("SELECT * FROM processing_jobs WHERE id=$1", [jobId])).rows[0]!;
  await pool.query(`INSERT INTO extraction_runs
    (id,user_id,document_id,processing_version,status,extractor_name,extractor_version,parser_version,normalizer_version,
     pipeline_fingerprint,base_extraction_run_id,trigger_kind)
    VALUES ($1,$2,$3,2,'PROCESSING','synthetic',$4,$5,'6',$6,$7,'USER_REPROCESS')`,
    [randomUUID(),userId,documentId,processingPipelineVersions.extractor,processingPipelineVersions.parser,currentPipelineFingerprint,baselineRunId]);
  await worker.setDocumentStage(job,"PARSING");
  const runId = (await pool.query("SELECT id FROM extraction_runs WHERE document_id=$1 AND processing_version=2", [documentId])).rows[0]!.id;
  const text = `RECIBO DE SUELDO\nEmpleador: Empresa Sintética OCR ${documentId}\nPeríodo: 08/2026\nSueldo básico $ 1.000,00\nJubilación $ 100,00\nTotal bruto $ 1.000,00\nTotal descuentos $ 100,00\nNeto a cobrar $ 900,00`;
  let calls = 0;
  const outcome = await orchestrator.orchestrateExtraction({ text:"",evidence:[],source:"PDF_TEXT" }, {
    fallback: async () => { calls++; return { provider:"zai",model:"glm-ocr",providerVersion:"1",text,
      pages:[{pageNumber:1,blocks:[]}],externalRequestId:"sal_synthetic",durationMs:1,retryCount:0 }; },
  });
  assert.equal(calls,1);
  const zaiConfig = {...config,ocr:{...config.ocr,provider:"zai"}};
  await worker.persistTextArtifact(s3,zaiConfig,job,runId,outcome,"OCR",false,1,outcome.ocrResult,true);
  const cached = await worker.loadCompatibleTextArtifact(s3,zaiConfig,job);
  assert.ok(cached?.ocr);
  const replay = await orchestrator.orchestrateExtraction(cached,{cachedOcr:cached.ocr,fallback:async()=>{calls++;throw new Error("must not call");}});
  assert.equal(calls,1);
  assert.equal(cached.reviewRequired,true);
  assert.equal(await worker.loadCompatibleTextArtifact(s3,zaiConfig,{...job,user_id:otherUserId}),null);
  assert.equal(await worker.persistExtraction(job,engine.classifyPayrollText(text),replay.extraction,"OCR",false,1,
    {ocr:replay.ocrResult,issues:["OCR_RESULT_CONFLICT"]}),"NEEDS_REVIEW");
  const state = (await pool.query(`SELECT d.active_extraction_run_id,d.processing_status,r.ocr_provider,r.ocr_version,r.promotion_outcome
    FROM documents d JOIN extraction_runs r ON r.document_id=d.id AND r.id=$2 WHERE d.id=$1`, [documentId,runId])).rows[0]!;
  assert.deepEqual(state,{active_extraction_run_id:baselineRunId,processing_status:"COMPLETED",ocr_provider:"zai",ocr_version:"1",promotion_outcome:"REVIEW_REQUIRED"});
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),0);
  await pool.query("UPDATE extraction_runs SET parser_version='7',extractor_version='7' WHERE id=$1", [baselineRunId]);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),0,"the observation upgrade must not repeat a terminal candidate");
  await pool.query("UPDATE extraction_runs SET parser_version=$2,extractor_version='6' WHERE id=$1", [baselineRunId,processingPipelineVersions.parser]);
  await pool.query("UPDATE processing_jobs SET execution_owner=NULL WHERE id=$1", [jobId]);
  await pool.query("UPDATE extraction_run_issues SET code='OCR_TIMEOUT' WHERE extraction_run_id=$1 AND code='OCR_RESULT_CONFLICT'", [runId]);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),1);
  await pool.query("UPDATE extraction_runs SET pipeline_fingerprint=$2,extractor_version=$3 WHERE id=$1",
    [baselineRunId,currentPipelineFingerprint,processingPipelineVersions.extractor]);
  await pool.query(`INSERT INTO extraction_run_issues (id,user_id,document_id,extraction_run_id,code,severity,recoverable)
    VALUES ($1,$2,$3,$4,'OCR_DISABLED','ERROR',true)`, [randomUUID(),userId,documentId,baselineRunId]);
  assert.equal(await reprocessing.countReprocessingCandidates(pool,userId!),1);
  class ApiError extends Error { constructor(_status:number,code:string,_message:string) { super(code); } }
  const request = { userId:userId!,requestedByUserId:userId!,documentId:documentId!,requestedKey:randomUUID(),triggerKind:"USER_REPROCESS" as const };
  const queued = await withTransaction((client)=>reprocessing.enqueueReprocessing(client,request,ApiError));
  const duplicate = await withTransaction((client)=>reprocessing.enqueueReprocessing(client,request,ApiError));
  assert.equal(queued.created,true);
  assert.equal(duplicate.job.id,queued.job.id);
  await pool.query("UPDATE processing_jobs SET state='PUBLISHED' WHERE id=$1", [queued.job.id]);
  const claimed = await worker.claimJob(queued.job.id,"synthetic-retry-worker",zaiConfig);
  assert.ok(claimed,"a transient OCR attempt must not permanently fence the same pipeline");
  assert.equal((await pool.query("SELECT active_extraction_run_id FROM documents WHERE id=$1", [documentId])).rows[0]!.active_extraction_run_id,baselineRunId);
  // Type confirmation with no active projection reuses the latest prior OCR artifact.
  await pool.query("UPDATE documents SET active_extraction_run_id=NULL WHERE id=$1", [documentId]);
  const confirmationCache = await worker.loadCompatibleTextArtifact(s3,zaiConfig,
    {...job,processing_version:3,base_extraction_run_id:null,trigger_kind:"USER_TYPE_CONFIRMATION"});
  assert.ok(confirmationCache?.ocr);
  await pool.query("UPDATE documents SET sha256=$2 WHERE id=$1", [documentId,"d".repeat(64)]);
  assert.equal(await worker.loadCompatibleTextArtifact(s3,zaiConfig,job),null);
});
