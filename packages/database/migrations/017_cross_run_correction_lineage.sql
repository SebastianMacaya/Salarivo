ALTER TABLE user_corrections
    ADD COLUMN inherited_from_correction_id uuid;

ALTER TABLE processing_jobs
    ADD COLUMN previous_document_status text,
    ADD CONSTRAINT processing_jobs_previous_document_status_check
        CHECK (previous_document_status IS NULL OR previous_document_status IN (
            'COMPLETED', 'NEEDS_REVIEW', 'FAILED_PERMANENT', 'CANCELLED'
        ));

ALTER TABLE user_corrections
    ADD CONSTRAINT user_corrections_inheritance_target_key
        UNIQUE (id, user_id, document_id, field_path),
    ADD CONSTRAINT user_corrections_inheritance_lineage_fkey
        FOREIGN KEY (inherited_from_correction_id, user_id, document_id, field_path)
        REFERENCES user_corrections(id, user_id, document_id, field_path)
        ON DELETE NO ACTION,
    ADD CONSTRAINT user_corrections_inheritance_not_self_check
        CHECK (inherited_from_correction_id IS NULL OR inherited_from_correction_id <> id);

CREATE INDEX user_corrections_inherited_from_idx
    ON user_corrections (inherited_from_correction_id)
    WHERE inherited_from_correction_id IS NOT NULL;
