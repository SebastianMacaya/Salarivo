-- Existing country/status values are retained as unconfirmed legacy evidence.
ALTER TABLE users
    ADD COLUMN primary_country_code text CHECK (primary_country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN primary_country_confirmed_at timestamptz,
    ADD COLUMN suggested_country_code text CHECK (suggested_country_code ~ '^[A-Z]{2}$'),
    ADD CONSTRAINT users_primary_country_confirmation_check
        CHECK ((primary_country_code IS NULL) = (primary_country_confirmed_at IS NULL));

ALTER TABLE oauth_attempts ADD COLUMN pending_country_code text CHECK (pending_country_code ~ '^[A-Z]{2}$');

ALTER TABLE employments
    ADD COLUMN subdivision_code text,
    ADD COLUMN legal_regime_code text CHECK (legal_regime_code ~ '^[A-Z][A-Z0-9_]{1,79}$'),
    ADD COLUMN country_source text NOT NULL DEFAULT 'LEGACY'
        CHECK (country_source IN ('LEGACY', 'DOCUMENT', 'USER_CONFIRMED')),
    ADD COLUMN country_confidence text CHECK (country_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
    ADD COLUMN country_confirmed_at timestamptz,
    ADD COLUMN status_confirmed_at timestamptz,
    ADD COLUMN start_date_confirmed_at timestamptz,
    ADD COLUMN employment_type text NOT NULL DEFAULT 'UNKNOWN'
        CHECK (employment_type IN ('DEPENDENT', 'INDEPENDENT', 'UNKNOWN')),
    ADD CONSTRAINT employments_subdivision_check CHECK (
        subdivision_code IS NULL OR (subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'
        AND left(subdivision_code, 2) = country_code)),
    ADD CONSTRAINT employments_country_confirmation_check CHECK (
        (country_source = 'USER_CONFIRMED') = (country_confirmed_at IS NOT NULL));

-- The original unnamed end-date/status constraint is discovered, not guessed.
DO $$
DECLARE constraint_name text;
BEGIN
    FOR constraint_name IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'employments'::regclass AND contype = 'c'
           AND pg_get_constraintdef(oid) LIKE '%status%'
    LOOP
        EXECUTE format('ALTER TABLE employments DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END;
$$;
ALTER TABLE employments
    ADD CONSTRAINT employments_status_check CHECK (status IN ('ACTIVE', 'ENDED', 'UNKNOWN')),
    ADD CONSTRAINT employments_status_dates_check CHECK (
        (status IN ('ACTIVE', 'UNKNOWN') AND end_date IS NULL) OR (status = 'ENDED' AND end_date IS NOT NULL));

ALTER TABLE documents
    ADD COLUMN country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN country_source text CHECK (country_source IN ('DOCUMENT_DETECTION', 'EMPLOYMENT_CONFIRMED')),
    ADD COLUMN country_confidence text CHECK (country_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
    ADD COLUMN country_snapshot_at timestamptz,
    ADD CONSTRAINT documents_country_snapshot_check CHECK (
        num_nonnulls(country_code, country_source, country_confidence, country_snapshot_at) IN (0, 4));

ALTER TABLE extraction_runs
    ADD COLUMN country_code text CHECK (country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN country_source text CHECK (country_source IN ('DOCUMENT_DETECTION', 'EMPLOYMENT_CONFIRMED')),
    ADD COLUMN country_confidence text CHECK (country_confidence IN ('HIGH', 'MEDIUM', 'LOW'));

-- These reviewed layouts were authored specifically for the existing AR parser.
ALTER TABLE document_layouts
    ADD COLUMN country_code text NOT NULL DEFAULT 'AR' CHECK (country_code ~ '^[A-Z]{2}$'),
    ADD COLUMN document_type text NOT NULL DEFAULT 'PAYROLL' CHECK (document_type = 'PAYROLL'),
    ADD COLUMN parser_version text NOT NULL DEFAULT '8' CHECK (length(parser_version) BETWEEN 1 AND 64);

DO $$
DECLARE constraint_name text;
BEGIN
    FOR constraint_name IN SELECT conname FROM pg_constraint
        WHERE conrelid = 'document_layouts'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (employer_id, fingerprint_version, structural_fingerprint)'
    LOOP
        EXECUTE format('ALTER TABLE document_layouts DROP CONSTRAINT %I', constraint_name);
    END LOOP;
END;
$$;
ALTER TABLE document_layouts ADD CONSTRAINT document_layouts_country_parser_key
    UNIQUE (country_code, employer_id, document_type, parser_version, fingerprint_version, structural_fingerprint);

CREATE INDEX documents_user_country_idx ON documents (user_id, country_code) WHERE deleted_at IS NULL;

-- Country classification must not mix with jobs dispatched by pre-jurisdiction workers.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END $$;
UPDATE processing_jobs
   SET pipeline_fingerprint = encode(sha256(convert_to(
       '{"classifier":"7","extractor":"7","parser":"8","normalizer":"6","resultSchema":"1"}', 'UTF8'
   )), 'hex')
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');
