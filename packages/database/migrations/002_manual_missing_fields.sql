ALTER TABLE user_corrections
    ADD COLUMN document_id uuid,
    ADD COLUMN extraction_run_id uuid,
    ADD COLUMN field_path text;

UPDATE user_corrections correction
   SET document_id = field.document_id,
       extraction_run_id = field.extraction_run_id,
       field_path = field.field_path
  FROM extracted_fields field
 WHERE field.id = correction.extracted_field_id;

ALTER TABLE user_corrections
    ALTER COLUMN document_id SET NOT NULL,
    ALTER COLUMN extraction_run_id SET NOT NULL,
    ALTER COLUMN field_path SET NOT NULL,
    ALTER COLUMN extracted_field_id DROP NOT NULL,
    DROP CONSTRAINT user_corrections_extracted_field_id_correction_version_key,
    ADD UNIQUE (extraction_run_id, field_path, correction_version),
    ADD FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    ADD CHECK (length(field_path) BETWEEN 1 AND 300);

DROP INDEX user_corrections_current_idx;
CREATE INDEX user_corrections_current_idx
    ON user_corrections (extraction_run_id, field_path, correction_version DESC);
