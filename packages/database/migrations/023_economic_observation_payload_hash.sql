ALTER TABLE economic_observations
    ADD COLUMN provider_payload_sha256 text;

ALTER TABLE economic_observations
    ADD CONSTRAINT economic_observations_provider_payload_sha256_check
        CHECK (
            provider_payload_sha256 IS NOT NULL
            AND provider_payload_sha256 ~ '^[0-9a-f]{64}$'
        ) NOT VALID;
