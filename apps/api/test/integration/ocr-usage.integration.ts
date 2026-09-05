import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

test('OCR admission is atomic, owner-scoped, bounded, replay-safe and survives deletion', async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: databaseUrl });
  const client = await admin.connect();
  const schema = `ocr_test_${randomUUID().replaceAll('-', '')}`;
  let workerPool: Pool | undefined;
  try {
    const { loadMigrations } = await import(new URL('../../../../packages/database/src/migrations.ts', import.meta.url).href);
    const { loadOcrConfig } = await import(new URL('../../../worker-documents/src/environment.ts', import.meta.url).href);
    const { OCRProviderError } = await import(new URL('../../../worker-documents/src/ocr-provider.ts', import.meta.url).href);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    for (const migration of await loadMigrations()) {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('COMMIT');
    }
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('options', `-csearch_path=${schema},public`);
    process.env.DATABASE_URL = isolatedUrl.href;
    const database = await import('@salarivo/database');
    workerPool = database.pool;
    const { runBudgetedOcr, recordOcrCacheHit } = await import(new URL('../../../worker-documents/src/ocr-usage.ts', import.meta.url).href);
    const config = loadOcrConfig({ OCR_ENABLED: 'true', OCR_PROVIDER: 'zai', ZAI_API_KEY: 'synthetic.key' });
    const provider = { providerName: 'synthetic', model: 'glm-ocr', providerVersion: '1' };
    const success = {
      provider: provider.providerName, model: provider.model, providerVersion: provider.providerVersion,
      text: 'SYNTHETIC', pages: [], usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
      externalRequestId: `sal_${randomUUID()}`, retryCount: 0, durationMs: 1,
    };
    async function acknowledgeCurrent(userId: string, documentTypes = ['TERMS','PRIVACY_NOTICE']) {
      await client.query(`INSERT INTO legal_acknowledgements (user_id,document_version_id)
        SELECT $1,current_version.id FROM (
          SELECT DISTINCT ON (document_type) id FROM legal_document_versions
           WHERE document_type=ANY($2::text[]) AND locale='es-AR' AND published_at<=now() AND effective_at<=now()
           ORDER BY document_type,effective_at DESC,split_part(version,'.',1)::numeric DESC,
                    split_part(version,'.',2)::numeric DESC,published_at DESC
        ) current_version ON CONFLICT DO NOTHING`,[userId,documentTypes]);
    }
    async function fixture(accepted = true) {
      const userId = randomUUID(), batchId = randomUUID(), itemId = randomUUID(), uploadId = randomUUID();
      const docId = randomUUID(), jobId = randomUUID(), runId = randomUUID(), lease = randomUUID();
      await client.query(`INSERT INTO users (id,email) VALUES ($1,$2)`, [userId, `${userId}@example.test`]);
      if (accepted) await acknowledgeCurrent(userId);
      await client.query(`INSERT INTO import_batches (id,user_id,idempotency_key,request_fingerprint)
        VALUES ($1,$2,$3,$4)`, [batchId,userId,batchId,createHash('sha256').update(batchId).digest('hex')]);
      await client.query(`INSERT INTO import_batch_items (id,user_id,batch_id,client_item_key,ordinal,
        original_filename,declared_mime_type,expected_size_bytes,status)
        VALUES ($1::uuid,$2,$3,$1::text,0,'synthetic.pdf','application/pdf',128,'PROCESSING')`, [itemId,userId,batchId]);
      await client.query(`INSERT INTO upload_sessions (id,user_id,batch_id,item_id,object_key,expected_size_bytes,
        expected_mime_type,status,expires_at,confirmed_at)
        VALUES ($1,$2,$3,$4,$5,128,'application/pdf','CONFIRMED',now()+interval '5 minutes',now())`,
      [uploadId,userId,batchId,itemId,`incoming/${uploadId}.pdf`]);
      await client.query(`INSERT INTO documents (id,user_id,import_batch_id,import_batch_item_id,upload_session_id,
        object_key,original_filename,declared_mime_type,detected_mime_type,size_bytes,page_count,
        security_status,classification_status,document_type,processing_status,retention_policy)
        VALUES ($1,$2,$3,$4,$5,$6,'synthetic.pdf','application/pdf','application/pdf',128,1,
        'CLEAN','SUPPORTED','PAYROLL','OCR','KEEP_ORIGINAL')`,
      [docId,userId,batchId,itemId,uploadId,`documents/${docId}.pdf`]);
      await client.query(`INSERT INTO processing_jobs (id,user_id,document_id,processing_version,stage,state,
        idempotency_key,attempt,max_attempts,lease_owner,lease_expires_at,execution_owner,
        pipeline_fingerprint) VALUES ($1::uuid,$2,$3,1,'DOCUMENT_PIPELINE_V2','RUNNING',$1::text,1,3,$4,
        now()+interval '5 minutes',$4,$5)`, [jobId,userId,docId,lease,database.currentPipelineFingerprint]);
      await client.query(`INSERT INTO extraction_runs (id,user_id,document_id,processing_version,status,
        extractor_name,extractor_version,parser_version,normalizer_version)
        VALUES ($1,$2,$3,1,'PROCESSING','synthetic','7','7','6')`,[runId,userId,docId]);
      return { job: { id:jobId,user_id:userId,document_id:docId,lease_owner:lease }, runId,
        triggerReason:'NO_NATIVE_TEXT',provider,config };
    }
    const legal = await fixture(false);
    const requesterId = randomUUID();
    await client.query(`INSERT INTO users (id,email,role,admin_role) VALUES ($1,$2,'ADMIN','SUPER_ADMIN')`,
      [requesterId,`${requesterId}@example.test`]);
    await acknowledgeCurrent(requesterId);
    await client.query('UPDATE processing_jobs SET requested_by_user_id=$1 WHERE id=$2',[requesterId,legal.job.id]);
    let legalCalls = 0;
    const legalProvider = async () => { legalCalls++; return success; };
    await assert.rejects(runBudgetedOcr(legal,legalProvider),{code:'OCR_LEGAL_ACCEPTANCE_REQUIRED',retryable:true});
    await acknowledgeCurrent(legal.job.user_id,['TERMS']);
    await assert.rejects(runBudgetedOcr(legal,legalProvider),/OCR_LEGAL_ACCEPTANCE_REQUIRED/);
    assert.equal(legalCalls,0,'requester acceptance never replaces document-owner acceptance');
    assert.equal((await client.query(`SELECT count(*)::integer AS count FROM ocr_provider_usage
      WHERE status='RESERVED' OR accounted_cost_usd>0`)).rows[0].count,0);
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM ocr_provider_daily_costs')).rows[0].count,0);
    await recordOcrCacheHit(legal);
    await acknowledgeCurrent(legal.job.user_id,['PRIVACY_NOTICE']);
    await runBudgetedOcr(legal,legalProvider);
    assert.equal(legalCalls,1);
    const accountedBeforeLegalChange=(await client.query('SELECT sum(accounted_cost_usd)::text AS total FROM ocr_provider_daily_costs')).rows[0].total;
    await client.query(`INSERT INTO legal_document_versions
      (id,document_type,version,locale,title,content,published_at,effective_at,requires_acceptance,approved_for_production)
      VALUES ($1,'PRIVACY_NOTICE','999.0','es-AR','Aviso sintético vigente',$2,now(),now(),true,true)`,
    [randomUUID(),'Contenido exclusivamente sintético para verificar la reaceptación legal del propietario. '.repeat(3)]);
    await assert.rejects(runBudgetedOcr(legal,legalProvider),/OCR_LEGAL_ACCEPTANCE_REQUIRED/);
    assert.equal(legalCalls,1,'a newly effective legal version blocks another external transfer');
    assert.equal((await client.query('SELECT sum(accounted_cost_usd)::text AS total FROM ocr_provider_daily_costs')).rows[0].total,accountedBeforeLegalChange);
    await client.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[legal.job.user_id,requesterId]]);
    assert.ok(database.retryableOcrIssueCodes.includes('OCR_LEGAL_ACCEPTANCE_REQUIRED'));
    const first = await fixture(), second = await fixture();
    await assert.rejects(runBudgetedOcr({...first,config:{...config,enabled:false}},async()=>success),/OCR_DISABLED/);
    let release!: (value: typeof success) => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    let calls = 0;
    const inFlight = runBudgetedOcr(first, async () => { calls++; admitted(); return new Promise<typeof success>((resolve) => { release = resolve; }); });
    await started;
    await assert.rejects(runBudgetedOcr(second, async () => { calls++; return success; }), /OCR_CONCURRENCY_LIMIT/);
    release(success);
    await inFlight;
    assert.equal(calls,1);
    await assert.rejects(runBudgetedOcr(first, async () => { calls++; return success; }), /OCR_ALREADY_ATTEMPTED/);
    const row = (await client.query(`SELECT status,total_tokens::text,estimated_cost_usd::text
      FROM ocr_provider_usage WHERE extraction_run_id=$1 AND status='SUCCEEDED'`,[first.runId])).rows[0];
    assert.deepEqual(row,{status:'SUCCEEDED',total_tokens:'200',estimated_cost_usd:'0.00000600'});
    await recordOcrCacheHit(second);
    await assert.rejects(runBudgetedOcr({...second,job:{...second.job,user_id:first.job.user_id}},async () => success), /OCR_JOB_NOT_AUTHORIZED/);
    await assert.rejects(runBudgetedOcr({...second,config:{...config,dailyBudgetUsd:'0.00000600'}},async () => success), /OCR_BUDGET_EXCEEDED/);
    await assert.rejects(runBudgetedOcr({...second,config:{...config,monthlyBudgetUsd:'0.00000600'}},async () => success), /OCR_BUDGET_EXCEEDED/);
    await assert.rejects(runBudgetedOcr(second,async () => {throw new OCRProviderError('OCR_TIMEOUT',true);}), /OCR_TIMEOUT/);
    assert.equal((await client.query(`SELECT accounted_cost_usd::text FROM ocr_provider_usage
      WHERE extraction_run_id=$1 AND status='FAILED'`,[second.runId])).rows[0].accounted_cost_usd,'0.02000000');
    const before=(await client.query(`SELECT accounted_cost_usd::text FROM ocr_provider_daily_costs WHERE provider='synthetic'`)).rows[0].accounted_cost_usd;
    await client.query(`DELETE FROM users WHERE id=ANY($1::uuid[])`,[[first.job.user_id,second.job.user_id]]);
    assert.equal((await client.query(`SELECT count(*)::integer AS count FROM ocr_provider_usage`)).rows[0].count,0);
    assert.equal((await client.query(`SELECT accounted_cost_usd::text FROM ocr_provider_daily_costs WHERE provider='synthetic'`)).rows[0].accounted_cost_usd,before);
    for (let failure=0; failure<5; failure++) {
      await assert.rejects(runBudgetedOcr(await fixture(),async()=>{throw new OCRProviderError('OCR_TIMEOUT',true);}),/OCR_TIMEOUT/);
    }
    await assert.rejects(runBudgetedOcr(await fixture(),async()=>success),/OCR_CIRCUIT_OPEN/);
  } finally {
    process.env.DATABASE_URL=databaseUrl;
    await workerPool?.end();
    assert.match(schema,/^ocr_test_[a-f0-9]{32}$/);
    await client.query('ROLLBACK').catch(()=>undefined);
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await admin.end();
  }
});
