import type { PoolClient } from "@salarivo/database";

export const R2_GLOBAL_STORAGE_CAP_BYTES = 8_000_000_000n;
export const R2_TOMBSTONE_FALLBACK_BYTES = 100n * 1024n * 1024n;

// Two-key advisory lock scoped to this database. The transaction keeps it until commit/rollback.
const R2_CAPACITY_LOCK_NAMESPACE = 1_396_788_289; // "SALA"
const R2_CAPACITY_LOCK_RESOURCE = 1_379_025_729; // "R2CA"

export async function lockR2PhysicalStorageBytes(client: PoolClient): Promise<bigint> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
    [R2_CAPACITY_LOCK_NAMESPACE, R2_CAPACITY_LOCK_RESOURCE],
  );

  const usage = await client.query<{ physical_bytes: string }>(
    `WITH live_documents AS (
       SELECT COALESCE(sum(document.size_bytes), 0) AS bytes
         FROM documents AS document
        WHERE document.deleted_at IS NULL
          AND document.original_deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM storage_deletion_tombstones AS tombstone
             WHERE tombstone.canonical_object_key = document.object_key
          )
     ), session_reservations AS (
       SELECT COALESCE(sum(
         CASE
           -- An OPEN authorization reserves the incoming object and its future canonical copy.
           WHEN session.status = 'OPEN' AND session.expires_at > now()
             THEN session.expected_size_bytes * 2
           -- A confirmed incoming key remains physical until cleanup changes it to the canonical key.
           WHEN session.status = 'CONFIRMED' AND session.object_key LIKE 'incoming/%'
             THEN session.expected_size_bytes
           -- A failed copy can leave both objects even after authorization expires.
           WHEN session.status IN ('OPEN', 'EXPIRED')
             THEN session.expected_size_bytes * 2
           -- R2 cleanup only cancels after deleting the marker/object, revoking its If-Match URL.
           ELSE 0
         END
       ), 0) AS bytes
         FROM upload_sessions AS session
        WHERE NOT EXISTS (
          SELECT 1
            FROM storage_deletion_tombstones AS tombstone
           WHERE tombstone.incoming_object_key = session.object_key
              OR tombstone.canonical_object_key = session.object_key
        )
     ), deletion_reservations AS (
       SELECT COALESCE(sum(
         -- FK rows may be gone; use the historical validator ceiling, never a mutable env limit.
         COALESCE(document.size_bytes, session.expected_size_bytes, $1::bigint)
         * CASE
             WHEN tombstone.canonical_object_key = tombstone.incoming_object_key THEN 1
             ELSE 2
           END
       ), 0) AS bytes
         FROM storage_deletion_tombstones AS tombstone
         LEFT JOIN documents AS document
           ON document.object_key = tombstone.canonical_object_key
         LEFT JOIN upload_sessions AS session
           ON session.object_key = tombstone.incoming_object_key
           OR session.object_key = tombstone.canonical_object_key
     )
     SELECT (live_documents.bytes + session_reservations.bytes + deletion_reservations.bytes)::text
              AS physical_bytes
       FROM live_documents, session_reservations, deletion_reservations`,
    [R2_TOMBSTONE_FALLBACK_BYTES.toString()],
  );
  return BigInt(usage.rows[0]?.physical_bytes ?? R2_GLOBAL_STORAGE_CAP_BYTES.toString());
}

export async function lockR2UploadCapacity(
  client: PoolClient,
  expectedSizeBytes: number,
): Promise<boolean> {
  const physicalBytes = await lockR2PhysicalStorageBytes(client);
  const requestedBytes = BigInt(expectedSizeBytes) * 2n;
  return physicalBytes + requestedBytes <= R2_GLOBAL_STORAGE_CAP_BYTES;
}
