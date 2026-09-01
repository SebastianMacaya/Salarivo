import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { loadMigrations, type Migration } from "@salarivo/database";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

test("migration 021 blocks and schedules legacy unsupported originals", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `migration_021_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    const migrations = await loadMigrations();
    for (const migration of migrations.filter(({ version }) => version <= 20)) {
      await applyMigration(client, migration);
    }

    const userId = randomUUID();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const uploadId = randomUUID();
    const documentId = randomUUID();
    const marker = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'synthetic-password-hash')`,
      [userId, `migration-021-${marker}@example.test`],
    );
    await client.query(
      `INSERT INTO import_batches (id, user_id, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4)`,
      [batchId, userId, `migration-021-${marker}`, createHash("sha256").update(marker).digest("hex")],
    );
    await client.query(
      `UPDATE import_batches SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
      [batchId],
    );
    await client.query(
      `INSERT INTO import_batch_items (
         id, user_id, batch_id, client_item_key, ordinal, original_filename,
         declared_mime_type, expected_size_bytes, status, error_code
       ) VALUES ($1, $2, $3, $4, 0, 'unsupported-synthetic.pdf',
         'application/pdf', 128, 'REJECTED', 'DOCUMENT_UNSUPPORTED')`,
      [itemId, userId, batchId, `item-${marker}`],
    );
    await client.query(
      `INSERT INTO upload_sessions (
         id, user_id, batch_id, item_id, object_key, expected_size_bytes,
         expected_mime_type, status, expires_at, confirmed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, 128, 'application/pdf', 'CONFIRMED',
         now() - interval '1 hour', now() - interval '90 minutes', now() - interval '2 hours')`,
      [uploadId, userId, batchId, itemId, `incoming/${marker}.pdf`],
    );
    await client.query(
      `INSERT INTO documents (
         id, user_id, import_batch_id, import_batch_item_id, upload_session_id,
         object_key, original_filename, declared_mime_type, detected_mime_type,
         size_bytes, page_count, security_status, classification_status,
         processing_status, retention_policy, processed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'unsupported-synthetic.pdf',
         'application/pdf', 'application/pdf', 128, 1, 'CLEAN', 'UNSUPPORTED',
         'REJECTED_UNSUPPORTED', 'KEEP_ORIGINAL', now())`,
      [documentId, userId, batchId, itemId, uploadId, `documents/${marker}.pdf`],
    );

    const migration = migrations.find(({ version }) => version === 21);
    assert.ok(migration);
    await applyMigration(client, migration);

    assert.deepEqual(
      (await client.query(
        `SELECT retention_policy, original_deleted_at IS NOT NULL AS original_blocked,
                unsupported_feedback
           FROM documents WHERE id = $1`,
        [documentId],
      )).rows[0],
      { retention_policy: "DELETE_AFTER_PROCESSING", original_blocked: true, unsupported_feedback: null },
    );
    assert.equal(
      (await client.query(
        `SELECT count(*)::integer AS count
           FROM storage_deletion_tombstones
          WHERE user_id = $1 AND canonical_object_key = $2`,
        [userId, `documents/${marker}.pdf`],
      )).rows[0].count,
      1,
    );
    await client.query(
      "UPDATE documents SET unsupported_feedback = 'Certificado laboral sintético' WHERE id = $1",
      [documentId],
    );
    await assert.rejects(
      client.query("UPDATE documents SET processing_status = 'COMPLETED' WHERE id = $1", [documentId]),
      /documents_unsupported_feedback_check/,
    );
  } finally {
    assert.match(schema, /^migration_021_[0-9a-f]{32}$/);
    await client.query("RESET search_path").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    client.release();
    await pool.end();
  }
});
