ALTER TABLE extracted_fields
    ADD CONSTRAINT extracted_fields_correction_lineage_key
        UNIQUE (user_id, document_id, extraction_run_id, id, field_path);

ALTER TABLE user_corrections
    DROP CONSTRAINT user_corrections_user_id_extracted_field_id_fkey,
    ADD CONSTRAINT user_corrections_extracted_field_lineage_fkey
        FOREIGN KEY (user_id, document_id, extraction_run_id, extracted_field_id, field_path)
        REFERENCES extracted_fields(user_id, document_id, extraction_run_id, id, field_path)
        ON DELETE CASCADE;
