-- External OCR telemetry contains metadata only. Content remains in private artifacts.
DO $$
DECLARE artifact_metadata_check name;
BEGIN
    SELECT conname INTO STRICT artifact_metadata_check FROM pg_constraint
     WHERE conrelid = 'processing_artifacts'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%payloadVersion%';
    EXECUTE format('ALTER TABLE processing_artifacts DROP CONSTRAINT %I', artifact_metadata_check);
END $$;
ALTER TABLE processing_artifacts ADD CONSTRAINT processing_artifacts_metadata_check
    CHECK (COALESCE(
        jsonb_typeof(metadata_no_sensitive) = 'object'
        AND jsonb_typeof(metadata_no_sensitive -> 'complete') = 'boolean'
        AND metadata_no_sensitive ->> 'payloadVersion' IN ('1', '2')
        AND metadata_no_sensitive ->> 'writeState' IN ('PENDING', 'COMPLETED'), false
    ));

ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_owner_document_id_key
    UNIQUE (user_id, document_id, id);

CREATE TABLE ocr_provider_usage (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    processing_job_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
    model text NOT NULL CHECK (model ~ '^[a-zA-Z0-9_.-]{1,80}$'),
    provider_version text NOT NULL CHECK (provider_version ~ '^[a-zA-Z0-9_.-]{1,80}$'),
    trigger_reason text NOT NULL CHECK (trigger_reason ~ '^[A-Z0-9_]{1,64}$'),
    request_id text NOT NULL UNIQUE CHECK (request_id ~ '^sal_[a-f0-9-]{36}$'),
    external_request_id text CHECK (external_request_id ~ '^sal_[a-f0-9-]{36}$'),
    status text NOT NULL CHECK (status IN ('RESERVED', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CACHE_HIT')),
    input_tokens bigint CHECK (input_tokens >= 0),
    output_tokens bigint CHECK (output_tokens >= 0),
    cached_tokens bigint CHECK (cached_tokens >= 0),
    total_tokens bigint CHECK (total_tokens >= 0),
    reserved_cost_usd numeric(20,8) NOT NULL CHECK (reserved_cost_usd >= 0),
    estimated_cost_usd numeric(20,8) CHECK (estimated_cost_usd >= 0),
    accounted_cost_usd numeric(20,8) NOT NULL CHECK (accounted_cost_usd >= 0),
    retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
    duration_ms bigint CHECK (duration_ms >= 0),
    error_code text CHECK (error_code ~ '^[A-Z0-9_]{1,64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, document_id, processing_job_id)
        REFERENCES processing_jobs(user_id, document_id, id) ON DELETE CASCADE,
    CHECK ((status = 'RESERVED') = (finished_at IS NULL)),
    CHECK (finished_at IS NULL OR finished_at >= created_at)
);

CREATE INDEX ocr_provider_usage_budget_idx ON ocr_provider_usage (provider, created_at);
CREATE INDEX ocr_provider_usage_run_idx ON ocr_provider_usage (user_id, document_id, extraction_run_id);
CREATE UNIQUE INDEX ocr_provider_usage_one_call_per_run_idx
    ON ocr_provider_usage (extraction_run_id, provider, model, provider_version)
    WHERE status IN ('RESERVED', 'SUCCEEDED', 'FAILED');

-- Anonymous spend survives owner/document deletion, so deletion cannot reset the budget.
CREATE TABLE ocr_provider_daily_costs (
    provider text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
    usage_date date NOT NULL,
    accounted_cost_usd numeric(20,8) NOT NULL CHECK (accounted_cost_usd >= 0),
    PRIMARY KEY (provider, usage_date)
);

-- Preserve historical runs; pending work adopts the new extractor only after drain.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END $$;

UPDATE processing_jobs
   SET pipeline_fingerprint = encode(sha256(convert_to(
       '{"classifier":"6","extractor":"7","parser":"7","normalizer":"6","resultSchema":"1"}', 'UTF8'
   )), 'hex')
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');
