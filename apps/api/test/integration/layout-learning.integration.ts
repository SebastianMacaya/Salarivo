import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { LightMyRequestResponse } from 'fastify';

test('reviewed layout aliases are versioned, admin-gated and reusable without another OCR request', { timeout: 60_000 }, async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const databaseAdmin = new Pool({ connectionString: databaseUrl });
  const client = await databaseAdmin.connect();
  const schema = `layout_test_${randomUUID().replaceAll('-', '')}`;
  let app: Awaited<ReturnType<typeof import('../../src/app.ts')['buildApp']>> | undefined;
  let workerPool: Pool | undefined;
  try {
    const { loadMigrations } = await import(new URL('../../../../packages/database/src/migrations.ts', import.meta.url).href);
    assert.match(schema, /^layout_test_[a-f0-9]{32}$/);
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
    process.env.APP_ENV = 'test';
    process.env.OCR_PROVIDER = 'tesseract';
    delete process.env.ZAI_API_KEY;
    const [database, { buildApp }, { loadConfig }, security, engine, orchestrator, { DisabledOCRProvider }, { fingerprintLayout }, reprocessing, worker] = await Promise.all([
      import('@salarivo/database'), import('../../src/app.ts'), import('../../src/config.ts'), import('../../src/security.ts'),
      import(new URL('../../../worker-documents/src/engine.ts', import.meta.url).href),
      import(new URL('../../../worker-documents/src/extraction-orchestrator.ts', import.meta.url).href),
      import(new URL('../../../worker-documents/src/ocr-provider.ts', import.meta.url).href),
      import(new URL('../../../worker-documents/src/layout-fingerprint.ts', import.meta.url).href),
      import('../../src/reprocessing.ts'), import(new URL('../../../worker-documents/src/index.ts', import.meta.url).href),
    ]);
    workerPool = database.pool;
    const origin = 'http://localhost:3000';
    const config = loadConfig({ ...process.env, APP_ENV: 'test', LOG_LEVEL: 'silent', PUBLIC_ORIGIN: origin });
    app = await buildApp(config);
    await app.ready();
    const adminId = randomUUID(), ownerId = randomUUID(), otherOwnerId = randomUUID();
    const employerId = randomUUID(), sessionId = randomUUID(), documentId = randomUUID(), runId = randomUUID();
    const batchId = randomUUID(), itemId = randomUUID(), uploadId = randomUUID();
    const employerName = 'Empresa Sintetica de Layouts SA';
    await client.query(`INSERT INTO users (id,email,status,role,admin_role,email_verified_at,onboarding_completed_at)
      VALUES ($1,$2,'ACTIVE','ADMIN','READ_ONLY',now(),now()),
             ($3,$4,'ACTIVE','USER',NULL,now(),now()),($5,$6,'ACTIVE','USER',NULL,now(),now())`,
    [adminId,`${adminId}@example.test`,ownerId,`${ownerId}@example.test`,otherOwnerId,`${otherOwnerId}@example.test`]);
    await client.query(`INSERT INTO auth_accounts (id,user_id,provider,provider_account_id) VALUES ($1,$2,'GOOGLE',$3)`,
      [randomUUID(),adminId,`synthetic-layout-${adminId}`]);
    await client.query(`INSERT INTO legal_acknowledgements (user_id,document_version_id)
      SELECT $1,version.id FROM (SELECT DISTINCT ON (document_type) id,document_type
        FROM legal_document_versions WHERE document_type IN ('TERMS','PRIVACY_NOTICE') AND locale='es-AR'
          AND published_at<=now() AND effective_at<=now()
        ORDER BY document_type,effective_at DESC,published_at DESC) version`,[adminId]);
    const token = security.opaqueToken();
    const cookie = `${security.sessionCookieName(config.appEnv)}=${token}`;
    await client.query(`INSERT INTO sessions (id,user_id,token_hash,expires_at,mfa_verified_at,step_up_expires_at)
      VALUES ($1,$2,$3,now()+interval '1 hour',now(),NULL)`,[sessionId,adminId,security.tokenHash(token)]);
    await client.query(`INSERT INTO mfa_factors (id,user_id,status,encrypted_secret,key_version,enabled_at)
      VALUES ($1,$2,'ACTIVE','synthetic-layout-mfa-secret-for-test-only',1,now())`,[randomUUID(),adminId]);
    await client.query(`INSERT INTO employers (id,name,country_code,status,created_source,created_by_user_id,verified_at)
      VALUES ($1,$2,'AR','VERIFIED','ADMIN',$3,now())`,[employerId,employerName,adminId]);

    const receipt = (period: string, basic: string, gross: string, deductions: string, net: string) =>
      `RECIBO DE SUELDO\nMoneda ARS\nEmpleador: ${employerName}\nCiclo liquidado: ${period}\nHaber garantizado $ ${basic}\n` +
      `Jubilacion $ ${deductions}\nTotal bruto $ ${gross}\nTotal descuentos $ ${deductions}\nNeto a cobrar $ ${net}`;
    const originalText = receipt('08/2026','1.000,00','1.000,00','100,00','900,00');
    const laterText = receipt('09/2026','1.500,00','1.500,00','150,00','1.350,00');
    const fingerprint = fingerprintLayout(originalText, 1);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(fingerprintLayout(laterText, 1), fingerprint, 'salary and date changes must not create another layout');
    const resolveLayout = (text: string, detectedEmployer: string) => database.findApprovedDocumentLayout(database.pool,
      { countryCode: 'AR', employerName: detectedEmployer, fingerprint: fingerprintLayout(text, 1) });
    let providerCalls = 0;
    const fallback = async () => {
      providerCalls++;
      return new DisabledOCRProvider().extract({ bytes: Buffer.from('%PDF-synthetic'), mimeType: 'application/pdf', pageCount: 1 });
    };
    const first = await orchestrator.orchestrateExtraction({ text: originalText, evidence: [], source: 'PDF_TEXT' }, { resolveLayout, fallback });
    assert.equal(first.extraction.payrollPeriod, null);
    assert.equal(first.extraction.needsReview, true);
    assert.ok(first.issues.includes('OCR_DISABLED'));
    assert.equal(await resolveLayout(originalText, employerName), null);

    await client.query(`INSERT INTO import_batches (id,user_id,idempotency_key,request_fingerprint)
      VALUES ($1::uuid,$2,$1::text,$3)`,[batchId,ownerId,'a'.repeat(64)]);
    await client.query(`INSERT INTO import_batch_items (id,user_id,batch_id,client_item_key,ordinal,original_filename,declared_mime_type,expected_size_bytes,status)
      VALUES ($1::uuid,$2,$3,$1::text,0,'synthetic-layout.pdf','application/pdf',2048,'NEEDS_REVIEW')`,[itemId,ownerId,batchId]);
    await client.query(`INSERT INTO upload_sessions (id,user_id,batch_id,item_id,object_key,expected_size_bytes,expected_mime_type,status,expires_at,confirmed_at)
      VALUES ($1,$2,$3,$4,$5,2048,'application/pdf','CONFIRMED',now()+interval '1 hour',now())`,[uploadId,ownerId,batchId,itemId,`synthetic/${documentId}`]);
    await client.query(`INSERT INTO documents (id,user_id,import_batch_id,import_batch_item_id,upload_session_id,object_key,original_filename,
      declared_mime_type,size_bytes,security_status,classification_status,document_type,processing_status,retention_policy,detected_employer_id)
      VALUES ($1,$2,$3,$4,$5,$6,'synthetic-layout.pdf','application/pdf',2048,'CLEAN','SUPPORTED','PAYROLL','NEEDS_REVIEW','KEEP_ORIGINAL',$7)`,
    [documentId,ownerId,batchId,itemId,uploadId,`synthetic/${documentId}`,employerId]);
    await client.query(`INSERT INTO extraction_runs (id,user_id,document_id,processing_version,status,extractor_name,extractor_version,
      parser_version,normalizer_version,detected_employer_id,layout_fingerprint,layout_fingerprint_version,pipeline_fingerprint,finished_at,
      country_code,country_source,country_confidence)
      VALUES ($1,$2,$3,1,'REVIEW_REQUIRED','synthetic',$4,$5,'6',$6,$7,'1',$8,now(),'AR','DOCUMENT_DETECTION','MEDIUM')`,
    [runId,ownerId,documentId,database.processingPipelineVersions.extractor,database.processingPipelineVersions.parser,employerId,fingerprint,database.currentPipelineFingerprint]);
    await client.query('UPDATE documents SET active_extraction_run_id=$1 WHERE id=$2',[runId,documentId]);
    await client.query(`INSERT INTO extraction_run_issues (id,user_id,document_id,extraction_run_id,code,severity,recoverable)
      VALUES ($1,$2,$3,$4,'UNKNOWN_LAYOUT','WARNING',true)`,[randomUUID(),ownerId,documentId,runId]);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,ownerId),0);
    const correctionId = randomUUID();
    await client.query(`INSERT INTO user_corrections (id,user_id,document_id,extraction_run_id,field_path,correction_version,extracted_value,corrected_value)
      VALUES ($1,$2,$3,$4,'settlement.basicAmount',1,'null'::jsonb,'{"amount":"975.00","currencyCode":"ARS"}'::jsonb)`,
    [correctionId,ownerId,documentId,runId]);

    const aliases = { 'settlement.payrollPeriod': ['Ciclo liquidado'], 'settlement.basicAmount': ['Haber garantizado'] };
    const payload = { employerId, fingerprint, fingerprintVersion: '1', aliases, enabled: true,
      reasonCode: 'OPERATIONAL_RECOVERY', reference: 'SYNTHETIC-LAYOUT-TEST' };
    const approve = (body: Record<string, unknown> = payload, headers = { origin, cookie }) => app!.inject({ method: 'POST', url: '/api/v1/admin/processing/layouts/approve', headers, payload: body });
    const deniedRole = await approve();
    assert.equal(deniedRole.statusCode, 403);
    assert.equal(deniedRole.json().error.code, 'ADMIN_PERMISSION_REQUIRED');
    await client.query("UPDATE users SET admin_role='SUPER_ADMIN' WHERE id=$1",[adminId]);
    const deniedStepUp = await approve();
    assert.equal(deniedStepUp.statusCode, 403);
    assert.equal(deniedStepUp.json().error.code, 'STEP_UP_REQUIRED');
    await client.query("UPDATE sessions SET step_up_expires_at=now()+interval '10 minutes' WHERE id=$1",[sessionId]);
    assert.equal((await approve(payload,{ origin:'https://untrusted.example',cookie })).statusCode,403);
    assert.equal((await approve({ ...payload, originRunId:runId, originUserId:otherOwnerId })).statusCode,400);
    for (const invalidAliases of [
      { 'settlement.basicAmount':['(a+)+$'] }, { 'settlement.basicAmount':['Sueldo 1000'] },
      { 'settlement.basicAmount':['https://example.test'] }, { 'settlement.basicAmount':['Neto\nSueldo'] },
      { 'settlement.basicAmount':['Mismo'], 'settlement.netAmount':['Mismo'] }, { 'employer.name':['Patron'] },
    ]) assert.equal((await approve({ ...payload, aliases:invalidAliases })).statusCode,400);
    assert.equal((await approve({...payload,fingerprint:'0'.repeat(64)})).json().error.code,'LAYOUT_NOT_OBSERVED');
    await client.query("UPDATE employers SET status='PENDING',verified_at=NULL WHERE id=$1",[employerId]);
    assert.equal((await approve()).json().error.code,'LAYOUT_EMPLOYER_NOT_VERIFIED');
    await client.query("UPDATE employers SET status='VERIFIED',verified_at=now() WHERE id=$1",[employerId]);
    const unavailableSources = [
      {id:ownerId,block:"UPDATE users SET status='DELETION_PENDING' WHERE id=$1",restore:"UPDATE users SET status='ACTIVE' WHERE id=$1"},
      {id:documentId,block:"UPDATE documents SET security_status='QUARANTINED' WHERE id=$1",restore:"UPDATE documents SET security_status='CLEAN' WHERE id=$1"},
      {id:documentId,block:'UPDATE documents SET original_deleted_at=now() WHERE id=$1',restore:'UPDATE documents SET original_deleted_at=NULL WHERE id=$1'},
    ];
    for (const unavailable of unavailableSources) {
      await client.query(unavailable.block,[unavailable.id]);
      assert.equal((await approve()).json().error.code,'LAYOUT_NOT_OBSERVED');
      const hidden: LightMyRequestResponse = await app.inject({method:'GET',url:'/api/v1/admin/processing/layouts',headers:{cookie}});
      assert.equal(hidden.json().data.total,0,'unavailable sources must not be exposed as layout observations');
      await client.query(unavailable.restore,[unavailable.id]);
    }
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM document_layout_versions')).rows[0].count,0);
    const approved = await approve();
    assert.equal(approved.statusCode,200,approved.body);
    assert.equal(approved.json().data.version,1);
    assert.equal((await reprocessing.findReprocessingCandidates(database.pool,ownerId)).length,1);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,ownerId),1);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,otherOwnerId),0);
    const profile = await resolveLayout(laterText,employerName);
    assert.ok(profile);
    assert.equal(profile.countryCode,'AR');
    assert.equal(profile.documentType,'PAYROLL');
    assert.equal(profile.parserVersion,database.processingPipelineVersions.parser);
    assert.equal(await database.findApprovedDocumentLayout(database.pool,
      {countryCode:'US',employerName,fingerprint}),null);
    assert.deepEqual(profile.aliases,aliases);
    const namesakeId = randomUUID();
    await client.query(`INSERT INTO employers (id,name,country_code,status,created_source,created_by_user_id)
      VALUES ($1,$2,'AR','PENDING','DOCUMENT',$3)`,[namesakeId,employerName,ownerId]);
    assert.equal(await resolveLayout(laterText,employerName),null,'a pending namesake must prevent ambiguous cross-employer reuse');
    await client.query('DELETE FROM employers WHERE id=$1',[namesakeId]);
    assert.equal((await resolveLayout(laterText,employerName))?.id,profile.id);
    const callsBeforeKnownLayout = providerCalls;
    const later = await orchestrator.orchestrateExtraction({ text:laterText,evidence:[],source:'PDF_TEXT' },{resolveLayout,fallback});
    assert.equal(providerCalls,callsBeforeKnownLayout,'approved aliases must take the deterministic path');
    assert.equal(later.extraction.payrollPeriod,'2026-09');
    assert.equal(later.extraction.basicAmount,'1500.00');
    assert.equal(later.extraction.netAmount,'1350.00');
    assert.equal(later.extraction.needsReview,false);
    const correction = (await client.query('SELECT field_path,corrected_value FROM user_corrections WHERE id=$1',[correctionId])).rows[0];
    assert.deepEqual(correction.corrected_value,{amount:'975.00',currencyCode:'ARS'});
    assert.equal(engine.applySettlementCorrections(later.extraction,[{fieldPath:correction.field_path,correctedValue:correction.corrected_value}]).basicAmount,'975.00');
    class ApiError extends Error { constructor(_status: number, code: string, _message: string) { super(code); } }
    const enqueue = () => database.withTransaction((db) => reprocessing.enqueueReprocessing(db,
      {userId:ownerId,requestedByUserId:ownerId,documentId,requestedKey:randomUUID(),triggerKind:'USER_REPROCESS'},ApiError));
    const queued = await enqueue();
    assert.equal(queued.created,true);
    await client.query("UPDATE processing_jobs SET state='PUBLISHED' WHERE id=$1",[queued.job.id]);
    const claimed = await worker.claimJob(queued.job.id,'synthetic-layout-worker',worker.loadConfig());
    assert.ok(claimed,'a newly approved layout permits a job on the current pipeline');
    assert.equal(await worker.resolveDocumentLayout({...claimed.job,user_id:otherOwnerId},laterText,employerName,1),null);
    assert.equal(await worker.resolveDocumentLayout({...claimed.job,lease_owner:'other-worker'},laterText,employerName,1),null);
    assert.equal((await worker.resolveDocumentLayout(claimed.job,laterText,employerName,1))?.id,profile.id);
    for (const unavailable of unavailableSources) {
      await client.query(unavailable.block,[unavailable.id]);
      assert.equal(await worker.resolveDocumentLayout(claimed.job,laterText,employerName,1),null);
      await client.query(unavailable.restore,[unavailable.id]);
    }
    // Another unsupported field can still require review after applying the approved aliases.
    assert.equal(await worker.persistExtraction(claimed.job,engine.classifyPayrollText(laterText),later.extraction,'PDF_TEXT',false,1,
      {layout:later.layout,issues:['UNKNOWN_LAYOUT']}),'NEEDS_REVIEW');
    const attempted = (await client.query(`SELECT status,document_layout_version_id,country_code,country_source FROM extraction_runs
      WHERE document_id=$1 AND processing_version=$2`,[documentId,queued.job.processingVersion])).rows[0];
    assert.equal(attempted.status,'REVIEW_REQUIRED');
    assert.equal(attempted.document_layout_version_id,profile.id);
    assert.equal(attempted.country_code,'AR');
    assert.equal(attempted.country_source,'DOCUMENT_DETECTION');
    assert.equal((await client.query('SELECT country_code FROM documents WHERE id=$1',[documentId])).rows[0].country_code,null,
      'reprocessing cannot populate a historical document snapshot silently');
    assert.equal((await client.query('SELECT active_extraction_run_id FROM documents WHERE id=$1',[documentId])).rows[0].active_extraction_run_id,runId);
    assert.deepEqual((await client.query('SELECT corrected_value FROM user_corrections WHERE id=$1',[correctionId])).rows[0].corrected_value,correction.corrected_value);
    await client.query('UPDATE processing_jobs SET execution_owner=NULL WHERE id=$1',[queued.job.id]);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,ownerId),0,'the same layout version cannot be retried indefinitely');
    assert.equal((await reprocessing.findReprocessingCandidates(database.pool,ownerId)).length,0);
    const approvedAgain = await approve();
    assert.equal(approvedAgain.statusCode,200,approvedAgain.body);
    assert.equal(approvedAgain.json().data.version,2);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,ownerId),1,'another explicit approval permits recovery');
    const queuedAgain = await enqueue();
    await client.query("UPDATE processing_jobs SET state='PUBLISHED' WHERE id=$1",[queuedAgain.job.id]);
    const claimedAgain = await worker.claimJob(queuedAgain.job.id,'synthetic-layout-worker',worker.loadConfig());
    assert.ok(claimedAgain);
    await assert.rejects(client.query("UPDATE document_layout_versions SET aliases='{}'::jsonb WHERE id=$1",[profile.id]),/DOCUMENT_LAYOUT_VERSION_IMMUTABLE/);
    const list = await app.inject({method:'GET',url:'/api/v1/admin/processing/layouts?page=1&pageSize=10',headers:{cookie}});
    assert.equal(list.statusCode,200,list.body);
    for (const forbidden of [documentId,runId,ownerId,otherOwnerId,originalText,'975.00']) assert.equal(list.body.includes(forbidden),false);
    const audit = await client.query("SELECT metadata_no_sensitive FROM admin_audit_events WHERE action LIKE '%LAYOUT%' OR action LIKE '%layout%'");
    assert.ok(audit.rows.length);
    assert.doesNotMatch(JSON.stringify(audit.rows),/Ciclo liquidado|Haber garantizado|975\.00|1\.000,00/);
    await client.query('UPDATE documents SET original_deleted_at=now() WHERE id=$1',[documentId]);
    const revoked = await approve({...payload,enabled:false,aliases:{}});
    assert.equal(revoked.statusCode,200,revoked.body);
    assert.equal(revoked.json().data.version,3);
    assert.equal(await resolveLayout(laterText,employerName),null);
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM document_layout_versions')).rows[0].count,3);
    await client.query('UPDATE documents SET original_deleted_at=NULL WHERE id=$1',[documentId]);
    // A revocation racing work that already read version 2 must prevent automatic promotion.
    const staleLayout = {...later.layout,profile:{...profile,id:approvedAgain.json().data.id,version:2}};
    assert.equal(await worker.persistExtraction(claimedAgain.job,engine.classifyPayrollText(laterText),later.extraction,'PDF_TEXT',false,1,
      {layout:staleLayout}),'NEEDS_REVIEW');
    assert.equal((await client.query(`SELECT count(*)::integer AS count FROM extraction_run_issues issue
      JOIN extraction_runs run ON run.id=issue.extraction_run_id
      WHERE run.document_id=$1 AND run.processing_version=$2 AND issue.code='LAYOUT_APPROVAL_CHANGED'`,
    [documentId,queuedAgain.job.processingVersion])).rows[0].count,1);
    assert.equal(providerCalls,callsBeforeKnownLayout,'all layout registry and recovery checks must remain offline');
    await client.query('UPDATE processing_jobs SET execution_owner=NULL WHERE id=$1',[queuedAgain.job.id]);
    // A selected run may never replace the preserved document jurisdiction, including admin rollback.
    await client.query(`UPDATE documents SET country_code='AR',country_source='DOCUMENT_DETECTION',
      country_confidence='MEDIUM',country_snapshot_at=now() WHERE id=$1`,[documentId]);
    const foreignRunId = randomUUID();
    await client.query(`INSERT INTO extraction_runs (id,user_id,document_id,processing_version,status,extractor_name,
      extractor_version,parser_version,normalizer_version,pipeline_fingerprint,country_code,country_source,country_confidence,finished_at)
      VALUES ($1,$2,$3,100,'COMPLETED','synthetic',$4,$5,'6',$6,'US','EMPLOYMENT_CONFIRMED','HIGH',now())`,
    [foreignRunId,ownerId,documentId,database.processingPipelineVersions.extractor,database.processingPipelineVersions.parser,database.currentPipelineFingerprint]);
    await assert.rejects(database.withTransaction((db) => reprocessing.promoteProcessingRun(db,
      {userId:ownerId,documentId,runId:foreignRunId,expectedActiveRunId:runId,decision:'PROMOTE'},ApiError)),
    /COUNTRY_REVIEW_REQUIRED/);
    const preserved = (await client.query('SELECT country_code,active_extraction_run_id FROM documents WHERE id=$1',[documentId])).rows[0];
    assert.equal(preserved.country_code,'AR');
    assert.equal(preserved.active_extraction_run_id,runId);
    const employmentId = randomUUID();
    await client.query(`INSERT INTO employments (id,user_id,employer_id,status,start_date,country_code,currency_code,
      country_source,country_confidence,country_confirmed_at)
      VALUES ($1,$2,$3,'UNKNOWN','2026-01-01','AR','ARS','USER_CONFIRMED','HIGH',now())`,[employmentId,ownerId,employerId]);
    const unresolvedRunId = randomUUID();
    await client.query(`INSERT INTO extraction_runs (id,user_id,document_id,processing_version,status,extractor_name,
      extractor_version,parser_version,normalizer_version,pipeline_fingerprint,finished_at)
      VALUES ($1,$2,$3,101,'REVIEW_REQUIRED','synthetic',$4,$5,'6',$6,now())`,
    [unresolvedRunId,ownerId,documentId,database.processingPipelineVersions.extractor,database.processingPipelineVersions.parser,database.currentPipelineFingerprint]);
    await client.query(`INSERT INTO extraction_run_issues (id,user_id,document_id,extraction_run_id,code,severity,recoverable)
      VALUES ($1,$2,$3,$4,'COUNTRY_UNCONFIRMED','ERROR',true)`,[randomUUID(),ownerId,documentId,unresolvedRunId]);
    await client.query('UPDATE documents SET active_extraction_run_id=$1,employment_id=$2 WHERE id=$3',[unresolvedRunId,employmentId,documentId]);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,ownerId),1,'confirmed employment unlocks country recovery');
    assert.equal((await reprocessing.findReprocessingCandidates(database.pool,ownerId)).length,1);
    assert.equal(await reprocessing.countReprocessingCandidates(database.pool,otherOwnerId),0);
    const recovery = await enqueue();
    await client.query("UPDATE processing_jobs SET state='PUBLISHED' WHERE id=$1",[recovery.job.id]);
    const recoveryClaim = await worker.claimJob(recovery.job.id,'synthetic-country-worker',worker.loadConfig());
    assert.ok(recoveryClaim);
    const recoverableText = laterText.replace('Moneda ARS\n','').replace('Ciclo liquidado','Período').replace('Haber garantizado','Sueldo básico');
    const recovered = await orchestrator.orchestrateExtraction({text:recoverableText,evidence:[],source:'PDF_TEXT'},
      {countryContext:{confirmedEmploymentCountryCode:'AR',snapshot:{countryCode:'AR',source:'DOCUMENT_DETECTION',confidence:'MEDIUM'}}});
    assert.equal(await worker.persistExtraction(recoveryClaim.job,engine.classifyPayrollText(recoverableText),recovered.extraction,
      'PDF_TEXT',false,1,{country:recovered.country,issues:recovered.issues,layout:recovered.layout}),'COMPLETED');
    const recoveredRun = (await client.query('SELECT id,country_code,country_source,promotion_outcome FROM extraction_runs WHERE document_id=$1 AND processing_version=$2',
      [documentId,recovery.job.processingVersion])).rows[0];
    assert.equal(recoveredRun.country_code,'AR');
    assert.equal(recoveredRun.country_source,'EMPLOYMENT_CONFIRMED');
    await client.query('UPDATE processing_jobs SET execution_owner=NULL WHERE id=$1',[recovery.job.id]);
    if (recoveredRun.promotion_outcome !== 'PROMOTED') {
      await database.withTransaction((db) => reprocessing.promoteProcessingRun(db,
        {userId:ownerId,documentId,runId:recoveredRun.id,expectedActiveRunId:unresolvedRunId,decision:'PROMOTE'},ApiError));
    }
    const recoveredDocument = (await client.query('SELECT country_code,country_source,employment_id FROM documents WHERE id=$1',[documentId])).rows[0];
    assert.equal(recoveredDocument.country_code,'AR');
    assert.equal(recoveredDocument.country_source,'DOCUMENT_DETECTION','reprocessing preserves the snapshot provenance');
    assert.equal(recoveredDocument.employment_id,employmentId);
    assert.equal((await client.query('SELECT active_extraction_run_id FROM documents WHERE id=$1',[documentId])).rows[0].active_extraction_run_id,recoveredRun.id);
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM extraction_run_issues WHERE extraction_run_id=$1 AND code='COUNTRY_UNCONFIRMED'",[unresolvedRunId])).rows[0].count,1,
      'country recovery preserves the earlier issue for audit');
    await client.query("UPDATE documents SET country_source='USER_CONFIRMED',country_confidence='HIGH',country_snapshot_at=now() WHERE id=$1",[documentId]);
    for (const [index, confirmedCountry] of ['AR','US'].entries()) {
      await client.query('UPDATE employments SET country_code=$2 WHERE id=$1',[employmentId,confirmedCountry]);
      const correctionJobId = randomUUID();
      await client.query(`INSERT INTO processing_jobs (id,user_id,document_id,stage,processing_version,idempotency_key,
        state,attempt,lease_owner,execution_owner,lease_expires_at,trigger_kind,previous_document_status,base_extraction_run_id,pipeline_fingerprint)
        VALUES ($1::uuid,$2,$3,'DOCUMENT_PIPELINE_V2',$4,$1::text,'RUNNING',1,'synthetic-country-worker','synthetic-country-worker',
          now()+interval '5 minutes','USER_REPROCESS','COMPLETED',$5,$6)`,
      [correctionJobId,ownerId,documentId,recovery.job.processingVersion+index+1,recoveredRun.id,database.currentPipelineFingerprint]);
      const correctionJob = (await client.query('SELECT * FROM processing_jobs WHERE id=$1',[correctionJobId])).rows[0];
      const contradictoryText = `${recoverableText}\nPaís: ES`;
      const corrected = await orchestrator.orchestrateExtraction({text:contradictoryText,evidence:[],source:'PDF_TEXT'},
        {countryContext:{confirmedEmploymentCountryCode:confirmedCountry,snapshot:{countryCode:'AR',source:'USER_CONFIRMED',confidence:'HIGH'}}});
      assert.equal(await worker.persistExtraction(correctionJob,engine.classifyPayrollText(contradictoryText),corrected.extraction,
        'PDF_TEXT',false,1,{country:corrected.country,issues:corrected.issues,layout:corrected.layout}),confirmedCountry==='AR'?'COMPLETED':'NEEDS_REVIEW');
      const countryRun = (await client.query('SELECT id,country_code,country_source,promotion_outcome FROM extraction_runs WHERE document_id=$1 AND processing_version=$2',
        [documentId,correctionJob.processing_version])).rows[0];
      const countryIssues = (await client.query('SELECT code,severity,metadata_no_sensitive FROM extraction_run_issues WHERE extraction_run_id=$1 AND code LIKE \'COUNTRY_%\'',[countryRun.id])).rows;
      if (confirmedCountry==='AR') {
        assert.equal(countryRun.country_source,'USER_CONFIRMED');
        assert.notEqual(countryRun.promotion_outcome,'REJECTED_REGRESSION','an informative country observation is not a regression');
        assert.deepEqual(countryIssues,[{code:'COUNTRY_DETECTION_OVERRIDDEN',severity:'INFO',metadata_no_sensitive:{
          detectedCountryCode:'ES',confirmedEmploymentCountryCode:'AR',snapshotCountryCode:'AR'}}]);
      } else {
        assert.ok(countryIssues.some(({code})=>code==='COUNTRY_EMPLOYMENT_CONFLICT'));
        assert.equal((await client.query('SELECT count(*)::integer AS count FROM payroll_settlements WHERE extraction_run_id=$1',[countryRun.id])).rows[0].count,0);
      }
      assert.deepEqual((await client.query('SELECT country_code,country_source,employment_id FROM documents WHERE id=$1',[documentId])).rows[0],
        {country_code:'AR',country_source:'USER_CONFIRMED',employment_id:employmentId});
      await client.query('UPDATE processing_jobs SET execution_owner=NULL WHERE id=$1',[correctionJobId]);
    }
  } finally {
    process.env.DATABASE_URL = databaseUrl;
    await app?.close();
    await workerPool?.end();
    await client.query('ROLLBACK').catch(()=>undefined);
    await client.query('RESET search_path');
    assert.match(schema,/^layout_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await databaseAdmin.end();
  }
});
