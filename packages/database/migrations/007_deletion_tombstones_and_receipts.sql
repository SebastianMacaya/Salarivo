ALTER TABLE privacy_operations
    DROP COLUMN object_key CASCADE,
    ADD CONSTRAINT privacy_operations_output_scope_check
        CHECK (operation_type = 'DATA_EXPORT' OR output_expires_at IS NULL),
    ADD CONSTRAINT privacy_operations_ready_output_check
        CHECK (status <> 'READY' OR (operation_type = 'DATA_EXPORT' AND output_expires_at IS NOT NULL));

CREATE TABLE storage_deletion_tombstones (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    canonical_object_key text NOT NULL UNIQUE,
    incoming_object_key text NOT NULL UNIQUE,
    upload_expires_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING')),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_owner text,
    lease_expires_at timestamptz,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (length(canonical_object_key) BETWEEN 16 AND 1024),
    CHECK (length(incoming_object_key) BETWEEN 16 AND 1024),
    CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
    CHECK (
        (status = 'PENDING' AND lease_owner IS NULL AND lease_expires_at IS NULL)
        OR (status = 'RUNNING' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX storage_deletion_tombstones_due_idx
    ON storage_deletion_tombstones (available_at, upload_expires_at)
    WHERE status = 'PENDING';

CREATE TABLE account_deletion_receipts (
    id uuid PRIMARY KEY,
    operation_id uuid NOT NULL UNIQUE,
    token_hash text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'COMPLETED')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR completed_at >= requested_at)
);
