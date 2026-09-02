import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSecureDatabaseUrl } from "../src/database-url.ts";
import { normalizeEmployerName, normalizeEmployerNameConservative } from "../src/employers.ts";
import { loadMigrations, pendingMigrations } from "../src/migrations.ts";

test("production database URLs require full certificate and hostname verification", () => {
  assert.doesNotThrow(() => assertSecureDatabaseUrl("postgresql://db.example/salarivo?sslmode=verify-full", "production"));
  assert.throws(() => assertSecureDatabaseUrl("postgresql://db.example/salarivo?sslmode=require", "production"), /verify-full/);
  assert.throws(
    () => assertSecureDatabaseUrl("postgresql://db.example/salarivo?sslmode=verify-full&sslmode=disable", "production"),
    /verify-full/,
  );
  assert.throws(
    () => assertSecureDatabaseUrl("postgresql://db.example/salarivo?sslmode=verify-full&uselibpqcompat=true", "production"),
    /weaken TLS/,
  );
  assert.throws(
    () => assertSecureDatabaseUrl("postgresql://db.example/salarivo?sslmode=verify-full", "production", "0"),
    /forbidden/,
  );
});

test("migration history detects edits and only returns unapplied files", async () => {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 25);
  assert.deepEqual(migrations.map(({ version }) => version), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.deepEqual(
    migrations.at(-1) && { version: migrations.at(-1)!.version, name: migrations.at(-1)!.name },
    { version: 25, name: "legal_document_versions_no_truncate" },
  );
  const migration = migrations[0];
  assert.ok(migration);
  for (const item of migrations) assert.match(item.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(pendingMigrations(migrations, []), migrations);
  assert.deepEqual(pendingMigrations(migrations, [migration]), migrations.slice(1));
  assert.deepEqual(pendingMigrations(migrations, migrations), []);
  assert.throws(
    () => pendingMigrations(migrations, [{ ...migration, checksum: "0".repeat(64) }]),
    /was modified/,
  );
});

test("Google identity migration keeps provider identity separate and transient OAuth data minimal", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 13);
  assert.ok(migration);
  assert.equal(migration.version, 13);
  assert.equal(migration.name, "google_identity_foundation");
  const { sql } = migration;

  const tableDefinition = (table: string): string => {
    const definition = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1];
    assert.ok(definition, `${table} definition is missing`);
    return definition;
  };

  assert.match(sql, /ALTER COLUMN password_hash DROP NOT NULL/);
  assert.match(sql, /ADD COLUMN email_verified_at timestamptz/);
  assert.match(sql, /ADD COLUMN onboarding_completed_at timestamptz/);
  assert.match(sql, /ADD COLUMN last_login_at timestamptz/);
  assert.match(sql, /SET onboarding_completed_at = app_user\.created_at/);
  assert.match(sql, /SELECT max\(session\.created_at\)/);
  assert.match(sql, /'ACTIVE', 'SUSPENDED', 'BLOCKED', 'DELETION_PENDING', 'DELETED'/);

  const accounts = tableDefinition("auth_accounts");
  assert.match(accounts, /user_id uuid NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(accounts, /UNIQUE \(provider, provider_account_id\)/);
  assert.match(accounts, /UNIQUE \(user_id, provider\)/);
  assert.match(accounts, /last_login_at timestamptz/);

  const attempts = tableDefinition("oauth_attempts");
  assert.match(attempts, /browser_token_hash text NOT NULL UNIQUE/);
  assert.match(attempts, /state_hash text NOT NULL UNIQUE/);
  assert.match(attempts, /provider text NOT NULL CHECK \(provider = 'GOOGLE'\)/);
  assert.match(attempts, /purpose text NOT NULL CHECK \(purpose IN \('LOGIN', 'STEP_UP'\)\)/);
  assert.match(attempts, /status IN \('STARTED', 'EXCHANGING', 'IDENTITY_VERIFIED'\)/);
  assert.match(attempts, /REFERENCES sessions\(user_id, id\) MATCH FULL ON DELETE CASCADE/);
  assert.match(attempts, /expires_at = created_at \+ interval '10 minutes'/);
  assert.match(attempts, /pending_subject text/);
  assert.match(attempts, /pending_email text/);
  assert.match(attempts, /pending_display_name text/);
  assert.match(sql, /CREATE INDEX oauth_attempts_expiry_idx/);
  assert.match(sql, /CREATE INDEX oauth_attempts_step_up_idx/);
  assert.doesNotMatch(`${accounts}\n${attempts}`, /^\s*(?:access_token|refresh_token|id_token)\s/im);

  assert.match(sql, /IF EXISTS \(SELECT 1 FROM users\)/);
  assert.match(sql, /OR EXISTS \(SELECT 1 FROM legal_acknowledgements\)/);
  assert.match(sql, /prelaunch legal reset requires an unused instance/);
  assert.match(sql, /DROP TRIGGER legal_document_versions_append_only/);
  assert.match(sql, /DELETE FROM legal_document_versions/);
  assert.equal(sql.match(/\n    '1\.0',/g)?.length, 2);
  assert.doesNotMatch(sql, /contraseñas?/i);
  assert.match(sql, /alcances openid, email y profile/);
  assert.match(sql, /no persiste access tokens, refresh tokens ni ID tokens/);
  assert.match(sql, /no se persisten access tokens, refresh tokens ni ID tokens/);
  assert.match(sql, /\$terms\$,\n\s+'2026-08-30T12:30:00Z',\n\s+'2026-08-30T12:30:00Z',\n\s+true,\n\s+true/);
  assert.match(sql, /\$privacy\$,\n\s+'2026-08-30T12:30:00Z',\n\s+'2026-08-30T12:30:00Z',\n\s+false,\n\s+true/);
});

test("upload marker migration adds a bounded nullable ETag without rewriting history", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 14);
  assert.ok(migration);
  assert.equal(migration.name, "upload_session_marker_etag");
  assert.match(migration.sql, /ALTER TABLE upload_sessions\s+ADD COLUMN upload_marker_etag text/);
  assert.match(migration.sql, /upload_marker_etag IS NULL/);
  assert.match(migration.sql, /length\(upload_marker_etag\) BETWEEN 1 AND 128/);
  assert.match(migration.sql, /upload_marker_etag !~ '\[\[:cntrl:\]\]'/);
});

test("granular admin migration keeps roles fixed and audit append-only", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 15);
  assert.ok(migration);
  assert.match(migration.sql, /ADD COLUMN admin_role text/);
  assert.match(migration.sql, /SET admin_role = 'READ_ONLY'/);
  assert.match(migration.sql, /\(role = 'ADMIN'\) = \(admin_role IS NOT NULL\)/);
  for (const role of ["SUPER_ADMIN", "OPERATIONS", "SUPPORT", "SECURITY", "FINANCE", "READ_ONLY"]) {
    assert.match(migration.sql, new RegExp(`'${role}'`));
  }
  assert.match(migration.sql, /CREATE TABLE admin_audit_events/);
  assert.match(migration.sql, /metadata_no_sensitive jsonb/);
  assert.match(migration.sql, /BEFORE UPDATE OR DELETE ON admin_audit_events/);
  assert.match(migration.sql, /BEFORE TRUNCATE ON admin_audit_events/);
  assert.doesNotMatch(migration.sql, /original_filename|object_key|gross_amount|net_amount|raw_value|corrected_value/);
});

test("reimbursement migration extends the settlement vocabulary without rewriting amounts", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 16);
  assert.ok(migration);
  assert.equal(migration.name, "reimbursement_settlement_type");
  assert.match(migration.sql, /ADD CONSTRAINT payroll_settlements_settlement_type_check_v2/);
  assert.match(migration.sql, /DROP CONSTRAINT payroll_settlements_settlement_type_check/);
  assert.match(migration.sql, /'REINTEGRO'/);
  assert.match(migration.sql, /NOT VALID/);
  assert.match(migration.sql, /VALIDATE CONSTRAINT payroll_settlements_settlement_type_check_v2/);
  assert.match(migration.sql, /RENAME CONSTRAINT payroll_settlements_settlement_type_check_v2/);
  assert.doesNotMatch(migration.sql, /UPDATE payroll_settlements|basic_amount|gross_amount|net_amount/);
});

test("cross-run corrections keep an additive, same-field root lineage", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 17);
  assert.ok(migration);
  assert.equal(migration.name, "cross_run_correction_lineage");
  assert.match(migration.sql, /ADD COLUMN inherited_from_correction_id uuid/);
  assert.match(migration.sql, /ADD COLUMN previous_document_status text/);
  for (const status of ["COMPLETED", "NEEDS_REVIEW", "FAILED_PERMANENT", "CANCELLED"]) {
    assert.match(migration.sql, new RegExp(`'${status}'`));
  }
  assert.match(migration.sql, /UNIQUE \(id, user_id, document_id, field_path\)/);
  assert.match(
    migration.sql,
    /FOREIGN KEY \(inherited_from_correction_id, user_id, document_id, field_path\)[\s\S]*REFERENCES user_corrections\(id, user_id, document_id, field_path\)/,
  );
  assert.match(migration.sql, /inherited_from_correction_id IS NULL OR inherited_from_correction_id <> id/);
  assert.match(migration.sql, /WHERE inherited_from_correction_id IS NOT NULL/);
  assert.doesNotMatch(migration.sql, /\b(?:DELETE FROM|UPDATE user_corrections|DROP (?:TABLE|COLUMN)|TRUNCATE)\b/);
});

test("session management stores only coarse client metadata and initializes activity", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 18);
  assert.ok(migration);
  assert.equal(migration.name, "session_management");
  assert.match(migration.sql, /device_type IN \('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN'\)/);
  assert.match(migration.sql, /browser_family IN \('CHROME', 'EDGE', 'FIREFOX', 'SAFARI', 'OTHER'\)/);
  assert.match(migration.sql, /os_family IN \('WINDOWS', 'MACOS', 'IOS', 'ANDROID', 'LINUX', 'OTHER'\)/);
  assert.match(migration.sql, /UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL/);
  assert.match(migration.sql, /ALTER COLUMN last_seen_at SET DEFAULT now\(\)/);
  assert.match(migration.sql, /ALTER COLUMN last_seen_at SET NOT NULL/);
  assert.doesNotMatch(migration.sql, /\b(?:user_agent|ip_address|geolocation|latitude|longitude)\b/i);
});

test("global employer migration preserves ownership boundaries and repairs only deterministic references", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 19);
  assert.ok(migration);
  assert.equal(migration.name, "global_employers");
  const { sql } = migration;

  assert.match(sql, /GLOBAL_EMPLOYER_EMPTY_NORMALIZATION/);
  assert.match(sql, /GLOBAL_EMPLOYER_NORMALIZATION_TOO_LONG/);
  assert.match(sql, /RENAME COLUMN user_id TO created_by_user_id/);
  assert.match(sql, /ALTER COLUMN created_by_user_id DROP NOT NULL/);
  assert.match(sql, /REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(sql, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /FOREIGN KEY \(employer_id\) REFERENCES employers\(id\) ON DELETE RESTRICT/);
  for (const status of ["PENDING", "VERIFIED", "MERGED", "REJECTED"]) assert.match(sql, new RegExp(`'${status}'`));
  for (const source of ["LEGACY", "MANUAL", "DOCUMENT", "ADMIN"]) assert.match(sql, new RegExp(`'${source}'`));
  assert.match(sql, /CREATE TABLE employer_aliases/);
  assert.match(sql, /CREATE TABLE employer_identifiers/);
  assert.match(sql, /identifier_fingerprint text/);
  assert.match(sql, /WHERE identifier_fingerprint IS NOT NULL/);
  assert.match(sql, /CREATE UNIQUE INDEX employer_identifiers_employer_type_uidx/);
  assert.match(sql, /ADD COLUMN detected_employer_id uuid REFERENCES employers\(id\) ON DELETE SET NULL/);
  assert.match(sql, /CREATE TEMP TABLE employment_duplicate_map ON COMMIT DROP/);
  assert.match(sql, /CREATE UNIQUE INDEX employments_exact_identity_uidx[\s\S]*NULLS NOT DISTINCT/);
  assert.match(sql, /GLOBAL_EMPLOYMENT_REFERENCE_CONFLICT/);
  assert.match(sql, /GLOBAL_EMPLOYMENT_REFERENCE_AMBIGUOUS/);
  assert.match(sql, /employment references diverged during global employer migration/);
  assert.match(sql, /UPDATE import_batch_items AS item[\s\S]*document\.employment_id/);
  assert.match(sql, /UPDATE payroll_settlements AS settlement[\s\S]*document\.employment_id/);
  assert.doesNotMatch(sql, /UNIQUE\s*\(\s*(?:country_code\s*,\s*)?normalized_name\s*\)/i);
  assert.doesNotMatch(sql, /tax_identifier_ciphertext\s*::\s*text|encode\s*\(\s*tax_identifier_ciphertext/i);
});

test("versioned reprocessing keeps promotion explicit, attributable and idempotent", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 20);
  assert.ok(migration);
  assert.equal(migration.name, "versioned_reprocessing");
  const { sql } = migration;

  assert.match(sql, /ADD COLUMN active_extraction_run_id uuid/);
  assert.match(sql, /REFERENCES extraction_runs\(user_id, document_id, id\)/);
  assert.match(sql, /WHERE run\.status = 'COMPLETED'/);
  for (const status of ["PROCESSING", "COMPLETED_WITH_WARNINGS", "REVIEW_REQUIRED", "CANCELLED"]) {
    assert.match(sql, new RegExp(`'${status}'`));
  }
  for (const column of [
    "trigger_kind", "requested_by_user_id", "base_extraction_run_id", "result_schema_version",
    "pipeline_fingerprint", "promotion_outcome", "comparison_summary", "promoted_at", "created_at",
    "ocr_language", "detected_employer_id",
  ]) assert.match(sql, new RegExp(`ADD COLUMN ${column}`));
  assert.match(sql, /EXTRACTION_RUN_OCR_PAIR_CONSTRAINT_NOT_FOUND/);
  assert.match(sql, /ocr_language = CASE[\s\S]+ocr_version = CASE[\s\S]+THEN NULL/);
  assert.match(sql, /ADD CONSTRAINT extraction_runs_ocr_metadata_check/);

  assert.match(sql, /CREATE TABLE extraction_run_issues/);
  assert.match(sql, /field\.signals ->> 'missingReason'/);
  assert.match(sql, /SET status = 'COMPLETED_WITH_WARNINGS'[\s\S]+extraction_run_issues/);
  assert.match(sql, /CREATE TABLE reprocessing_batches/);
  assert.match(sql, /ADD COLUMN reprocessing_batch_id uuid/);
  assert.match(sql, /PROCESSING_JOB_ACTIVE_CONFLICT/);
  assert.match(sql, /CREATE UNIQUE INDEX processing_jobs_one_active_document_uidx/);
  assert.match(sql, /state IN \('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE'\)\s+OR execution_owner IS NOT NULL/);
  assert.match(sql, /CREATE TABLE processing_artifacts/);
  assert.match(sql, /ADD COLUMN artifact_object_keys text\[\]/);
  assert.match(sql, /ADD COLUMN uncertain_artifact_object_keys text\[\]/);
  assert.match(sql, /PROCESSING_WORKER_DRAIN_REQUIRED/);
  assert.match(sql, /DOCUMENT_PIPELINE_V2/);
  assert.match(sql, /BEFORE INSERT ON storage_deletion_tombstones/);
  assert.doesNotMatch(sql, /^\s*(?:content|raw_text|ocr_text)\s+text/im);
});

test("unsupported originals are scheduled for deletion and exact duplicates retain only an aggregate count", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 21);
  assert.ok(migration);
  const { sql } = migration;

  assert.match(sql, /ADD COLUMN discarded_duplicate_count integer NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN unsupported_feedback text/);
  assert.match(sql, /length\(unsupported_feedback\) BETWEEN 1 AND 500/);
  assert.match(sql, /processing_status = 'REJECTED_UNSUPPORTED'/);
  assert.match(sql, /INSERT INTO storage_deletion_tombstones/);
  assert.match(sql, /SET retention_policy = 'DELETE_AFTER_PROCESSING'/);
  assert.match(sql, /canonical_object_key = document\.object_key/);
  assert.doesNotMatch(sql, /DELETE_AFTER_[0-9]+_DAYS|interval '\d+ days'/i);
});

test("economic data is global, revisioned and synchronized without private salary context", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 22);
  assert.ok(migration);
  assert.equal(migration.name, "economic_data");
  const { sql } = migration;

  for (const table of ["economic_series", "economic_observations", "economic_sync_jobs"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /series_type IN \('EXCHANGE_RATE', 'PRICE_INDEX'\)/);
  assert.match(sql, /frequency IN \('DAILY', 'MONTHLY'\)/);
  assert.match(sql, /base_currency_code IS NOT NULL/);
  assert.match(sql, /quote_currency_code IS NOT NULL/);
  assert.match(sql, /base_currency_code <> quote_currency_code/);
  for (const column of [
    "provider_code", "external_series_id", "source_url", "methodology",
    "provider_observation_id", "source_updated_at", "fetched_at",
  ]) assert.match(sql, new RegExp(`\\b${column}\\b`));
  assert.equal(sql.match(/metadata_no_sensitive jsonb/g)?.length, 2);
  assert.match(sql, /value numeric\(30,12\) NOT NULL CHECK \(value > 0\)/);
  assert.match(sql, /UNIQUE \(series_id, observation_date, revision\)/);
  assert.match(sql, /economic_observations_series_range_latest_idx[\s\S]*revision DESC/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON economic_observations/);
  assert.match(sql, /BEFORE TRUNCATE ON economic_observations/);

  assert.match(sql, /range_end >= range_start/);
  assert.match(sql, /attempt <= max_attempts/);
  assert.match(sql, /\(state = 'RUNNING'\) = \(lease_owner IS NOT NULL\)/);
  assert.match(sql, /economic_sync_jobs_due_idx/);
  assert.match(sql, /economic_sync_jobs_lease_idx/);
  assert.match(sql, /CREATE UNIQUE INDEX economic_sync_jobs_one_active_series_uidx/);
  assert.match(sql, /WHERE state IN \('PENDING', 'RUNNING', 'RETRYABLE'\)/);

  assert.doesNotMatch(sql, /\b(?:user_id|document_id|employment_id|settlement_id|salary|gross_amount|net_amount)\b/i);
  assert.doesNotMatch(sql, /\b(?:real|float|double precision)\b/i);
  assert.doesNotMatch(sql, /INSERT INTO economic_/i);
  assert.doesNotMatch(sql, /https:\/\/[^']+\//i);
});

test("economic provider payload hashes are mandatory for new rows without rewriting append-only history", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 23);
  assert.ok(migration);
  assert.equal(migration.name, "economic_observation_payload_hash");
  assert.match(migration.sql, /ADD COLUMN provider_payload_sha256 text/);
  assert.match(migration.sql, /provider_payload_sha256 IS NOT NULL/);
  assert.match(migration.sql, /provider_payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration.sql, /NOT VALID/);
  assert.doesNotMatch(migration.sql, /ALTER COLUMN provider_payload_sha256 SET NOT NULL/);
  assert.doesNotMatch(migration.sql, /UPDATE economic_observations/);
  assert.doesNotMatch(migration.sql, /DROP TRIGGER|DISABLE TRIGGER/i);
});

test("favorite employers stay owner-scoped without changing global employer identity", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 24);
  assert.ok(migration);
  assert.equal(migration.name, "favorite_employers");
  assert.match(migration.sql, /CREATE TABLE user_favorite_employers/);
  assert.match(migration.sql, /user_id uuid NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration.sql, /employer_id uuid NOT NULL REFERENCES employers\(id\) ON DELETE CASCADE/);
  assert.match(migration.sql, /PRIMARY KEY \(user_id, employer_id\)/);
  assert.match(migration.sql, /user_favorite_employers_employer_idx/);
  assert.doesNotMatch(migration.sql, /ALTER TABLE employers[\s\S]+favorite/i);
});

test("legal document versions reject truncate without rewriting history", async () => {
  const migration = (await loadMigrations()).find(({ version }) => version === 25);
  assert.ok(migration);
  assert.equal(migration.name, "legal_document_versions_no_truncate");
  assert.match(migration.sql, /BEFORE TRUNCATE ON legal_document_versions/);
  assert.match(migration.sql, /FOR EACH STATEMENT EXECUTE FUNCTION reject_legal_document_version_mutation\(\)/);
  assert.doesNotMatch(migration.sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE TABLE|DROP)\b/i);
});

test("employer normalization aligns legal suffix punctuation without retaining punctuation-only input", () => {
  assert.equal(normalizeEmployerName("  Acme SA  "), "acme sa");
  assert.equal(normalizeEmployerName("\tAcme SA\n"), "acme sa");
  assert.equal(normalizeEmployerName("ACME S.A."), "acme sa");
  assert.equal(normalizeEmployerName("Empresa-Sintética"), "empresa sintética");
  assert.equal(normalizeEmployerName("Empresa+Norte"), "empresa norte");
  assert.equal(normalizeEmployerNameConservative("ACME S.A."), "acme sa");
  assert.equal(normalizeEmployerNameConservative("\tACME S.A.\n"), "acme sa");
  assert.notEqual(normalizeEmployerNameConservative("Empresa+Norte"), normalizeEmployerNameConservative("Empresa-Norte"));
  assert.equal(normalizeEmployerName("..."), "");
});
