import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationName = /^(\d+)_([a-z0-9_]+)\.sql$/;
const migrationLock = "764271950317";

export type Migration = Readonly<{
  version: number;
  name: string;
  sql: string;
  checksum: string;
}>;

type AppliedMigration = Readonly<{
  version: number;
  name: string;
  checksum: string;
}>;

export async function loadMigrations(directory = migrationDirectory): Promise<Migration[]> {
  const filenames = (await readdir(directory)).filter((filename) => filename.endsWith(".sql")).sort();
  const migrations = await Promise.all(
    filenames.map(async (filename) => {
      const match = migrationName.exec(filename);
      if (!match) throw new Error(`Invalid migration filename: ${filename}`);
      const version = match[1];
      const name = match[2];
      if (!version || !name) throw new Error(`Invalid migration filename: ${filename}`);
      const sql = await readFile(join(directory, filename), "utf8");
      return {
        version: Number(version),
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );

  const versions = new Set<number>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) throw new Error(`Duplicate migration version: ${migration.version}`);
    versions.add(migration.version);
  }
  return migrations.sort((left, right) => left.version - right.version);
}

export function pendingMigrations(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): Migration[] {
  const local = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = local.get(row.version);
    if (!migration) throw new Error(`Applied migration ${row.version} is missing locally`);
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`Applied migration ${row.version} was modified`);
    }
  }
  const appliedVersions = new Set(applied.map((migration) => migration.version));
  return migrations.filter((migration) => !appliedVersions.has(migration.version));
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original migration error is more useful than a failed rollback.
  }
}

export async function runMigrations(database: Pool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [migrationLock]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL UNIQUE,
        checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const result = await client.query<AppliedMigration>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const pending = pendingMigrations(await loadMigrations(), result.rows);

    for (const migration of pending) {
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client);
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLock]);
    } finally {
      client.release();
    }
  }
}
