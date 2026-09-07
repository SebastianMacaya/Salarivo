-- Keep historical results and reviewed layouts scoped to their original parser.
-- Reprocessing creates a candidate; changed concepts require owner review.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END $$;
UPDATE processing_jobs
   SET pipeline_fingerprint = encode(sha256(convert_to(
       '{"classifier":"7","extractor":"7","parser":"10","normalizer":"6","resultSchema":"1"}', 'UTF8'
   )), 'hex')
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');

ALTER TABLE document_layouts ALTER COLUMN parser_version SET DEFAULT '10';
