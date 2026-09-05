-- Concurrent relations with one organization can belong to different subdivisions/regimes.
DROP INDEX employments_exact_identity_uidx;
CREATE UNIQUE INDEX employments_exact_identity_uidx
    ON employments (
        user_id, employer_id, start_date, end_date, role, category, modality,
        country_code, currency_code, subdivision_code, legal_regime_code, employment_type
    ) NULLS NOT DISTINCT;
