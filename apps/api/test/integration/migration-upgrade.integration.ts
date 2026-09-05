import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';

test('populated pre-020 databases upgrade without rewriting historical SQL or legal acknowledgements', async () => {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await admin.connect();
  const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
  let isolated: Pool | undefined;
  try {
    const { loadMigrations, runMigrations } = await import(new URL('../../../../packages/database/src/migrations.ts', import.meta.url).href);
    const migrations = await loadMigrations();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL UNIQUE,
      checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of migrations.filter((entry: { version: number }) => entry.version <= 19)) {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version,name,checksum) VALUES ($1,$2,$3)', [migration.version,migration.name,migration.checksum]);
      await client.query('COMMIT');
    }
    const [userId,batchId,itemId,uploadId,documentId,runId,jobId] = Array.from({length:7},()=>randomUUID());
    await client.query('INSERT INTO users (id,email,password_hash) VALUES ($1,$2,NULL)', [userId,`${userId}@example.test`]);
    await client.query('INSERT INTO legal_acknowledgements (user_id,document_version_id) SELECT $1,id FROM legal_document_versions', [userId]);
    await client.query(`INSERT INTO import_batches (id,user_id,idempotency_key,request_fingerprint,status,completed_at)
      VALUES ($1::uuid,$2,$1::text,$3,'COMPLETED',now())`, [batchId,userId,'a'.repeat(64)]);
    await client.query(`INSERT INTO import_batch_items (id,user_id,batch_id,client_item_key,ordinal,original_filename,declared_mime_type,expected_size_bytes,status)
      VALUES ($1::uuid,$2,$3,$1::text,0,'synthetic.pdf','application/pdf',128,'COMPLETED')`, [itemId,userId,batchId]);
    await client.query(`INSERT INTO upload_sessions (id,user_id,batch_id,item_id,object_key,expected_size_bytes,expected_mime_type,status,expires_at,confirmed_at)
      VALUES ($1,$2,$3,$4,$5,128,'application/pdf','CONFIRMED',now()+interval '1 hour',now())`, [uploadId,userId,batchId,itemId,`synthetic/${documentId}`]);
    await client.query(`INSERT INTO documents (id,user_id,import_batch_id,import_batch_item_id,upload_session_id,object_key,original_filename,
      declared_mime_type,size_bytes,security_status,classification_status,document_type,processing_status,retention_policy)
      VALUES ($1,$2,$3,$4,$5,$6,'synthetic.pdf','application/pdf',128,'CLEAN','SUPPORTED','PAYROLL','COMPLETED','KEEP_ORIGINAL')`,
    [documentId,userId,batchId,itemId,uploadId,`synthetic/${documentId}`]);
    await client.query(`INSERT INTO extraction_runs (id,user_id,document_id,processing_version,status,extractor_name,extractor_version,parser_version,normalizer_version,finished_at)
      VALUES ($1,$2,$3,1,'COMPLETED','synthetic','6','6','6',now())`, [runId,userId,documentId]);
    await client.query(`INSERT INTO processing_jobs (id,user_id,document_id,stage,processing_version,idempotency_key,state,attempt,max_attempts,
      previous_document_status,completed_at) VALUES ($1::uuid,$2,$3,'PARSING',2,$1::text,'COMPLETED',1,3,'COMPLETED',now())`, [jobId,userId,documentId]);
    const legalBefore = (await client.query("SELECT md5(string_agg(row_to_json(legal_row)::text,'' ORDER BY id)) AS checksum FROM legal_document_versions legal_row")).rows[0]!.checksum;
    const historical = migrations.find((entry: { version: number }) => entry.version === 20)!;
    await client.query('BEGIN');
    await assert.rejects(client.query(historical.sql), (error: { code?: string; message?: string }) =>
      error.code === '55006' && Boolean(error.message?.includes('pending trigger events')));
    await client.query('ROLLBACK');
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    isolated = new Pool({ connectionString: url.href });
    await runMigrations(isolated);
    const rows = (await client.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    assert.equal(rows.length,migrations.length);
    assert.equal(rows.find((row)=>row.version===20)?.checksum,historical.checksum);
    const after = (await client.query('SELECT trigger_kind,base_extraction_run_id FROM processing_jobs WHERE id=$1',[jobId])).rows[0];
    assert.deepEqual(after,{trigger_kind:'USER_REPROCESS',base_extraction_run_id:runId});
    assert.equal((await client.query('SELECT count(*)::int AS count FROM users')).rows[0]!.count,1);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM legal_acknowledgements')).rows[0]!.count,2);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM documents')).rows[0]!.count,1);
    assert.equal((await client.query("SELECT md5(string_agg(row_to_json(legal_row)::text,'' ORDER BY id)) AS checksum FROM legal_document_versions legal_row")).rows[0]!.checksum,legalBefore);
    const constraint = (await client.query(`SELECT condeferrable,condeferred FROM pg_constraint
      WHERE conrelid='processing_jobs'::regclass AND conname='processing_jobs_base_fkey'`)).rows[0];
    assert.deepEqual(constraint,{condeferrable:true,condeferred:true});
  } finally {
    await isolated?.end();
    await client.query('ROLLBACK').catch(()=>undefined);
    await client.query('RESET search_path');
    assert.match(schema,/^migration_test_[a-f0-9]{32}$/);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await admin.end();
  }
});
