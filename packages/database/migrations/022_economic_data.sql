CREATE TABLE economic_series (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE,
    series_type text NOT NULL
        CHECK (series_type IN ('EXCHANGE_RATE', 'PRICE_INDEX')),
    frequency text NOT NULL
        CHECK (frequency IN ('DAILY', 'MONTHLY')),
    country_code text NOT NULL,
    base_currency_code text,
    quote_currency_code text,
    variant_code text NOT NULL,
    provider_code text NOT NULL,
    external_series_id text NOT NULL,
    name text NOT NULL,
    source_url text NOT NULL,
    methodology text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'DISCONTINUED')),
    valid_from date,
    valid_to date,
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider_code, external_series_id),
    CHECK (code ~ '^[A-Z][A-Z0-9._-]{2,99}$'),
    CHECK (country_code ~ '^[A-Z]{2}$'),
    CHECK (variant_code ~ '^[A-Z][A-Z0-9._-]{2,99}$'),
    CHECK (provider_code ~ '^[A-Z][A-Z0-9._-]{2,99}$'),
    CHECK (
        length(external_series_id) BETWEEN 1 AND 200
        AND external_series_id = btrim(external_series_id)
        AND external_series_id !~ '[[:cntrl:]]'
    ),
    CHECK (length(name) BETWEEN 1 AND 200 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
    CHECK (
        length(source_url) BETWEEN 8 AND 2048
        AND source_url = btrim(source_url)
        AND source_url !~ '[[:cntrl:]]'
        AND source_url ~ '^https://'
    ),
    CHECK (
        length(methodology) BETWEEN 1 AND 4000
        AND methodology = btrim(methodology)
        AND methodology !~ '[[:cntrl:]]'
    ),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
    CHECK (jsonb_typeof(metadata_no_sensitive) = 'object'),
    CHECK (
        (
            series_type = 'EXCHANGE_RATE'
            AND base_currency_code IS NOT NULL
            AND quote_currency_code IS NOT NULL
            AND base_currency_code ~ '^[A-Z]{3}$'
            AND quote_currency_code ~ '^[A-Z]{3}$'
            AND base_currency_code <> quote_currency_code
        )
        OR (
            series_type = 'PRICE_INDEX'
            AND base_currency_code IS NULL
            AND quote_currency_code IS NULL
        )
    )
);

CREATE INDEX economic_series_lookup_idx
    ON economic_series (series_type, country_code, status, code);

CREATE TABLE economic_observations (
    id uuid PRIMARY KEY,
    series_id uuid NOT NULL REFERENCES economic_series(id) ON DELETE RESTRICT,
    observation_date date NOT NULL,
    value numeric(30,12) NOT NULL CHECK (value > 0),
    revision integer NOT NULL CHECK (revision > 0),
    provider_observation_id text,
    source_updated_at timestamptz,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    metadata_no_sensitive jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (series_id, observation_date, revision),
    CHECK (
        provider_observation_id IS NULL
        OR (
            length(provider_observation_id) BETWEEN 1 AND 200
            AND provider_observation_id !~ '[[:cntrl:]]'
        )
    ),
    CHECK (jsonb_typeof(metadata_no_sensitive) = 'object')
);

CREATE INDEX economic_observations_series_range_latest_idx
    ON economic_observations (series_id, observation_date, revision DESC);

CREATE FUNCTION reject_economic_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'economic observations are append-only';
END;
$$;

CREATE TRIGGER economic_observations_append_only
BEFORE UPDATE OR DELETE ON economic_observations
FOR EACH ROW EXECUTE FUNCTION reject_economic_observation_mutation();

CREATE TRIGGER economic_observations_no_truncate
BEFORE TRUNCATE ON economic_observations
FOR EACH STATEMENT EXECUTE FUNCTION reject_economic_observation_mutation();

CREATE TABLE economic_sync_jobs (
    id uuid PRIMARY KEY,
    series_id uuid NOT NULL REFERENCES economic_series(id) ON DELETE RESTRICT,
    range_start date NOT NULL,
    range_end date NOT NULL,
    state text NOT NULL DEFAULT 'PENDING'
        CHECK (state IN ('PENDING', 'RUNNING', 'RETRYABLE', 'COMPLETED', 'FAILED', 'CANCELLED')),
    available_at timestamptz NOT NULL DEFAULT now(),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
    lease_owner text,
    lease_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (range_end >= range_start),
    CHECK (attempt <= max_attempts),
    CHECK (state <> 'RETRYABLE' OR attempt < max_attempts),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    CHECK ((state = 'RUNNING') = (lease_owner IS NOT NULL)),
    CHECK ((state IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL)),
    CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
        lease_owner IS NULL
        OR (length(lease_owner) BETWEEN 1 AND 200 AND lease_owner !~ '[[:cntrl:]]')
    ),
    CHECK (error_code IS NULL OR (
        state IN ('RETRYABLE', 'FAILED')
        AND error_code ~ '^[A-Z0-9_]{1,64}$'
    ))
);

CREATE INDEX economic_sync_jobs_due_idx
    ON economic_sync_jobs (available_at, series_id)
    WHERE state IN ('PENDING', 'RETRYABLE');

CREATE INDEX economic_sync_jobs_lease_idx
    ON economic_sync_jobs (lease_expires_at)
    WHERE state = 'RUNNING';

CREATE INDEX economic_sync_jobs_series_range_idx
    ON economic_sync_jobs (series_id, range_start, range_end);

CREATE UNIQUE INDEX economic_sync_jobs_one_active_series_uidx
    ON economic_sync_jobs (series_id)
    WHERE state IN ('PENDING', 'RUNNING', 'RETRYABLE');
