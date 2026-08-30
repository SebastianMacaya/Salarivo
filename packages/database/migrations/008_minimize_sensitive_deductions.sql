UPDATE payroll_line_items
   SET raw_description = 'Deducción',
       normalized_concept_code = NULL,
       is_recurring = NULL
 WHERE normalized_concept_code IN ('HEALTH_INSURANCE', 'UNION_DUES')
    OR raw_description ~* '(obra[[:space:]]+social|sindicat|cuota[[:space:]]+sindical)';

ALTER TABLE payroll_line_items
    ADD CONSTRAINT payroll_line_items_sensitive_concept_check
        CHECK (normalized_concept_code IS NULL
            OR normalized_concept_code NOT IN ('HEALTH_INSURANCE', 'UNION_DUES')),
    ADD CONSTRAINT payroll_line_items_sensitive_description_check
        CHECK (raw_description !~* '(obra[[:space:]]+social|sindicat|cuota[[:space:]]+sindical)');
