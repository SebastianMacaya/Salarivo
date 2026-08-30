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
  assert.equal(migrations.length, 11);
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
