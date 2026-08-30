-- Rollback: only after proving no REINTEGRO rows exist, repeat this validated-constraint
-- swap with the previous vocabulary. Never coerce existing settlement types silently.
ALTER TABLE payroll_settlements
    ADD CONSTRAINT payroll_settlements_settlement_type_check_v2
        CHECK (settlement_type IN (
            'NORMAL', 'SAC', 'VACACIONES', 'BONO', 'RETROACTIVO', 'COMISION',
            'HORAS_EXTRA', 'LIQUIDACION_FINAL', 'INDEMNIZACION', 'AJUSTE',
            'REINTEGRO', 'OTRO_LABORAL'
        )) NOT VALID;

ALTER TABLE payroll_settlements
    VALIDATE CONSTRAINT payroll_settlements_settlement_type_check_v2;

ALTER TABLE payroll_settlements
    DROP CONSTRAINT payroll_settlements_settlement_type_check;

ALTER TABLE payroll_settlements
    RENAME CONSTRAINT payroll_settlements_settlement_type_check_v2
    TO payroll_settlements_settlement_type_check;
