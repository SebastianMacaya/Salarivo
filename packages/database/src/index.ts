import { Pool, type PoolClient } from "pg";
import { assertSecureDatabaseUrl } from "./database-url.ts";
import { runMigrations } from "./migrations.ts";

export { loadMigrations, type Migration } from "./migrations.ts";

export {
  employerSources,
  employerStatuses,
  EmployerResolutionError,
  followMergedEmployer,
  lockEmployerMutation,
  normalizeEmployerName,
  normalizeEmployerNameConservative,
  normalizeEmployerNameInDatabase,
  resolveEmployer,
  type EmployerSource,
  type EmployerResolution,
  type EmployerResolutionErrorCode,
  type EmployerResolutionOutcome,
  type EmployerStatus,
  type ProtectedEmployerIdentifier,
  type ResolveEmployerInput,
  type ResolvedEmployer,
} from "./employers.ts";

export {
  compareProcessingSnapshots,
  criticalFieldsBySettlementType,
  currentPipelineFingerprint,
  extractionRunStatuses,
  parserFixCatalog,
  processingPipelineVersions,
  processingTriggerKinds,
  promotionOutcomes,
  settlementTypes,
  type ExtractionRunStatus,
  type ParserFix,
  type ProcessingSnapshot,
  type ProcessingTriggerKind,
  type PromotionOutcome,
  type SettlementType,
  type SnapshotComparison,
} from "./processing.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const databaseEnvironment = process.env.NODE_ENV === "production"
  ? "production"
  : process.env.APP_ENV?.trim();
assertSecureDatabaseUrl(databaseUrl, databaseEnvironment, process.env.NODE_TLS_REJECT_UNAUTHORIZED);

export const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5_000,
  query_timeout: 30_000,
  statement_timeout: 30_000,
});

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
