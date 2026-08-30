import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMigrations, pendingMigrations } from "../src/migrations.ts";

test("migration history detects edits and only returns unapplied files", async () => {
  const migrations = await loadMigrations();
  assert.equal(migrations.length, 5);
  const migration = migrations[0];
  const second = migrations[1];
  const third = migrations[2];
  const fourth = migrations[3];
  const fifth = migrations[4];
  assert.ok(migration && second && third && fourth && fifth);
  assert.match(migration.checksum, /^[0-9a-f]{64}$/);
  assert.match(second.checksum, /^[0-9a-f]{64}$/);
  assert.match(third.checksum, /^[0-9a-f]{64}$/);
  assert.match(fourth.checksum, /^[0-9a-f]{64}$/);
  assert.match(fifth.checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(pendingMigrations(migrations, []), migrations);
  assert.deepEqual(pendingMigrations(migrations, [migration]), [second, third, fourth, fifth]);
  assert.deepEqual(pendingMigrations(migrations, migrations), []);
  assert.throws(
    () => pendingMigrations(migrations, [{ ...migration, checksum: "0".repeat(64) }]),
    /was modified/,
  );
});
