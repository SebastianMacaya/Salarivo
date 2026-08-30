UPDATE payroll_line_items
   SET raw_description = 'Deducción',
       normalized_concept_code = NULL,
       is_recurring = NULL,
       source_field = NULL
 WHERE item_type = 'DEDUCTION';

ALTER TABLE payroll_line_items
    ADD CONSTRAINT payroll_line_items_deduction_minimization_check
        CHECK (item_type <> 'DEDUCTION'
            OR (raw_description = 'Deducción'
                AND normalized_concept_code IS NULL
                AND is_recurring IS NULL
                AND source_field IS NULL));
