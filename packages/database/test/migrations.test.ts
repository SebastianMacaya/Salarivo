import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSecureDatabaseUrl } from "../src/database-url.ts";
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
  assert.equal(migrations.length, 13);
  assert.deepEqual(migrations.map(({ version }) => version), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.deepEqual(
    migrations.at(-1) && { version: migrations.at(-1)!.version, name: migrations.at(-1)!.name },
    { version: 13, name: "google_identity_foundation" },
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
  const migration = (await loadMigrations()).at(-1);
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
