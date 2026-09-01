-- A pre-020 worker can only claim the legacy stages. Taking the table lock and
-- refusing an in-flight lease makes the migration a rollout barrier; queued
-- jobs are moved to DOCUMENT_PIPELINE_V2 below before the lock is released.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM processing_jobs
         WHERE state = 'RUNNING' OR execution_owner IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END;
$$;

ALTER TABLE extraction_runs
    DROP CONSTRAINT extraction_runs_status_check;

DO $$
DECLARE
    lifecycle_constraint name;
BEGIN
    SELECT constraint_row.conname
      INTO lifecycle_constraint
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'extraction_runs'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%status%RUNNING%'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%finished_at IS NULL%'
     LIMIT 1;

    IF lifecycle_constraint IS NULL THEN
        RAISE EXCEPTION 'EXTRACTION_RUN_LIFECYCLE_CONSTRAINT_NOT_FOUND';
    END IF;

    EXECUTE format('ALTER TABLE extraction_runs DROP CONSTRAINT %I', lifecycle_constraint);
END;
$$;

ALTER TABLE extraction_runs
    ADD COLUMN trigger_kind text NOT NULL DEFAULT 'LEGACY_UNKNOWN',
    ADD COLUMN requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN base_extraction_run_id uuid,
    ADD COLUMN result_schema_version text,
    ADD COLUMN pipeline_fingerprint text,
    ADD COLUMN promotion_outcome text NOT NULL DEFAULT 'NOT_EVALUATED',
    ADD COLUMN comparison_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN promoted_at timestamptz,
    ADD COLUMN created_at timestamptz,
    ADD COLUMN ocr_language text,
    ADD COLUMN detected_employer_id uuid REFERENCES employers(id) ON DELETE SET NULL,
    ADD CONSTRAINT extraction_runs_status_check_v2
        CHECK (status IN (
            'RUNNING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS',
            'REVIEW_REQUIRED', 'FAILED', 'CANCELLED'
        )) NOT VALID,
    ADD CONSTRAINT extraction_runs_lifecycle_check_v2
        CHECK (
            (status IN ('RUNNING', 'PROCESSING') AND finished_at IS NULL)
            OR
            (status IN (
                'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REVIEW_REQUIRED',
                'FAILED', 'CANCELLED'
            ) AND finished_at IS NOT NULL)
        ) NOT VALID,
    ADD CONSTRAINT extraction_runs_trigger_kind_check
        CHECK (trigger_kind IN (
            'LEGACY_UNKNOWN', 'INITIAL_UPLOAD', 'USER_TYPE_CONFIRMATION',
            'USER_REPROCESS', 'ADMIN_REPROCESS', 'PARSER_UPGRADE',
            'AUTOMATIC_RECOVERY'
        )),
    ADD CONSTRAINT extraction_runs_result_schema_version_check
        CHECK (
            result_schema_version IS NULL
            OR (length(result_schema_version) BETWEEN 1 AND 80 AND result_schema_version !~ '[[:cntrl:]]')
        ),
    ADD CONSTRAINT extraction_runs_pipeline_fingerprint_check
        CHECK (pipeline_fingerprint IS NULL OR pipeline_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT extraction_runs_promotion_outcome_check
        CHECK (promotion_outcome IN (
            'NOT_EVALUATED', 'PROMOTED', 'UNCHANGED',
            'REVIEW_REQUIRED', 'REJECTED_REGRESSION'
        )),
    ADD CONSTRAINT extraction_runs_comparison_summary_check
        CHECK (jsonb_typeof(comparison_summary) = 'object'),
    ADD CONSTRAINT extraction_runs_ocr_language_check
        CHECK (
            ocr_language IS NULL
            OR (length(ocr_language) BETWEEN 2 AND 35 AND ocr_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
        ),
    ADD CONSTRAINT extraction_runs_base_not_self_check
        CHECK (base_extraction_run_id IS NULL OR base_extraction_run_id <> id),
    ADD CONSTRAINT extraction_runs_base_fkey
        FOREIGN KEY (user_id, document_id, base_extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

DO $$
DECLARE
    ocr_pair_constraint name;
BEGIN
    SELECT constraint_row.conname
      INTO ocr_pair_constraint
      FROM pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = 'extraction_runs'::regclass
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%ocr_provider IS NULL%'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%ocr_version IS NULL%'
     LIMIT 1;

    IF ocr_pair_constraint IS NULL THEN
        RAISE EXCEPTION 'EXTRACTION_RUN_OCR_PAIR_CONSTRAINT_NOT_FOUND';
    END IF;

    EXECUTE format('ALTER TABLE extraction_runs DROP CONSTRAINT %I', ocr_pair_constraint);
END;
$$;

UPDATE extraction_runs
   SET created_at = started_at,
       ocr_language = CASE
           WHEN ocr_provider = 'tesseract' AND ocr_version ~ '^[A-Za-z]{2,3}$' THEN ocr_version
           ELSE NULL
       END,
       ocr_version = CASE
           WHEN ocr_provider = 'tesseract' AND ocr_version ~ '^[A-Za-z]{2,3}$' THEN NULL
           ELSE ocr_version
       END;

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_ocr_metadata_check
        CHECK (
            ocr_provider IS NOT NULL
            OR (ocr_version IS NULL AND ocr_language IS NULL)
        );

ALTER TABLE extraction_runs
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN created_at SET NOT NULL,
    VALIDATE CONSTRAINT extraction_runs_status_check_v2,
    VALIDATE CONSTRAINT extraction_runs_lifecycle_check_v2;

ALTER TABLE extraction_runs
    RENAME CONSTRAINT extraction_runs_status_check_v2 TO extraction_runs_status_check;

ALTER TABLE extraction_runs
    RENAME CONSTRAINT extraction_runs_lifecycle_check_v2 TO extraction_runs_lifecycle_check;

CREATE TABLE reprocessing_batches (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    requested_by_user_id uuid,
    trigger_kind text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (user_id, id),
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CHECK (trigger_kind IN (
        'USER_REPROCESS', 'ADMIN_REPROCESS', 'PARSER_UPGRADE', 'AUTOMATIC_RECOVERY'
    )),
    CHECK (length(idempotency_key) BETWEEN 16 AND 200),
    CHECK (
        (status IN ('PENDING', 'RUNNING') AND completed_at IS NULL)
        OR
        (status IN ('COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED') AND completed_at IS NOT NULL)
    ),
    CHECK (updated_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX reprocessing_batches_user_status_idx
    ON reprocessing_batches (user_id, status, created_at DESC);

ALTER TABLE processing_jobs
    DROP CONSTRAINT processing_jobs_stage_check,
    ADD CONSTRAINT processing_jobs_stage_check
        CHECK (stage IN (
            'SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION', 'TEXT_EXTRACTION', 'OCR',
            'PARSING', 'NORMALIZATION', 'VALIDATION', 'CLEANUP', 'DOCUMENT_PIPELINE_V2'
        )),
    ADD COLUMN trigger_kind text,
    ADD COLUMN requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN base_extraction_run_id uuid,
    ADD COLUMN reprocessing_batch_id uuid,
    ADD COLUMN pipeline_fingerprint text,
    ADD CONSTRAINT processing_jobs_trigger_kind_check
        CHECK (trigger_kind IN (
            'LEGACY_UNKNOWN', 'INITIAL_UPLOAD', 'USER_TYPE_CONFIRMATION',
            'USER_REPROCESS', 'ADMIN_REPROCESS', 'PARSER_UPGRADE',
            'AUTOMATIC_RECOVERY'
        )),
    ADD CONSTRAINT processing_jobs_pipeline_fingerprint_check
        CHECK (pipeline_fingerprint IS NULL OR pipeline_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT processing_jobs_base_fkey
        FOREIGN KEY (user_id, document_id, base_extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT processing_jobs_batch_fkey
        FOREIGN KEY (user_id, reprocessing_batch_id)
        REFERENCES reprocessing_batches(user_id, id)
        ON DELETE SET NULL (reprocessing_batch_id);

-- requested_by_user_id is cleared while the same user deletion cascades through
-- documents. Defer the existing document ownership FK so both cascades settle
-- before PostgreSQL validates the surviving rows.
ALTER TABLE processing_jobs
    ALTER CONSTRAINT processing_jobs_user_id_document_id_fkey
    DEFERRABLE INITIALLY DEFERRED;

UPDATE processing_jobs
   SET trigger_kind = CASE
       WHEN previous_document_status IS NOT NULL THEN 'USER_REPROCESS'
       WHEN stage = 'TEXT_EXTRACTION' THEN 'USER_TYPE_CONFIRMATION'
       ELSE 'INITIAL_UPLOAD'
   END;

UPDATE processing_jobs AS job
   SET base_extraction_run_id = (
       SELECT run.id
         FROM extraction_runs AS run
        WHERE run.user_id = job.user_id
          AND run.document_id = job.document_id
          AND run.processing_version < job.processing_version
          AND run.status = 'COMPLETED'
        ORDER BY run.processing_version DESC, run.id DESC
        LIMIT 1
   )
 WHERE job.processing_version > 1;

-- This fingerprint is the SHA-256 of the v6 pipeline catalog shipped with
-- migration 020. A database test keeps it in sync with the application value.
UPDATE processing_jobs
   SET stage = 'DOCUMENT_PIPELINE_V2',
       requested_by_user_id = CASE
           WHEN trigger_kind IN ('USER_TYPE_CONFIRMATION', 'USER_REPROCESS')
               THEN COALESCE(requested_by_user_id, user_id)
           ELSE requested_by_user_id
       END,
       pipeline_fingerprint = COALESCE(
           pipeline_fingerprint,
           'c4a5bc3169eed176ddfe8b26239c5b496a4c36901827145a4b60c67c6ad92f41'
       )
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');

ALTER TABLE processing_jobs
    ALTER COLUMN trigger_kind SET DEFAULT 'INITIAL_UPLOAD',
    ALTER COLUMN trigger_kind SET NOT NULL;

UPDATE extraction_runs AS run
   SET trigger_kind = job.trigger_kind,
       base_extraction_run_id = job.base_extraction_run_id
  FROM processing_jobs AS job
 WHERE job.user_id = run.user_id
   AND job.document_id = run.document_id
   AND job.processing_version = run.processing_version;

DO $$
BEGIN
    IF EXISTS (
        SELECT job.document_id
          FROM processing_jobs AS job
         WHERE job.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
            OR job.execution_owner IS NOT NULL
         GROUP BY job.document_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'PROCESSING_JOB_ACTIVE_CONFLICT';
    END IF;
END;
$$;

CREATE UNIQUE INDEX processing_jobs_one_active_document_uidx
    ON processing_jobs (document_id)
    WHERE state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE')
       OR execution_owner IS NOT NULL;

CREATE INDEX processing_jobs_batch_state_idx
    ON processing_jobs (user_id, reprocessing_batch_id, state)
    WHERE reprocessing_batch_id IS NOT NULL;

CREATE INDEX processing_jobs_pipeline_idx
    ON processing_jobs (pipeline_fingerprint, state)
    WHERE pipeline_fingerprint IS NOT NULL;

ALTER TABLE documents
    ADD COLUMN active_extraction_run_id uuid;

WITH latest_completed AS (
    SELECT DISTINCT ON (run.document_id)
           run.document_id,
           run.id
      FROM extraction_runs AS run
     WHERE run.status = 'COMPLETED'
     ORDER BY run.document_id, run.processing_version DESC, run.id DESC
)
UPDATE documents AS document
   SET active_extraction_run_id = latest_completed.id
  FROM latest_completed
 WHERE latest_completed.document_id = document.id;

ALTER TABLE documents
    ADD CONSTRAINT documents_active_extraction_run_fkey
        FOREIGN KEY (user_id, id, active_extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id)
        ON DELETE SET NULL (active_extraction_run_id)
        DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX documents_active_extraction_run_idx
    ON documents (active_extraction_run_id)
    WHERE active_extraction_run_id IS NOT NULL;

UPDATE extraction_runs AS run
   SET promotion_outcome = 'PROMOTED',
       promoted_at = COALESCE(run.finished_at, run.started_at),
       detected_employer_id = document.detected_employer_id
  FROM documents AS document
 WHERE document.active_extraction_run_id = run.id
   AND document.user_id = run.user_id;

CREATE FUNCTION processing_jobs_protocol_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    active_run_id uuid;
BEGIN
    IF NEW.stage NOT IN ('SECURITY_VALIDATION', 'TEXT_EXTRACTION') THEN
        RETURN NEW;
    END IF;

    IF NEW.stage = 'TEXT_EXTRACTION' THEN
        NEW.trigger_kind = CASE
            WHEN NEW.previous_document_status IS NULL THEN 'USER_TYPE_CONFIRMATION'
            ELSE 'USER_REPROCESS'
        END;
        NEW.requested_by_user_id = COALESCE(NEW.requested_by_user_id, NEW.user_id);
        IF NEW.previous_document_status IS NOT NULL THEN
            SELECT document.active_extraction_run_id
              INTO active_run_id
              FROM documents AS document
             WHERE document.id = NEW.document_id AND document.user_id = NEW.user_id;
            NEW.base_extraction_run_id = COALESCE(NEW.base_extraction_run_id, active_run_id);
        END IF;
    END IF;

    NEW.stage = 'DOCUMENT_PIPELINE_V2';
    NEW.pipeline_fingerprint = COALESCE(
        NEW.pipeline_fingerprint,
        'c4a5bc3169eed176ddfe8b26239c5b496a4c36901827145a4b60c67c6ad92f41'
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER processing_jobs_protocol_v2_before_insert
BEFORE INSERT ON processing_jobs
FOR EACH ROW EXECUTE FUNCTION processing_jobs_protocol_v2();

ALTER TABLE processing_jobs
    ADD CONSTRAINT processing_jobs_active_protocol_check
        CHECK (
            (state IN ('COMPLETED', 'FAILED', 'CANCELLED') AND execution_owner IS NULL)
            OR (stage = 'DOCUMENT_PIPELINE_V2' AND pipeline_fingerprint IS NOT NULL)
        );

ALTER TABLE extraction_runs
    ADD CONSTRAINT extraction_runs_promoted_at_check
        CHECK ((promotion_outcome = 'PROMOTED') = (promoted_at IS NOT NULL));

CREATE INDEX extraction_runs_document_created_idx
    ON extraction_runs (user_id, document_id, created_at DESC);

CREATE INDEX extraction_runs_pipeline_status_idx
    ON extraction_runs (pipeline_fingerprint, status)
    WHERE pipeline_fingerprint IS NOT NULL;

CREATE TABLE extraction_run_issues (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    code text NOT NULL,
    severity text NOT NULL,
    recoverable boolean NOT NULL,
    affected_field_path text,
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (extraction_run_id, code, affected_field_path),
    FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    CHECK (code ~ '^[A-Z0-9_]{1,96}$'),
    CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
    CHECK (
        affected_field_path IS NULL
        OR (length(affected_field_path) BETWEEN 1 AND 300 AND affected_field_path !~ '[[:cntrl:]]')
    ),
    CHECK (jsonb_typeof(metadata_no_sensitive) = 'object')
);

INSERT INTO extraction_run_issues (
    id, user_id, document_id, extraction_run_id, code, severity,
    recoverable, affected_field_path, created_at
)
SELECT md5('extraction-run-issue:' || field.id::text)::uuid,
       field.user_id,
       field.document_id,
       field.extraction_run_id,
       field.signals ->> 'missingReason',
       'WARNING',
       (field.signals ->> 'missingReason') = 'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
       field.field_path,
       field.created_at
  FROM extracted_fields AS field
 WHERE field.signals ->> 'missingReason' IN (
       'LABEL_OR_LAYOUT_NOT_RECOGNIZED', 'VALUE_NOT_INTERPRETABLE'
 )
ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING;

CREATE INDEX extraction_run_issues_document_idx
    ON extraction_run_issues (user_id, document_id, extraction_run_id);

CREATE INDEX extraction_run_issues_recoverable_idx
    ON extraction_run_issues (code, affected_field_path, extraction_run_id)
    WHERE recoverable;

UPDATE extraction_runs AS run
   SET status = 'COMPLETED_WITH_WARNINGS'
 WHERE run.status = 'COMPLETED'
   AND EXISTS (
       SELECT 1
         FROM extraction_run_issues AS issue
        WHERE issue.user_id = run.user_id
          AND issue.document_id = run.document_id
          AND issue.extraction_run_id = run.id
          AND issue.severity IN ('WARNING', 'ERROR')
   );

CREATE TABLE processing_artifacts (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    artifact_type text NOT NULL
        CHECK (artifact_type IN ('PDF_TEXT', 'OCR_TEXT', 'OCR_LAYOUT')),
    object_key text NOT NULL UNIQUE,
    content_sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    page_count integer,
    producer_name text NOT NULL,
    producer_version text NOT NULL,
    ocr_language text,
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (
        extraction_run_id, artifact_type, producer_name, producer_version, ocr_language
    ),
    FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    CHECK (length(object_key) BETWEEN 16 AND 1024),
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (size_bytes > 0),
    CHECK (page_count IS NULL OR page_count > 0),
    CHECK (length(producer_name) BETWEEN 1 AND 120 AND producer_name !~ '[[:cntrl:]]'),
    CHECK (length(producer_version) BETWEEN 1 AND 80 AND producer_version !~ '[[:cntrl:]]'),
    CHECK (
        ocr_language IS NULL
        OR (length(ocr_language) BETWEEN 2 AND 35 AND ocr_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
    ),
    CHECK (
        jsonb_typeof(metadata_no_sensitive) = 'object'
        AND jsonb_typeof(metadata_no_sensitive -> 'complete') = 'boolean'
        AND metadata_no_sensitive ->> 'payloadVersion' = '1'
        AND metadata_no_sensitive ->> 'writeState' IN ('PENDING', 'COMPLETED')
    )
);

CREATE INDEX processing_artifacts_document_idx
    ON processing_artifacts (user_id, document_id, artifact_type, created_at DESC);

ALTER TABLE storage_deletion_tombstones
    ADD COLUMN artifact_object_keys text[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN uncertain_artifact_object_keys text[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN object_delete_verify_after timestamptz,
    ADD CONSTRAINT storage_deletion_tombstones_artifact_keys_check
        CHECK (
            array_position(artifact_object_keys, NULL) IS NULL
            AND array_position(uncertain_artifact_object_keys, NULL) IS NULL
            AND uncertain_artifact_object_keys <@ artifact_object_keys
        );

CREATE FUNCTION capture_processing_artifact_deletion_keys()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    captured_keys text[];
    uncertain_keys text[];
BEGIN
    SELECT COALESCE(array_agg(source.object_key ORDER BY source.object_key), '{}'::text[])
      INTO captured_keys
      FROM (
          SELECT artifact.object_key
            FROM documents AS document
            JOIN processing_artifacts AS artifact
              ON artifact.user_id = document.user_id
             AND artifact.document_id = document.id
           WHERE document.user_id = NEW.user_id
             AND document.object_key = NEW.canonical_object_key
          UNION
          SELECT 'artifacts/' || encode(sha256(convert_to(
                     run.user_id::text || ':' || run.document_id::text || ':' || run.id::text
                     || ':' || identity.artifact_type || ':' || identity.producer_name
                     || ':' || run.extractor_version || ':' || identity.ocr_language,
                     'UTF8'
                 )), 'hex') || '.json.gz'
            FROM documents AS document
            JOIN extraction_runs AS run
              ON run.user_id = document.user_id
             AND run.document_id = document.id
            CROSS JOIN (VALUES
                ('PDF_TEXT', 'salarivo-pdf-text', ''),
                ('OCR_LAYOUT', 'salarivo-ocr-text', 'spa')
            ) AS identity(artifact_type, producer_name, ocr_language)
           WHERE document.user_id = NEW.user_id
             AND document.object_key = NEW.canonical_object_key
      ) AS source;

    SELECT COALESCE(array_agg(artifact.object_key ORDER BY artifact.object_key), '{}'::text[])
      INTO uncertain_keys
      FROM documents AS document
      JOIN processing_artifacts AS artifact
        ON artifact.user_id = document.user_id
       AND artifact.document_id = document.id
     WHERE document.user_id = NEW.user_id
       AND document.object_key = NEW.canonical_object_key
       AND artifact.metadata_no_sensitive @> '{"writeState":"PENDING"}'::jsonb;

    NEW.artifact_object_keys := ARRAY(
        SELECT DISTINCT key_row.object_key
          FROM unnest(
              COALESCE(NEW.artifact_object_keys, '{}'::text[])
              || COALESCE(captured_keys, '{}'::text[])
          ) AS key_row(object_key)
         ORDER BY key_row.object_key
    );
    NEW.uncertain_artifact_object_keys := ARRAY(
        SELECT DISTINCT key_row.object_key
          FROM unnest(
              COALESCE(NEW.uncertain_artifact_object_keys, '{}'::text[])
              || COALESCE(uncertain_keys, '{}'::text[])
          ) AS key_row(object_key)
         ORDER BY key_row.object_key
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER storage_deletion_tombstones_capture_artifacts
BEFORE INSERT ON storage_deletion_tombstones
FOR EACH ROW EXECUTE FUNCTION capture_processing_artifact_deletion_keys();
