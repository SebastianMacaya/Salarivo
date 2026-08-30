import { Pool, type PoolClient } from "pg";
import { runMigrations } from "./migrations.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

export const pool = new Pool({ connectionString: databaseUrl });

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the application error that caused the rollback.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function migrate(): Promise<void> {
  return runMigrations(pool);
}

export type { PoolClient } from "pg";
