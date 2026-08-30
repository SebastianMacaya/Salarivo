CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name text,
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DELETION_PENDING', 'DELETED')),
    default_retention_policy text NOT NULL DEFAULT 'KEEP_ORIGINAL'
        CHECK (default_retention_policy IN ('KEEP_ORIGINAL', 'DELETE_AFTER_PROCESSING')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 320),
    CHECK (length(password_hash) BETWEEN 20 AND 1024),
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
    CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (expires_at > created_at),
    CHECK (last_seen_at IS NULL OR last_seen_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX sessions_user_expiry_idx ON sessions (user_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (expires_at > created_at),
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);

CREATE TABLE employers (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    country_code text NOT NULL,
    tax_identifier_type text,
    tax_identifier_ciphertext bytea,
    tax_identifier_key_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    CHECK (length(name) BETWEEN 1 AND 200),
    CHECK (country_code ~ '^[A-Z]{2}$'),
    CHECK (num_nonnulls(tax_identifier_type, tax_identifier_ciphertext, tax_identifier_key_version) IN (0, 3)),
    CHECK (tax_identifier_type IS NULL OR length(tax_identifier_type) BETWEEN 1 AND 32),
    CHECK (tax_identifier_ciphertext IS NULL OR length(tax_identifier_ciphertext) > 0),
    CHECK (tax_identifier_key_version IS NULL OR length(tax_identifier_key_version) BETWEEN 1 AND 64)
);

CREATE TABLE employments (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    employer_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
    start_date date NOT NULL,
    end_date date,
    role text,
    category text,
    modality text,
    country_code text NOT NULL,
    currency_code text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, employer_id) REFERENCES employers(user_id, id) ON DELETE CASCADE,
    CHECK (end_date IS NULL OR end_date >= start_date),
    CHECK ((status = 'ACTIVE' AND end_date IS NULL) OR (status = 'ENDED' AND end_date IS NOT NULL)),
    CHECK (country_code ~ '^[A-Z]{2}$'),
    CHECK (currency_code ~ '^[A-Z]{3}$'),
    CHECK (role IS NULL OR length(role) BETWEEN 1 AND 160),
    CHECK (category IS NULL OR length(category) BETWEEN 1 AND 120),
    CHECK (modality IS NULL OR length(modality) BETWEEN 1 AND 80)
);

CREATE INDEX employments_user_status_idx ON employments (user_id, status);

CREATE TABLE import_batches (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    request_fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (user_id, id),
    UNIQUE (user_id, idempotency_key),
    CHECK (length(idempotency_key) BETWEEN 16 AND 128),
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CHECK ((status IN ('COMPLETED', 'CANCELLED')) = (completed_at IS NOT NULL))
);

CREATE INDEX import_batches_user_status_idx ON import_batches (user_id, status, created_at DESC);

CREATE TABLE import_batch_items (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    employment_id uuid,
    client_item_key text NOT NULL,
    ordinal integer NOT NULL,
    original_filename text NOT NULL,
    declared_mime_type text NOT NULL,
    expected_size_bytes bigint NOT NULL,
    status text NOT NULL DEFAULT 'PENDING_UPLOAD'
        CHECK (status IN (
            'PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'COMPLETED', 'NEEDS_REVIEW',
            'REJECTED', 'FAILED', 'CANCELLED'
        )),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, batch_id, id),
    UNIQUE (batch_id, client_item_key),
    UNIQUE (batch_id, ordinal),
    FOREIGN KEY (user_id, batch_id) REFERENCES import_batches(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, employment_id) REFERENCES employments(user_id, id) ON DELETE SET NULL (employment_id),
    CHECK (length(original_filename) BETWEEN 1 AND 255),
    CHECK (length(client_item_key) BETWEEN 1 AND 128),
    CHECK (ordinal >= 0),
    CHECK (declared_mime_type = 'application/pdf'),
    CHECK (expected_size_bytes > 0),
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$')
);

CREATE INDEX import_batch_items_batch_status_idx ON import_batch_items (batch_id, status, created_at);

CREATE TABLE upload_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    item_id uuid NOT NULL,
    object_key text NOT NULL UNIQUE,
    expected_size_bytes bigint NOT NULL,
    expected_mime_type text NOT NULL,
    status text NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
    expires_at timestamptz NOT NULL,
    confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, batch_id, item_id, id),
    FOREIGN KEY (user_id, batch_id, item_id)
        REFERENCES import_batch_items(user_id, batch_id, id) ON DELETE CASCADE,
    CHECK (length(object_key) BETWEEN 16 AND 1024),
    CHECK (expected_size_bytes > 0),
    CHECK (expected_mime_type = 'application/pdf'),
    CHECK (expires_at > created_at),
    CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);

CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at) WHERE status = 'OPEN';
CREATE INDEX upload_sessions_item_idx ON upload_sessions (user_id, item_id, created_at DESC);
CREATE UNIQUE INDEX upload_sessions_one_open_item_uidx
    ON upload_sessions (item_id) WHERE status = 'OPEN';

CREATE TABLE documents (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    import_batch_id uuid NOT NULL,
    import_batch_item_id uuid NOT NULL,
    upload_session_id uuid NOT NULL,
    employment_id uuid,
    object_key text NOT NULL UNIQUE,
    original_filename text NOT NULL,
    declared_mime_type text NOT NULL,
    detected_mime_type text,
    size_bytes bigint NOT NULL,
    page_count integer,
    sha256 text,
    security_status text NOT NULL DEFAULT 'PENDING'
        CHECK (security_status IN ('PENDING', 'CLEAN', 'QUARANTINED', 'REJECTED', 'ERROR')),
    classification_status text NOT NULL DEFAULT 'PENDING'
        CHECK (classification_status IN ('PENDING', 'SUPPORTED', 'NEEDS_CONFIRMATION', 'UNSUPPORTED')),
    document_type text CHECK (document_type IS NULL OR document_type = 'PAYROLL'),
    classification_confidence numeric(5,4),
    processing_status text NOT NULL DEFAULT 'CREATED'
        CHECK (processing_status IN (
            'CREATED', 'UPLOADED', 'SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION',
            'NEEDS_TYPE_CONFIRMATION', 'TEXT_EXTRACTION', 'OCR', 'PARSING',
            'NORMALIZATION', 'VALIDATION', 'COMPLETED', 'NEEDS_REVIEW',
            'REJECTED_UNSUPPORTED', 'QUARANTINED', 'FAILED_RETRYABLE',
            'RETRY_SCHEDULED', 'FAILED_PERMANENT', 'CANCELLED', 'DELETED'
        )),
    retention_policy text NOT NULL
        CHECK (retention_policy IN ('KEEP_ORIGINAL', 'DELETE_AFTER_PROCESSING')),
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    original_deleted_at timestamptz,
    deleted_at timestamptz,
    UNIQUE (user_id, id),
    UNIQUE (import_batch_item_id),
    UNIQUE (upload_session_id),
    FOREIGN KEY (user_id, import_batch_id, import_batch_item_id)
        REFERENCES import_batch_items(user_id, batch_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, import_batch_id, import_batch_item_id, upload_session_id)
        REFERENCES upload_sessions(user_id, batch_id, item_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, employment_id) REFERENCES employments(user_id, id) ON DELETE SET NULL (employment_id),
    CHECK (length(object_key) BETWEEN 16 AND 1024),
    CHECK (length(original_filename) BETWEEN 1 AND 255),
    CHECK (declared_mime_type = 'application/pdf'),
    CHECK (detected_mime_type IS NULL OR detected_mime_type = 'application/pdf'),
    CHECK (size_bytes > 0),
    CHECK (page_count IS NULL OR page_count > 0),
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CHECK (classification_confidence IS NULL OR classification_confidence BETWEEN 0 AND 1),
    CHECK ((processing_status = 'DELETED') = (deleted_at IS NOT NULL))
);

CREATE UNIQUE INDEX documents_user_checksum_uidx ON documents (user_id, sha256)
    WHERE sha256 IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX documents_user_created_idx ON documents (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX documents_user_processing_idx ON documents (user_id, processing_status) WHERE deleted_at IS NULL;

CREATE TABLE processing_jobs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    stage text NOT NULL
        CHECK (stage IN (
            'SECURITY_VALIDATION', 'DOCUMENT_CLASSIFICATION', 'TEXT_EXTRACTION', 'OCR',
            'PARSING', 'NORMALIZATION', 'VALIDATION', 'CLEANUP'
        )),
    processing_version integer NOT NULL CHECK (processing_version > 0),
    idempotency_key text NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'PENDING'
        CHECK (state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE', 'COMPLETED', 'FAILED', 'CANCELLED')),
    available_at timestamptz NOT NULL DEFAULT now(),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    lease_owner text,
    lease_expires_at timestamptz,
    published_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, processing_version, stage),
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE,
    CHECK (length(idempotency_key) BETWEEN 16 AND 200),
    CHECK (attempt <= max_attempts),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'RUNNING') = (lease_owner IS NOT NULL)),
    CHECK ((state IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)),
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$')
);

CREATE INDEX processing_jobs_dispatch_idx ON processing_jobs (state, available_at, user_id);
CREATE INDEX processing_jobs_lease_idx ON processing_jobs (lease_expires_at) WHERE state = 'RUNNING';

CREATE TABLE extraction_runs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    processing_version integer NOT NULL CHECK (processing_version > 0),
    status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
    classifier_name text,
    classifier_version text,
    extractor_name text NOT NULL,
    extractor_version text NOT NULL,
    parser_version text NOT NULL,
    normalizer_version text NOT NULL,
    ocr_provider text,
    ocr_version text,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    confidence numeric(5,4),
    error_code text,
    compute_ms bigint,
    UNIQUE (document_id, processing_version),
    UNIQUE (user_id, document_id, id),
    FOREIGN KEY (user_id, document_id) REFERENCES documents(user_id, id) ON DELETE CASCADE,
    CHECK ((ocr_provider IS NULL) = (ocr_version IS NULL)),
    CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
    CHECK (compute_ms IS NULL OR compute_ms >= 0)
);

CREATE TABLE extracted_fields (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    field_path text NOT NULL,
    entity_type text NOT NULL,
    raw_value text NOT NULL,
    interpreted_value jsonb NOT NULL,
    confidence numeric(5,4) NOT NULL,
    source text NOT NULL CHECK (source IN ('PDF_TEXT', 'OCR', 'RULE', 'TEMPLATE', 'AI_FALLBACK')),
    page_number integer,
    source_region jsonb,
    extractor_version text NOT NULL,
    signals jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (extraction_run_id, field_path),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    CHECK (length(field_path) BETWEEN 1 AND 300),
    CHECK (length(entity_type) BETWEEN 1 AND 80),
    CHECK (confidence BETWEEN 0 AND 1),
    CHECK (page_number IS NULL OR page_number > 0),
    CHECK (source_region IS NULL OR jsonb_typeof(source_region) = 'object'),
    CHECK (jsonb_typeof(signals) = 'object')
);

CREATE INDEX extracted_fields_document_idx ON extracted_fields (user_id, document_id, extraction_run_id);

CREATE TABLE payroll_settlements (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    document_id uuid NOT NULL,
    extraction_run_id uuid NOT NULL,
    employment_id uuid,
    settlement_ordinal integer NOT NULL CHECK (settlement_ordinal > 0),
    payroll_period date NOT NULL,
    payment_date date,
    issue_date date,
    settlement_type text NOT NULL
        CHECK (settlement_type IN (
            'NORMAL', 'SAC', 'VACACIONES', 'BONO', 'RETROACTIVO', 'COMISION',
            'HORAS_EXTRA', 'LIQUIDACION_FINAL', 'INDEMNIZACION', 'AJUSTE', 'OTRO_LABORAL'
        )),
    is_recurring boolean NOT NULL,
    currency_code text NOT NULL,
    basic_amount numeric(20,2),
    gross_amount numeric(20,2),
    net_amount numeric(20,2),
    remunerative_amount numeric(20,2),
    non_remunerative_amount numeric(20,2),
    deductions_amount numeric(20,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (extraction_run_id, settlement_ordinal),
    UNIQUE (user_id, id),
    FOREIGN KEY (user_id, document_id, extraction_run_id)
        REFERENCES extraction_runs(user_id, document_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, employment_id) REFERENCES employments(user_id, id) ON DELETE SET NULL (employment_id),
    CHECK (EXTRACT(DAY FROM payroll_period) = 1),
    CHECK (currency_code ~ '^[A-Z]{3}$')
);

CREATE INDEX payroll_settlements_user_period_idx ON payroll_settlements (user_id, payroll_period DESC);
CREATE INDEX payroll_settlements_employment_period_idx
    ON payroll_settlements (user_id, employment_id, payroll_period DESC)
    WHERE employment_id IS NOT NULL;

CREATE TABLE payroll_line_items (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    item_ordinal integer NOT NULL CHECK (item_ordinal > 0),
    raw_description text NOT NULL,
    normalized_concept_code text,
    amount numeric(20,2) NOT NULL,
    currency_code text NOT NULL,
    item_type text NOT NULL CHECK (item_type IN ('EARNING', 'DEDUCTION', 'INFORMATIONAL')),
    is_recurring boolean,
    confidence numeric(5,4),
    source_page integer,
    source_field text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (settlement_id, item_ordinal),
    FOREIGN KEY (user_id, settlement_id) REFERENCES payroll_settlements(user_id, id) ON DELETE CASCADE,
    CHECK (length(raw_description) BETWEEN 1 AND 500),
    CHECK (normalized_concept_code IS NULL OR normalized_concept_code ~ '^[A-Z0-9_]{1,80}$'),
    CHECK (currency_code ~ '^[A-Z]{3}$'),
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CHECK (source_page IS NULL OR source_page > 0)
);

CREATE TABLE user_corrections (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    extracted_field_id uuid NOT NULL,
    correction_version integer NOT NULL CHECK (correction_version > 0),
    extracted_value jsonb NOT NULL,
    corrected_value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (extracted_field_id, correction_version),
    FOREIGN KEY (user_id, extracted_field_id) REFERENCES extracted_fields(user_id, id) ON DELETE CASCADE
);

CREATE INDEX user_corrections_current_idx
    ON user_corrections (extracted_field_id, correction_version DESC);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    result text NOT NULL CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED')),
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (length(action) BETWEEN 1 AND 100),
    CHECK (length(resource_type) BETWEEN 1 AND 80),
    CHECK (jsonb_typeof(metadata_no_sensitive) = 'object')
);

CREATE INDEX audit_events_user_created_idx ON audit_events (user_id, created_at DESC);

CREATE TABLE privacy_operations (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation_type text NOT NULL CHECK (operation_type IN ('DATA_EXPORT', 'ACCOUNT_DELETION')),
    idempotency_key text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'READY', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')),
    object_key text UNIQUE,
    output_expires_at timestamptz,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (user_id, id),
    CHECK (length(idempotency_key) BETWEEN 16 AND 200),
    CHECK (object_key IS NULL OR length(object_key) BETWEEN 16 AND 1024),
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
    CHECK (operation_type = 'DATA_EXPORT' OR (object_key IS NULL AND output_expires_at IS NULL)),
    CHECK (status <> 'READY' OR (operation_type = 'DATA_EXPORT' AND object_key IS NOT NULL AND output_expires_at IS NOT NULL)),
    CHECK ((status IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')) = (completed_at IS NOT NULL))
);

CREATE INDEX privacy_operations_user_status_idx ON privacy_operations (user_id, status, created_at DESC);
