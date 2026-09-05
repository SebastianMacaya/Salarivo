import { randomUUID } from "node:crypto";
import {
  layoutAliasFields, lockEmployerMutation, pool, validateLayoutAliases, withTransaction, type LayoutAliases,
} from "@salarivo/database";
import type { FastifyInstance } from "fastify";
import { audit, lockActor, type AdminRouteDependencies } from "./admin-routes.ts";

const uuid = { type: "string", format: "uuid" };
const fingerprint = { type: "string", pattern: "^[0-9a-f]{64}$" };
const aliasesSchema = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(layoutAliasFields.map((field) => [field, {
    type: "array", minItems: 1, maxItems: 4, uniqueItems: true,
    items: { type: "string", minLength: 2, maxLength: 60 },
  }])),
};
const versionSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "version", "enabled", "aliases", "approvedAt"],
  properties: { id: uuid, version: { type: "integer", minimum: 1 }, enabled: { type: "boolean" },
    aliases: aliasesSchema, approvedAt: { type: "string" } },
};
const reasonCodes = ["SUPPORT_REQUEST", "SECURITY_INCIDENT", "ABUSE_PREVENTION", "USER_REQUEST", "OPERATIONAL_RECOVERY", "ROLE_ADMINISTRATION"] as const;
type ApprovalBody = {
  employerId: string; fingerprint: string; fingerprintVersion: "1"; aliases: LayoutAliases; enabled: boolean;
  reasonCode: typeof reasonCodes[number]; reference: string;
};

function versionView(row: Record<string, unknown>) {
  return { id: String(row.id), version: Number(row.version), enabled: row.enabled === true,
    aliases: validateLayoutAliases(row.aliases, row.enabled === true) ?? {},
    approvedAt: new Date(row.approved_at as string | Date).toISOString() };
}

export async function registerAdminLayoutRoutes(app: FastifyInstance, dependencies: AdminRouteDependencies) {
  const { ApiError, requireAdminPermission } = dependencies;
  app.get<{ Querystring: { page?: number; pageSize?: number } }>("/api/v1/admin/processing/layouts", {
    preValidation: (request) => requireAdminPermission(request, "processing.read"),
    schema: {
      querystring: { type: "object", additionalProperties: false, properties: {
        page: { type: "integer", minimum: 1, maximum: 1_000 }, pageSize: { type: "integer", minimum: 1, maximum: 100 },
      } },
      response: { 200: { type: "object", additionalProperties: false, required: ["data"], properties: { data: {
        type: "object", additionalProperties: false, required: ["items", "page", "pageSize", "total"], properties: {
          page: { type: "integer" }, pageSize: { type: "integer" }, total: { type: "integer" },
          items: { type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["employerId", "fingerprint", "fingerprintVersion", "observedRuns", "lastSeenAt", "layoutId", "versions", "versionCount"],
            properties: { employerId: uuid, fingerprint, fingerprintVersion: { type: "string", const: "1" },
              observedRuns: { type: "integer" }, lastSeenAt: { anyOf: [{ type: "string" }, { type: "null" }] },
              layoutId: { anyOf: [uuid, { type: "null" }] }, versions: { type: "array", items: versionSchema }, versionCount: { type: "integer" } },
          } },
        },
      } } } },
    },
  }, async (request) => {
    const page = request.query.page ?? 1;
    const pageSize = request.query.pageSize ?? 25;
    const observations = `WITH observed AS (
      SELECT run.detected_employer_id AS employer_id, run.layout_fingerprint_version AS fingerprint_version,
             run.layout_fingerprint AS structural_fingerprint, count(*)::integer AS observed_runs, max(run.started_at) AS last_seen_at
        FROM extraction_runs run JOIN documents document ON document.id = run.document_id AND document.user_id = run.user_id
        JOIN users owner ON owner.id = run.user_id
       WHERE run.layout_fingerprint IS NOT NULL AND run.status = 'REVIEW_REQUIRED'
         AND document.deleted_at IS NULL AND owner.deleted_at IS NULL AND owner.status = 'ACTIVE'
         AND document.security_status = 'CLEAN' AND document.original_deleted_at IS NULL
       GROUP BY run.detected_employer_id, run.layout_fingerprint_version, run.layout_fingerprint
    ), candidates AS (
      SELECT COALESCE(layout.employer_id, observed.employer_id) AS employer_id,
             COALESCE(layout.fingerprint_version, observed.fingerprint_version) AS fingerprint_version,
             COALESCE(layout.structural_fingerprint, observed.structural_fingerprint) AS structural_fingerprint,
             COALESCE(observed.observed_runs, 0) AS observed_runs, observed.last_seen_at, layout.id AS layout_id
        FROM document_layouts layout FULL JOIN observed ON layout.employer_id = observed.employer_id
         AND layout.fingerprint_version = observed.fingerprint_version AND layout.structural_fingerprint = observed.structural_fingerprint
    )`;
    const [rows, count] = await Promise.all([
      pool.query(`${observations} SELECT candidates.*,
          (SELECT count(*)::integer FROM document_layout_versions version WHERE version.layout_id = candidates.layout_id) AS version_count,
          COALESCE((SELECT jsonb_agg(versions ORDER BY versions.version DESC) FROM (
            SELECT id, version, enabled, aliases, approved_at FROM document_layout_versions
             WHERE layout_id = candidates.layout_id ORDER BY version DESC LIMIT 20
          ) versions), '[]'::jsonb) AS versions
        FROM candidates JOIN employers employer ON employer.id = candidates.employer_id
        WHERE employer.country_code = 'AR' AND employer.status = 'VERIFIED'
        ORDER BY candidates.last_seen_at DESC NULLS LAST, candidates.employer_id, candidates.structural_fingerprint
        LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]),
      pool.query(`${observations} SELECT count(*)::integer AS total FROM candidates
        JOIN employers employer ON employer.id = candidates.employer_id
        WHERE employer.country_code = 'AR' AND employer.status = 'VERIFIED'`),
    ]);
    return { data: { page, pageSize, total: Number(count.rows[0]!.total), items: rows.rows.map((row) => ({
      employerId: String(row.employer_id), fingerprint: String(row.structural_fingerprint), fingerprintVersion: "1",
      observedRuns: Number(row.observed_runs), lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
      layoutId: row.layout_id ? String(row.layout_id) : null, versionCount: Number(row.version_count),
      versions: (row.versions as Record<string, unknown>[]).map(versionView),
    })) } };
  });

  app.post<{ Body: ApprovalBody }>("/api/v1/admin/processing/layouts/approve", {
    config: { adminAudit: { capability: "layouts.manage", action: "DOCUMENT_LAYOUT_APPROVED", resourceType: "DOCUMENT_LAYOUT" } },
    preValidation: (request) => requireAdminPermission(request, "layouts.manage", true),
    schema: {
      body: { type: "object", additionalProperties: false,
        required: ["employerId", "fingerprint", "fingerprintVersion", "aliases", "enabled", "reasonCode", "reference"],
        properties: { employerId: uuid, fingerprint, fingerprintVersion: { type: "string", const: "1" },
          aliases: aliasesSchema, enabled: { type: "boolean" }, reasonCode: { type: "string", enum: [...reasonCodes] },
          reference: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{2,79}$" },
        },
      },
      response: { 200: { type: "object", additionalProperties: false, required: ["data"], properties: { data: {
        ...versionSchema, required: [...versionSchema.required, "layoutId", "fingerprint", "fingerprintVersion"],
        properties: { ...versionSchema.properties, layoutId: uuid, fingerprint, fingerprintVersion: { type: "string", const: "1" } },
      } } } },
    },
  }, async (request) => {
    const aliases = validateLayoutAliases(request.body.aliases, request.body.enabled);
    if (!aliases) throw new ApiError(400, "LAYOUT_ALIASES_INVALID", "Usá etiquetas literales sin datos personales, números ni expresiones.");
    return withTransaction(async (client) => {
      await lockEmployerMutation(client);
      const actorRole = await lockActor(client, request, "layouts.manage", ApiError);
      const employer = await client.query("SELECT status, country_code FROM employers WHERE id = $1 FOR UPDATE", [request.body.employerId]);
      if (employer.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      if (employer.rows[0]!.status !== "VERIFIED" || employer.rows[0]!.country_code !== "AR") {
        throw new ApiError(409, "LAYOUT_EMPLOYER_NOT_VERIFIED", "El formato requiere un empleador argentino verificado.");
      }
      const existing = await client.query("SELECT id FROM document_layouts WHERE employer_id = $1 AND fingerprint_version = $2 AND structural_fingerprint = $3", [request.body.employerId, request.body.fingerprintVersion, request.body.fingerprint]);
      if (!existing.rowCount) {
        const observed = await client.query(`SELECT 1 FROM extraction_runs run
          JOIN documents document ON document.id = run.document_id AND document.user_id = run.user_id
          JOIN users owner ON owner.id = run.user_id
          WHERE run.detected_employer_id = $1 AND run.layout_fingerprint_version = $2 AND run.layout_fingerprint = $3
            AND run.status = 'REVIEW_REQUIRED' AND document.deleted_at IS NULL AND owner.deleted_at IS NULL
            AND owner.status = 'ACTIVE' AND document.security_status = 'CLEAN' AND document.original_deleted_at IS NULL LIMIT 1`,
        [request.body.employerId, request.body.fingerprintVersion, request.body.fingerprint]);
        if (!observed.rowCount) throw new ApiError(409, "LAYOUT_NOT_OBSERVED", "No hay un formato observado en revisión para ese empleador.");
      }
      const layoutId = existing.rows[0]?.id as string | undefined ?? randomUUID();
      if (!existing.rowCount) await client.query(`INSERT INTO document_layouts (id, employer_id, fingerprint_version, structural_fingerprint) VALUES ($1, $2, $3, $4)`, [layoutId, request.body.employerId, request.body.fingerprintVersion, request.body.fingerprint]);
      const version = await client.query(`INSERT INTO document_layout_versions (id, layout_id, version, aliases, enabled, approved_by_user_id)
        SELECT $1, $2, COALESCE(max(version), 0) + 1, $3::jsonb, $4, $5 FROM document_layout_versions WHERE layout_id = $2
        RETURNING id, version, aliases, enabled, approved_at`, [randomUUID(), layoutId, JSON.stringify(aliases), request.body.enabled, request.authUser!.id]);
      const result = { ...versionView(version.rows[0]!), layoutId, fingerprint: request.body.fingerprint, fingerprintVersion: "1" };
      await audit(client, request, actorRole, "layouts.manage", "DOCUMENT_LAYOUT_APPROVED", "DOCUMENT_LAYOUT", layoutId, null, request.body,
        { layoutVersionId: result.id, version: result.version, enabled: result.enabled, fieldCount: Object.keys(aliases).length });
      return { data: result };
    });
  });
}
