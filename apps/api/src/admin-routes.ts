import { createHash, randomUUID } from "node:crypto";
import {
  currentPipelineFingerprint,
  followMergedEmployer,
  lockEmployerMutation,
  normalizeEmployerNameInDatabase,
  parserFixCatalog,
  pool,
  processingPipelineVersions,
  withTransaction,
  type PoolClient,
} from "@salarivo/database";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.ts";
import {
  adminPermissions,
  adminRoles,
  hasAdminPermission,
  isAdminRole,
  permissionsForAdminRole,
  type AdminPermission,
  type AdminRole,
} from "./admin-rbac.ts";
import {
  InvalidArgentineCuitError,
  protectArgentineCuit,
} from "./employer-identifiers.ts";
import { lockValidStepUpSession } from "./session-assurance.ts";
import {
  enqueueReprocessing,
  enqueueReprocessingBatch,
  findReprocessingCandidates,
  loadProcessingHealth,
  loadReprocessingBatch,
  processingRunView,
  promoteProcessingRun,
  refreshReprocessingBatch,
  reprocessingCandidateExistsSql,
} from "./reprocessing.ts";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const REFERENCE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{2,79}$";
const reasonCodes = [
  "SUPPORT_REQUEST",
  "SECURITY_INCIDENT",
  "ABUSE_PREVENTION",
  "USER_REQUEST",
  "OPERATIONAL_RECOVERY",
  "ROLE_ADMINISTRATION",
] as const;
const employerStatuses = ["PENDING", "VERIFIED", "MERGED", "REJECTED"] as const;
const employerSources = ["LEGACY", "MANUAL", "DOCUMENT", "ADMIN"] as const;
type ReasonCode = typeof reasonCodes[number];

type ApiErrorConstructor = new (
  statusCode: number,
  code: string,
  message: string,
) => Error & { readonly statusCode: number; readonly code: string };

export type AdminRouteDependencies = {
  config: ApiConfig;
  ApiError: ApiErrorConstructor;
  requireAdminPermission: (
    request: FastifyRequest,
    permission: AdminPermission,
    stepUp?: boolean,
  ) => Promise<void>;
};

type PageQuery = { page?: number; pageSize?: number };
type ListQuery = PageQuery & {
  search?: string;
  sort?: string;
  direction?: "asc" | "desc";
};
type IdParams = { id: string };
type Reason = { reasonCode: ReasonCode; reference: string };
type ProcessingRunParams = { id: string; runId: string };
type AdminReprocessBody = Reason & { retry?: boolean };
type AdminReprocessingBatchBody = Reason & { userId: string; documentIds?: string[] };
type ActiveReprocessingBatchQuery = { userId: string };
type AdminAuditConfig = {
  capability: AdminPermission;
  action: string;
  resourceType: string;
  subjectIsResource?: boolean;
};

declare module "fastify" {
  interface FastifyContextConfig {
    adminAudit?: AdminAuditConfig;
  }
}

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const pagingProperties = {
  page: { type: "integer", minimum: 1, maximum: 1_000 },
  pageSize: { type: "integer", minimum: 1, maximum: 100 },
};

const reasonProperties = {
  reasonCode: { type: "string", enum: [...reasonCodes] },
  reference: { type: "string", pattern: REFERENCE_PATTERN },
};

const reasonBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["reasonCode", "reference"],
  properties: reasonProperties,
};

const employerIdentifierSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "countryCode", "identifierType", "maskedValue", "createdSource", "createdAt"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN }, countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
    identifierType: { type: "string" }, maskedValue: { type: "string", pattern: "^\\*\\*\\*[A-Za-z0-9]*$" },
    createdSource: { type: "string", enum: [...employerSources] }, createdAt: { type: "string" },
  },
};

const uuidRegex = new RegExp(UUID_PATTERN, "i");
const referenceRegex = new RegExp(REFERENCE_PATTERN);

const paginationFields = {
  page: { type: "integer", minimum: 1 },
  pageSize: { type: "integer", minimum: 1, maximum: 100 },
  total: { type: "integer", minimum: 0 },
};

const reprocessingBatchSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "status", "triggerKind", "createdAt", "updatedAt", "completedAt", "progress"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN }, status: { type: "string" },
    triggerKind: { type: "string" }, createdAt: { type: "string" }, updatedAt: { type: "string" },
    completedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    progress: {
      type: "object", additionalProperties: false,
      required: ["total", "queued", "processing", "improved", "unchanged", "reviewRequired", "failed", "skipped"],
      properties: Object.fromEntries([
        "total", "queued", "processing", "improved", "unchanged", "reviewRequired", "failed", "skipped",
      ].map((key) => [key, { type: "integer", minimum: 0 }])),
    },
  },
};

function envelope(data: object): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data },
  };
}

function ok(data: object): { response: Record<number, object> } {
  return { response: { 200: envelope(data) } };
}

function timestamp(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateOnly(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function integer(value: unknown): number {
  return Number(value ?? 0);
}

function maskedEmail(value: unknown): string {
  const email = String(value);
  const separator = email.lastIndexOf("@");
  if (separator < 1) return "***";
  return `${email[0]}***${email.slice(separator)}`;
}

function pageOf(query: PageQuery) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function searchOf(value: string | undefined): string | null {
  const search = value?.trim();
  return search ? search : null;
}

function prefixSearchOf(value: string | undefined): string | null {
  return searchOf(value)?.replace(/[\\%_]/g, "\\$&") ?? null;
}

function safeReason(request: FastifyRequest): Partial<Reason> {
  for (const source of [request.body, request.query]) {
    if (!source || typeof source !== "object") continue;
    const { reasonCode, reference } = source as Record<string, unknown>;
    if (
      typeof reasonCode === "string"
      && reasonCodes.includes(reasonCode as ReasonCode)
      && typeof reference === "string"
      && referenceRegex.test(reference)
    ) return { reasonCode: reasonCode as ReasonCode, reference };
  }
  return {};
}

function sortOf(value: string | undefined, direction: "asc" | "desc" | undefined, allowed: Record<string, string>, fallback: string): string {
  const column = allowed[value ?? ""] ?? allowed[fallback];
  return `${column} ${direction === "asc" ? "ASC" : "DESC"}`;
}

function paged(items: object[], page: number, pageSize: number, total: number) {
  return { items, page, pageSize, total };
}

async function totalForPage(sql: string, values: unknown[], current: unknown, offset: number): Promise<number> {
  if (current !== undefined) return integer(current);
  if (offset === 0) return 0;
  const firstPage = await pool.query(sql, [...values.slice(0, -2), 1, 0]);
  return integer(firstPage.rows[0]?.total);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function maskEmployerIdentifier(suffix: unknown): string {
  return typeof suffix === "string" && suffix.length > 0 ? `***${suffix}` : "***";
}

async function employerNameInput(
  client: PoolClient,
  value: string,
  ApiError: ApiErrorConstructor,
): Promise<{ value: string; normalized: string }> {
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(400, "VALIDATION_ERROR", "El nombre del empleador no es válido.");
  const normalized = await normalizeEmployerNameInDatabase(client, trimmed);
  if (!normalized || [...normalized].length > 200) {
    throw new ApiError(400, "VALIDATION_ERROR", "El nombre del empleador no es válido.");
  }
  return { value: trimmed, normalized };
}

function employerAdminDto(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    countryCode: String(row.country_code),
    status: String(row.status),
    mergedIntoEmployerId: text(row.merged_into_employer_id),
    createdSource: String(row.created_source),
    employmentCount: integer(row.employment_count),
    userCount: integer(row.user_count),
    documentCount: integer(row.document_count),
    createdAt: timestamp(row.created_at as Date | string | null)!,
    updatedAt: timestamp(row.updated_at as Date | string | null)!,
    verifiedAt: timestamp(row.verified_at as Date | string | null),
  };
}

function employerStateDto(row: Record<string, unknown>) {
  return {
    id: String(row.id), name: String(row.name), normalizedName: String(row.normalized_name),
    status: String(row.status), mergedIntoEmployerId: text(row.merged_into_employer_id),
    updatedAt: timestamp(row.updated_at as Date | string | null)!,
    verifiedAt: timestamp(row.verified_at as Date | string | null),
  };
}

async function lockActor(
  client: PoolClient,
  request: FastifyRequest,
  permission: AdminPermission,
  ApiError: ApiErrorConstructor,
): Promise<AdminRole> {
  if (
    !request.authSessionHash
    || !request.authUser
    || !await lockValidStepUpSession(client, request.authSessionHash, request.authUser.id)
  ) {
    throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
  }
  const actor = await client.query(
    `SELECT role, admin_role, status, deleted_at
       FROM users
      WHERE id = $1
      FOR UPDATE`,
    [request.authUser.id],
  );
  const row = actor.rows[0];
  if (
    actor.rowCount !== 1
    || row.role !== "ADMIN"
    || row.status !== "ACTIVE"
    || row.deleted_at !== null
    || !isAdminRole(row.admin_role)
    || !hasAdminPermission(row.admin_role, permission)
  ) {
    throw new ApiError(403, "ADMIN_PERMISSION_REQUIRED", "No tenés permisos para realizar esta operación.");
  }
  return row.admin_role;
}

export async function lockEmployerManagement(
  client: PoolClient,
  request: FastifyRequest,
  ApiError: ApiErrorConstructor,
): Promise<AdminRole> {
  // ponytail: one global admin-employer lock; split by employer only if measured contention appears.
  await lockEmployerMutation(client);
  return lockActor(client, request, "employers.manage", ApiError);
}

async function lockEmployerNames(
  client: PoolClient,
  countryCode: string,
  normalizedNames: readonly string[],
): Promise<void> {
  const keys = [...new Set(normalizedNames)]
    .map((name) => `employer-name:${countryCode}:${name}`)
    .sort();
  for (const key of keys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
}

async function lockEmployerIdentities(
  client: PoolClient,
  names: readonly { countryCode: string; normalizedName: string }[],
  identifiers: readonly { countryCode: string; identifierType: string; fingerprint: string }[],
): Promise<ReadonlySet<string>> {
  const identifierKeys = [...new Set(identifiers.map((identifier) =>
    `employer-identifier:${identifier.countryCode}:${identifier.identifierType}:${identifier.fingerprint}`))].sort();
  const nameKeys = [...new Set(names.map((name) =>
    `employer-name:${name.countryCode}:${name.normalizedName}`))].sort();
  const keys = [...identifierKeys, ...nameKeys];
  for (const key of keys) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
  }
  return new Set(keys);
}

type EmployerMergeRow = {
  id: string;
  name: string;
  normalized_name: string;
  country_code: string;
  status: string;
  merged_into_employer_id: string | null;
};

async function readEmployerMergeChain(
  client: PoolClient,
  employerId: string,
  ApiError: ApiErrorConstructor,
): Promise<EmployerMergeRow[]> {
  const chain: EmployerMergeRow[] = [];
  const visited = new Set<string>();
  let currentId = employerId;
  for (let depth = 0; depth < 32; depth += 1) {
    if (visited.has(currentId)) {
      throw new ApiError(409, "EMPLOYER_MERGE_CHAIN_INVALID", "La cadena de fusión del destino no es válida.");
    }
    visited.add(currentId);
    const result = await client.query<EmployerMergeRow>(
      `SELECT id, name, normalized_name, country_code, status, merged_into_employer_id
         FROM employers
        WHERE id = $1`,
      [currentId],
    );
    const row = result.rows[0];
    if (!row || row.status === "REJECTED") {
      throw new ApiError(404, "TARGET_EMPLOYER_NOT_FOUND", "El empleador destino no existe o fue rechazado.");
    }
    chain.push(row);
    if (row.status !== "MERGED") return chain;
    if (!row.merged_into_employer_id) {
      throw new ApiError(409, "EMPLOYER_MERGE_CHAIN_INVALID", "La cadena de fusión del destino no es válida.");
    }
    currentId = row.merged_into_employer_id;
  }
  throw new ApiError(409, "EMPLOYER_MERGE_CHAIN_INVALID", "La cadena de fusión del destino es demasiado larga.");
}

type EmployerNameIdentityRow = { employer_id: string; country_code: string; normalized_name: string };
type EmployerIdentifierIdentityRow = {
  employer_id: string;
  country_code: string;
  identifier_type: string;
  identifier_fingerprint: string;
};

async function readEmployerIdentitySnapshot(client: PoolClient, employerIds: readonly string[]) {
  const names = await client.query<EmployerNameIdentityRow>(
    `SELECT id AS employer_id, country_code, normalized_name
       FROM employers
      WHERE id = ANY($1::uuid[])
     UNION
     SELECT alias.employer_id, employer.country_code, alias.normalized_alias AS normalized_name
       FROM employer_aliases alias
       JOIN employers employer ON employer.id = alias.employer_id
      WHERE alias.employer_id = ANY($1::uuid[])`,
    [employerIds],
  );
  const identifiers = await client.query<EmployerIdentifierIdentityRow>(
    `SELECT employer_id, country_code, identifier_type, identifier_fingerprint
       FROM employer_identifiers
      WHERE employer_id = ANY($1::uuid[]) AND identifier_fingerprint IS NOT NULL`,
    [employerIds],
  );
  return { names: names.rows, identifiers: identifiers.rows };
}

function identityLockKey(row: EmployerNameIdentityRow | EmployerIdentifierIdentityRow): string {
  if ("identifier_fingerprint" in row) {
    return `employer-identifier:${row.country_code}:${row.identifier_type}:${row.identifier_fingerprint}`;
  }
  return `employer-name:${row.country_code}:${row.normalized_name}`;
}

async function assertEmployerNameAvailable(
  client: PoolClient,
  employerId: string,
  countryCode: string,
  normalizedName: string,
  ApiError: ApiErrorConstructor,
  allowDistinctStrongIdentifiers = false,
): Promise<void> {
  const matches = await client.query(
    `SELECT id
       FROM employers
      WHERE country_code = $1 AND normalized_name = $2 AND status <> 'REJECTED'
     UNION
     SELECT alias.employer_id AS id
       FROM employer_aliases alias
       JOIN employers employer ON employer.id = alias.employer_id
      WHERE employer.country_code = $1 AND alias.normalized_alias = $2 AND employer.status <> 'REJECTED'
     ORDER BY id`,
    [countryCode, normalizedName],
  );
  for (const match of matches.rows) {
    const canonical = await followMergedEmployer(client, String(match.id));
    if (canonical && canonical.id !== employerId) {
      if (allowDistinctStrongIdentifiers) {
        const distinction = await client.query<{ proven: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM employer_identifiers candidate
               JOIN employer_identifiers existing
                 ON existing.country_code = candidate.country_code
                AND existing.identifier_type = candidate.identifier_type
              WHERE candidate.employer_id = $1
                AND existing.employer_id = $2
                AND candidate.country_code = $3
                AND candidate.identifier_fingerprint IS NOT NULL
                AND existing.identifier_fingerprint IS NOT NULL
                AND candidate.identifier_fingerprint <> existing.identifier_fingerprint
           ) AS proven`,
          [employerId, canonical.id, countryCode],
        );
        if (distinction.rows[0]?.proven) continue;
      }
      throw new ApiError(409, "EMPLOYER_NAME_CONFLICT", "Ese nombre o alias pertenece a otro empleador; usá la fusión.");
    }
  }
}

async function audit(
  client: PoolClient,
  request: FastifyRequest,
  actorRole: AdminRole,
  capability: AdminPermission,
  action: string,
  resourceType: string,
  resourceId: string | null,
  subjectUserId: string | null,
  reason: Reason,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_events (
       id, actor_user_id, actor_admin_role, capability, action, resource_type,
       resource_id, subject_user_id, result, reason_code, reference, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SUCCESS', $9, $10, $11::jsonb)`,
    [
      randomUUID(), request.authUser!.id, actorRole, capability, action, resourceType,
      resourceId, subjectUserId, reason.reasonCode, reason.reference, JSON.stringify(metadata),
    ],
  );
}

async function protectLastSuperAdmin(client: PoolClient, target: Record<string, unknown>, ApiError: ApiErrorConstructor) {
  if (target.role !== "ADMIN" || target.admin_role !== "SUPER_ADMIN" || target.status !== "ACTIVE") return;
  const remaining = await client.query(
    `SELECT 1 FROM users
      WHERE role = 'ADMIN' AND admin_role = 'SUPER_ADMIN' AND status = 'ACTIVE'
        AND deleted_at IS NULL AND id <> $1
      LIMIT 1`,
    [target.id],
  );
  if (remaining.rowCount === 0) {
    throw new ApiError(409, "LAST_SUPER_ADMIN", "Debe quedar al menos un superadministrador activo.");
  }
}

async function finalizeBatchIfTerminal(client: PoolClient, batchId: string, userId: string): Promise<void> {
  await client.query(
    `UPDATE import_batches AS batch
        SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE batch.id = $1 AND batch.user_id = $2 AND batch.status IN ('ACTIVE', 'PAUSED')
        AND NOT EXISTS (
          SELECT 1 FROM import_batch_items AS item
           WHERE item.batch_id = batch.id AND item.user_id = batch.user_id
             AND item.status NOT IN ('COMPLETED', 'NEEDS_REVIEW', 'REJECTED', 'FAILED', 'CANCELLED')
        )`,
    [batchId, userId],
  );
}

async function scheduleOriginalDeletion(client: PoolClient, document: Record<string, unknown>): Promise<void> {
  if (document.retention_policy !== "DELETE_AFTER_PROCESSING" || document.original_deleted_at !== null) return;
  await client.query(
    `INSERT INTO storage_deletion_tombstones (
       id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), document.user_id, document.object_key, document.incoming_object_key, document.upload_expires_at],
  );
  await client.query(
    `UPDATE documents
        SET original_deleted_at = now()
      WHERE id = $1 AND user_id = $2 AND original_deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM storage_deletion_tombstones
           WHERE canonical_object_key = $3 AND user_id = $2
        )`,
    [document.id, document.user_id, document.object_key],
  );
}

export async function registerAdminRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies): Promise<void> {
  const { config, ApiError, requireAdminPermission } = dependencies;
  const guard = (permission: AdminPermission, stepUp = false) =>
    (request: FastifyRequest) => requireAdminPermission(request, permission, stepUp);

  app.addHook("onError", async (request, _reply, error) => {
    const routeAudit = request.routeOptions.config.adminAudit;
    const actor = request.authUser;
    if (!routeAudit || !actor || !isAdminRole(actor.adminRole)) return;
    const rawId = (request.params as Record<string, unknown> | null)?.id;
    const resourceId = typeof rawId === "string" && uuidRegex.test(rawId) ? rawId : null;
    const reason = safeReason(request);
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    try {
      await pool.query(
        `INSERT INTO admin_audit_events (
           id, actor_user_id, actor_admin_role, capability, action, resource_type,
           resource_id, subject_user_id, result, reason_code, reference
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(), actor.id, actor.adminRole, routeAudit.capability, routeAudit.action,
          routeAudit.resourceType, resourceId, routeAudit.subjectIsResource ? resourceId : null,
          statusCode >= 500 ? "FAILED" : "DENIED", reason.reasonCode ?? null, reason.reference ?? null,
        ],
      );
    } catch {
      request.log.warn({ errorCode: "ADMIN_AUDIT_WRITE_FAILED" }, "admin audit write failed");
    }
  });

  app.get(
    "/api/v1/admin/context",
    {
      preHandler: guard("dashboard.read"),
      schema: ok({
        type: "object",
        additionalProperties: false,
        required: ["user", "permissions"],
        properties: {
          user: {
            type: "object",
            additionalProperties: false,
            required: ["id", "adminRole"],
            properties: {
              id: { type: "string", pattern: UUID_PATTERN },
              adminRole: { type: "string", enum: [...adminRoles] },
            },
          },
          permissions: { type: "array", uniqueItems: true, items: { type: "string", enum: [...adminPermissions] } },
        },
      }),
    },
    async (request) => ({
      data: {
        user: { id: request.authUser!.id, adminRole: request.authUser!.adminRole },
        permissions: request.authUser!.permissions,
      },
    }),
  );

  app.get<{ Querystring: { range?: "TODAY" | "7D" | "30D" } }>(
    "/api/v1/admin/overview",
    {
      preHandler: guard("dashboard.read"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { range: { type: "string", enum: ["TODAY", "7D", "30D"] } },
        },
        ...ok({
          type: "object",
          additionalProperties: false,
          required: ["range", "metrics", "activity", "legalDocuments"],
          properties: {
            range: { type: "string", enum: ["TODAY", "7D", "30D"] },
            metrics: {
              type: "object",
              additionalProperties: false,
              required: ["totalUsers", "activeUsers", "totalDocuments", "pendingReview", "activeImports", "failedDocuments"],
              properties: Object.fromEntries([
                "totalUsers", "activeUsers", "totalDocuments", "pendingReview", "activeImports", "failedDocuments",
              ].map((key) => [key, { type: "integer", minimum: 0 }])),
            },
            activity: {
              type: "object",
              additionalProperties: false,
              required: ["newUsers", "documentsCreated", "completedDocuments", "failedJobs", "retryableJobs", "quarantinedDocuments", "pendingPrivacyOperations"],
              properties: Object.fromEntries([
                "newUsers", "documentsCreated", "completedDocuments", "failedJobs", "retryableJobs",
                "quarantinedDocuments", "pendingPrivacyOperations",
              ].map((key) => [key, { type: "integer", minimum: 0 }])),
            },
            legalDocuments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["documentType", "version", "effectiveAt", "requiresAcceptance", "approvedForProduction", "acknowledgementCount"],
                properties: {
                  documentType: { type: "string", enum: ["TERMS", "PRIVACY_NOTICE"] },
                  version: { type: "string" },
                  effectiveAt: { type: "string" },
                  requiresAcceptance: { type: "boolean" },
                  approvedForProduction: { type: "boolean" },
                  acknowledgementCount: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        }),
      },
    },
    async (request) => {
      const range = request.query.range ?? "7D";
      const [metrics, activity, legalDocuments] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT count(*)::integer FROM users) AS total_users,
             (SELECT count(*)::integer FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL) AS active_users,
             (SELECT count(*)::integer FROM documents WHERE deleted_at IS NULL) AS total_documents,
             (SELECT count(*)::integer FROM documents WHERE deleted_at IS NULL
               AND processing_status IN ('NEEDS_REVIEW', 'NEEDS_TYPE_CONFIRMATION')) AS pending_review,
             (SELECT count(*)::integer FROM import_batches WHERE status IN ('ACTIVE', 'PAUSED')) AS active_imports,
             (SELECT count(*)::integer FROM documents WHERE deleted_at IS NULL
               AND processing_status IN ('FAILED_PERMANENT', 'QUARANTINED', 'REJECTED_UNSUPPORTED')) AS failed_documents`,
        ),
        pool.query(
          `WITH threshold AS (
             SELECT CASE $1
               WHEN 'TODAY' THEN date_trunc('day', now())
               WHEN '30D' THEN now() - interval '30 days'
               ELSE now() - interval '7 days'
             END AS value
           )
           SELECT
             (SELECT count(*)::integer FROM users, threshold WHERE users.created_at >= threshold.value) AS new_users,
             (SELECT count(*)::integer FROM documents, threshold WHERE documents.created_at >= threshold.value) AS documents_created,
             (SELECT count(*)::integer FROM documents, threshold
               WHERE documents.processed_at >= threshold.value AND documents.processing_status = 'COMPLETED') AS completed_documents,
             (SELECT count(*)::integer FROM processing_jobs, threshold
               WHERE processing_jobs.updated_at >= threshold.value AND processing_jobs.state = 'FAILED') AS failed_jobs,
             (SELECT count(*)::integer FROM processing_jobs WHERE state = 'RETRYABLE') AS retryable_jobs,
             (SELECT count(*)::integer FROM documents, threshold
               WHERE documents.created_at >= threshold.value AND documents.security_status = 'QUARANTINED') AS quarantined_documents,
             (SELECT count(*)::integer FROM privacy_operations WHERE status IN ('PENDING', 'RUNNING', 'READY')) AS pending_privacy_operations`,
          [range],
        ),
        pool.query(
          `SELECT version.document_type, version.version, version.effective_at, version.requires_acceptance,
                  version.approved_for_production,
                  count(acknowledgement.user_id)::integer AS acknowledgement_count
             FROM legal_document_versions AS version
             LEFT JOIN legal_acknowledgements AS acknowledgement ON acknowledgement.document_version_id = version.id
            GROUP BY version.id
            ORDER BY version.document_type, version.effective_at DESC`,
        ),
      ]);
      const m = metrics.rows[0];
      const a = activity.rows[0];
      return {
        data: {
          range,
          metrics: {
            totalUsers: integer(m.total_users), activeUsers: integer(m.active_users),
            totalDocuments: integer(m.total_documents), pendingReview: integer(m.pending_review),
            activeImports: integer(m.active_imports), failedDocuments: integer(m.failed_documents),
          },
          activity: {
            newUsers: integer(a.new_users), documentsCreated: integer(a.documents_created),
            completedDocuments: integer(a.completed_documents), failedJobs: integer(a.failed_jobs),
            retryableJobs: integer(a.retryable_jobs), quarantinedDocuments: integer(a.quarantined_documents),
            pendingPrivacyOperations: integer(a.pending_privacy_operations),
          },
          legalDocuments: legalDocuments.rows.map((row) => ({
            documentType: String(row.document_type), version: String(row.version),
            effectiveAt: timestamp(row.effective_at)!, requiresAcceptance: Boolean(row.requires_acceptance),
            approvedForProduction: Boolean(row.approved_for_production),
            acknowledgementCount: integer(row.acknowledgement_count),
          })),
        },
      };
    },
  );

  app.get(
    "/api/v1/admin/roles",
    {
      preHandler: guard("roles.manage"),
      schema: ok({
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "permissions"],
          properties: {
            role: { type: "string", enum: [...adminRoles] },
            permissions: { type: "array", uniqueItems: true, items: { type: "string", enum: [...adminPermissions] } },
          },
        },
      }),
    },
    async () => ({ data: adminRoles.map((role) => ({ role, permissions: permissionsForAdminRole(role) })) }),
  );

  const userItemSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "maskedEmail", "status", "role", "adminRole", "mfaEnabled", "activeSessions", "documentCount", "createdAt", "lastLoginAt"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN },
      maskedEmail: { type: "string" },
      status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "BLOCKED", "DELETION_PENDING", "DELETED"] },
      role: { type: "string", enum: ["USER", "ADMIN"] },
      adminRole: { anyOf: [{ type: "string", enum: [...adminRoles] }, { type: "null" }] },
      mfaEnabled: { type: "boolean" },
      activeSessions: { type: "integer", minimum: 0 },
      documentCount: { type: "integer", minimum: 0 },
      createdAt: { type: "string" },
      lastLoginAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };

  app.get<{ Querystring: ListQuery & { status?: string; role?: "USER" | "ADMIN"; adminRole?: AdminRole } }>(
    "/api/v1/admin/users",
    {
      preHandler: guard("users.read_metadata"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties,
            search: { type: "string", minLength: 1, maxLength: 120 },
            status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "BLOCKED", "DELETION_PENDING", "DELETED"] },
            role: { type: "string", enum: ["USER", "ADMIN"] },
            adminRole: { type: "string", enum: [...adminRoles] },
            sort: { type: "string", enum: ["createdAt", "status", "documents", "lastLoginAt"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: { items: { type: "array", items: userItemSchema }, ...paginationFields },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const search = searchOf(request.query.search);
      const order = sortOf(request.query.sort, request.query.direction, {
        createdAt: "u.created_at", status: "u.status", documents: "document_count", lastLoginAt: "u.last_login_at",
      }, "createdAt");
      const sql = `SELECT u.id, u.email, u.status, u.role, u.admin_role, u.created_at, u.last_login_at,
                EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.status = 'ACTIVE') AS mfa_enabled,
                (SELECT count(*)::integer FROM sessions s
                  WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
                (SELECT count(*)::integer FROM documents d
                  WHERE d.user_id = u.id AND d.deleted_at IS NULL) AS document_count,
                count(*) OVER ()::integer AS total
           FROM users u
          WHERE ($1::text IS NULL OR u.id::text = $1)
            AND ($2::text IS NULL OR u.status = $2)
            AND ($3::text IS NULL OR u.role = $3)
            AND ($4::text IS NULL OR u.admin_role = $4)
          ORDER BY ${order} NULLS LAST, u.id
          LIMIT $5 OFFSET $6`;
      const values = [search, request.query.status ?? null, request.query.role ?? null, request.query.adminRole ?? null, pageSize, offset];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map((row) => ({
          id: String(row.id), maskedEmail: maskedEmail(row.email), status: String(row.status), role: String(row.role),
          adminRole: text(row.admin_role), mfaEnabled: Boolean(row.mfa_enabled), activeSessions: integer(row.active_sessions),
          documentCount: integer(row.document_count), createdAt: timestamp(row.created_at)!, lastLoginAt: timestamp(row.last_login_at),
        })), page, pageSize, total),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/admin/users/:id",
    {
      preHandler: guard("users.read_metadata"),
      schema: {
        params: idParamsSchema,
        ...ok({
          type: "object", additionalProperties: false,
          required: ["user", "employments", "recentDocuments"],
          properties: {
            user: userItemSchema,
            employments: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "employerId", "employerName", "status", "startDate", "endDate", "countryCode"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, employerId: { type: "string", pattern: UUID_PATTERN },
                  employerName: { type: "string" }, status: { type: "string", enum: ["ACTIVE", "ENDED"] },
                  startDate: { type: "string" }, endDate: { anyOf: [{ type: "string" }, { type: "null" }] },
                  countryCode: { type: "string" },
                },
              },
            },
            recentDocuments: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "documentType", "processingStatus", "securityStatus", "sizeBytes", "createdAt"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, documentType: { anyOf: [{ type: "string" }, { type: "null" }] },
                  processingStatus: { type: "string" }, securityStatus: { type: "string" },
                  sizeBytes: { type: "integer", minimum: 0 }, createdAt: { type: "string" },
                },
              },
            },
          },
        }),
      },
    },
    async (request) => {
      const canReadEmployments = hasAdminPermission(request.authUser!.adminRole, "employers.read_metadata");
      const [users, employments, documents] = await Promise.all([
        pool.query(
          `SELECT u.id, u.email, u.status, u.role, u.admin_role, u.created_at, u.last_login_at,
                  EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.status = 'ACTIVE') AS mfa_enabled,
                  (SELECT count(*)::integer FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
                  (SELECT count(*)::integer FROM documents d WHERE d.user_id = u.id AND d.deleted_at IS NULL) AS document_count
             FROM users u WHERE u.id = $1`,
          [request.params.id],
        ),
        pool.query(
          `SELECT employment.id, employment.employer_id, employer.name AS employer_name,
                  employment.status, employment.start_date, employment.end_date, employment.country_code
             FROM employments AS employment
             JOIN employers AS employer ON employer.id = employment.employer_id
            WHERE employment.user_id = $1 AND $2::boolean
            ORDER BY employment.start_date DESC, employment.id
            LIMIT 25`,
          [request.params.id, canReadEmployments],
        ),
        pool.query(
          `SELECT id, document_type, processing_status, security_status, size_bytes, created_at
             FROM documents WHERE user_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC, id LIMIT 25`,
          [request.params.id],
        ),
      ]);
      if (users.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = users.rows[0];
      return {
        data: {
          user: {
            id: String(row.id), maskedEmail: maskedEmail(row.email), status: String(row.status), role: String(row.role),
            adminRole: text(row.admin_role), mfaEnabled: Boolean(row.mfa_enabled), activeSessions: integer(row.active_sessions),
            documentCount: integer(row.document_count), createdAt: timestamp(row.created_at)!, lastLoginAt: timestamp(row.last_login_at),
          },
          employments: employments.rows.map((employment) => ({
            id: String(employment.id), employerId: String(employment.employer_id), employerName: String(employment.employer_name),
            status: String(employment.status), startDate: dateOnly(employment.start_date)!, endDate: dateOnly(employment.end_date),
            countryCode: String(employment.country_code),
          })),
          recentDocuments: documents.rows.map((document) => ({
            id: String(document.id), documentType: text(document.document_type), processingStatus: String(document.processing_status),
            securityStatus: String(document.security_status), sizeBytes: integer(document.size_bytes), createdAt: timestamp(document.created_at)!,
          })),
        },
      };
    },
  );

  app.get<{ Params: IdParams; Querystring: Reason }>(
    "/api/v1/admin/users/:id/contact",
    {
      config: { adminAudit: { capability: "users.read_contact", action: "USER_CONTACT_REVEALED", resourceType: "USER", subjectIsResource: true } },
      preHandler: guard("users.read_contact", true),
      schema: {
        params: idParamsSchema,
        querystring: { type: "object", additionalProperties: false, required: ["reasonCode", "reference"], properties: reasonProperties },
        ...ok({
          type: "object", additionalProperties: false, required: ["email"],
          properties: { email: { type: "string" } },
        }),
      },
    },
    async (request) => {
      if (request.params.id === request.authUser!.id) {
        throw new ApiError(409, "SELF_ACTION_NOT_ALLOWED", "Usá la configuración de tu propia cuenta.");
      }
      return withTransaction(async (client) => {
        const actorRole = await lockActor(client, request, "users.read_contact", ApiError);
        const result = await client.query(`SELECT email FROM users WHERE id = $1 FOR KEY SHARE`, [request.params.id]);
        if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        await audit(client, request, actorRole, "users.read_contact", "USER_CONTACT_READ", "USER", request.params.id, request.params.id, request.query);
        return { data: { email: String(result.rows[0].email) } };
      });
    },
  );

  app.post<{ Params: IdParams; Body: Reason & { status: "ACTIVE" | "SUSPENDED" | "BLOCKED" } }>(
    "/api/v1/admin/users/:id/status",
    {
      config: { adminAudit: { capability: "users.status.update", action: "USER_STATUS_UPDATED", resourceType: "USER", subjectIsResource: true } },
      preHandler: guard("users.status.update", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["status", "reasonCode", "reference"],
          properties: { status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "BLOCKED"] }, ...reasonProperties },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "status", "revokedSessions"],
          properties: { id: { type: "string", pattern: UUID_PATTERN }, status: { type: "string", enum: ["ACTIVE", "SUSPENDED", "BLOCKED"] }, revokedSessions: { type: "integer", minimum: 0 } },
        }),
      },
    },
    async (request) => {
      if (request.params.id === request.authUser!.id) throw new ApiError(409, "SELF_ACTION_NOT_ALLOWED", "No podés cambiar tu propio acceso.");
      return withTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(713, 12012)");
        const actorRole = await lockActor(client, request, "users.status.update", ApiError);
        const target = await client.query(`SELECT id, role, admin_role, status, deleted_at FROM users WHERE id = $1 FOR UPDATE`, [request.params.id]);
        if (target.rowCount !== 1 || target.rows[0].deleted_at !== null) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = target.rows[0];
        if (["DELETION_PENDING", "DELETED"].includes(row.status)) {
          throw new ApiError(409, "PRIVACY_OPERATION_IN_PROGRESS", "El estado está controlado por la operación de privacidad.");
        }
        if (row.status === request.body.status) throw new ApiError(409, "STATUS_UNCHANGED", "La cuenta ya tiene ese estado.");
        if (request.body.status !== "ACTIVE") await protectLastSuperAdmin(client, row, ApiError);
        await client.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [request.params.id, request.body.status]);
        const revoked = request.body.status === "ACTIVE" ? { rowCount: 0 } : await client.query(
          `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [request.params.id],
        );
        await audit(client, request, actorRole, "users.status.update", "USER_STATUS_UPDATED", "USER", request.params.id, request.params.id, request.body, {
          previousStatus: row.status, status: request.body.status, revokedSessions: revoked.rowCount ?? 0,
        });
        return { data: { id: request.params.id, status: request.body.status, revokedSessions: revoked.rowCount ?? 0 } };
      });
    },
  );

  app.post<{ Params: IdParams; Body: Reason & { cuit: string } }>(
    "/api/v1/admin/employers/:id/identifiers/cuit",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_IDENTIFIER_SET", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["cuit", "reasonCode", "reference"],
          properties: { cuit: { type: "string", minLength: 11, maxLength: 32 }, ...reasonProperties },
        },
        ...ok(employerIdentifierSchema),
      },
    },
    async (request) => {
      let identifier;
      try {
        identifier = protectArgentineCuit(request.body.cuit, config.employerIdentifierProtection);
      } catch (error) {
        if (error instanceof InvalidArgentineCuitError) {
          throw new ApiError(400, "INVALID_CUIT", "El CUIT no tiene un formato o dígito verificador válido.");
        }
        throw error;
      }
      const response = await withTransaction(async (client) => {
        const actorRole = await lockEmployerManagement(client, request, ApiError);
        const employer = await client.query(
          `SELECT id, country_code, status FROM employers WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        if (employer.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        if (employer.rows[0].country_code !== "AR") {
          throw new ApiError(409, "EMPLOYER_IDENTIFIER_UNSUPPORTED", "Este identificador sólo está habilitado para empleadores de Argentina.");
        }
        if (!["PENDING", "VERIFIED"].includes(employer.rows[0].status)) {
          throw new ApiError(409, "EMPLOYER_NOT_EDITABLE", "El empleador no admite cambios de identificador.");
        }
        const existing = await client.query(
          `SELECT id FROM employer_identifiers
            WHERE employer_id = $1 AND country_code = 'AR' AND identifier_type = 'CUIT'
            FOR UPDATE`,
          [request.params.id],
        );
        const conflict = await client.query(
          `SELECT 1 FROM employer_identifiers
            WHERE country_code = 'AR' AND identifier_type = 'CUIT'
              AND identifier_fingerprint = $1 AND employer_id <> $2
            LIMIT 1`,
          [identifier.fingerprint, request.params.id],
        );
        if (conflict.rowCount) {
          throw new ApiError(409, "EMPLOYER_IDENTIFIER_CONFLICT", "Ese CUIT ya pertenece a otro empleador; revisá o fusioná las identidades.");
        }
        const values = [
          request.params.id,
          Buffer.from(identifier.ciphertext),
          identifier.fingerprint,
          identifier.keyVersion,
          identifier.maskedSuffix,
          request.authUser!.id,
        ];
        const saved = existing.rowCount
          ? await client.query(
            `UPDATE employer_identifiers
                SET identifier_ciphertext = $2, identifier_fingerprint = $3,
                    identifier_key_version = $4, masked_suffix = $5,
                    created_source = 'ADMIN', created_by_user_id = $6
              WHERE employer_id = $1 AND country_code = 'AR' AND identifier_type = 'CUIT'
              RETURNING id, country_code, identifier_type, masked_suffix, created_source, created_at`,
            values,
          )
          : await client.query(
            `INSERT INTO employer_identifiers (
               id, employer_id, country_code, identifier_type, identifier_ciphertext,
               identifier_fingerprint, identifier_key_version, masked_suffix,
               created_source, created_by_user_id
             ) VALUES ($7, $1, 'AR', 'CUIT', $2, $3, $4, $5, 'ADMIN', $6)
             RETURNING id, country_code, identifier_type, masked_suffix, created_source, created_at`,
            [...values, randomUUID()],
          );
        await client.query("UPDATE employers SET updated_at = now() WHERE id = $1", [request.params.id]);
        const row = saved.rows[0];
        const operation = existing.rowCount ? "CORRECTED" : "ADDED";
        await audit(
          client,
          request,
          actorRole,
          "employers.manage",
          "EMPLOYER_IDENTIFIER_SET",
          "EMPLOYER",
          request.params.id,
          null,
          { reasonCode: request.body.reasonCode, reference: request.body.reference },
          { identifierId: row.id, countryCode: "AR", identifierType: "CUIT", operation },
        );
        return { data: {
          id: String(row.id), countryCode: String(row.country_code), identifierType: String(row.identifier_type),
          maskedValue: maskEmployerIdentifier(row.masked_suffix), createdSource: String(row.created_source),
          createdAt: timestamp(row.created_at)!,
        } };
      });
      request.log.info({
        event: "employer.identifier.set", employerId: request.params.id,
        countryCode: "AR", identifierType: "CUIT", result: "SUCCESS",
        actorUserId: request.authUser!.id, actorAdminRole: request.authUser!.adminRole,
      }, "employer identifier set");
      return response;
    },
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    "/api/v1/admin/users/:id/revoke-sessions",
    {
      config: { adminAudit: { capability: "sessions.revoke", action: "USER_SESSIONS_REVOKED", resourceType: "USER", subjectIsResource: true } },
      preHandler: guard("sessions.revoke", true),
      schema: {
        params: idParamsSchema, body: reasonBodySchema,
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "revokedSessions"],
          properties: { id: { type: "string", pattern: UUID_PATTERN }, revokedSessions: { type: "integer", minimum: 0 } },
        }),
      },
    },
    async (request) => {
      if (request.params.id === request.authUser!.id) throw new ApiError(409, "SELF_ACTION_NOT_ALLOWED", "Usá la revocación de tus propias sesiones.");
      return withTransaction(async (client) => {
        const actorRole = await lockActor(client, request, "sessions.revoke", ApiError);
        const target = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [request.params.id]);
        if (target.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const revoked = await client.query(
          `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [request.params.id],
        );
        await audit(client, request, actorRole, "sessions.revoke", "USER_SESSIONS_REVOKED", "USER", request.params.id, request.params.id, request.body, {
          revokedSessions: revoked.rowCount ?? 0,
        });
        return { data: { id: request.params.id, revokedSessions: revoked.rowCount ?? 0 } };
      });
    },
  );

  app.put<{ Params: IdParams; Body: Reason & { role: "USER" | "ADMIN"; adminRole?: AdminRole | null } }>(
    "/api/v1/admin/users/:id/role",
    {
      config: { adminAudit: { capability: "roles.manage", action: "USER_ROLE_UPDATED", resourceType: "USER", subjectIsResource: true } },
      preHandler: guard("roles.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["role", "reasonCode", "reference"],
          properties: {
            role: { type: "string", enum: ["USER", "ADMIN"] },
            adminRole: { anyOf: [{ type: "string", enum: [...adminRoles] }, { type: "null" }] },
            ...reasonProperties,
          },
          allOf: [
            { if: { properties: { role: { const: "ADMIN" } } }, then: { required: ["adminRole"] } },
            { if: { properties: { role: { const: "USER" } } }, then: { properties: { adminRole: { type: "null" } } } },
          ],
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "role", "adminRole", "revokedSessions"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }, role: { type: "string", enum: ["USER", "ADMIN"] },
            adminRole: { anyOf: [{ type: "string", enum: [...adminRoles] }, { type: "null" }] },
            revokedSessions: { type: "integer", minimum: 0 },
          },
        }),
      },
    },
    async (request) => {
      if (request.params.id === request.authUser!.id) throw new ApiError(409, "SELF_ACTION_NOT_ALLOWED", "No podés cambiar tu propio rol.");
      const nextAdminRole = request.body.role === "ADMIN" ? request.body.adminRole : null;
      if (request.body.role === "ADMIN" && !isAdminRole(nextAdminRole)) {
        throw new ApiError(400, "VALIDATION_ERROR", "El rol administrativo no es válido.");
      }
      return withTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(713, 12012)");
        const actorRole = await lockActor(client, request, "roles.manage", ApiError);
        const target = await client.query(
          `SELECT id, role, admin_role, status, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
          [request.params.id],
        );
        if (target.rowCount !== 1 || target.rows[0].deleted_at !== null) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const row = target.rows[0];
        if (["DELETION_PENDING", "DELETED"].includes(row.status)) throw new ApiError(409, "PRIVACY_OPERATION_IN_PROGRESS", "El rol no puede cambiar durante la baja.");
        const mfaEnabled = request.body.role === "ADMIN" && (await client.query(
          `SELECT EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE') AS enabled`,
          [request.params.id],
        )).rows[0].enabled;
        if (request.body.role === "ADMIN" && (row.status !== "ACTIVE" || !mfaEnabled)) {
          throw new ApiError(409, "ADMIN_MFA_REQUIRED", "La cuenta debe estar activa y tener MFA antes de recibir acceso administrativo.");
        }
        if (row.role === request.body.role && row.admin_role === nextAdminRole) throw new ApiError(409, "ROLE_UNCHANGED", "La cuenta ya tiene ese rol.");
        if (row.admin_role === "SUPER_ADMIN" && nextAdminRole !== "SUPER_ADMIN") await protectLastSuperAdmin(client, row, ApiError);
        await client.query(`UPDATE users SET role = $2, admin_role = $3, updated_at = now() WHERE id = $1`, [request.params.id, request.body.role, nextAdminRole]);
        const revoked = await client.query(
          `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [request.params.id],
        );
        await audit(client, request, actorRole, "roles.manage", "USER_ROLE_UPDATED", "USER", request.params.id, request.params.id, request.body, {
          previousRole: row.role, previousAdminRole: row.admin_role, role: request.body.role,
          adminRole: nextAdminRole, revokedSessions: revoked.rowCount ?? 0,
        });
        return { data: { id: request.params.id, role: request.body.role, adminRole: nextAdminRole, revokedSessions: revoked.rowCount ?? 0 } };
      });
    },
  );

  const documentItemSchema = {
    type: "object", additionalProperties: false,
    required: [
      "id", "userId", "maskedEmail", "documentType", "processingStatus", "securityStatus",
      "classificationStatus", "sizeBytes", "pageCount", "retentionPolicy", "originalAvailable",
      "createdAt", "processedAt", "activeRunStatus", "activeParserVersion", "reprocessAvailable", "issueCount",
    ],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, userId: { type: "string", pattern: UUID_PATTERN },
      maskedEmail: { type: "string" }, documentType: { anyOf: [{ type: "string" }, { type: "null" }] },
      processingStatus: { type: "string" }, securityStatus: { type: "string" }, classificationStatus: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 }, pageCount: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      retentionPolicy: { type: "string", enum: ["KEEP_ORIGINAL", "DELETE_AFTER_PROCESSING"] }, originalAvailable: { type: "boolean" },
      createdAt: { type: "string" }, processedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
      activeRunStatus: { anyOf: [{ type: "string" }, { type: "null" }] },
      activeParserVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
      reprocessAvailable: { type: "boolean" }, issueCount: { type: "integer", minimum: 0 },
    },
  };

  type DocumentQuery = ListQuery & {
    processingStatus?: string;
    securityStatus?: string;
    userId?: string;
    from?: string;
    to?: string;
    reprocessAvailable?: boolean;
    issueCode?: string;
    parserVersion?: string;
    promotionOutcome?: string;
    runStatus?: string;
  };

  app.get<{ Querystring: DocumentQuery }>(
    "/api/v1/admin/documents",
    {
      preHandler: guard("documents.read_metadata"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties,
            search: { type: "string", minLength: 1, maxLength: 120 },
            processingStatus: {
              type: "string", enum: [
                "CREATED", "UPLOADED", "SECURITY_VALIDATION", "DOCUMENT_CLASSIFICATION", "NEEDS_TYPE_CONFIRMATION",
                "TEXT_EXTRACTION", "OCR", "PARSING", "NORMALIZATION", "VALIDATION", "COMPLETED", "NEEDS_REVIEW",
                "REJECTED_UNSUPPORTED", "QUARANTINED", "FAILED_RETRYABLE", "RETRY_SCHEDULED", "FAILED_PERMANENT",
                "CANCELLED", "DELETED",
              ],
            },
            securityStatus: { type: "string", enum: ["PENDING", "CLEAN", "QUARANTINED", "REJECTED", "ERROR"] },
            userId: { type: "string", pattern: UUID_PATTERN },
            from: { type: "string", format: "date" }, to: { type: "string", format: "date" },
            reprocessAvailable: { type: "boolean" },
            issueCode: { type: "string", pattern: "^[A-Z0-9_]{1,96}$" },
            parserVersion: { type: "string", minLength: 1, maxLength: 80 },
            promotionOutcome: {
              type: "string",
              enum: ["NOT_EVALUATED", "PROMOTED", "UNCHANGED", "REVIEW_REQUIRED", "REJECTED_REGRESSION"],
            },
            runStatus: {
              type: "string",
              enum: ["RUNNING", "PROCESSING", "COMPLETED", "COMPLETED_WITH_WARNINGS", "REVIEW_REQUIRED", "FAILED", "CANCELLED"],
            },
            sort: { type: "string", enum: ["createdAt", "status", "sizeBytes", "processedAt"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: { items: { type: "array", items: documentItemSchema }, ...paginationFields },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, {
        createdAt: "d.created_at", status: "d.processing_status", sizeBytes: "d.size_bytes", processedAt: "d.processed_at",
      }, "createdAt");
      const candidatePredicate = reprocessingCandidateExistsSql("d", "$12", "$13", "$14");
      const sql = `SELECT d.id, d.user_id, u.email, d.document_type, d.processing_status, d.security_status,
                d.classification_status, d.size_bytes, d.page_count, d.retention_policy,
                d.original_deleted_at, d.created_at, d.processed_at,
                active_run.status AS active_run_status, active_run.parser_version AS active_parser_version,
                (${candidatePredicate}) AS reprocess_available,
                (SELECT count(*)::integer FROM extraction_run_issues issue
                  WHERE issue.user_id = d.user_id AND issue.document_id = d.id
                    AND issue.extraction_run_id = d.active_extraction_run_id) AS issue_count,
                count(*) OVER ()::integer AS total
           FROM documents d
           JOIN users u ON u.id = d.user_id
           LEFT JOIN extraction_runs active_run
             ON active_run.id = d.active_extraction_run_id
            AND active_run.user_id = d.user_id AND active_run.document_id = d.id
          WHERE d.deleted_at IS NULL
            AND ($1::text IS NULL OR d.id::text = $1 OR d.user_id::text = $1)
            AND ($2::text IS NULL OR d.processing_status = $2)
            AND ($3::text IS NULL OR d.security_status = $3)
            AND ($4::uuid IS NULL OR d.user_id = $4)
            AND ($5::date IS NULL OR d.created_at >= $5::date)
            AND ($6::date IS NULL OR d.created_at < $6::date + interval '1 day')
            AND ($7::boolean IS NULL OR (${candidatePredicate}) = $7)
            AND ($8::text IS NULL OR EXISTS (
              SELECT 1 FROM extraction_run_issues issue
               WHERE issue.user_id = d.user_id AND issue.document_id = d.id
                 AND issue.extraction_run_id = d.active_extraction_run_id AND issue.code = $8
            ))
            AND (($9::text IS NULL AND $10::text IS NULL AND $11::text IS NULL) OR EXISTS (
              SELECT 1 FROM extraction_runs filtered_run
               WHERE filtered_run.user_id = d.user_id AND filtered_run.document_id = d.id
                 AND ($9::text IS NULL OR filtered_run.parser_version = $9)
                 AND ($10::text IS NULL OR filtered_run.status = $10)
                 AND ($11::text IS NULL OR filtered_run.promotion_outcome = $11)
            ))
          ORDER BY ${order} NULLS LAST, d.id
          LIMIT $15 OFFSET $16`;
      const values = [
          searchOf(request.query.search), request.query.processingStatus ?? null, request.query.securityStatus ?? null,
          request.query.userId ?? null, request.query.from ?? null, request.query.to ?? null,
          request.query.reprocessAvailable ?? null, request.query.issueCode ?? null,
          request.query.parserVersion ?? null, request.query.runStatus ?? null,
          request.query.promotionOutcome ?? null,
          JSON.stringify(parserFixCatalog), processingPipelineVersions.parser, currentPipelineFingerprint,
          pageSize, offset,
        ];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map((row) => ({
          id: String(row.id), userId: String(row.user_id), maskedEmail: maskedEmail(row.email), documentType: text(row.document_type),
          processingStatus: String(row.processing_status), securityStatus: String(row.security_status), classificationStatus: String(row.classification_status),
          sizeBytes: integer(row.size_bytes), pageCount: row.page_count === null ? null : integer(row.page_count), retentionPolicy: String(row.retention_policy),
          originalAvailable: row.original_deleted_at === null, createdAt: timestamp(row.created_at)!, processedAt: timestamp(row.processed_at),
          activeRunStatus: text(row.active_run_status), activeParserVersion: text(row.active_parser_version),
          reprocessAvailable: row.reprocess_available === true, issueCount: integer(row.issue_count),
        })), page, pageSize, total),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/admin/documents/:id",
    {
      preHandler: guard("documents.read_metadata"),
      schema: {
        params: idParamsSchema,
        ...ok({
          type: "object", additionalProperties: false,
          required: ["document", "employmentId", "importBatchId", "activeRunId", "recentJobs", "processingRuns", "issues"],
          properties: {
            document: documentItemSchema,
            employmentId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
            importBatchId: { type: "string", pattern: UUID_PATTERN },
            activeRunId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
            recentJobs: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "stage", "processingVersion", "state", "attempt", "maxAttempts", "errorCode", "updatedAt"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, stage: { type: "string" }, processingVersion: { type: "integer", minimum: 1 },
                  state: { type: "string" }, attempt: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1 },
                  errorCode: { anyOf: [{ type: "string" }, { type: "null" }] }, updatedAt: { type: "string" },
                },
              },
            },
            processingRuns: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: [
                  "id", "processingVersion", "status", "triggerKind", "parserVersion",
                  "resultSchemaVersion", "pipelineFingerprint", "promotionOutcome",
                  "promotedAt", "startedAt", "finishedAt", "active",
                ],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, processingVersion: { type: "integer", minimum: 1 },
                  status: { type: "string" }, triggerKind: { type: "string" }, parserVersion: { type: "string" },
                  resultSchemaVersion: { anyOf: [{ type: "string" }, { type: "null" }] },
                  pipelineFingerprint: { anyOf: [{ type: "string" }, { type: "null" }] },
                  promotionOutcome: { type: "string" },
                  promotedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
                  startedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
                  finishedAt: { anyOf: [{ type: "string" }, { type: "null" }] }, active: { type: "boolean" },
                },
              },
            },
            issues: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "runId", "code", "severity", "recoverable", "affectedFieldPath", "createdAt"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, runId: { type: "string", pattern: UUID_PATTERN },
                  code: { type: "string" }, severity: { type: "string" }, recoverable: { type: "boolean" },
                  affectedFieldPath: { anyOf: [{ type: "string" }, { type: "null" }] }, createdAt: { type: "string" },
                },
              },
            },
          },
        }),
      },
    },
    async (request) => {
      const canReadProcessing = hasAdminPermission(request.authUser!.adminRole, "processing.read");
      const candidatePredicate = reprocessingCandidateExistsSql("d", "$2", "$3", "$4");
      const [documents, jobs, runs, issues] = await Promise.all([
        pool.query(
          `SELECT d.id, d.user_id, u.email, d.document_type, d.processing_status, d.security_status,
                  d.classification_status, d.size_bytes, d.page_count, d.retention_policy, d.original_deleted_at,
                  d.created_at, d.processed_at, d.employment_id, d.import_batch_id,
                  d.active_extraction_run_id, active_run.status AS active_run_status,
                  active_run.parser_version AS active_parser_version,
                  (${candidatePredicate}) AS reprocess_available,
                  (SELECT count(*)::integer FROM extraction_run_issues issue
                    WHERE issue.user_id = d.user_id AND issue.document_id = d.id
                      AND issue.extraction_run_id = d.active_extraction_run_id) AS issue_count
             FROM documents d JOIN users u ON u.id = d.user_id
             LEFT JOIN extraction_runs active_run
               ON active_run.id = d.active_extraction_run_id
              AND active_run.user_id = d.user_id AND active_run.document_id = d.id
            WHERE d.id = $1 AND d.deleted_at IS NULL`,
          [request.params.id, JSON.stringify(parserFixCatalog), processingPipelineVersions.parser, currentPipelineFingerprint],
        ),
        pool.query(
          `SELECT id, stage, processing_version, state, attempt, max_attempts, error_code, updated_at
             FROM processing_jobs WHERE document_id = $1 AND $2::boolean
            ORDER BY processing_version DESC, created_at DESC LIMIT 25`,
          [request.params.id, canReadProcessing],
        ),
        pool.query(
          `SELECT run.id, run.processing_version, run.status, run.trigger_kind,
                  run.parser_version, run.result_schema_version, run.pipeline_fingerprint,
                  run.promotion_outcome, run.promoted_at, run.started_at, run.finished_at,
                  (run.id = document.active_extraction_run_id) AS active
             FROM documents document
             JOIN extraction_runs run
               ON run.user_id = document.user_id AND run.document_id = document.id
            WHERE document.id = $1 AND document.deleted_at IS NULL AND $2::boolean
            ORDER BY run.processing_version DESC, run.id DESC LIMIT 25`,
          [request.params.id, canReadProcessing],
        ),
        pool.query(
          `SELECT issue.id, issue.extraction_run_id, issue.code, issue.severity,
                  issue.recoverable, issue.affected_field_path, issue.created_at
             FROM documents document
             JOIN extraction_run_issues issue
               ON issue.user_id = document.user_id AND issue.document_id = document.id
            WHERE document.id = $1 AND document.deleted_at IS NULL AND $2::boolean
            ORDER BY issue.created_at DESC, issue.id DESC LIMIT 100`,
          [request.params.id, canReadProcessing],
        ),
      ]);
      if (documents.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = documents.rows[0];
      return {
        data: {
          document: {
            id: String(row.id), userId: String(row.user_id), maskedEmail: maskedEmail(row.email), documentType: text(row.document_type),
            processingStatus: String(row.processing_status), securityStatus: String(row.security_status), classificationStatus: String(row.classification_status),
            sizeBytes: integer(row.size_bytes), pageCount: row.page_count === null ? null : integer(row.page_count), retentionPolicy: String(row.retention_policy),
            originalAvailable: row.original_deleted_at === null, createdAt: timestamp(row.created_at)!, processedAt: timestamp(row.processed_at),
            activeRunStatus: text(row.active_run_status), activeParserVersion: text(row.active_parser_version),
            reprocessAvailable: row.reprocess_available === true, issueCount: integer(row.issue_count),
          },
          employmentId: text(row.employment_id), importBatchId: String(row.import_batch_id),
          activeRunId: text(row.active_extraction_run_id),
          recentJobs: jobs.rows.map((job) => ({
            id: String(job.id), stage: String(job.stage), processingVersion: integer(job.processing_version), state: String(job.state),
            attempt: integer(job.attempt), maxAttempts: integer(job.max_attempts), errorCode: text(job.error_code), updatedAt: timestamp(job.updated_at)!,
          })),
          processingRuns: runs.rows.map((run) => {
            const view = processingRunView(run);
            return {
              id: view.id, processingVersion: view.processingVersion, status: view.status,
              triggerKind: view.triggerKind, parserVersion: view.parserVersion,
              resultSchemaVersion: view.resultSchemaVersion, pipelineFingerprint: view.pipelineFingerprint,
              promotionOutcome: view.promotionOutcome, promotedAt: view.promotedAt,
              startedAt: view.startedAt, finishedAt: view.finishedAt, active: view.active,
            };
          }),
          issues: issues.rows.map((issue) => ({
            id: String(issue.id), runId: String(issue.extraction_run_id), code: String(issue.code),
            severity: String(issue.severity), recoverable: issue.recoverable === true,
            affectedFieldPath: text(issue.affected_field_path), createdAt: timestamp(issue.created_at)!,
          })),
        },
      };
    },
  );

  app.post<{ Params: IdParams; Body: AdminReprocessBody }>(
    "/api/v1/admin/documents/:id/reprocess",
    {
      config: { adminAudit: { capability: "processing.reprocess", action: "DOCUMENT_REPROCESS_REQUESTED", resourceType: "DOCUMENT" } },
      preHandler: guard("processing.reprocess", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false,
          required: ["reasonCode", "reference"],
          properties: { ...reasonProperties, retry: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const requestedKey = request.headers["idempotency-key"];
      if (typeof requestedKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestedKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const result = await withTransaction(async (client) => {
        const actorRole = await lockActor(client, request, "processing.reprocess", ApiError);
        const owner = await client.query(
          "SELECT user_id FROM documents WHERE id = $1 AND deleted_at IS NULL",
          [request.params.id],
        );
        if (!owner.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const queued = await enqueueReprocessing(client, {
          userId: String(owner.rows[0].user_id),
          requestedByUserId: request.authUser!.id,
          documentId: request.params.id,
          requestedKey,
          triggerKind: "ADMIN_REPROCESS",
          allowRetry: request.body.retry === true,
        }, ApiError);
        await audit(
          client, request, actorRole, "processing.reprocess", "DOCUMENT_REPROCESS_REQUESTED",
          "DOCUMENT", request.params.id, String(owner.rows[0].user_id), request.body,
          { processingVersion: queued.job.processingVersion, activeRunId: queued.activeRunId },
        );
        return queued;
      });
      const { created, ...data } = result;
      return reply.code(created ? 201 : 200).send({ data });
    },
  );

  app.post<{ Body: AdminReprocessingBatchBody }>(
    "/api/v1/admin/reprocessing-batches",
    {
      config: { adminAudit: { capability: "processing.reprocess", action: "REPROCESSING_BATCH_REQUESTED", resourceType: "REPROCESSING_BATCH" } },
      preHandler: guard("processing.reprocess", true),
      schema: {
        body: {
          type: "object", additionalProperties: false,
          required: ["userId", "reasonCode", "reference"],
          properties: {
            ...reasonProperties,
            userId: { type: "string", pattern: UUID_PATTERN },
            documentIds: {
              type: "array", minItems: 1, maxItems: 100, uniqueItems: true,
              items: { type: "string", pattern: UUID_PATTERN },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const requestedKey = request.headers["idempotency-key"];
      if (typeof requestedKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(requestedKey)) {
        throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Falta una clave de idempotencia válida.");
      }
      const result = await withTransaction(async (client) => {
        const actorRole = await lockActor(client, request, "processing.reprocess", ApiError);
        const target = await client.query(
          "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE",
          [request.body.userId],
        );
        if (!target.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        const idempotencyKey = `admin-reprocess-batch:${request.authUser!.id}:${createHash("sha256").update(requestedKey).digest("hex")}`;
        const existing = await client.query(
          "SELECT id FROM reprocessing_batches WHERE user_id = $1 AND idempotency_key = $2",
          [request.body.userId, idempotencyKey],
        );
        if (existing.rowCount) {
          return {
            created: false,
            batch: await loadReprocessingBatch(client, request.body.userId, String(existing.rows[0].id)),
          };
        }
        const activeBatch = await client.query(
          `SELECT id FROM reprocessing_batches
            WHERE user_id = $1 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
          [request.body.userId],
        );
        if (activeBatch.rowCount) {
          throw new ApiError(409, "REPROCESSING_BATCH_ALREADY_ACTIVE", "La cuenta ya tiene un lote de reprocesamiento activo.");
        }
        const foundCandidates = await findReprocessingCandidates(client, request.body.userId, {
          ...(request.body.documentIds ? { documentIds: request.body.documentIds } : {}),
          limit: request.body.documentIds?.length ?? 100,
        });
        if (request.body.documentIds && foundCandidates.length !== request.body.documentIds.length) {
          throw new ApiError(409, "BATCH_CONTAINS_UNAVAILABLE_DOCUMENT", "Uno o más documentos no están disponibles para reprocesar.");
        }
        const candidates = foundCandidates.filter((candidate) => !candidate.inProgress);
        if (!candidates.length) throw new ApiError(409, "NO_REPROCESSING_CANDIDATES", "No hay documentos reprocesables.");
        const batchId = randomUUID();
        await client.query(
          `INSERT INTO reprocessing_batches (
             id, user_id, requested_by_user_id, trigger_kind, idempotency_key
           ) VALUES ($1, $2, $3, 'ADMIN_REPROCESS', $4)`,
          [batchId, request.body.userId, request.authUser!.id, idempotencyKey],
        );
        await enqueueReprocessingBatch(client, {
          userId: request.body.userId,
          requestedByUserId: request.authUser!.id,
          documentIds: candidates.map((candidate) => candidate.documentId),
          triggerKind: "ADMIN_REPROCESS",
          batchId,
        }, ApiError);
        await audit(
          client, request, actorRole, "processing.reprocess", "REPROCESSING_BATCH_REQUESTED",
          "REPROCESSING_BATCH", batchId, request.body.userId, request.body,
          { documentCount: candidates.length },
        );
        return { created: true, batch: await loadReprocessingBatch(client, request.body.userId, batchId) };
      });
      return reply.code(result.created ? 201 : 200).send({ data: result.batch });
    },
  );

  app.get<{ Querystring: ActiveReprocessingBatchQuery }>(
    "/api/v1/admin/reprocessing-batches/active",
    {
      preHandler: guard("processing.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false, required: ["userId"],
          properties: { userId: { type: "string", pattern: UUID_PATTERN } },
        },
        ...ok({ anyOf: [reprocessingBatchSchema, { type: "null" }] }),
      },
    },
    async (request) => {
      const target = await pool.query(
        "SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL",
        [request.query.userId],
      );
      if (!target.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const active = await pool.query(
        `SELECT id FROM reprocessing_batches
          WHERE user_id = $1 AND status IN ('PENDING', 'RUNNING')
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [request.query.userId],
      );
      return {
        data: active.rowCount
          ? await loadReprocessingBatch(pool, request.query.userId, String(active.rows[0].id))
          : null,
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/admin/reprocessing-batches/:id",
    {
      preHandler: guard("processing.read"),
      schema: {
        params: idParamsSchema,
        ...ok(reprocessingBatchSchema),
      },
    },
    async (request) => {
      const owner = await pool.query("SELECT user_id FROM reprocessing_batches WHERE id = $1", [request.params.id]);
      if (!owner.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const batch = await loadReprocessingBatch(pool, String(owner.rows[0].user_id), request.params.id);
      if (!batch) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: batch };
    },
  );

  app.post<{ Params: ProcessingRunParams; Body: Reason }>(
    "/api/v1/admin/documents/:id/processing-runs/:runId/rollback",
    {
      config: { adminAudit: { capability: "processing.rollback", action: "PROCESSING_RUN_ROLLED_BACK", resourceType: "EXTRACTION_RUN" } },
      preHandler: guard("processing.rollback", true),
      schema: {
        params: {
          type: "object", additionalProperties: false, required: ["id", "runId"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN },
            runId: { type: "string", pattern: UUID_PATTERN },
          },
        },
        body: reasonBodySchema,
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockActor(client, request, "processing.rollback", ApiError);
      const document = await client.query(
        `SELECT user_id, active_extraction_run_id FROM documents
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [request.params.id],
      );
      if (!document.rowCount) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const ownerId = String(document.rows[0].user_id);
      const activeRunId = text(document.rows[0].active_extraction_run_id);
      if (activeRunId === request.params.runId) {
        throw new ApiError(409, "RUN_ALREADY_ACTIVE", "Ese análisis ya está activo.");
      }
      const target = await client.query(
        `SELECT id FROM extraction_runs
          WHERE id = $1 AND document_id = $2 AND user_id = $3
            AND promotion_outcome = 'PROMOTED' AND promoted_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM payroll_settlements settlement
               WHERE settlement.user_id = extraction_runs.user_id
                 AND settlement.document_id = extraction_runs.document_id
                 AND settlement.extraction_run_id = extraction_runs.id
            )
          FOR UPDATE`,
        [request.params.runId, request.params.id, ownerId],
      );
      if (!target.rowCount) {
        throw new ApiError(409, "RUN_NOT_ROLLBACK_TARGET", "Sólo se puede volver a un análisis que ya estuvo activo.");
      }
      const promoted = await promoteProcessingRun(client, {
        userId: ownerId,
        documentId: request.params.id,
        runId: request.params.runId,
        expectedActiveRunId: activeRunId,
        decision: "PROMOTE",
      }, ApiError);
      await audit(
        client, request, actorRole, "processing.rollback", "PROCESSING_RUN_ROLLED_BACK",
        "EXTRACTION_RUN", request.params.runId, ownerId, request.body,
        {
          documentId: request.params.id,
          employmentAssociationRemoved: promoted.employmentAssociationRemoved ?? false,
          previousActiveRunId: activeRunId,
        },
      );
      return { data: { documentId: request.params.id, previousActiveRunId: activeRunId, activeRunId: promoted.activeRunId } };
    }),
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    "/api/v1/admin/documents/:id/quarantine",
    {
      config: { adminAudit: { capability: "documents.quarantine", action: "DOCUMENT_QUARANTINED", resourceType: "DOCUMENT" } },
      preHandler: guard("documents.quarantine", true),
      schema: {
        params: idParamsSchema, body: reasonBodySchema,
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "securityStatus", "processingStatus", "cancelledJobs"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }, securityStatus: { type: "string", const: "QUARANTINED" },
            processingStatus: { type: "string", const: "QUARANTINED" }, cancelledJobs: { type: "integer", minimum: 0 },
          },
        }),
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockActor(client, request, "documents.quarantine", ApiError);
      const owner = await client.query(
        `SELECT user_id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      );
      if (owner.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [owner.rows[0].user_id]);
      const lockedJobs = await client.query(
        `SELECT state, execution_owner FROM processing_jobs WHERE document_id = $1 ORDER BY id FOR UPDATE`,
        [request.params.id],
      );
      const found = await client.query(
        `SELECT d.id, d.user_id, d.import_batch_id, d.import_batch_item_id, d.processing_status,
                d.security_status, d.retention_policy, d.original_deleted_at, d.object_key,
                upload.object_key AS incoming_object_key, upload.expires_at AS upload_expires_at
           FROM documents d
           JOIN upload_sessions upload ON upload.id = d.upload_session_id AND upload.user_id = d.user_id
          WHERE d.id = $1 AND d.deleted_at IS NULL
          FOR UPDATE OF d, upload`,
        [request.params.id],
      );
      if (found.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const document = found.rows[0];
      if (document.security_status === "QUARANTINED" || document.processing_status === "QUARANTINED") {
        throw new ApiError(409, "DOCUMENT_ALREADY_QUARANTINED", "El documento ya está en cuarentena.");
      }
      if (lockedJobs.rows.some((job) => job.state === "RUNNING" || job.execution_owner !== null)) {
        throw new ApiError(409, "DOCUMENT_STILL_PROCESSING", "Esperá a que termine la ejecución activa.");
      }
      const cancelled = await client.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
                execution_owner = NULL, error_code = 'ADMIN_QUARANTINE', updated_at = now()
          WHERE document_id = $1 AND state IN ('PENDING', 'PUBLISHED', 'RETRYABLE')`,
        [request.params.id],
      );
      await client.query(
        `UPDATE documents
            SET security_status = 'QUARANTINED', processing_status = 'QUARANTINED', processed_at = now()
          WHERE id = $1`,
        [request.params.id],
      );
      await client.query(
        `UPDATE import_batch_items SET status = 'REJECTED', error_code = 'ADMIN_QUARANTINE', updated_at = now()
          WHERE id = $1 AND user_id = $2`,
        [document.import_batch_item_id, document.user_id],
      );
      await scheduleOriginalDeletion(client, document);
      await finalizeBatchIfTerminal(client, String(document.import_batch_id), String(document.user_id));
      await audit(client, request, actorRole, "documents.quarantine", "DOCUMENT_QUARANTINED", "DOCUMENT", request.params.id, String(document.user_id), request.body, {
        previousSecurityStatus: document.security_status, previousProcessingStatus: document.processing_status,
        cancelledJobs: cancelled.rowCount ?? 0,
      });
      return { data: { id: request.params.id, securityStatus: "QUARANTINED", processingStatus: "QUARANTINED", cancelledJobs: cancelled.rowCount ?? 0 } };
    }),
  );

  const jobItemSchema = {
    type: "object", additionalProperties: false,
    required: [
      "id", "userId", "documentId", "stage", "processingVersion", "state", "attempt", "maxAttempts",
      "availableAt", "startedAt", "completedAt", "errorCode", "createdAt", "updatedAt",
    ],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, userId: { type: "string", pattern: UUID_PATTERN },
      documentId: { type: "string", pattern: UUID_PATTERN }, stage: { type: "string" },
      processingVersion: { type: "integer", minimum: 1 }, state: { type: "string" },
      attempt: { type: "integer", minimum: 0 }, maxAttempts: { type: "integer", minimum: 1 },
      availableAt: { type: "string" }, startedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
      completedAt: { anyOf: [{ type: "string" }, { type: "null" }] }, errorCode: { anyOf: [{ type: "string" }, { type: "null" }] },
      createdAt: { type: "string" }, updatedAt: { type: "string" },
    },
  };

  type JobQuery = ListQuery & { state?: string; stage?: string; userId?: string; documentId?: string };
  app.get<{ Querystring: JobQuery }>(
    "/api/v1/admin/jobs",
    {
      preHandler: guard("processing.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties,
            search: { type: "string", minLength: 1, maxLength: 120 },
            state: { type: "string", enum: ["PENDING", "PUBLISHED", "RUNNING", "RETRYABLE", "COMPLETED", "FAILED", "CANCELLED"] },
            stage: { type: "string", enum: ["SECURITY_VALIDATION", "DOCUMENT_CLASSIFICATION", "TEXT_EXTRACTION", "OCR", "PARSING", "NORMALIZATION", "VALIDATION", "CLEANUP", "DOCUMENT_PIPELINE_V2"] },
            userId: { type: "string", pattern: UUID_PATTERN }, documentId: { type: "string", pattern: UUID_PATTERN },
            sort: { type: "string", enum: ["createdAt", "updatedAt", "availableAt", "state", "attempt"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: { items: { type: "array", items: jobItemSchema }, ...paginationFields },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, {
        createdAt: "job.created_at", updatedAt: "job.updated_at", availableAt: "job.available_at", state: "job.state", attempt: "job.attempt",
      }, "createdAt");
      const sql = `SELECT job.id, job.user_id, job.document_id, job.stage, job.processing_version, job.state,
                job.attempt, job.max_attempts, job.available_at, job.started_at, job.completed_at,
                job.error_code, job.created_at, job.updated_at, count(*) OVER ()::integer AS total
           FROM processing_jobs job
          WHERE ($1::text IS NULL OR job.id::text = $1 OR job.document_id::text = $1 OR job.user_id::text = $1)
            AND ($2::text IS NULL OR job.state = $2)
            AND ($3::text IS NULL OR job.stage = $3)
            AND ($4::uuid IS NULL OR job.user_id = $4)
            AND ($5::uuid IS NULL OR job.document_id = $5)
          ORDER BY ${order} NULLS LAST, job.id
          LIMIT $6 OFFSET $7`;
      const values = [searchOf(request.query.search), request.query.state ?? null, request.query.stage ?? null,
        request.query.userId ?? null, request.query.documentId ?? null, pageSize, offset];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map((row) => ({
          id: String(row.id), userId: String(row.user_id), documentId: String(row.document_id), stage: String(row.stage),
          processingVersion: integer(row.processing_version), state: String(row.state), attempt: integer(row.attempt), maxAttempts: integer(row.max_attempts),
          availableAt: timestamp(row.available_at)!, startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at),
          errorCode: text(row.error_code), createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!,
        })), page, pageSize, total),
      };
    },
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    "/api/v1/admin/jobs/:id/retry",
    {
      config: { adminAudit: { capability: "processing.retry", action: "PROCESSING_JOB_RETRY_ADVANCED", resourceType: "PROCESSING_JOB" } },
      preHandler: guard("processing.retry", true),
      schema: {
        params: idParamsSchema, body: reasonBodySchema,
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "state", "availableAt"],
          properties: { id: { type: "string", pattern: UUID_PATTERN }, state: { type: "string", const: "RETRYABLE" }, availableAt: { type: "string" } },
        }),
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockActor(client, request, "processing.retry", ApiError);
      const result = await client.query(
        `SELECT job.id, job.user_id, job.document_id, job.state, job.attempt, job.max_attempts,
                job.execution_owner, document.import_batch_id, document.import_batch_item_id,
                document.original_deleted_at, app_user.status AS user_status
           FROM processing_jobs job
           JOIN documents document ON document.id = job.document_id AND document.user_id = job.user_id
           JOIN users app_user ON app_user.id = job.user_id
          WHERE job.id = $1 AND document.deleted_at IS NULL
          FOR UPDATE OF job, document, app_user`,
        [request.params.id],
      );
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const job = result.rows[0];
      if (job.state !== "RETRYABLE" || job.execution_owner !== null) {
        throw new ApiError(409, "JOB_NOT_RETRYABLE", "Sólo se puede adelantar un job reintentable sin ejecución activa.");
      }
      if (integer(job.attempt) >= integer(job.max_attempts)) {
        throw new ApiError(409, "JOB_ATTEMPTS_EXHAUSTED", "El job agotó sus intentos permitidos.");
      }
      if (job.user_status !== "ACTIVE") {
        throw new ApiError(409, "USER_NOT_ACTIVE", "La cuenta debe estar activa para reanudar el procesamiento.");
      }
      if (job.original_deleted_at !== null) {
        throw new ApiError(409, "ORIGINAL_NOT_AVAILABLE", "El original ya no está disponible para procesarlo.");
      }
      const activeBatches = await client.query(
        `SELECT count(*)::integer AS count FROM import_batches
          WHERE user_id = $1 AND id <> $2 AND status IN ('ACTIVE', 'PAUSED')`,
        [job.user_id, job.import_batch_id],
      );
      if (integer(activeBatches.rows[0].count) >= config.maxActiveImportsPerUser) {
        throw new ApiError(409, "TOO_MANY_ACTIVE_IMPORTS", "La cuenta ya tiene el máximo de importaciones activas.");
      }
      const updated = await client.query(
        `UPDATE processing_jobs SET available_at = now(), error_code = NULL, updated_at = now()
          WHERE id = $1 RETURNING available_at`,
        [request.params.id],
      );
      await client.query(
        `UPDATE documents SET processing_status = 'RETRY_SCHEDULED', processed_at = NULL
          WHERE id = $1 AND user_id = $2 AND processing_status = 'FAILED_RETRYABLE'`,
        [job.document_id, job.user_id],
      );
      await client.query(
        `UPDATE import_batch_items SET status = 'PROCESSING', error_code = NULL, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status = 'FAILED'`,
        [job.import_batch_item_id, job.user_id],
      );
      await client.query(
        `UPDATE import_batches SET status = 'ACTIVE', completed_at = NULL, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status IN ('COMPLETED', 'PAUSED')`,
        [job.import_batch_id, job.user_id],
      );
      await audit(client, request, actorRole, "processing.retry", "PROCESSING_JOB_RETRY_ADVANCED", "PROCESSING_JOB", request.params.id, String(job.user_id), request.body, {
        documentId: job.document_id, attempt: integer(job.attempt), maxAttempts: integer(job.max_attempts),
      });
      return { data: { id: request.params.id, state: "RETRYABLE", availableAt: timestamp(updated.rows[0].available_at)! } };
    }),
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    "/api/v1/admin/jobs/:id/cancel",
    {
      config: { adminAudit: { capability: "processing.cancel", action: "PROCESSING_JOB_CANCELLED", resourceType: "PROCESSING_JOB" } },
      preHandler: guard("processing.cancel", true),
      schema: {
        params: idParamsSchema, body: reasonBodySchema,
        ...ok({
          type: "object", additionalProperties: false, required: ["id", "state", "documentStatus"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }, state: { type: "string", const: "CANCELLED" },
            documentStatus: { type: "string" },
          },
        }),
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockActor(client, request, "processing.cancel", ApiError);
      const result = await client.query(
        `SELECT job.id, job.user_id, job.document_id, job.state, job.execution_owner,
                job.trigger_kind, job.processing_version, job.reprocessing_batch_id,
                document.import_batch_id, document.import_batch_item_id, document.processing_status,
                document.retention_policy, document.original_deleted_at, document.object_key,
                upload.object_key AS incoming_object_key, upload.expires_at AS upload_expires_at
           FROM processing_jobs job
           JOIN documents document ON document.id = job.document_id AND document.user_id = job.user_id
           JOIN upload_sessions upload ON upload.id = document.upload_session_id AND upload.user_id = document.user_id
          WHERE job.id = $1 AND document.deleted_at IS NULL
          FOR UPDATE OF job, document, upload`,
        [request.params.id],
      );
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const job = result.rows[0];
      if (!["PENDING", "PUBLISHED", "RETRYABLE"].includes(job.state) || job.execution_owner !== null) {
        throw new ApiError(409, "JOB_NOT_CANCELLABLE", "No se puede cancelar un job en ejecución o terminal.");
      }
      const otherActive = await client.query(
        `SELECT 1 FROM processing_jobs
          WHERE document_id = $1 AND id <> $2
            AND (state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE') OR execution_owner IS NOT NULL)
          LIMIT 1`,
        [job.document_id, request.params.id],
      );
      if (otherActive.rowCount) throw new ApiError(409, "DOCUMENT_HAS_OTHER_ACTIVE_JOB", "El documento tiene otra ejecución activa.");
      await client.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL,
                execution_owner = NULL, error_code = 'ADMIN_CANCELLED', updated_at = now()
          WHERE id = $1`,
        [request.params.id],
      );
      const isReprocessing = [
        "USER_REPROCESS", "ADMIN_REPROCESS", "PARSER_UPGRADE", "AUTOMATIC_RECOVERY",
      ].includes(String(job.trigger_kind));
      if (isReprocessing) {
        await client.query(
          `UPDATE extraction_runs
              SET status = 'CANCELLED', finished_at = COALESCE(finished_at, now()),
                  promotion_outcome = 'NOT_EVALUATED', promoted_at = NULL
            WHERE user_id = $1 AND document_id = $2 AND processing_version = $3
              AND status IN ('RUNNING', 'PROCESSING')`,
          [job.user_id, job.document_id, job.processing_version],
        );
        if (job.reprocessing_batch_id !== null) {
          await refreshReprocessingBatch(client, String(job.user_id), String(job.reprocessing_batch_id));
        }
        await audit(client, request, actorRole, "processing.cancel", "PROCESSING_JOB_CANCELLED", "PROCESSING_JOB", request.params.id, String(job.user_id), request.body, {
          documentId: job.document_id, previousJobState: job.state,
          documentStatusPreserved: job.processing_status,
        });
        return { data: { id: request.params.id, state: "CANCELLED", documentStatus: String(job.processing_status) } };
      }
      await client.query(
        `UPDATE documents SET processing_status = 'CANCELLED', processed_at = now()
          WHERE id = $1 AND user_id = $2`,
        [job.document_id, job.user_id],
      );
      await client.query(
        `UPDATE import_batch_items SET status = 'CANCELLED', error_code = 'ADMIN_CANCELLED', updated_at = now()
          WHERE id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING', 'FAILED')`,
        [job.import_batch_item_id, job.user_id],
      );
      await scheduleOriginalDeletion(client, { ...job, id: job.document_id });
      await finalizeBatchIfTerminal(client, String(job.import_batch_id), String(job.user_id));
      await audit(client, request, actorRole, "processing.cancel", "PROCESSING_JOB_CANCELLED", "PROCESSING_JOB", request.params.id, String(job.user_id), request.body, {
        documentId: job.document_id, previousJobState: job.state, previousDocumentStatus: job.processing_status,
      });
      return { data: { id: request.params.id, state: "CANCELLED", documentStatus: "CANCELLED" } };
    }),
  );

  const employerItemSchema = {
    type: "object", additionalProperties: false,
    required: [
      "id", "name", "normalizedName", "countryCode", "status", "mergedIntoEmployerId",
      "createdSource", "employmentCount", "userCount", "documentCount", "createdAt", "updatedAt", "verifiedAt",
    ],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, name: { type: "string" }, normalizedName: { type: "string" },
      countryCode: { type: "string", pattern: "^[A-Z]{2}$" }, status: { type: "string", enum: [...employerStatuses] },
      mergedIntoEmployerId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
      createdSource: { type: "string", enum: [...employerSources] }, employmentCount: { type: "integer", minimum: 0 },
      userCount: { type: "integer", minimum: 0 }, documentCount: { type: "integer", minimum: 0 },
      createdAt: { type: "string" }, updatedAt: { type: "string" },
      verifiedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };

  const employerAliasSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "alias", "normalizedAlias", "createdSource", "createdAt"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, alias: { type: "string" }, normalizedAlias: { type: "string" },
      createdSource: { type: "string", enum: [...employerSources] }, createdAt: { type: "string" },
    },
  };

  const employerPossibleMatchSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "name", "status", "matchReason", "employmentCount", "userCount", "documentCount"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, name: { type: "string" },
      status: { type: "string", enum: ["PENDING", "VERIFIED"] },
      matchReason: { type: "string", enum: ["EXACT_NORMALIZED_NAME", "EXACT_NORMALIZED_ALIAS"] },
      employmentCount: { type: "integer", minimum: 0 }, userCount: { type: "integer", minimum: 0 },
      documentCount: { type: "integer", minimum: 0 },
    },
  };

  const employerDetectionOriginSchema = {
    type: "object", additionalProperties: false,
    required: ["documentId", "importBatchId", "employerName", "confidence", "source", "detectedAt"],
    properties: {
      documentId: { type: "string", pattern: UUID_PATTERN },
      importBatchId: { type: "string", pattern: UUID_PATTERN },
      employerName: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] },
      confidence: { anyOf: [{ type: "number", minimum: 0, maximum: 1 }, { type: "null" }] },
      source: {
        anyOf: [
          { type: "string", enum: ["PDF_TEXT", "OCR", "RULE", "TEMPLATE", "AI_FALLBACK", "HUMAN_CORRECTION"] },
          { type: "null" },
        ],
      },
      detectedAt: { type: "string" },
    },
  };

  const employerStateSchema = {
    type: "object", additionalProperties: false,
    required: ["id", "name", "normalizedName", "status", "mergedIntoEmployerId", "updatedAt", "verifiedAt"],
    properties: {
      id: { type: "string", pattern: UUID_PATTERN }, name: { type: "string" }, normalizedName: { type: "string" },
      status: { type: "string", enum: [...employerStatuses] },
      mergedIntoEmployerId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
      updatedAt: { type: "string" }, verifiedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };

  type EmployerQuery = ListQuery & { status?: typeof employerStatuses[number]; countryCode?: string };

  app.get<{ Querystring: EmployerQuery }>(
    "/api/v1/admin/employers",
    {
      preHandler: guard("employers.read_metadata"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties,
            search: { type: "string", minLength: 1, maxLength: 120 }, status: { type: "string", enum: [...employerStatuses] },
            countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
            sort: { type: "string", enum: ["createdAt", "name", "status", "employments", "users", "documents"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: {
            items: {
              type: "array", items: employerItemSchema,
            },
            ...paginationFields,
          },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, {
        createdAt: "employer.created_at", name: "employer.normalized_name", status: "employer.status",
        employments: "employment_count", users: "user_count", documents: "document_count",
      }, "createdAt");
      const sql = `SELECT employer.id, employer.name, employer.normalized_name, employer.country_code,
                employer.status, employer.merged_into_employer_id, employer.created_source,
                employer.created_at, employer.updated_at, employer.verified_at,
                (SELECT count(*)::integer FROM employments employment WHERE employment.employer_id = employer.id) AS employment_count,
                (SELECT count(DISTINCT employment.user_id)::integer FROM employments employment WHERE employment.employer_id = employer.id) AS user_count,
                (SELECT count(*)::integer
                   FROM documents document
                  WHERE document.deleted_at IS NULL
                    AND (document.detected_employer_id = employer.id OR EXISTS (
                      SELECT 1 FROM employments employment
                       WHERE employment.id = document.employment_id
                         AND employment.user_id = document.user_id
                         AND employment.employer_id = employer.id
                    ))) AS document_count,
                count(*) OVER ()::integer AS total
           FROM employers employer
          WHERE ($1::text IS NULL OR employer.id::text = $1 OR lower(employer.name) LIKE lower($1) || '%' ESCAPE '\\'
                 OR (NULLIF(normalize_employer_name($2), '') IS NOT NULL
                   AND left(employer.normalized_name, length(normalize_employer_name($2))) = normalize_employer_name($2))
                 OR EXISTS (
                   SELECT 1 FROM employer_aliases alias
                    WHERE alias.employer_id = employer.id
                      AND NULLIF(normalize_employer_name($2), '') IS NOT NULL
                      AND left(alias.normalized_alias, length(normalize_employer_name($2))) = normalize_employer_name($2)
                 ))
            AND ($3::text IS NULL OR employer.status = $3)
            AND ($4::text IS NULL OR employer.country_code = $4)
          ORDER BY ${order}, employer.id
          LIMIT $5 OFFSET $6`;
      const search = searchOf(request.query.search);
      const values = [prefixSearchOf(search ?? undefined), search,
        request.query.status ?? null, request.query.countryCode ?? null, pageSize, offset];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map(employerAdminDto), page, pageSize, total),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/admin/employers/:id",
    {
      preHandler: guard("employers.read_metadata"),
      schema: {
        params: idParamsSchema,
        ...ok({
          type: "object", additionalProperties: false,
          required: ["employer", "aliases", "identifiers", "possibleMatches", "detectionOrigins"],
          properties: {
            employer: employerItemSchema,
            aliases: { type: "array", items: employerAliasSchema },
            identifiers: { type: "array", items: employerIdentifierSchema },
            possibleMatches: { type: "array", items: employerPossibleMatchSchema },
            detectionOrigins: { type: "array", maxItems: 20, items: employerDetectionOriginSchema },
          },
        }),
      },
    },
    async (request) => {
      const employer = await pool.query(
        `SELECT employer.id, employer.name, employer.normalized_name, employer.country_code,
                employer.status, employer.merged_into_employer_id, employer.created_source,
                employer.created_at, employer.updated_at, employer.verified_at,
                (SELECT count(*)::integer FROM employments employment WHERE employment.employer_id = employer.id) AS employment_count,
                (SELECT count(DISTINCT employment.user_id)::integer FROM employments employment WHERE employment.employer_id = employer.id) AS user_count,
                (SELECT count(*)::integer
                   FROM documents document
                  WHERE document.deleted_at IS NULL
                    AND (document.detected_employer_id = employer.id OR EXISTS (
                      SELECT 1 FROM employments employment
                       WHERE employment.id = document.employment_id
                         AND employment.user_id = document.user_id
                         AND employment.employer_id = employer.id
                    ))) AS document_count
           FROM employers employer
          WHERE employer.id = $1`,
        [request.params.id],
      );
      if (employer.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const [aliases, identifiers, possibleMatches, detectionOrigins] = await Promise.all([
        pool.query(
          `SELECT id, alias, normalized_alias, created_source, created_at
             FROM employer_aliases WHERE employer_id = $1
            ORDER BY normalized_alias, id`,
          [request.params.id],
        ),
        pool.query(
          `SELECT id, country_code, identifier_type, masked_suffix, created_source, created_at
             FROM employer_identifiers WHERE employer_id = $1
            ORDER BY country_code, identifier_type, id`,
          [request.params.id],
        ),
        pool.query(
          `WITH current_identity AS (
             SELECT normalized_name
               FROM employers
              WHERE id = $1
             UNION
             SELECT normalized_alias
               FROM employer_aliases
              WHERE employer_id = $1
           ), candidate_matches AS (
             SELECT candidate.id AS employer_id, 'EXACT_NORMALIZED_NAME'::text AS match_reason, 1 AS priority
               FROM employers candidate
               JOIN current_identity identity ON identity.normalized_name = candidate.normalized_name
              WHERE candidate.id <> $1
                AND candidate.country_code = $2
                AND candidate.status IN ('PENDING', 'VERIFIED')
             UNION ALL
             SELECT candidate.id AS employer_id, 'EXACT_NORMALIZED_ALIAS'::text AS match_reason, 2 AS priority
               FROM employers candidate
               JOIN employer_aliases alias ON alias.employer_id = candidate.id
               JOIN current_identity identity ON identity.normalized_name = alias.normalized_alias
              WHERE candidate.id <> $1
                AND candidate.country_code = $2
                AND candidate.status IN ('PENDING', 'VERIFIED')
           ), best_matches AS (
             SELECT DISTINCT ON (employer_id) employer_id, match_reason
               FROM candidate_matches
              ORDER BY employer_id, priority
           )
           SELECT candidate.id, candidate.name, candidate.status, match.match_reason,
                  (SELECT count(*)::integer FROM employments employment
                    WHERE employment.employer_id = candidate.id) AS employment_count,
                  (SELECT count(DISTINCT employment.user_id)::integer FROM employments employment
                    WHERE employment.employer_id = candidate.id) AS user_count,
                  (SELECT count(*)::integer
                     FROM documents document
                    WHERE document.deleted_at IS NULL
                      AND (document.detected_employer_id = candidate.id OR EXISTS (
                        SELECT 1 FROM employments employment
                         WHERE employment.id = document.employment_id
                           AND employment.user_id = document.user_id
                           AND employment.employer_id = candidate.id
                      ))) AS document_count
             FROM best_matches match
             JOIN employers candidate ON candidate.id = match.employer_id
            ORDER BY candidate.normalized_name, candidate.id`,
          [request.params.id, String(employer.rows[0].country_code)],
        ),
        pool.query(
          `WITH active_runs AS (
             SELECT run.id, run.user_id, run.document_id, run.finished_at,
                    document.import_batch_id
               FROM documents document
               JOIN extraction_runs run
                 ON run.id = document.active_extraction_run_id
                AND run.document_id = document.id AND run.user_id = document.user_id
              WHERE document.detected_employer_id = $1
                AND document.deleted_at IS NULL
           )
           SELECT latest.document_id, latest.import_batch_id,
                  COALESCE(
                    CASE WHEN jsonb_typeof(correction.corrected_value) = 'string'
                      THEN left(NULLIF(btrim(correction.corrected_value #>> '{}'), ''), 200)
                    END,
                    CASE WHEN jsonb_typeof(field.interpreted_value) = 'string'
                      THEN left(NULLIF(btrim(field.interpreted_value #>> '{}'), ''), 200)
                    END
                  ) AS employer_name,
                  CASE WHEN correction.id IS NULL THEN field.confidence ELSE NULL END AS confidence,
                  CASE WHEN correction.id IS NOT NULL THEN 'HUMAN_CORRECTION' ELSE field.source END AS source,
                  COALESCE(correction.created_at, field.created_at, latest.finished_at) AS detected_at
             FROM active_runs latest
             LEFT JOIN extracted_fields field
               ON field.user_id = latest.user_id
              AND field.document_id = latest.document_id
              AND field.extraction_run_id = latest.id
              AND field.field_path = 'employer.name'
             LEFT JOIN LATERAL (
               SELECT current.id, current.corrected_value, current.created_at
                 FROM user_corrections current
                WHERE current.user_id = latest.user_id
                  AND current.document_id = latest.document_id
                  AND current.extraction_run_id = latest.id
                  AND current.field_path = 'employer.name'
                ORDER BY current.correction_version DESC, current.created_at DESC, current.id DESC
                LIMIT 1
             ) correction ON true
            ORDER BY detected_at DESC, latest.document_id DESC
            LIMIT 20`,
          [request.params.id],
        ),
      ]);
      return {
        data: {
          employer: employerAdminDto(employer.rows[0]),
          aliases: aliases.rows.map((row) => ({
            id: String(row.id), alias: String(row.alias), normalizedAlias: String(row.normalized_alias),
            createdSource: String(row.created_source), createdAt: timestamp(row.created_at)!,
          })),
          identifiers: identifiers.rows.map((row) => ({
            id: String(row.id), countryCode: String(row.country_code), identifierType: String(row.identifier_type),
            maskedValue: maskEmployerIdentifier(row.masked_suffix), createdSource: String(row.created_source),
            createdAt: timestamp(row.created_at)!,
          })),
          possibleMatches: possibleMatches.rows.map((row) => ({
            id: String(row.id), name: String(row.name), status: String(row.status),
            matchReason: String(row.match_reason), employmentCount: integer(row.employment_count),
            userCount: integer(row.user_count), documentCount: integer(row.document_count),
          })),
          detectionOrigins: detectionOrigins.rows.map((row) => ({
            documentId: String(row.document_id), importBatchId: String(row.import_batch_id),
            employerName: text(row.employer_name),
            confidence: row.confidence === null ? null : Number(row.confidence),
            source: text(row.source), detectedAt: timestamp(row.detected_at)!,
          })),
        },
      };
    },
  );

  app.post<{ Params: IdParams; Body: Reason & { name?: string } }>(
    "/api/v1/admin/employers/:id/approve",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_APPROVED", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["reasonCode", "reference"],
          properties: { name: { type: "string", minLength: 1, maxLength: 200 }, ...reasonProperties },
        },
        ...ok(employerStateSchema),
      },
    },
    async (request) => {
      const response = await withTransaction(async (client) => {
        const actorRole = await lockEmployerManagement(client, request, ApiError);
      const observed = await client.query(
        `SELECT id, name, normalized_name, country_code FROM employers WHERE id = $1`,
        [request.params.id],
      );
      if (observed.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const proposed = request.body.name === undefined
        ? { value: String(observed.rows[0].name), normalized: String(observed.rows[0].normalized_name) }
        : await employerNameInput(client, request.body.name, ApiError);
      await lockEmployerNames(client, String(observed.rows[0].country_code), [String(observed.rows[0].normalized_name), proposed.normalized]);
      const current = await client.query(
        `SELECT id, name, normalized_name, country_code, status
           FROM employers WHERE id = $1 FOR UPDATE`,
        [request.params.id],
      );
      if (current.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = current.rows[0];
      if (!["PENDING", "REJECTED"].includes(row.status)) {
        throw new ApiError(409, "EMPLOYER_NOT_APPROVABLE", "El empleador no está pendiente de aprobación.");
      }
      const next = request.body.name === undefined
        ? { value: String(row.name), normalized: String(row.normalized_name) }
        : proposed;
      await assertEmployerNameAvailable(client, request.params.id, String(row.country_code), next.normalized, ApiError, true);
      if (next.normalized !== row.normalized_name) {
        await client.query(
          `INSERT INTO employer_aliases (
             id, employer_id, alias, created_source, created_by_user_id
           ) VALUES ($1, $2, $3, 'ADMIN', $4)
           ON CONFLICT (employer_id, normalized_alias) DO NOTHING`,
          [randomUUID(), request.params.id, row.name, request.authUser!.id],
        );
      }
      const updated = await client.query(
        `UPDATE employers
            SET name = $2, status = 'VERIFIED', merged_into_employer_id = NULL,
                verified_at = now(), verified_by_user_id = $3, updated_at = now()
          WHERE id = $1
          RETURNING id, name, normalized_name, status, merged_into_employer_id, updated_at, verified_at`,
        [request.params.id, next.value, request.authUser!.id],
      );
      await audit(client, request, actorRole, "employers.manage", "EMPLOYER_APPROVED", "EMPLOYER", request.params.id, null, request.body, {
        previousStatus: row.status, renamed: next.value !== row.name,
      });
        return { data: employerStateDto(updated.rows[0]) };
      });
      request.log.info({
        event: "employer.approved", employerId: request.params.id, result: "SUCCESS",
        actorUserId: request.authUser!.id, actorAdminRole: request.authUser!.adminRole,
      }, "employer approved");
      return response;
    },
  );

  app.post<{ Params: IdParams; Body: Reason & { name: string } }>(
    "/api/v1/admin/employers/:id/rename",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_RENAMED", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["name", "reasonCode", "reference"],
          properties: { name: { type: "string", minLength: 1, maxLength: 200 }, ...reasonProperties },
        },
        ...ok(employerStateSchema),
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockEmployerManagement(client, request, ApiError);
      const next = await employerNameInput(client, request.body.name, ApiError);
      const observed = await client.query(
        `SELECT id, normalized_name, country_code FROM employers WHERE id = $1`,
        [request.params.id],
      );
      if (observed.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      await lockEmployerNames(client, String(observed.rows[0].country_code), [String(observed.rows[0].normalized_name), next.normalized]);
      const current = await client.query(
        `SELECT id, name, normalized_name, country_code, status
           FROM employers WHERE id = $1 FOR UPDATE`,
        [request.params.id],
      );
      if (current.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const row = current.rows[0];
      if (!["PENDING", "VERIFIED"].includes(row.status)) {
        throw new ApiError(409, "EMPLOYER_NOT_RENAMEABLE", "El empleador no admite cambios de nombre.");
      }
      if (next.value === row.name) throw new ApiError(409, "NAME_UNCHANGED", "El empleador ya tiene ese nombre.");
      await assertEmployerNameAvailable(client, request.params.id, String(row.country_code), next.normalized, ApiError);
      if (next.normalized !== row.normalized_name) {
        await client.query(
          `INSERT INTO employer_aliases (
             id, employer_id, alias, created_source, created_by_user_id
           ) VALUES ($1, $2, $3, 'ADMIN', $4)
           ON CONFLICT (employer_id, normalized_alias) DO NOTHING`,
          [randomUUID(), request.params.id, row.name, request.authUser!.id],
        );
      }
      const updated = await client.query(
        `UPDATE employers SET name = $2, updated_at = now()
          WHERE id = $1
          RETURNING id, name, normalized_name, status, merged_into_employer_id, updated_at, verified_at`,
        [request.params.id, next.value],
      );
      await audit(client, request, actorRole, "employers.manage", "EMPLOYER_RENAMED", "EMPLOYER", request.params.id, null, request.body, {
        normalizedNameChanged: next.normalized !== row.normalized_name,
      });
      return { data: employerStateDto(updated.rows[0]) };
    }),
  );

  app.post<{ Params: IdParams; Body: Reason & { alias: string } }>(
    "/api/v1/admin/employers/:id/aliases",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_ALIAS_ADDED", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["alias", "reasonCode", "reference"],
          properties: { alias: { type: "string", minLength: 1, maxLength: 200 }, ...reasonProperties },
        },
        ...ok(employerAliasSchema),
      },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockEmployerManagement(client, request, ApiError);
      const alias = await employerNameInput(client, request.body.alias, ApiError);
      const observed = await client.query(
        `SELECT id, normalized_name, country_code FROM employers WHERE id = $1`,
        [request.params.id],
      );
      if (observed.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      await lockEmployerNames(client, String(observed.rows[0].country_code), [String(observed.rows[0].normalized_name), alias.normalized]);
      const employer = await client.query(
        `SELECT id, normalized_name, country_code, status FROM employers WHERE id = $1 FOR UPDATE`,
        [request.params.id],
      );
      if (employer.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      if (!["PENDING", "VERIFIED"].includes(employer.rows[0].status)) {
        throw new ApiError(409, "EMPLOYER_NOT_EDITABLE", "El empleador no admite aliases.");
      }
      if (alias.normalized === employer.rows[0].normalized_name) {
        throw new ApiError(409, "ALIAS_MATCHES_NAME", "El alias coincide con el nombre del empleador.");
      }
      await assertEmployerNameAvailable(client, request.params.id, String(employer.rows[0].country_code), alias.normalized, ApiError);
      const inserted = await client.query(
        `INSERT INTO employer_aliases (
           id, employer_id, alias, created_source, created_by_user_id
         ) VALUES ($1, $2, $3, 'ADMIN', $4)
         ON CONFLICT (employer_id, normalized_alias) DO NOTHING
         RETURNING id, alias, normalized_alias, created_source, created_at`,
        [randomUUID(), request.params.id, alias.value, request.authUser!.id],
      );
      if (inserted.rowCount !== 1) throw new ApiError(409, "ALIAS_EXISTS", "El empleador ya tiene ese alias.");
      const row = inserted.rows[0];
      await audit(client, request, actorRole, "employers.manage", "EMPLOYER_ALIAS_ADDED", "EMPLOYER", request.params.id, null, request.body, {
        aliasId: row.id,
      });
      return { data: {
        id: String(row.id), alias: String(row.alias), normalizedAlias: String(row.normalized_alias),
        createdSource: String(row.created_source), createdAt: timestamp(row.created_at)!,
      } };
    }),
  );

  app.post<{ Params: IdParams; Body: Reason }>(
    "/api/v1/admin/employers/:id/reject",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_REJECTED", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: { params: idParamsSchema, body: reasonBodySchema, ...ok(employerStateSchema) },
    },
    async (request) => withTransaction(async (client) => {
      const actorRole = await lockEmployerManagement(client, request, ApiError);
      const observed = await client.query(
        `SELECT id, normalized_name, country_code FROM employers WHERE id = $1`,
        [request.params.id],
      );
      if (observed.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      await lockEmployerNames(client, String(observed.rows[0].country_code), [String(observed.rows[0].normalized_name)]);
      const current = await client.query(
        `SELECT id, status FROM employers WHERE id = $1 FOR UPDATE`,
        [request.params.id],
      );
      if (current.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      if (current.rows[0].status !== "PENDING") {
        throw new ApiError(409, "EMPLOYER_NOT_REJECTABLE", "Sólo se puede rechazar un empleador pendiente.");
      }
      const references = await client.query(
        `SELECT
           (SELECT count(*)::integer FROM employments WHERE employer_id = $1) AS employment_count,
           (SELECT count(*)::integer FROM documents WHERE detected_employer_id = $1) AS detected_document_count,
           (SELECT count(*)::integer FROM employers WHERE merged_into_employer_id = $1) AS merged_source_count`,
        [request.params.id],
      );
      if (
        integer(references.rows[0].employment_count) > 0
        || integer(references.rows[0].detected_document_count) > 0
        || integer(references.rows[0].merged_source_count) > 0
      ) {
        throw new ApiError(409, "EMPLOYER_IN_USE", "El empleador tiene referencias; fusionálo para conservarlas.");
      }
      const updated = await client.query(
        `UPDATE employers
            SET status = 'REJECTED', merged_into_employer_id = NULL,
                verified_at = NULL, verified_by_user_id = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id, name, normalized_name, status, merged_into_employer_id, updated_at, verified_at`,
        [request.params.id],
      );
      await audit(client, request, actorRole, "employers.manage", "EMPLOYER_REJECTED", "EMPLOYER", request.params.id, null, request.body, {
        employmentCount: integer(references.rows[0].employment_count),
        detectedDocumentCount: integer(references.rows[0].detected_document_count),
        mergedSourceCount: integer(references.rows[0].merged_source_count),
      });
      return { data: employerStateDto(updated.rows[0]) };
    }),
  );

  app.post<{ Params: IdParams; Body: Reason & { targetEmployerId: string } }>(
    "/api/v1/admin/employers/:id/merge",
    {
      config: { adminAudit: { capability: "employers.manage", action: "EMPLOYER_MERGED", resourceType: "EMPLOYER" } },
      preHandler: guard("employers.manage", true),
      schema: {
        params: idParamsSchema,
        body: {
          type: "object", additionalProperties: false, required: ["targetEmployerId", "reasonCode", "reference"],
          properties: { targetEmployerId: { type: "string", pattern: UUID_PATTERN }, ...reasonProperties },
        },
        ...ok({
          type: "object", additionalProperties: false,
          required: [
            "id", "status", "mergedIntoEmployerId", "movedEmploymentCount", "consolidatedEmploymentCount",
            "relinkedImportItemCount", "relinkedDocumentCount", "relinkedSettlementCount",
            "movedDetectedDocumentCount", "movedAliasCount", "deduplicatedAliasCount", "movedIdentifierCount",
          ],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }, status: { type: "string", const: "MERGED" },
            mergedIntoEmployerId: { type: "string", pattern: UUID_PATTERN },
            movedEmploymentCount: { type: "integer", minimum: 0 }, consolidatedEmploymentCount: { type: "integer", minimum: 0 },
            relinkedImportItemCount: { type: "integer", minimum: 0 }, relinkedDocumentCount: { type: "integer", minimum: 0 },
            relinkedSettlementCount: { type: "integer", minimum: 0 }, movedDetectedDocumentCount: { type: "integer", minimum: 0 },
            movedAliasCount: { type: "integer", minimum: 0 }, deduplicatedAliasCount: { type: "integer", minimum: 0 },
            movedIdentifierCount: { type: "integer", minimum: 0 },
          },
        }),
      },
    },
    async (request) => {
      const response = await withTransaction(async (client) => {
        const actorRole = await lockEmployerManagement(client, request, ApiError);
      const targetChain = await readEmployerMergeChain(client, request.body.targetEmployerId, ApiError);
      const targetChainIds = targetChain.map((row) => row.id);
      if (targetChainIds.includes(request.params.id)) {
        throw new ApiError(409, "EMPLOYER_MERGE_CYCLE", "El empleador no puede fusionarse consigo mismo.");
      }
      const canonicalPreflight = targetChain.at(-1)!;
      const employerIds = [request.params.id, ...targetChainIds];
      const identityPreflight = await readEmployerIdentitySnapshot(client, employerIds);
      const lockedIdentityKeys = await lockEmployerIdentities(
        client,
        identityPreflight.names.map((row) => ({ countryCode: row.country_code, normalizedName: row.normalized_name })),
        identityPreflight.identifiers.map((row) => ({
          countryCode: row.country_code, identifierType: row.identifier_type, fingerprint: row.identifier_fingerprint,
        })),
      );
      const locked = await client.query<EmployerMergeRow>(
        `SELECT id, name, normalized_name, country_code, status, merged_into_employer_id
           FROM employers
          WHERE id = ANY($1::uuid[])
          ORDER BY id
          FOR UPDATE`,
        [employerIds],
      );
      if (locked.rowCount !== employerIds.length) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      const byId = new Map(locked.rows.map((row) => [row.id, row]));
      const chainIsStable = targetChainIds.every((id, index) => {
        const current = byId.get(id);
        const nextId = targetChainIds[index + 1];
        return current !== undefined && (nextId === undefined
          ? ["PENDING", "VERIFIED"].includes(current.status) && current.merged_into_employer_id === null
          : current.status === "MERGED" && current.merged_into_employer_id === nextId);
      });
      if (!chainIsStable || canonicalPreflight.id !== targetChainIds.at(-1)) {
        throw new ApiError(409, "TARGET_EMPLOYER_CHANGED", "El empleador destino cambió; volvé a intentarlo.");
      }
      const identityCurrent = await readEmployerIdentitySnapshot(client, employerIds);
      if ([...identityCurrent.names, ...identityCurrent.identifiers]
        .some((row) => !lockedIdentityKeys.has(identityLockKey(row)))) {
        throw new ApiError(409, "TARGET_EMPLOYER_CHANGED", "La identidad del empleador cambió; volvé a intentarlo.");
      }
      const source = byId.get(request.params.id)!;
      const target = byId.get(canonicalPreflight.id)!;
      if (!["PENDING", "VERIFIED"].includes(source.status)) {
        throw new ApiError(409, "EMPLOYER_NOT_MERGEABLE", "El empleador origen no admite fusión.");
      }
      if (!["PENDING", "VERIFIED"].includes(target.status) || target.merged_into_employer_id !== null) {
        throw new ApiError(409, "TARGET_EMPLOYER_CHANGED", "El empleador destino cambió; volvé a intentarlo.");
      }
      if (source.country_code !== target.country_code) {
        throw new ApiError(409, "EMPLOYER_COUNTRY_MISMATCH", "Los empleadores deben pertenecer al mismo país.");
      }
      if (source.status === "VERIFIED" && target.status !== "VERIFIED") {
        throw new ApiError(409, "TARGET_EMPLOYER_NOT_CANONICAL", "Un empleador verificado sólo puede fusionarse en otro verificado.");
      }
      const mergeEmployerIds = [request.params.id, target.id];
      const mergeIdentifiers = await client.query<{
        employer_id: string; country_code: string; identifier_type: string; identifier_fingerprint: string | null;
      }>(
        `SELECT employer_id, country_code, identifier_type, identifier_fingerprint
           FROM employer_identifiers
          WHERE employer_id = ANY($1::uuid[])
          ORDER BY employer_id, country_code, identifier_type
          FOR UPDATE`,
        [mergeEmployerIds],
      );
      if (mergeIdentifiers.rows.some((identifier) => identifier.identifier_fingerprint === null)) {
        throw new ApiError(409, "EMPLOYER_IDENTIFIER_REVIEW_REQUIRED", "Hay un identificador histórico que debe corregirse antes de fusionar.");
      }
      const identifierByType = new Map<string, string>();
      for (const identifier of mergeIdentifiers.rows) {
        const key = `${identifier.country_code}\0${identifier.identifier_type}`;
        const knownFingerprint = identifierByType.get(key);
        if (knownFingerprint !== undefined && knownFingerprint !== identifier.identifier_fingerprint) {
          throw new ApiError(409, "EMPLOYER_IDENTIFIER_CONFLICT", "Los empleadores tienen identificadores fiscales diferentes.");
        }
        identifierByType.set(key, identifier.identifier_fingerprint!);
      }

      await client.query(
        `WITH locked_employments AS MATERIALIZED (
           SELECT id
             FROM employments
            WHERE employer_id = ANY($1::uuid[])
            ORDER BY id
            FOR UPDATE
         ) SELECT count(*) FROM locked_employments`,
        [mergeEmployerIds],
      );
      const collisions = await client.query(
        `WITH ranked AS (
           SELECT id, employer_id,
                  first_value(id) OVER (
                    PARTITION BY user_id, start_date, end_date, role, category, modality, country_code, currency_code
                    ORDER BY (employer_id = $2)::integer DESC, created_at, id
                  ) AS survivor_id
             FROM employments
            WHERE employer_id = ANY($3::uuid[])
         )
         SELECT id AS source_id, survivor_id
           FROM ranked
          WHERE employer_id = $1 AND id <> survivor_id
          ORDER BY id`,
        [request.params.id, target.id, mergeEmployerIds],
      );
      const sourceEmploymentIds = collisions.rows.map((row) => String(row.source_id));
      const survivorEmploymentIds = collisions.rows.map((row) => String(row.survivor_id));
      let relinkedImportItemCount = 0;
      let relinkedDocumentCount = 0;
      let relinkedSettlementCount = 0;
      if (sourceEmploymentIds.length > 0) {
        relinkedImportItemCount = (await client.query(
          `UPDATE import_batch_items item
              SET employment_id = mapping.survivor_id, updated_at = now()
             FROM unnest($1::uuid[], $2::uuid[]) AS mapping(source_id, survivor_id)
            WHERE item.employment_id = mapping.source_id`,
          [sourceEmploymentIds, survivorEmploymentIds],
        )).rowCount ?? 0;
        relinkedDocumentCount = (await client.query(
          `UPDATE documents document
              SET employment_id = mapping.survivor_id
             FROM unnest($1::uuid[], $2::uuid[]) AS mapping(source_id, survivor_id)
            WHERE document.employment_id = mapping.source_id`,
          [sourceEmploymentIds, survivorEmploymentIds],
        )).rowCount ?? 0;
        relinkedSettlementCount = (await client.query(
          `UPDATE payroll_settlements settlement
              SET employment_id = mapping.survivor_id
             FROM unnest($1::uuid[], $2::uuid[]) AS mapping(source_id, survivor_id)
            WHERE settlement.employment_id = mapping.source_id`,
          [sourceEmploymentIds, survivorEmploymentIds],
        )).rowCount ?? 0;
        await client.query(`DELETE FROM employments WHERE id = ANY($1::uuid[])`, [sourceEmploymentIds]);
      }
      const movedEmployments = await client.query(
        `UPDATE employments SET employer_id = $2, updated_at = now() WHERE employer_id = $1`,
        [request.params.id, target.id],
      );
      const movedDetectedDocuments = await client.query(
        `UPDATE documents SET detected_employer_id = $2 WHERE detected_employer_id = $1`,
        [request.params.id, target.id],
      );

      const deduplicatedAliases = await client.query(
        `DELETE FROM employer_aliases source_alias
          WHERE source_alias.employer_id = $1
            AND (source_alias.normalized_alias = $3 OR EXISTS (
              SELECT 1 FROM employer_aliases target_alias
               WHERE target_alias.employer_id = $2
                 AND target_alias.normalized_alias = source_alias.normalized_alias
            ))`,
        [request.params.id, target.id, target.normalized_name],
      );
      const movedAliases = await client.query(
        `UPDATE employer_aliases SET employer_id = $2 WHERE employer_id = $1`,
        [request.params.id, target.id],
      );
      const sourceNameAlias = source.normalized_name === target.normalized_name ? { rowCount: 0 } : await client.query(
        `INSERT INTO employer_aliases (
           id, employer_id, alias, created_source, created_by_user_id
         ) VALUES ($1, $2, $3, 'ADMIN', $4)
         ON CONFLICT (employer_id, normalized_alias) DO NOTHING`,
        [randomUUID(), target.id, source.name, request.authUser!.id],
      );
      const deduplicatedIdentifiers = await client.query(
        `DELETE FROM employer_identifiers source_identifier
          USING employer_identifiers target_identifier
          WHERE source_identifier.employer_id = $1
            AND target_identifier.employer_id = $2
            AND source_identifier.identifier_fingerprint IS NOT NULL
            AND source_identifier.country_code = target_identifier.country_code
            AND source_identifier.identifier_type = target_identifier.identifier_type
            AND source_identifier.identifier_fingerprint = target_identifier.identifier_fingerprint`,
        [request.params.id, target.id],
      );
      const movedIdentifiers = await client.query(
        `UPDATE employer_identifiers SET employer_id = $2 WHERE employer_id = $1`,
        [request.params.id, target.id],
      );
      const merged = await client.query(
        `UPDATE employers
            SET status = 'MERGED', merged_into_employer_id = $2,
                verified_at = NULL, verified_by_user_id = NULL, updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [request.params.id, target.id],
      );
      if (merged.rowCount !== 1) throw new ApiError(409, "EMPLOYER_MERGE_FAILED", "No se pudo completar la fusión.");
      const result = {
        id: request.params.id,
        status: "MERGED" as const,
        mergedIntoEmployerId: target.id,
        movedEmploymentCount: movedEmployments.rowCount ?? 0,
        consolidatedEmploymentCount: sourceEmploymentIds.length,
        relinkedImportItemCount,
        relinkedDocumentCount,
        relinkedSettlementCount,
        movedDetectedDocumentCount: movedDetectedDocuments.rowCount ?? 0,
        movedAliasCount: (movedAliases.rowCount ?? 0) + (sourceNameAlias.rowCount ?? 0),
        deduplicatedAliasCount: deduplicatedAliases.rowCount ?? 0,
        movedIdentifierCount: (movedIdentifiers.rowCount ?? 0) + (deduplicatedIdentifiers.rowCount ?? 0),
      };
      await audit(client, request, actorRole, "employers.manage", "EMPLOYER_MERGED", "EMPLOYER", request.params.id, null, request.body, result);
        return { data: result };
      });
      request.log.info({
        event: "employer.merged", employerId: request.params.id, targetEmployerId: response.data.mergedIntoEmployerId,
        result: "SUCCESS", actorUserId: request.authUser!.id, actorAdminRole: request.authUser!.adminRole,
      }, "employer merged");
      return response;
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/api/v1/admin/storage",
    {
      preHandler: guard("storage.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties, search: { type: "string", minLength: 1, maxLength: 120 },
            sort: { type: "string", enum: ["originalBytes", "documents", "createdAt"] },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["summary", "items", "page", "pageSize", "total"],
          properties: {
            summary: {
              type: "object", additionalProperties: false,
              required: ["totalOriginalBytes", "documentCount", "usersWithOriginals", "pendingDeletions", "uncertainArtifactWrites", "quotaBytesPerUser"],
              properties: Object.fromEntries([
                "totalOriginalBytes", "documentCount", "usersWithOriginals", "pendingDeletions", "uncertainArtifactWrites", "quotaBytesPerUser",
              ].map((key) => [key, { type: "integer", minimum: 0 }])),
            },
            items: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["userId", "originalBytes", "documentCount", "largestDocumentBytes", "quotaBytes", "usagePercent", "anomalyFlags"],
                properties: {
                  userId: { type: "string", pattern: UUID_PATTERN },
                  originalBytes: { type: "integer", minimum: 0 }, documentCount: { type: "integer", minimum: 0 },
                  largestDocumentBytes: { type: "integer", minimum: 0 }, quotaBytes: { type: "integer", minimum: 1 },
                  usagePercent: { type: "number", minimum: 0 },
                  anomalyFlags: { type: "array", uniqueItems: true, items: { type: "string", enum: ["NEAR_QUOTA", "OVER_QUOTA"] } },
                },
              },
            },
            ...paginationFields,
          },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, {
        originalBytes: "original_bytes", documents: "document_count", createdAt: "app_user.created_at",
      }, "originalBytes");
      const usersSql = `SELECT app_user.id AS user_id, app_user.created_at,
                COALESCE(sum(document.size_bytes), 0)::bigint AS original_bytes,
                count(document.id)::integer AS document_count,
                COALESCE(max(document.size_bytes), 0)::bigint AS largest_document_bytes,
                count(*) OVER ()::integer AS total
           FROM users app_user
           LEFT JOIN documents document ON document.user_id = app_user.id
             AND document.deleted_at IS NULL AND document.original_deleted_at IS NULL
          WHERE ($1::text IS NULL OR app_user.id::text = $1)
          GROUP BY app_user.id
          ORDER BY ${order}, app_user.id
          LIMIT $2 OFFSET $3`;
      const usersValues = [searchOf(request.query.search), pageSize, offset];
      const [summary, users] = await Promise.all([
        pool.query(
          `SELECT
             COALESCE(sum(size_bytes) FILTER (WHERE deleted_at IS NULL AND original_deleted_at IS NULL), 0)::bigint AS total_original_bytes,
             count(*) FILTER (WHERE deleted_at IS NULL AND original_deleted_at IS NULL)::integer AS document_count,
             count(DISTINCT user_id) FILTER (WHERE deleted_at IS NULL AND original_deleted_at IS NULL)::integer AS users_with_originals,
             (SELECT count(*)::integer FROM storage_deletion_tombstones) AS pending_deletions,
             (SELECT count(*)::integer FROM storage_deletion_tombstones
               WHERE cardinality(uncertain_artifact_object_keys) > 0) AS uncertain_artifact_writes
           FROM documents`,
        ),
        pool.query(usersSql, usersValues),
      ]);
      const pageTotal = await totalForPage(usersSql, usersValues, users.rows[0]?.total, offset);
      const summaryRow = summary.rows[0];
      return {
        data: {
          summary: {
            totalOriginalBytes: integer(summaryRow.total_original_bytes), documentCount: integer(summaryRow.document_count),
            usersWithOriginals: integer(summaryRow.users_with_originals), pendingDeletions: integer(summaryRow.pending_deletions),
            uncertainArtifactWrites: integer(summaryRow.uncertain_artifact_writes),
            quotaBytesPerUser: config.maxUserStorageBytes,
          },
          ...paged(users.rows.map((row) => {
            const originalBytes = integer(row.original_bytes);
            const usagePercent = Math.round((originalBytes / config.maxUserStorageBytes) * 10_000) / 100;
            return {
              userId: String(row.user_id), originalBytes,
              documentCount: integer(row.document_count), largestDocumentBytes: integer(row.largest_document_bytes),
              quotaBytes: config.maxUserStorageBytes, usagePercent,
              anomalyFlags: usagePercent >= 100 ? ["OVER_QUOTA"] : usagePercent >= 80 ? ["NEAR_QUOTA"] : [],
            };
          }), page, pageSize, pageTotal),
        },
      };
    },
  );

  app.get<{ Querystring: ListQuery & { operationType?: string; status?: string; userId?: string } }>(
    "/api/v1/admin/privacy",
    {
      preHandler: guard("privacy.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties, search: { type: "string", minLength: 1, maxLength: 120 },
            operationType: { type: "string", enum: ["DATA_EXPORT", "ACCOUNT_DELETION"] },
            status: { type: "string", enum: ["PENDING", "RUNNING", "READY", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] },
            userId: { type: "string", pattern: UUID_PATTERN },
            sort: { type: "string", enum: ["createdAt", "updatedAt", "status"] }, direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: {
            items: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "userId", "maskedEmail", "operationType", "status", "hasOutput", "outputExpiresAt", "errorCode", "createdAt", "updatedAt", "startedAt", "completedAt"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, userId: { type: "string", pattern: UUID_PATTERN }, maskedEmail: { type: "string" },
                  operationType: { type: "string", enum: ["DATA_EXPORT", "ACCOUNT_DELETION"] }, status: { type: "string" }, hasOutput: { type: "boolean" },
                  outputExpiresAt: { anyOf: [{ type: "string" }, { type: "null" }] }, errorCode: { anyOf: [{ type: "string" }, { type: "null" }] },
                  createdAt: { type: "string" }, updatedAt: { type: "string" }, startedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
                  completedAt: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              },
            },
            ...paginationFields,
          },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, {
        createdAt: "operation.created_at", updatedAt: "operation.updated_at", status: "operation.status",
      }, "createdAt");
      const sql = `SELECT operation.id, operation.user_id, app_user.email, operation.operation_type, operation.status,
                operation.output_expires_at, operation.error_code, operation.created_at, operation.updated_at,
                operation.started_at, operation.completed_at, count(*) OVER ()::integer AS total
           FROM privacy_operations operation JOIN users app_user ON app_user.id = operation.user_id
          WHERE ($1::text IS NULL OR operation.id::text = $1 OR operation.user_id::text = $1)
            AND ($2::text IS NULL OR operation.operation_type = $2)
            AND ($3::text IS NULL OR operation.status = $3)
            AND ($4::uuid IS NULL OR operation.user_id = $4)
          ORDER BY ${order}, operation.id
          LIMIT $5 OFFSET $6`;
      const values = [searchOf(request.query.search), request.query.operationType ?? null, request.query.status ?? null,
        request.query.userId ?? null, pageSize, offset];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map((row) => ({
          id: String(row.id), userId: String(row.user_id), maskedEmail: maskedEmail(row.email), operationType: String(row.operation_type),
          status: String(row.status), hasOutput: row.output_expires_at !== null, outputExpiresAt: timestamp(row.output_expires_at),
          errorCode: text(row.error_code), createdAt: timestamp(row.created_at)!, updatedAt: timestamp(row.updated_at)!,
          startedAt: timestamp(row.started_at), completedAt: timestamp(row.completed_at),
        })), page, pageSize, total),
      };
    },
  );

  app.get(
    "/api/v1/admin/security",
    {
      preHandler: guard("security.read"),
      schema: ok({
        type: "object", additionalProperties: false,
        required: ["activeSessions", "recentlyRevokedSessions", "adminsWithoutMfa", "suspendedUsers", "blockedUsers", "quarantinedDocuments", "securityErrors", "adminMutations24h"],
        properties: Object.fromEntries([
          "activeSessions", "recentlyRevokedSessions", "adminsWithoutMfa", "suspendedUsers", "blockedUsers",
          "quarantinedDocuments", "securityErrors", "adminMutations24h",
        ].map((key) => [key, { type: "integer", minimum: 0 }])),
      }),
    },
    async () => {
      const result = await pool.query(
        `SELECT
           (SELECT count(*)::integer FROM sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_sessions,
           (SELECT count(*)::integer FROM sessions WHERE revoked_at >= now() - interval '24 hours') AS recently_revoked_sessions,
           (SELECT count(*)::integer FROM users u WHERE u.role = 'ADMIN' AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.status = 'ACTIVE')) AS admins_without_mfa,
           (SELECT count(*)::integer FROM users WHERE status = 'SUSPENDED') AS suspended_users,
           (SELECT count(*)::integer FROM users WHERE status = 'BLOCKED') AS blocked_users,
           (SELECT count(*)::integer FROM documents WHERE deleted_at IS NULL AND security_status = 'QUARANTINED') AS quarantined_documents,
           (SELECT count(*)::integer FROM documents WHERE deleted_at IS NULL AND security_status = 'ERROR') AS security_errors,
           (SELECT count(*)::integer FROM admin_audit_events WHERE created_at >= now() - interval '24 hours') AS admin_mutations_24h`,
      );
      const row = result.rows[0];
      return { data: {
        activeSessions: integer(row.active_sessions), recentlyRevokedSessions: integer(row.recently_revoked_sessions),
        adminsWithoutMfa: integer(row.admins_without_mfa), suspendedUsers: integer(row.suspended_users), blockedUsers: integer(row.blocked_users),
        quarantinedDocuments: integer(row.quarantined_documents), securityErrors: integer(row.security_errors), adminMutations24h: integer(row.admin_mutations_24h),
      } };
    },
  );

  app.get<{ Querystring: ListQuery & { action?: string; result?: string; actorUserId?: string; subjectUserId?: string; resourceType?: string; reasonCode?: ReasonCode } }>(
    "/api/v1/admin/audit",
    {
      preHandler: guard("audit.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: {
            ...pagingProperties, search: { type: "string", minLength: 1, maxLength: 100 },
            action: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,99}$" }, result: { type: "string", enum: ["SUCCESS", "DENIED", "FAILED"] },
            actorUserId: { type: "string", pattern: UUID_PATTERN }, subjectUserId: { type: "string", pattern: UUID_PATTERN },
            resourceType: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,79}$" }, reasonCode: { type: "string", enum: [...reasonCodes] },
            sort: { type: "string", enum: ["createdAt", "action"] }, direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
        ...ok({
          type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"],
          properties: {
            items: {
              type: "array", items: {
                type: "object", additionalProperties: false,
                required: ["id", "actorUserId", "actorAdminRole", "capability", "action", "resourceType", "resourceId", "subjectUserId", "result", "reasonCode", "reference", "createdAt"],
                properties: {
                  id: { type: "string", pattern: UUID_PATTERN }, actorUserId: { type: "string", pattern: UUID_PATTERN },
                  actorAdminRole: { type: "string", enum: [...adminRoles] }, capability: { type: "string", pattern: "^[a-z][a-z0-9_.]{2,79}$" }, action: { type: "string" },
                  resourceType: { type: "string" }, resourceId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
                  subjectUserId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] }, result: { type: "string", enum: ["SUCCESS", "DENIED", "FAILED"] },
                  reasonCode: { anyOf: [{ type: "string", enum: [...reasonCodes] }, { type: "null" }] }, reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                  createdAt: { type: "string" },
                },
              },
            },
            ...paginationFields,
          },
        }),
      },
    },
    async (request) => {
      const { page, pageSize, offset } = pageOf(request.query);
      const order = sortOf(request.query.sort, request.query.direction, { createdAt: "event.created_at", action: "event.action" }, "createdAt");
      const sql = `SELECT event.id, event.actor_user_id, event.actor_admin_role, event.capability, event.action,
                event.resource_type, event.resource_id, event.subject_user_id, event.result,
                event.reason_code, event.reference, event.created_at, count(*) OVER ()::integer AS total
           FROM admin_audit_events event
          WHERE ($1::text IS NULL OR event.id::text = $1 OR event.resource_id::text = $1 OR event.reference = $1)
            AND ($2::text IS NULL OR event.action = $2)
            AND ($3::text IS NULL OR event.result = $3)
            AND ($4::uuid IS NULL OR event.actor_user_id = $4)
            AND ($5::uuid IS NULL OR event.subject_user_id = $5)
            AND ($6::text IS NULL OR event.resource_type = $6)
            AND ($7::text IS NULL OR event.reason_code = $7)
          ORDER BY ${order}, event.id DESC
          LIMIT $8 OFFSET $9`;
      const values = [searchOf(request.query.search), request.query.action ?? null, request.query.result ?? null,
        request.query.actorUserId ?? null, request.query.subjectUserId ?? null, request.query.resourceType ?? null,
        request.query.reasonCode ?? null, pageSize, offset];
      const result = await pool.query(sql, values);
      const total = await totalForPage(sql, values, result.rows[0]?.total, offset);
      return {
        data: paged(result.rows.map((row) => ({
          id: String(row.id), actorUserId: String(row.actor_user_id), actorAdminRole: String(row.actor_admin_role),
          capability: String(row.capability), action: String(row.action), resourceType: String(row.resource_type),
          resourceId: text(row.resource_id), subjectUserId: text(row.subject_user_id), result: String(row.result),
          reasonCode: text(row.reason_code), reference: text(row.reference), createdAt: timestamp(row.created_at)!,
        })), page, pageSize, total),
      };
    },
  );

  app.get<{ Querystring: PageQuery }>(
    "/api/v1/admin/processing/health",
    {
      preHandler: guard("processing.read"),
      schema: {
        querystring: {
          type: "object", additionalProperties: false,
          properties: pagingProperties,
        },
        ...ok({
          type: "object", additionalProperties: false,
          required: ["summary", "currentPipeline", "versions", "issues", "checkedAt"],
          properties: {
            summary: {
              type: "object", additionalProperties: false,
              required: [
                "totalDocuments", "completeDocuments", "warningDocuments", "failedDocuments",
                "reviewRequiredDocuments", "candidateDocuments", "processingDocuments",
              ],
              properties: Object.fromEntries([
                "totalDocuments", "completeDocuments", "warningDocuments", "failedDocuments",
                "reviewRequiredDocuments", "candidateDocuments", "processingDocuments",
              ].map((key) => [key, { type: "integer", minimum: 0 }])),
            },
            currentPipeline: {
              type: "object", additionalProperties: false,
              required: ["fingerprint", "parserVersion", "resultSchemaVersion"],
              properties: {
                fingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
                parserVersion: { type: "string" }, resultSchemaVersion: { type: "string" },
              },
            },
            versions: {
              type: "object", additionalProperties: false,
              required: ["items", "page", "pageSize", "total"],
              properties: {
                items: { type: "array", items: {
                  type: "object", additionalProperties: false,
                  required: ["pipelineFingerprint", "parserVersion", "status", "promotionOutcome", "documents"],
                  properties: {
                    pipelineFingerprint: { anyOf: [{ type: "string" }, { type: "null" }] },
                    parserVersion: { type: "string" }, status: { type: "string" }, promotionOutcome: { type: "string" },
                    documents: { type: "integer", minimum: 0 },
                  },
                } },
                ...paginationFields,
              },
            },
            issues: {
              type: "object", additionalProperties: false,
              required: ["items", "page", "pageSize", "total"],
              properties: {
                items: { type: "array", items: {
                  type: "object", additionalProperties: false,
                  required: ["code", "severity", "documents", "candidates"],
                  properties: {
                    code: { type: "string" }, severity: { type: "string" },
                    documents: { type: "integer", minimum: 0 }, candidates: { type: "integer", minimum: 0 },
                  },
                } },
                ...paginationFields,
              },
            },
            checkedAt: { type: "string" },
          },
        }),
      },
    },
    async (request) => ({
      data: {
        ...(await loadProcessingHealth(pool, request.query)),
        currentPipeline: {
          fingerprint: currentPipelineFingerprint,
          parserVersion: processingPipelineVersions.parser,
          resultSchemaVersion: processingPipelineVersions.resultSchema,
        },
        checkedAt: new Date().toISOString(),
      },
    }),
  );

  app.get(
    "/api/v1/admin/settings",
    {
      preHandler: guard("settings.read"),
      schema: ok({
        type: "object", additionalProperties: false, required: ["environment", "authentication", "limits", "storage", "features"],
        properties: {
          environment: { type: "string", enum: ["development", "test", "production"] },
          authentication: {
            type: "object", additionalProperties: false, required: ["provider", "adminMfaRequired", "sensitiveActionsRequireStepUp", "sessionTtlSeconds"],
            properties: { provider: { type: "string", const: "GOOGLE" }, adminMfaRequired: { type: "boolean" }, sensitiveActionsRequireStepUp: { type: "boolean" }, sessionTtlSeconds: { type: "integer", minimum: 1 } },
          },
          limits: {
            type: "object", additionalProperties: false,
            required: ["maxFileBytes", "maxFilesPerBatch", "maxBatchBytes", "maxActiveImportsPerUser", "maxUserDocuments", "maxUserStorageBytes", "uploadTtlSeconds"],
            properties: Object.fromEntries([
              "maxFileBytes", "maxFilesPerBatch", "maxBatchBytes", "maxActiveImportsPerUser", "maxUserDocuments", "maxUserStorageBytes", "uploadTtlSeconds",
            ].map((key) => [key, { type: "integer", minimum: 1 }])),
          },
          storage: {
            type: "object", additionalProperties: false, required: ["provider", "private", "encryption"],
            properties: { provider: { type: "string", enum: ["aws", "r2"] }, private: { type: "boolean" }, encryption: { type: "string", enum: ["SSE_KMS", "PROVIDER_MANAGED"] } },
          },
          features: {
            type: "object", additionalProperties: false,
            required: ["roleManagement", "documentQuarantine", "sameVersionRetry", "fullReprocessing", "dynamicSettings", "breakGlass"],
            properties: Object.fromEntries([
              "roleManagement", "documentQuarantine", "sameVersionRetry", "fullReprocessing", "dynamicSettings", "breakGlass",
            ].map((key) => [key, { type: "boolean" }])),
          },
        },
      }),
    },
    async () => ({ data: {
      environment: config.appEnv,
      authentication: { provider: "GOOGLE", adminMfaRequired: true, sensitiveActionsRequireStepUp: true, sessionTtlSeconds: config.sessionTtlSeconds },
      limits: {
        maxFileBytes: config.maxFileBytes, maxFilesPerBatch: config.maxFilesPerBatch, maxBatchBytes: config.maxBatchBytes,
        maxActiveImportsPerUser: config.maxActiveImportsPerUser, maxUserDocuments: config.maxUserDocuments,
        maxUserStorageBytes: config.maxUserStorageBytes, uploadTtlSeconds: config.uploadTtlSeconds,
      },
      storage: { provider: config.storageProvider, private: true, encryption: config.storageProvider === "r2" ? "PROVIDER_MANAGED" : "SSE_KMS" },
      features: { roleManagement: true, documentQuarantine: true, sameVersionRetry: true, fullReprocessing: true, dynamicSettings: false, breakGlass: false },
    } }),
  );

  app.get(
    "/api/v1/admin/system/health",
    {
      preHandler: guard("system.health.read"),
      schema: ok({
        type: "object", additionalProperties: false, required: ["overall", "components", "checkedAt"],
        properties: {
          overall: { type: "string", enum: ["HEALTHY", "DEGRADED"] },
          components: {
            type: "object", additionalProperties: false, required: ["api", "database", "documentWorker", "storage"],
            properties: Object.fromEntries(["api", "database", "documentWorker", "storage"].map((key) => [key, { type: "string", enum: ["HEALTHY", "UNAVAILABLE", "UNKNOWN"] }])),
          },
          checkedAt: { type: "string" },
        },
      }),
    },
    async () => {
      let database: "HEALTHY" | "UNAVAILABLE" = "HEALTHY";
      try { await pool.query("SELECT 1"); } catch { database = "UNAVAILABLE"; }
      return { data: {
        overall: database === "HEALTHY" ? "HEALTHY" : "DEGRADED",
        components: { api: "HEALTHY", database, documentWorker: "UNKNOWN", storage: "UNKNOWN" },
        checkedAt: new Date().toISOString(),
      } };
    },
  );
}
