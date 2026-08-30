import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import { pool, withTransaction } from "@salarivo/database";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
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
import { registerAdminRoutes } from "./admin-routes.ts";
import { registerDataRoutes } from "./data-routes.ts";
import type { Storage } from "./storage.ts";
import { registerGoogleAuthRoutes } from "./google-auth-routes.ts";
import { createGoogleOidc, type GoogleOidcClient } from "./google-oidc.ts";
import { registerMfaRoutes } from "./mfa-routes.ts";
import { lockValidStepUpSession } from "./session-assurance.ts";
import {
  hasTrustedMutationOrigin,
  sessionCookieName,
  tokenHash,
} from "./security.ts";

type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: "USER" | "ADMIN";
  adminRole: AdminRole | null;
  permissions: readonly AdminPermission[];
  createdAt: string;
  authState: "AUTHENTICATED" | "MFA_REQUIRED" | "MFA_SETUP_REQUIRED";
  mfaEnabled: boolean;
  onboardingCompleted: boolean;
  authMethods: "GOOGLE"[];
};

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    authSessionHash: string | null;
    authStepUp: boolean;
  }
}

class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

type RegistrationLegalDocument = {
  id: unknown;
  document_type: unknown;
  version: unknown;
  requires_acceptance: unknown;
  approved_for_production: unknown;
};

export function validateRegistrationLegalDocuments(
  appEnv: ApiConfig["appEnv"],
  documents: RegistrationLegalDocument[],
): { terms: RegistrationLegalDocument; privacy: RegistrationLegalDocument } {
  const byType = new Map(documents.map((document) => [String(document.document_type), document]));
  const terms = byType.get("TERMS");
  const privacy = byType.get("PRIVACY_NOTICE");
  if (!terms || terms.requires_acceptance !== true || !privacy) {
    throw new ApiError(503, "LEGAL_DOCUMENTS_UNAVAILABLE", "No se puede crear la cuenta sin los documentos legales vigentes.");
  }
  if (
    appEnv === "production"
    && (terms.approved_for_production !== true || privacy.approved_for_production !== true)
  ) {
    throw new ApiError(503, "LEGAL_REVIEW_REQUIRED", "El alta está cerrada hasta aprobar los documentos legales de producción.");
  }
  return { terms, privacy };
}

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const TOKEN_PATTERN = "^[A-Za-z0-9_-]{43}$";
const nullableText = (maximum: number) => ({
  anyOf: [
    { type: "string", minLength: 1, maxLength: maximum },
    { type: "null" },
  ],
});

const errorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
    },
  },
};

const userSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "email", "displayName", "role", "adminRole", "permissions", "createdAt", "authState", "mfaEnabled",
    "onboardingCompleted", "authMethods",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    email: { type: "string" },
    displayName: nullableText(100),
    role: { type: "string", enum: ["USER", "ADMIN"] },
    adminRole: { anyOf: [{ type: "string", enum: [...adminRoles] }, { type: "null" }] },
    permissions: { type: "array", uniqueItems: true, items: { type: "string", enum: [...adminPermissions] } },
    createdAt: { type: "string" },
    authState: { type: "string", enum: ["AUTHENTICATED", "MFA_REQUIRED", "MFA_SETUP_REQUIRED"] },
    mfaEnabled: { type: "boolean" },
    onboardingCompleted: { type: "boolean" },
    authMethods: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", const: "GOOGLE" },
    },
  },
};

const legalDocumentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "version", "locale", "title", "content", "effectiveAt", "requiresAcceptance"],
  properties: {
    documentType: { type: "string", enum: ["TERMS", "PRIVACY_NOTICE"] },
    version: { type: "string" },
    locale: { type: "string" },
    title: { type: "string" },
    content: { type: "string" },
    effectiveAt: { type: "string" },
    requiresAcceptance: { type: "boolean" },
  },
};

const employerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "countryCode", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    name: { type: "string" },
    countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
};

const employmentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "employerId",
    "employerName",
    "status",
    "startDate",
    "endDate",
    "role",
    "category",
    "modality",
    "countryCode",
    "currencyCode",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    employerId: { type: "string", pattern: UUID_PATTERN },
    employerName: { type: "string" },
    status: { type: "string", enum: ["ACTIVE", "ENDED"] },
    startDate: { type: "string", pattern: DATE_PATTERN },
    endDate: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
    role: nullableText(120),
    category: nullableText(120),
    modality: nullableText(80),
    countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
    currencyCode: { type: "string", pattern: "^[A-Z]{3}$" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
};

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

function envelope(data: object): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data },
  };
}

function responses(status: number, data: object): Record<number, object> {
  return {
    [status]: envelope(data),
    400: errorSchema,
    401: errorSchema,
    403: errorSchema,
    404: errorSchema,
    409: errorSchema,
    413: errorSchema,
    415: errorSchema,
    429: errorSchema,
    500: errorSchema,
    503: errorSchema,
  };
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function userFrom(row: Record<string, unknown>): AuthUser {
  const role = row.role === "ADMIN" ? "ADMIN" : "USER";
  const adminRole = role === "ADMIN" && isAdminRole(row.admin_role) ? row.admin_role : null;
  const mfaEnabled = Boolean(row.mfa_enabled);
  const authState = role === "ADMIN" && !mfaEnabled
    ? "MFA_SETUP_REQUIRED"
    : mfaEnabled && !row.mfa_verified_at
      ? "MFA_REQUIRED"
      : "AUTHENTICATED";
  const authMethods: "GOOGLE"[] = row.google_enabled === true ? ["GOOGLE"] : [];
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: row.display_name === null ? null : String(row.display_name),
    role,
    adminRole,
    permissions: permissionsForAdminRole(adminRole),
    createdAt: timestamp(row.created_at as Date | string),
    authState,
    mfaEnabled,
    onboardingCompleted: row.onboarding_completed_at !== null && row.onboarding_completed_at !== undefined,
    authMethods,
  };
}

function legalDocumentFrom(row: Record<string, unknown>) {
  return {
    documentType: String(row.document_type),
    version: String(row.version),
    locale: String(row.locale),
    title: String(row.title),
    content: String(row.content),
    effectiveAt: timestamp(row.effective_at as Date | string),
    requiresAcceptance: Boolean(row.requires_acceptance),
  };
}

function employerFrom(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    countryCode: String(row.country_code),
    createdAt: timestamp(row.created_at as Date | string),
    updatedAt: timestamp(row.updated_at as Date | string),
  };
}

function employmentFrom(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    employerId: String(row.employer_id),
    employerName: String(row.employer_name),
    status: String(row.status),
    startDate: row.start_date instanceof Date
      ? row.start_date.toISOString().slice(0, 10)
      : String(row.start_date),
    endDate: row.end_date === null
      ? null
      : row.end_date instanceof Date
        ? row.end_date.toISOString().slice(0, 10)
        : String(row.end_date),
    role: row.role === null ? null : String(row.role),
    category: row.category === null ? null : String(row.category),
    modality: row.modality === null ? null : String(row.modality),
    countryCode: String(row.country_code),
    currencyCode: String(row.currency_code),
    createdAt: timestamp(row.created_at as Date | string),
    updatedAt: timestamp(row.updated_at as Date | string),
  };
}

function text(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new ApiError(400, "VALIDATION_ERROR", "Los datos enviados no son válidos.");
  }
  return normalized;
}

function optionalText(value: string | null | undefined, maximum: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  return text(value, maximum);
}

function countryCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Los datos enviados no son válidos.");
  }
  return normalized;
}

function currencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Los datos enviados no son válidos.");
  }
  return normalized;
}

function date(value: string): string {
  if (!new RegExp(DATE_PATTERN).test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Los datos enviados no son válidos.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "VALIDATION_ERROR", "Los datos enviados no son válidos.");
  }
  return value;
}

function isDatabaseError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

type EmployerBody = { name: string; countryCode: string };
type EmployerPatch = { name?: string; countryCode?: string };
type EmploymentBody = {
  employerId: string;
  startDate: string;
  endDate?: string | null;
  role?: string | null;
  category?: string | null;
  modality?: string | null;
  countryCode: string;
  currencyCode: string;
};
type EmploymentPatch = Partial<EmploymentBody>;
type IdParams = { id: string };
type LegalParams = { type: "terms" | "privacy" };
type LegalQuery = { version?: string };

export async function buildApp(
  config: ApiConfig,
  options: { provisionStorage?: boolean; googleOidc?: GoogleOidcClient; storage?: Storage } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 256 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false } },
    logger:
      config.logLevel === "silent"
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                "res.headers.set-cookie",
              ],
              censor: "[REDACTED]",
            },
          },
  });
  app.decorateRequest("authUser", null);
  app.decorateRequest("authSessionHash", null);
  app.decorateRequest("authStepUp", false);
  const googleOidc = options.googleOidc ?? createGoogleOidc(config.googleOAuth);
  const clientRateKey = (request: FastifyRequest) => {
    const forwarded = config.appEnv === "production" ? request.headers["cf-connecting-ip"] : undefined;
    return normalizeIP(typeof forwarded === "string" && isIP(forwarded) ? forwarded : request.ip);
  };

  await app.register(cookie);
  await app.register(cors, {
    origin: config.publicOrigin,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(helmet);
  // ponytail: local in-memory limit; move counters to Redis when the API runs in more than one process.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: clientRateKey,
  });

  app.addHook("onRequest", async (request) => {
    if (
      request.url.startsWith("/api/v1/") &&
      !hasTrustedMutationOrigin(request.method, request.headers.origin, config.publicOrigin)
    ) {
      throw new ApiError(403, "UNTRUSTED_ORIGIN", "Origen no autorizado.");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1/") && !request.url.startsWith("/api/v1/legal/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    let statusCode = 500;
    let code = "INTERNAL_ERROR";
    let message = "No se pudo completar la operación.";
    const errorObject = typeof error === "object" && error !== null ? error : null;
    const errorStatus = errorObject && "statusCode" in errorObject && typeof errorObject.statusCode === "number"
      ? errorObject.statusCode
      : undefined;

    if (error instanceof ApiError) {
      ({ statusCode, code, message } = error);
    } else if (errorObject && "validation" in errorObject && errorObject.validation) {
      statusCode = 400;
      code = "VALIDATION_ERROR";
      message = "Los datos enviados no son válidos.";
    } else if (errorStatus === 429) {
      statusCode = 429;
      code = "RATE_LIMITED";
      message = "Demasiados intentos. Probá nuevamente más tarde.";
    } else if (errorStatus === 413) {
      statusCode = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "El cuerpo de la solicitud supera el límite permitido.";
    } else if (errorStatus === 415) {
      statusCode = 415;
      code = "UNSUPPORTED_MEDIA_TYPE";
      message = "El tipo de contenido no está soportado.";
    } else if (errorStatus === 400) {
      statusCode = 400;
      code = "VALIDATION_ERROR";
      message = "Los datos enviados no son válidos.";
    } else if (isDatabaseError(error)) {
      if (error.code === "23505") {
        statusCode = 409;
        code = "CONFLICT";
        message = "El recurso ya existe.";
      } else if (["23502", "23514", "22P02"].includes(error.code)) {
        statusCode = 400;
        code = "VALIDATION_ERROR";
        message = "Los datos enviados no son válidos.";
      } else if (error.code === "23503") {
        statusCode = 409;
        code = "RESOURCE_IN_USE";
        message = "El recurso está en uso y no se puede eliminar.";
      }
    }

    if (statusCode === 500) {
      request.log.error({ requestId: request.id, errorCode: code }, "request failed");
    }
    void reply.code(statusCode).send({ error: { code, message, requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Recurso no encontrado.", requestId: request.id },
    });
  });

  const oauthAttemptCleanup = setInterval(() => {
    void pool.query(`DELETE FROM oauth_attempts WHERE expires_at <= now()`).catch(() => {
      app.log.warn({ errorCode: "OAUTH_ATTEMPT_CLEANUP_FAILED" }, "oauth attempt cleanup failed");
    });
  }, 60_000);
  oauthAttemptCleanup.unref();
  app.addHook("onClose", async () => clearInterval(oauthAttemptCleanup));

  const legacySessionCookie = "salarivo_session";
  const sessionCookie = sessionCookieName(config.appEnv);
  const cookieOptions = {
    httpOnly: true,
    secure: config.appEnv === "production",
    sameSite: "lax" as const,
    path: "/",
  };

  async function requirePrimaryAuth(request: FastifyRequest): Promise<void> {
    const rawToken = request.cookies[sessionCookie];
    if (!rawToken || !new RegExp(TOKEN_PATTERN).test(rawToken)) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
    }

    const digest = tokenHash(rawToken);
    const result = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role, u.admin_role, u.created_at,
              u.onboarding_completed_at,
              EXISTS (
                SELECT 1 FROM auth_accounts account
                 WHERE account.user_id = u.id AND account.provider = 'GOOGLE'
              ) AS google_enabled,
              s.mfa_verified_at, s.step_up_expires_at,
              EXISTS (
                SELECT 1 FROM mfa_factors factor
                 WHERE factor.user_id = u.id AND factor.status = 'ACTIVE'
              ) AS mfa_enabled
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'ACTIVE'
          AND u.deleted_at IS NULL
          AND EXISTS (
                SELECT 1 FROM auth_accounts account
                 WHERE account.user_id = u.id AND account.provider = 'GOOGLE'
              )`,
      [digest],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
    }
    request.authUser = userFrom(result.rows[0]);
    request.authSessionHash = digest;
    request.authStepUp = result.rows[0].step_up_expires_at !== null
      && new Date(result.rows[0].step_up_expires_at) > new Date();
  }

  async function requireAuth(request: FastifyRequest): Promise<void> {
    await requirePrimaryAuth(request);
    if (request.authUser!.authState === "MFA_REQUIRED") {
      throw new ApiError(403, "MFA_REQUIRED", "Ingresá el código de tu segundo factor para continuar.");
    }
    if (request.authUser!.authState === "MFA_SETUP_REQUIRED") {
      throw new ApiError(403, "MFA_SETUP_REQUIRED", "Configurá el segundo factor para continuar.");
    }
  }

  async function requireStepUp(request: FastifyRequest): Promise<void> {
    await requireAuth(request);
    if (!request.authStepUp) {
      throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
    }
  }

  async function requireAdminPermission(
    request: FastifyRequest,
    permission: AdminPermission,
    stepUp = false,
  ): Promise<void> {
    await requireAuth(request);
    if (!hasAdminPermission(request.authUser!.adminRole, permission)) {
      throw new ApiError(403, "ADMIN_PERMISSION_REQUIRED", "No tenés permisos para realizar esta operación.");
    }
    if (stepUp && !request.authStepUp) {
      throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
    }
  }

  function setSession(reply: FastifyReply, token: string): void {
    if (sessionCookie !== legacySessionCookie) reply.clearCookie(legacySessionCookie, cookieOptions);
    reply.setCookie(sessionCookie, token, {
      ...cookieOptions,
      maxAge: config.sessionTtlSeconds,
    });
  }

  function clearSession(reply: FastifyReply): void {
    reply.clearCookie(sessionCookie, cookieOptions);
    if (sessionCookie !== legacySessionCookie) reply.clearCookie(legacySessionCookie, cookieOptions);
  }

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status"],
            properties: { status: { type: "string", const: "ok" } },
          },
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  app.get<{ Params: LegalParams; Querystring: LegalQuery }>(
    "/api/v1/legal/:type",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: { type: { type: "string", enum: ["terms", "privacy"] } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { version: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" } },
        },
        response: responses(200, legalDocumentSchema),
      },
    },
    async (request, reply) => {
      const documentType = request.params.type === "terms" ? "TERMS" : "PRIVACY_NOTICE";
      const values: unknown[] = [documentType];
      let versionFilter = "";
      if (request.query.version) {
        values.push(request.query.version);
        versionFilter = `AND version = $${values.length}`;
      }
      const result = await pool.query(
        `SELECT document_type, version, locale, title, content, effective_at, requires_acceptance
           FROM legal_document_versions
          WHERE document_type = $1 AND locale = 'es-AR'
            AND published_at <= now() AND effective_at <= now()
            ${versionFilter}
          ORDER BY effective_at DESC, published_at DESC
          LIMIT 1`,
        values,
      );
      if (result.rowCount !== 1) throw new ApiError(404, "LEGAL_DOCUMENT_NOT_FOUND", "Documento legal no encontrado.");
      reply.header("Cache-Control", "public, max-age=300");
      return { data: legalDocumentFrom(result.rows[0]) };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    {
      schema: { response: responses(200, { type: "null" }) },
    },
    async (request, reply) => {
      const rawToken = request.cookies[sessionCookie];
      if (rawToken && new RegExp(TOKEN_PATTERN).test(rawToken)) {
        await pool.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE token_hash = $1 AND revoked_at IS NULL`,
          [tokenHash(rawToken)],
        );
      }
      clearSession(reply);
      return { data: null };
    },
  );

  app.get(
    "/api/v1/auth/me",
    {
      preHandler: requirePrimaryAuth,
      schema: { response: responses(200, userSchema) },
    },
    async (request) => ({ data: request.authUser }),
  );

  app.post(
    "/api/v1/auth/onboarding/complete",
    {
      preHandler: requireAuth,
      schema: { response: responses(200, userSchema) },
    },
    async (request) => {
      const completed = await withTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE users SET onboarding_completed_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'ACTIVE' AND onboarding_completed_at IS NULL
            RETURNING id`,
          [request.authUser!.id],
        );
        if (updated.rowCount === 1) {
          await client.query(
            `INSERT INTO audit_events (
               id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
             ) VALUES ($1, $2, $2, 'ONBOARDING_COMPLETED', 'ACCOUNT', $2, 'SUCCESS', '{}'::jsonb)`,
            [randomUUID(), request.authUser!.id],
          );
        }
        return updated.rowCount === 1;
      });
      return { data: completed ? { ...request.authUser!, onboardingCompleted: true } : request.authUser! };
    },
  );

  app.post(
    "/api/v1/auth/sessions/revoke-others",
    {
      preHandler: requireStepUp,
      schema: {
        response: responses(200, {
          type: "object",
          additionalProperties: false,
          required: ["revokedSessions"],
          properties: { revokedSessions: { type: "integer", minimum: 0 } },
        }),
      },
    },
    async (request) => {
      const revokedSessions = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const activeUser = await client.query(
          `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE`,
          [request.authUser!.id],
        );
        if (activeUser.rowCount !== 1) {
          throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Iniciá sesión para continuar.");
        }
        const revoked = await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL AND expires_at > now()`,
          [request.authUser!.id, request.authSessionHash],
        );
        await client.query(
          `INSERT INTO audit_events (
             id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
           ) VALUES ($1, $2, $2, 'OTHER_SESSIONS_REVOKED', 'ACCOUNT', $2, 'SUCCESS', $3::jsonb)`,
          [randomUUID(), request.authUser!.id, JSON.stringify({ revokedSessions: revoked.rowCount ?? 0 })],
        );
        return revoked.rowCount ?? 0;
      });
      return { data: { revokedSessions } };
    },
  );

  await registerGoogleAuthRoutes(app, {
    config,
    google: googleOidc,
    ApiError,
    requirePrimaryAuth,
    setSession,
    userSchema,
    userFrom,
    validateLegalDocuments: validateRegistrationLegalDocuments,
  });

  await registerMfaRoutes(app, {
    config,
    ApiError,
    requirePrimaryAuth,
    requireAuth,
    requireStepUp,
    setSession,
    userSchema,
  });

  await registerAdminRoutes(app, { config, ApiError, requireAdminPermission });

  app.get(
    "/api/v1/employers",
    {
      preHandler: requireAuth,
      schema: {
        response: responses(200, { type: "array", items: employerSchema }),
      },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT id, name, country_code, created_at, updated_at
           FROM employers
          WHERE user_id = $1
          ORDER BY lower(name), id`,
        [request.authUser!.id],
      );
      return { data: result.rows.map(employerFrom) };
    },
  );

  app.post<{ Body: EmployerBody }>(
    "/api/v1/employers",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "countryCode"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            countryCode: { type: "string", minLength: 2, maxLength: 2 },
          },
        },
        response: responses(201, employerSchema),
      },
    },
    async (request, reply) => {
      const result = await pool.query(
        `INSERT INTO employers (id, user_id, name, country_code)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, country_code, created_at, updated_at`,
        [
          randomUUID(),
          request.authUser!.id,
          text(request.body.name, 160),
          countryCode(request.body.countryCode),
        ],
      );
      return reply.code(201).send({ data: employerFrom(result.rows[0]) });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/employers/:id",
    {
      preHandler: requireStepUp,
      schema: { params: idParamsSchema, response: responses(200, employerSchema) },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT id, name, country_code, created_at, updated_at
           FROM employers WHERE id = $1 AND user_id = $2`,
        [request.params.id, request.authUser!.id],
      );
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: employerFrom(result.rows[0]) };
    },
  );

  app.patch<{ Params: IdParams; Body: EmployerPatch }>(
    "/api/v1/employers/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            countryCode: { type: "string", minLength: 2, maxLength: 2 },
          },
        },
        response: responses(200, employerSchema),
      },
    },
    async (request) => {
      const values: unknown[] = [request.params.id, request.authUser!.id];
      const updates: string[] = [];
      if (request.body.name !== undefined) {
        values.push(text(request.body.name, 160));
        updates.push(`name = $${values.length}`);
      }
      if (request.body.countryCode !== undefined) {
        values.push(countryCode(request.body.countryCode));
        updates.push(`country_code = $${values.length}`);
      }
      updates.push("updated_at = now()");

      const result = await pool.query(
        `UPDATE employers SET ${updates.join(", ")}
          WHERE id = $1 AND user_id = $2
          RETURNING id, name, country_code, created_at, updated_at`,
        values,
      );
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: employerFrom(result.rows[0]) };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/employers/:id",
    {
      preHandler: requireAuth,
      schema: { params: idParamsSchema, response: responses(200, { type: "null" }) },
    },
    async (request) => {
      const outcome = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const employer = await client.query(
          `SELECT id FROM employers WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [request.params.id, request.authUser!.id],
        );
        if (employer.rowCount !== 1) return "NOT_FOUND";
        const employment = await client.query(
          `SELECT 1 FROM employments WHERE employer_id = $1 AND user_id = $2 LIMIT 1`,
          [request.params.id, request.authUser!.id],
        );
        if (employment.rowCount !== 0) return "IN_USE";
        await client.query(`DELETE FROM employers WHERE id = $1 AND user_id = $2`, [
          request.params.id,
          request.authUser!.id,
        ]);
        return "DELETED";
      });
      if (outcome === "NOT_FOUND") throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      if (outcome === "IN_USE") {
        throw new ApiError(409, "RESOURCE_IN_USE", "El empleador tiene empleos asociados.");
      }
      return { data: null };
    },
  );

  const employmentSelect = `
    SELECT e.id, e.employer_id, employer.name AS employer_name, e.status,
           e.start_date, e.end_date, e.role, e.category, e.modality,
           e.country_code, e.currency_code, e.created_at, e.updated_at
      FROM employments e
      JOIN employers employer ON employer.id = e.employer_id AND employer.user_id = e.user_id`;

  app.get(
    "/api/v1/employments",
    {
      preHandler: requireAuth,
      schema: {
        response: responses(200, { type: "array", items: employmentSchema }),
      },
    },
    async (request) => {
      const result = await pool.query(
        `${employmentSelect}
          WHERE e.user_id = $1
          ORDER BY e.start_date DESC, e.id`,
        [request.authUser!.id],
      );
      return { data: result.rows.map(employmentFrom) };
    },
  );

  app.post<{ Body: EmploymentBody }>(
    "/api/v1/employments",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["employerId", "startDate", "countryCode", "currencyCode"],
          properties: {
            employerId: { type: "string", pattern: UUID_PATTERN },
            startDate: { type: "string", pattern: DATE_PATTERN },
            endDate: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
            role: nullableText(120),
            category: nullableText(120),
            modality: nullableText(80),
            countryCode: { type: "string", minLength: 2, maxLength: 2 },
            currencyCode: { type: "string", minLength: 3, maxLength: 3 },
          },
        },
        response: responses(201, employmentSchema),
      },
    },
    async (request, reply) => {
      const startDate = date(request.body.startDate);
      const endDate = request.body.endDate === undefined || request.body.endDate === null
        ? null
        : date(request.body.endDate);
      if (endDate !== null && endDate < startDate) {
        throw new ApiError(400, "VALIDATION_ERROR", "La fecha de fin no puede ser anterior al inicio.");
      }

      const created = await withTransaction(async (client) => {
        const result = await client.query(
          `INSERT INTO employments (
             id, user_id, employer_id, status, start_date, end_date, role, category,
             modality, country_code, currency_code
           )
           SELECT $1, $2, employer.id, $4, $5, $6, $7, $8, $9, $10, $11
             FROM employers employer
            WHERE employer.id = $3 AND employer.user_id = $2
           RETURNING id`,
          [
            randomUUID(),
            request.authUser!.id,
            request.body.employerId,
            endDate === null ? "ACTIVE" : "ENDED",
            startDate,
            endDate,
            optionalText(request.body.role, 120) ?? null,
            optionalText(request.body.category, 120) ?? null,
            optionalText(request.body.modality, 80) ?? null,
            countryCode(request.body.countryCode),
            currencyCode(request.body.currencyCode),
          ],
        );
        if (result.rowCount !== 1) {
          throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
        }
        const selected = await client.query(
          `${employmentSelect} WHERE e.id = $1 AND e.user_id = $2`,
          [result.rows[0].id, request.authUser!.id],
        );
        return selected.rows[0];
      });
      return reply.code(201).send({ data: employmentFrom(created) });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/employments/:id",
    {
      preHandler: requireStepUp,
      schema: { params: idParamsSchema, response: responses(200, employmentSchema) },
    },
    async (request) => {
      const result = await pool.query(`${employmentSelect} WHERE e.id = $1 AND e.user_id = $2`, [
        request.params.id,
        request.authUser!.id,
      ]);
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: employmentFrom(result.rows[0]) };
    },
  );

  app.patch<{ Params: IdParams; Body: EmploymentPatch }>(
    "/api/v1/employments/:id",
    {
      preHandler: requireAuth,
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            employerId: { type: "string", pattern: UUID_PATTERN },
            startDate: { type: "string", pattern: DATE_PATTERN },
            endDate: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
            role: nullableText(120),
            category: nullableText(120),
            modality: nullableText(80),
            countryCode: { type: "string", minLength: 2, maxLength: 2 },
            currencyCode: { type: "string", minLength: 3, maxLength: 3 },
          },
        },
        response: responses(200, employmentSchema),
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const values: unknown[] = [request.params.id, userId];
      const updates: string[] = [];
      const add = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };
      if (request.body.employerId !== undefined) add("employer_id", request.body.employerId);
      if (request.body.startDate !== undefined) add("start_date", date(request.body.startDate));
      if (request.body.endDate !== undefined) {
        add("end_date", request.body.endDate === null ? null : date(request.body.endDate));
        add("status", request.body.endDate === null ? "ACTIVE" : "ENDED");
      }
      if (request.body.role !== undefined) add("role", optionalText(request.body.role, 120));
      if (request.body.category !== undefined) add("category", optionalText(request.body.category, 120));
      if (request.body.modality !== undefined) add("modality", optionalText(request.body.modality, 80));
      if (request.body.countryCode !== undefined) add("country_code", countryCode(request.body.countryCode));
      if (request.body.currencyCode !== undefined) add("currency_code", currencyCode(request.body.currencyCode));
      updates.push("updated_at = now()");

      const row = await withTransaction(async (client) => {
        if (request.body.employerId !== undefined) {
          const employer = await client.query(
            `SELECT 1 FROM employers WHERE id = $1 AND user_id = $2 FOR KEY SHARE`,
            [request.body.employerId, userId],
          );
          if (employer.rowCount !== 1) {
            throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
          }
        }
        const updated = await client.query(
          `UPDATE employments SET ${updates.join(", ")}
            WHERE id = $1 AND user_id = $2 RETURNING id`,
          values,
        );
        if (updated.rowCount !== 1) {
          throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        }
        const selected = await client.query(
          `${employmentSelect} WHERE e.id = $1 AND e.user_id = $2`,
          [request.params.id, userId],
        );
        return selected.rows[0];
      });
      return { data: employmentFrom(row) };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/employments/:id",
    {
      preHandler: requireAuth,
      schema: { params: idParamsSchema, response: responses(200, { type: "null" }) },
    },
    async (request) => {
      const result = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        return client.query(
          `DELETE FROM employments WHERE id = $1 AND user_id = $2 RETURNING id`,
          [request.params.id, request.authUser!.id],
        );
      });
      if (result.rowCount !== 1) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: null };
    },
  );

  await registerDataRoutes(app, {
    config,
    requireAuth,
    requireStepUp,
    ApiError,
    provisionStorage: options.provisionStorage ?? config.appEnv !== "test",
    ...(options.storage ? { storage: options.storage } : {}),
  });

  return app;
}
