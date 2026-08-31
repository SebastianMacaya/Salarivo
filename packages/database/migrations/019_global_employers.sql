DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM documents AS document
          JOIN payroll_settlements AS settlement
            ON settlement.document_id = document.id
           AND settlement.user_id = document.user_id
         WHERE document.employment_id IS NOT NULL
           AND settlement.employment_id IS NOT NULL
           AND settlement.employment_id <> document.employment_id
    ) OR EXISTS (
        SELECT 1
          FROM documents AS document
          JOIN import_batch_items AS item
            ON item.id = document.import_batch_item_id
           AND item.user_id = document.user_id
         WHERE document.employment_id IS NOT NULL
           AND item.employment_id IS NOT NULL
           AND item.employment_id <> document.employment_id
    ) THEN
        RAISE EXCEPTION 'GLOBAL_EMPLOYMENT_REFERENCE_CONFLICT';
    END IF;

    IF EXISTS (
        SELECT document.id
          FROM documents AS document
          JOIN LATERAL (
              SELECT item.employment_id
                FROM import_batch_items AS item
               WHERE item.id = document.import_batch_item_id
                 AND item.user_id = document.user_id
                 AND item.employment_id IS NOT NULL
              UNION
              SELECT settlement.employment_id
                FROM payroll_settlements AS settlement
               WHERE settlement.document_id = document.id
                 AND settlement.user_id = document.user_id
                 AND settlement.employment_id IS NOT NULL
          ) AS reference ON true
         WHERE document.employment_id IS NULL
         GROUP BY document.id
        HAVING count(DISTINCT reference.employment_id) > 1
    ) THEN
        RAISE EXCEPTION 'GLOBAL_EMPLOYMENT_REFERENCE_AMBIGUOUS';
    END IF;
END;
$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
         FROM employers
         WHERE lower(
             btrim(regexp_replace(
                 regexp_replace(
                     regexp_replace(normalize(name, NFKC), '[.]', '', 'g'),
                     '[[:punct:]]+', ' ', 'g'
                 ),
                 '[[:space:]]+', ' ', 'g'
             )) COLLATE "und-x-icu"
         ) = ''
    ) THEN
        RAISE EXCEPTION 'GLOBAL_EMPLOYER_EMPTY_NORMALIZATION';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM employers
         WHERE char_length(
             lower(
                 btrim(regexp_replace(
                     regexp_replace(
                         regexp_replace(normalize(name, NFKC), '[.]', '', 'g'),
                         '[[:punct:]]+', ' ', 'g'
                     ),
                     '[[:space:]]+', ' ', 'g'
                 )) COLLATE "und-x-icu"
             )
         ) > 200
    ) THEN
        RAISE EXCEPTION 'GLOBAL_EMPLOYER_NORMALIZATION_TOO_LONG';
    END IF;
END;
$$;

CREATE FUNCTION normalize_employer_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT lower(
        btrim(regexp_replace(
            regexp_replace(
                regexp_replace(normalize(value, NFKC), '[.]', '', 'g'),
                '[[:punct:]]+', ' ', 'g'
            ),
            '[[:space:]]+', ' ', 'g'
        ))
        COLLATE "und-x-icu"
    )
$$;

CREATE FUNCTION normalize_employer_name_conservative(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
    SELECT lower(
        btrim(regexp_replace(
            regexp_replace(normalize(value, NFKC), '[.]', '', 'g'),
            '[[:space:]]+', ' ', 'g'
        ))
        COLLATE "und-x-icu"
    )
$$;

ALTER TABLE employments
    DROP CONSTRAINT employments_user_id_employer_id_fkey;

ALTER TABLE employers
    DROP CONSTRAINT employers_user_id_fkey,
    DROP CONSTRAINT employers_user_id_id_key;

ALTER TABLE employers
    RENAME COLUMN user_id TO created_by_user_id;

ALTER TABLE employers
    ALTER COLUMN created_by_user_id DROP NOT NULL;

ALTER TABLE employers
    ADD CONSTRAINT employers_created_by_user_id_fkey
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN normalized_name text
        GENERATED ALWAYS AS (normalize_employer_name(name)) STORED,
    ADD COLUMN status text NOT NULL DEFAULT 'PENDING',
    ADD COLUMN created_source text NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN merged_into_employer_id uuid REFERENCES employers(id),
    ADD COLUMN verified_at timestamptz,
    ADD COLUMN verified_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT employers_status_check
        CHECK (status IN ('PENDING', 'VERIFIED', 'MERGED', 'REJECTED')),
    ADD CONSTRAINT employers_created_source_check
        CHECK (created_source IN ('LEGACY', 'MANUAL', 'DOCUMENT', 'ADMIN')),
    ADD CONSTRAINT employers_normalized_name_check
        CHECK (length(normalized_name) BETWEEN 1 AND 200),
    ADD CONSTRAINT employers_merge_state_check CHECK (
        (status = 'MERGED') = (merged_into_employer_id IS NOT NULL)
        AND (merged_into_employer_id IS NULL OR merged_into_employer_id <> id)
    ),
    ADD CONSTRAINT employers_verification_state_check CHECK (
        (status = 'VERIFIED') = (verified_at IS NOT NULL)
        AND (verified_by_user_id IS NULL OR status = 'VERIFIED')
    );

ALTER TABLE employers
    ALTER COLUMN created_source SET DEFAULT 'MANUAL';

ALTER TABLE employments
    ADD CONSTRAINT employments_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    ADD CONSTRAINT employments_employer_id_fkey
        FOREIGN KEY (employer_id) REFERENCES employers(id) ON DELETE RESTRICT;

CREATE INDEX employers_country_normalized_idx
    ON employers (country_code, normalized_name, id)
    WHERE status IN ('PENDING', 'VERIFIED');

CREATE INDEX employers_merge_target_idx
    ON employers (merged_into_employer_id)
    WHERE merged_into_employer_id IS NOT NULL;

CREATE TABLE employer_aliases (
    id uuid PRIMARY KEY,
    employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
    alias text NOT NULL,
    normalized_alias text GENERATED ALWAYS AS (normalize_employer_name(alias)) STORED,
    created_source text NOT NULL,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employer_id, normalized_alias),
    CHECK (length(alias) BETWEEN 1 AND 200),
    CHECK (length(normalized_alias) BETWEEN 1 AND 200),
    CHECK (created_source IN ('LEGACY', 'MANUAL', 'DOCUMENT', 'ADMIN'))
);

CREATE INDEX employer_aliases_normalized_idx
    ON employer_aliases (normalized_alias, employer_id);

CREATE TABLE employer_identifiers (
    id uuid PRIMARY KEY,
    employer_id uuid NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
    country_code text NOT NULL,
    identifier_type text NOT NULL,
    identifier_ciphertext bytea NOT NULL,
    identifier_fingerprint text,
    identifier_key_version text NOT NULL,
    masked_suffix text,
    created_source text NOT NULL,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (country_code ~ '^[A-Z]{2}$'),
    CHECK (length(identifier_type) BETWEEN 1 AND 32),
    CHECK (length(identifier_ciphertext) > 0),
    CHECK (length(identifier_key_version) BETWEEN 1 AND 64),
    CHECK (identifier_fingerprint IS NULL OR identifier_fingerprint ~ '^[0-9a-f]{64}$'),
    CHECK (masked_suffix IS NULL OR masked_suffix ~ '^[A-Za-z0-9]{2,8}$'),
    CHECK (created_source IN ('LEGACY', 'MANUAL', 'DOCUMENT', 'ADMIN')),
    CHECK (
        (identifier_fingerprint IS NOT NULL AND masked_suffix IS NOT NULL)
        OR (created_source = 'LEGACY' AND identifier_fingerprint IS NULL AND masked_suffix IS NULL)
    )
);

CREATE UNIQUE INDEX employer_identifiers_fingerprint_uidx
    ON employer_identifiers (country_code, identifier_type, identifier_fingerprint)
    WHERE identifier_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX employer_identifiers_employer_type_uidx
    ON employer_identifiers (employer_id, country_code, identifier_type);

INSERT INTO employer_identifiers (
    id, employer_id, country_code, identifier_type, identifier_ciphertext,
    identifier_key_version, created_source, created_by_user_id, created_at
)
SELECT id, id, country_code, tax_identifier_type, tax_identifier_ciphertext,
       tax_identifier_key_version, 'LEGACY', created_by_user_id, created_at
  FROM employers
 WHERE tax_identifier_type IS NOT NULL;

ALTER TABLE employers
    DROP COLUMN tax_identifier_type,
    DROP COLUMN tax_identifier_ciphertext,
    DROP COLUMN tax_identifier_key_version;

ALTER TABLE documents
    ADD COLUMN detected_employer_id uuid REFERENCES employers(id) ON DELETE SET NULL;

CREATE INDEX documents_detected_employer_idx
    ON documents (user_id, detected_employer_id, created_at DESC)
    WHERE detected_employer_id IS NOT NULL AND deleted_at IS NULL;

WITH inferred AS (
    SELECT document.id AS document_id,
           min(reference.employment_id::text)::uuid AS employment_id
      FROM documents AS document
      JOIN LATERAL (
          SELECT item.employment_id
            FROM import_batch_items AS item
           WHERE item.id = document.import_batch_item_id
             AND item.user_id = document.user_id
             AND item.employment_id IS NOT NULL
          UNION
          SELECT settlement.employment_id
            FROM payroll_settlements AS settlement
           WHERE settlement.document_id = document.id
             AND settlement.user_id = document.user_id
             AND settlement.employment_id IS NOT NULL
      ) AS reference ON true
     WHERE document.employment_id IS NULL
     GROUP BY document.id
    HAVING count(DISTINCT reference.employment_id) = 1
)
UPDATE documents AS document
   SET employment_id = inferred.employment_id
  FROM inferred
 WHERE document.id = inferred.document_id
   AND document.employment_id IS NULL;

CREATE TEMP TABLE employment_duplicate_map ON COMMIT DROP AS
SELECT id AS duplicate_id, survivor_id, user_id
  FROM (
      SELECT id, user_id,
             first_value(id) OVER (
                 PARTITION BY user_id, employer_id, start_date, end_date, role,
                              category, modality, country_code, currency_code
                 ORDER BY created_at, id
             ) AS survivor_id
        FROM employments
  ) AS ranked
 WHERE id <> survivor_id;

UPDATE import_batch_items AS item
   SET employment_id = duplicate.survivor_id,
       updated_at = now()
  FROM employment_duplicate_map AS duplicate
 WHERE item.user_id = duplicate.user_id
   AND item.employment_id = duplicate.duplicate_id;

UPDATE documents AS document
   SET employment_id = duplicate.survivor_id
  FROM employment_duplicate_map AS duplicate
 WHERE document.user_id = duplicate.user_id
   AND document.employment_id = duplicate.duplicate_id;

UPDATE payroll_settlements AS settlement
   SET employment_id = duplicate.survivor_id
  FROM employment_duplicate_map AS duplicate
 WHERE settlement.user_id = duplicate.user_id
   AND settlement.employment_id = duplicate.duplicate_id;

DELETE FROM employments AS employment
 USING employment_duplicate_map AS duplicate
 WHERE employment.id = duplicate.duplicate_id
   AND employment.user_id = duplicate.user_id;

CREATE UNIQUE INDEX employments_exact_identity_uidx
    ON employments (
        user_id, employer_id, start_date, end_date, role, category, modality,
        country_code, currency_code
    ) NULLS NOT DISTINCT;

UPDATE documents AS document
   SET detected_employer_id = employment.employer_id
  FROM employments AS employment
 WHERE document.employment_id = employment.id
   AND document.user_id = employment.user_id
   AND document.detected_employer_id IS NULL;

CREATE TEMP TABLE migration_019_auto_associations ON COMMIT DROP AS
WITH latest_runs AS (
    SELECT DISTINCT ON (run.document_id)
           run.id, run.document_id, run.user_id
      FROM extraction_runs AS run
     WHERE run.status = 'COMPLETED'
     ORDER BY run.document_id, run.processing_version DESC
), effective_names AS (
    SELECT document.id AS document_id,
           document.user_id,
           run.id AS extraction_run_id,
           normalize_employer_name(
               COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}')
           ) AS normalized_name,
           normalize_employer_name_conservative(
               COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}')
           ) AS conservative_name
      FROM documents AS document
      JOIN latest_runs AS run
        ON run.document_id = document.id
       AND run.user_id = document.user_id
      JOIN extracted_fields AS field
        ON field.extraction_run_id = run.id
       AND field.user_id = run.user_id
       AND field.document_id = run.document_id
       AND field.field_path = 'employer.name'
      LEFT JOIN LATERAL (
          SELECT current.corrected_value
            FROM user_corrections AS current
           WHERE current.user_id = field.user_id
             AND current.extraction_run_id = field.extraction_run_id
             AND current.field_path = field.field_path
           ORDER BY current.correction_version DESC
           LIMIT 1
      ) AS correction ON true
     WHERE document.employment_id IS NULL
       AND document.deleted_at IS NULL
       AND COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}') IS NOT NULL
), candidate_employments AS (
    SELECT name.document_id, name.user_id,
           employment.id AS employment_id, employment.employer_id
      FROM effective_names AS name
      JOIN employments AS employment
        ON employment.user_id = name.user_id
      JOIN employers AS employer
        ON employer.id = employment.employer_id
       AND normalize_employer_name_conservative(employer.name) = name.conservative_name
       AND employer.status IN ('PENDING', 'VERIFIED')
     WHERE EXISTS (
               SELECT 1
                 FROM payroll_settlements AS settlement
                WHERE settlement.extraction_run_id = name.extraction_run_id
                  AND settlement.user_id = name.user_id
           )
       AND NOT EXISTS (
               SELECT 1
                 FROM payroll_settlements AS settlement
                WHERE settlement.extraction_run_id = name.extraction_run_id
                  AND settlement.user_id = name.user_id
                  AND (
                      settlement.currency_code <> employment.currency_code
                      OR settlement.payroll_period < date_trunc('month', employment.start_date)::date
                      OR (
                          employment.end_date IS NOT NULL
                          AND settlement.payroll_period > date_trunc('month', employment.end_date)::date
                      )
                  )
           )
), unique_matches AS (
    SELECT document_id, user_id, min(employment_id::text)::uuid AS employment_id,
           min(employer_id::text)::uuid AS employer_id
      FROM candidate_employments
     GROUP BY document_id, user_id
    HAVING count(*) = 1
)
SELECT document_id, user_id, employment_id, employer_id
  FROM unique_matches;

UPDATE documents AS document
   SET employment_id = match.employment_id,
       detected_employer_id = match.employer_id
  FROM migration_019_auto_associations AS match
 WHERE document.id = match.document_id
   AND document.employment_id IS NULL;

INSERT INTO audit_events (
    id, user_id, actor_user_id, action, resource_type, resource_id, result,
    metadata_no_sensitive
)
SELECT md5('migration-019-auto-association:' || match.document_id::text)::uuid,
       match.user_id, NULL, 'EMPLOYMENT_AUTO_ASSOCIATED', 'DOCUMENT',
       match.document_id, 'SUCCESS', jsonb_build_object(
           'employmentId', match.employment_id,
           'employerId', match.employer_id,
           'matchRule', 'EXACT_CONSERVATIVE_NAME_CURRENCY_PERIOD_UNIQUE',
           'resolverVersion', 'migration-019',
           'source', 'MIGRATION_019'
       )
  FROM migration_019_auto_associations AS match;

WITH latest_runs AS (
    SELECT DISTINCT ON (run.document_id)
           run.id, run.document_id, run.user_id
      FROM extraction_runs AS run
     WHERE run.status = 'COMPLETED'
     ORDER BY run.document_id, run.processing_version DESC
), effective_names AS (
    SELECT document.id AS document_id,
           document.user_id,
           normalize_employer_name_conservative(
               COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}')
           ) AS conservative_name
      FROM documents AS document
      JOIN latest_runs AS run
        ON run.document_id = document.id
       AND run.user_id = document.user_id
      JOIN extracted_fields AS field
        ON field.extraction_run_id = run.id
       AND field.user_id = run.user_id
       AND field.document_id = run.document_id
       AND field.field_path = 'employer.name'
      LEFT JOIN LATERAL (
          SELECT current.corrected_value
            FROM user_corrections AS current
           WHERE current.user_id = field.user_id
             AND current.extraction_run_id = field.extraction_run_id
             AND current.field_path = field.field_path
           ORDER BY current.correction_version DESC
           LIMIT 1
      ) AS correction ON true
     WHERE document.detected_employer_id IS NULL
       AND document.deleted_at IS NULL
       AND COALESCE(correction.corrected_value #>> '{}', field.interpreted_value #>> '{}') IS NOT NULL
), candidates AS (
    SELECT name.document_id, name.user_id, employer.id AS employer_id,
           employer.created_by_user_id = name.user_id AS created_by_user
      FROM effective_names AS name
      JOIN employers AS employer
        ON employer.country_code = 'AR'
       AND normalize_employer_name_conservative(employer.name) = name.conservative_name
       AND employer.status IN ('PENDING', 'VERIFIED')
), matches AS (
    SELECT document_id,
           CASE
               WHEN count(*) FILTER (WHERE created_by_user) = 1
                   THEN min(employer_id::text) FILTER (WHERE created_by_user)::uuid
               WHEN count(*) = 1 THEN min(employer_id::text)::uuid
               ELSE NULL
           END AS employer_id
      FROM candidates
     GROUP BY document_id
)
UPDATE documents AS document
   SET detected_employer_id = match.employer_id
  FROM matches AS match
 WHERE document.id = match.document_id
   AND match.employer_id IS NOT NULL
   AND document.detected_employer_id IS NULL;

UPDATE payroll_settlements AS settlement
   SET employment_id = document.employment_id
  FROM documents AS document
 WHERE document.id = settlement.document_id
   AND document.user_id = settlement.user_id
   AND document.employment_id IS NOT NULL
   AND settlement.employment_id IS DISTINCT FROM document.employment_id;

UPDATE import_batch_items AS item
   SET employment_id = document.employment_id,
       updated_at = now()
  FROM documents AS document
 WHERE document.import_batch_item_id = item.id
   AND document.user_id = item.user_id
   AND document.employment_id IS NOT NULL
   AND item.employment_id IS DISTINCT FROM document.employment_id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM documents AS document
          JOIN import_batch_items AS item
            ON item.id = document.import_batch_item_id
           AND item.user_id = document.user_id
         WHERE item.employment_id IS DISTINCT FROM document.employment_id
    ) OR EXISTS (
        SELECT 1
          FROM documents AS document
          JOIN payroll_settlements AS settlement
            ON settlement.document_id = document.id
           AND settlement.user_id = document.user_id
         WHERE settlement.employment_id IS DISTINCT FROM document.employment_id
    ) THEN
        RAISE EXCEPTION 'employment references diverged during global employer migration';
    END IF;
END;
$$;
