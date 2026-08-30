ALTER TABLE sessions
    ADD COLUMN mfa_verified_at timestamptz,
    ADD COLUMN step_up_expires_at timestamptz,
    ADD CHECK (mfa_verified_at IS NULL OR mfa_verified_at >= created_at),
    ADD CHECK (step_up_expires_at IS NULL OR step_up_expires_at > created_at);

CREATE TABLE mfa_factors (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    factor_type text NOT NULL DEFAULT 'TOTP' CHECK (factor_type = 'TOTP'),
    status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE')),
    encrypted_secret text NOT NULL,
    key_version integer NOT NULL CHECK (key_version > 0),
    pending_expires_at timestamptz,
    enabled_at timestamptz,
    last_used_counter bigint,
    failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    CHECK (length(encrypted_secret) BETWEEN 32 AND 1024),
    CHECK (last_used_counter IS NULL OR last_used_counter >= 0),
    CHECK (
        (status = 'PENDING' AND pending_expires_at > created_at AND enabled_at IS NULL)
        OR (status = 'ACTIVE' AND pending_expires_at IS NULL AND enabled_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX mfa_factors_one_active_uidx
    ON mfa_factors (user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX mfa_factors_one_pending_uidx
    ON mfa_factors (user_id) WHERE status = 'PENDING';

CREATE TABLE mfa_recovery_codes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    factor_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, factor_id) REFERENCES mfa_factors(user_id, id) ON DELETE CASCADE,
    UNIQUE (factor_id, code_hash),
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX mfa_recovery_codes_available_idx
    ON mfa_recovery_codes (user_id, factor_id) WHERE used_at IS NULL;
