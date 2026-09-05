-- Shared parsing configuration contains operator-authored labels, never source documents.
CREATE TABLE document_layouts (
    id uuid PRIMARY KEY,
    employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE RESTRICT,
    fingerprint_version text NOT NULL CHECK (fingerprint_version = '1'),
    structural_fingerprint text NOT NULL CHECK (structural_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employer_id, fingerprint_version, structural_fingerprint)
);

CREATE TABLE document_layout_versions (
    id uuid PRIMARY KEY,
    layout_id uuid NOT NULL REFERENCES document_layouts(id) ON DELETE RESTRICT,
    version integer NOT NULL CHECK (version > 0),
    aliases jsonb NOT NULL CHECK (jsonb_typeof(aliases) = 'object' AND octet_length(aliases::text) <= 4096),
    enabled boolean NOT NULL,
    approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    approved_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layout_id, version)
);

CREATE FUNCTION preserve_document_layout_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.id = OLD.id AND NEW.layout_id = OLD.layout_id
       AND NEW.version = OLD.version AND NEW.aliases = OLD.aliases AND NEW.enabled = OLD.enabled
       AND NEW.approved_at = OLD.approved_at AND NEW.approved_by_user_id IS NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'DOCUMENT_LAYOUT_VERSION_IMMUTABLE';
END $$;
CREATE TRIGGER document_layout_versions_immutable BEFORE UPDATE OR DELETE ON document_layout_versions
    FOR EACH ROW EXECUTE FUNCTION preserve_document_layout_version();

ALTER TABLE extraction_runs
    ADD COLUMN layout_fingerprint text CHECK (layout_fingerprint ~ '^[0-9a-f]{64}$'),
    ADD COLUMN layout_fingerprint_version text CHECK (layout_fingerprint_version = '1'),
    ADD COLUMN document_layout_version_id uuid REFERENCES document_layout_versions(id) ON DELETE RESTRICT,
    ADD CONSTRAINT extraction_runs_layout_fingerprint_pair CHECK ((layout_fingerprint IS NULL) = (layout_fingerprint_version IS NULL));
CREATE INDEX extraction_runs_layout_observation_idx
    ON extraction_runs (detected_employer_id, layout_fingerprint_version, layout_fingerprint, started_at DESC)
    WHERE layout_fingerprint IS NOT NULL;

-- Preserve historical runs and cached OCR; only pending work adopts reviewed aliases.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END $$;
UPDATE processing_jobs
   SET pipeline_fingerprint = encode(sha256(convert_to(
       '{"classifier":"6","extractor":"7","parser":"8","normalizer":"6","resultSchema":"1"}', 'UTF8'
   )), 'hex')
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');
