DELETE FROM mfa_factors WHERE status = 'PENDING';

ALTER TABLE mfa_factors
    ADD COLUMN pending_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
    ADD CONSTRAINT mfa_factors_pending_session_check
        CHECK ((status = 'PENDING') = (pending_session_id IS NOT NULL));
