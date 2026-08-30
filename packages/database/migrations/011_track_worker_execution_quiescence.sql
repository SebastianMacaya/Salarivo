ALTER TABLE processing_jobs
    ADD COLUMN execution_owner text;

UPDATE processing_jobs
   SET execution_owner = lease_owner
 WHERE state = 'RUNNING';

ALTER TABLE processing_jobs
    ADD CONSTRAINT processing_jobs_execution_owner_check
        CHECK (execution_owner IS NULL OR length(execution_owner) BETWEEN 1 AND 200);

CREATE INDEX processing_jobs_active_execution_idx
    ON processing_jobs (user_id)
    WHERE execution_owner IS NOT NULL;
