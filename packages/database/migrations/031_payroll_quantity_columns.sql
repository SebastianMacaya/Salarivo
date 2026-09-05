-- Preserve active results and cached text; pending work adopts the corrected parser.
LOCK TABLE processing_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM processing_jobs WHERE state = 'RUNNING' OR execution_owner IS NOT NULL) THEN
        RAISE EXCEPTION 'PROCESSING_WORKER_DRAIN_REQUIRED';
    END IF;
END $$;
UPDATE processing_jobs
   SET pipeline_fingerprint = encode(sha256(convert_to(
       '{"classifier":"7","extractor":"7","parser":"9","normalizer":"6","resultSchema":"1"}', 'UTF8'
   )), 'hex')
 WHERE state IN ('PENDING', 'PUBLISHED', 'RETRYABLE');

-- Existing approved layouts remain tied to the parser version that was reviewed.
ALTER TABLE document_layouts ALTER COLUMN parser_version SET DEFAULT '9';
