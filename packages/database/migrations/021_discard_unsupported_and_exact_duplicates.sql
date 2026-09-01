ALTER TABLE import_batches
    ADD COLUMN discarded_duplicate_count integer NOT NULL DEFAULT 0,
    ADD CONSTRAINT import_batches_discarded_duplicate_count_check
        CHECK (discarded_duplicate_count >= 0);

ALTER TABLE documents
    ADD COLUMN unsupported_feedback text,
    ADD CONSTRAINT documents_unsupported_feedback_check
        CHECK (
            unsupported_feedback IS NULL
            OR (
                processing_status = 'REJECTED_UNSUPPORTED'
                AND length(unsupported_feedback) BETWEEN 1 AND 500
                AND unsupported_feedback = btrim(unsupported_feedback)
                AND unsupported_feedback !~ '[[:cntrl:]]'
            )
        );

INSERT INTO storage_deletion_tombstones (
    id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
)
SELECT gen_random_uuid(), document.user_id, document.object_key,
       session.object_key, session.expires_at
  FROM documents AS document
  JOIN upload_sessions AS session
    ON session.id = document.upload_session_id
   AND session.user_id = document.user_id
 WHERE document.processing_status = 'REJECTED_UNSUPPORTED'
   AND document.deleted_at IS NULL
ON CONFLICT DO NOTHING;

UPDATE documents AS document
   SET retention_policy = 'DELETE_AFTER_PROCESSING',
       original_deleted_at = CASE
           WHEN document.original_deleted_at IS NULL
            AND EXISTS (
                SELECT 1
                  FROM storage_deletion_tombstones AS tombstone
                 WHERE tombstone.user_id = document.user_id
                   AND tombstone.canonical_object_key = document.object_key
            ) THEN now()
           ELSE document.original_deleted_at
       END
 WHERE document.processing_status = 'REJECTED_UNSUPPORTED'
   AND document.deleted_at IS NULL;
