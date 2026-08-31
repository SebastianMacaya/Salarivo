import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import {
  EmployerResolutionError,
  followMergedEmployer,
  lockEmployerMutation,
  pool,
  resolveEmployer,
  type PoolClient,
  type ResolveEmployerInput,
  withTransaction,
} from "@salarivo/database";
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
import { MAX_COVERAGE_MONTHS } from "./salary-analytics.ts";
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

async function resolveEmployerForApi(
  client: PoolClient,
  input: ResolveEmployerInput,
  request: FastifyRequest,
) {
  try {
    const employer = await resolveEmployer(client, input);
    const event = employer.outcome === "CREATED"
      ? "employer.pending.created"
      : employer.status === "PENDING"
        ? "employer.pending.reused"
        : "employer.reused";
    request.log.info({
      event,
      employerId: employer.id,
      employerStatus: employer.status,
      matchType: employer.outcome,
      source: input.createdSource,
      ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
    }, event);
    return employer;
  } catch (error) {
    if (error instanceof EmployerResolutionError) {
      request.log.warn({
        event: error.code === "AMBIGUOUS"
          ? "employer.match.ambiguous"
          : error.code === "REJECTED_IDENTIFIER"
            ? "employer.identifier.rejected"
            : "employer.match.invalid",
        resolutionErrorCode: error.code,
        source: input.createdSource,
        ...(input.createdByUserId ? { userId: input.createdByUserId } : {}),
      }, "employer resolution rejected");
      if (error.code === "INVALID_NAME") {
        throw new ApiError(400, "INVALID_EMPLOYER_NAME", "El nombre del empleador no es válido.");
      }
      throw new ApiError(
        409,
        error.code === "AMBIGUOUS" ? "EMPLOYER_AMBIGUOUS" : "EMPLOYER_IDENTIFIER_REJECTED",
        error.code === "AMBIGUOUS"
          ? "Hay más de una empresa compatible; elegí un empleo existente o solicitá revisión."
          : "El identificador de empresa requiere revisión.",
      );
    }
    throw error;
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

const sessionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id", "current", "deviceType", "browser", "operatingSystem", "createdAt", "lastSeenAt", "expiresAt",
  ],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    current: { type: "boolean" },
    deviceType: { type: "string", enum: ["DESKTOP", "MOBILE", "TABLET", "UNKNOWN"] },
    browser: { type: "string", enum: ["CHROME", "EDGE", "FIREFOX", "SAFARI", "OTHER"] },
    operatingSystem: { type: "string", enum: ["WINDOWS", "MACOS", "IOS", "ANDROID", "LINUX", "OTHER"] },
    createdAt: { type: "string" },
    lastSeenAt: { type: "string" },
    expiresAt: { type: "string" },
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
  required: ["id", "name", "countryCode", "status"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    name: { type: "string" },
    countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
    status: { type: "string", enum: ["PENDING", "VERIFIED"] },
  },
};

const employmentSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "employerId",
    "employerName",
    "employerStatus",
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
    employerStatus: { type: "string", enum: ["PENDING", "VERIFIED"] },
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

const employmentDetectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["employerId", "employerName", "currencyCode", "firstPeriod", "lastPeriod", "documentCount", "state"],
  properties: {
    employerId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
    employerName: { type: "string" },
    currencyCode: { type: "string", pattern: "^[A-Z]{3}$" },
    firstPeriod: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    lastPeriod: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    documentCount: { type: "integer", minimum: 1 },
    state: { type: "string", const: "DETECTED" },
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

function sessionFrom(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    current: Boolean(row.current),
    deviceType: String(row.device_type),
    browser: String(row.browser_family),
    operatingSystem: String(row.os_family),
    createdAt: timestamp(row.created_at as Date | string),
    lastSeenAt: timestamp(row.last_seen_at as Date | string),
    expiresAt: timestamp(row.expires_at as Date | string),
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
    status: String(row.status),
  };
}

function employmentFrom(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    employerId: String(row.employer_id),
    employerName: String(row.employer_name),
    employerStatus: String(row.employer_status),
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

export function validateEmploymentDates(
  startValue: string,
  endValue: string | null,
): { startDate: string; endDate: string | null } {
  const startDate = date(startValue);
  const endDate = endValue === null ? null : date(endValue);
  const today = new Date().toISOString().slice(0, 10);
  const invalidBoundary = startDate < "1900-01-01" || startDate > today
    || (endDate !== null && (endDate < startDate || endDate > today));
  const monthIndex = (current: string) => Number(current.slice(0, 4)) * 12 + Number(current.slice(5, 7)) - 1;
  if (invalidBoundary || monthIndex(endDate ?? today) - monthIndex(startDate) + 1 > MAX_COVERAGE_MONTHS) {
    throw new ApiError(400, "VALIDATION_ERROR", "El período laboral no es válido.");
  }
  return { startDate, endDate };
}

function isDatabaseError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

type EmployerBody = { name: string; countryCode: string };
type EmployerPatch = { name?: string; countryCode?: string };
type EmploymentBody = {
  employerId?: string;
  employerName?: string;
  startDate: string;
  endDate?: string | null;
  role?: string | null;
  category?: string | null;
  modality?: string | null;
  countryCode: string;
  currencyCode: string;
};
type EmploymentPatch = Partial<EmploymentBody>;
type EmploymentDetectionBody = {
  employerId?: string | null;
  employerName: string;
  employmentId?: string;
  startDate?: string;
  endDate?: string | null;
  currencyCode: string;
};
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
              s.last_seen_at <= now() - interval '5 minutes' AS activity_touch_due,
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
    if (result.rows[0].activity_touch_due === true) {
      await pool.query(
        `UPDATE sessions SET last_seen_at = clock_timestamp()
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
            AND last_seen_at <= now() - interval '5 minutes'`,
        [digest],
      );
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

  app.get(
    "/api/v1/auth/sessions",
    {
      preHandler: requireAuth,
      schema: { response: responses(200, { type: "array", items: sessionSchema }) },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT id, token_hash = $2 AS current, device_type, browser_family, os_family,
                created_at, last_seen_at, expires_at
           FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY (token_hash = $2) DESC, last_seen_at DESC, created_at DESC, id`,
        [request.authUser!.id, request.authSessionHash],
      );
      return { data: result.rows.map(sessionFrom) };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/auth/sessions/:id",
    {
      preHandler: requireStepUp,
      schema: {
        params: idParamsSchema,
        response: responses(200, {
          type: "object",
          additionalProperties: false,
          required: ["revoked"],
          properties: { revoked: { type: "boolean" } },
        }),
      },
    },
    async (request) => {
      const revoked = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, request.authUser!.id)) {
          throw new ApiError(403, "STEP_UP_REQUIRED", "Confirmá tu identidad para continuar.");
        }
        const target = await client.query(
          `SELECT token_hash = $3 AS current,
                  revoked_at IS NULL AND expires_at > now() AS active
             FROM sessions
            WHERE id = $1 AND user_id = $2
            FOR UPDATE`,
          [request.params.id, request.authUser!.id, request.authSessionHash],
        );
        if (target.rowCount !== 1) {
          throw new ApiError(404, "SESSION_NOT_FOUND", "Sesión no encontrada.");
        }
        if (target.rows[0].current === true) {
          throw new ApiError(409, "CURRENT_SESSION", "La sesión actual no se puede finalizar desde esta acción.");
        }
        if (target.rows[0].active !== true) return false;
        const updated = await client.query(
          `UPDATE sessions SET revoked_at = clock_timestamp()
            WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()
            RETURNING id`,
          [request.params.id, request.authUser!.id],
        );
        if (updated.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO audit_events (
             id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
           ) VALUES ($1, $2, $2, 'SESSION_REVOKED', 'SESSION', $3, 'SUCCESS', '{}'::jsonb)`,
          [randomUUID(), request.authUser!.id, request.params.id],
        );
        return true;
      });
      return { data: { revoked } };
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
        `SELECT employer.id, employer.name, employer.country_code, employer.status
           FROM employers AS employer
          WHERE employer.status IN ('PENDING', 'VERIFIED')
            AND (
              employer.created_by_user_id = $1
              OR EXISTS (
                SELECT 1 FROM employments AS employment
                 WHERE employment.employer_id = employer.id AND employment.user_id = $1
              )
            )
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
      const row = await withTransaction(async (client) => {
        const employer = await resolveEmployerForApi(client, {
          name: text(request.body.name, 160),
          countryCode: countryCode(request.body.countryCode),
          createdByUserId: request.authUser!.id,
          createdSource: "MANUAL",
        }, request);
        const selected = await client.query(
          `SELECT id, name, country_code, status
             FROM employers WHERE id = $1`,
          [employer.id],
        );
        return selected.rows[0];
      });
      return reply.code(201).send({ data: employerFrom(row) });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/v1/employers/:id",
    {
      preHandler: requireStepUp,
      schema: { params: idParamsSchema, response: responses(200, employerSchema) },
    },
    async (request) => {
      const row = await withTransaction(async (client) => {
        const canonical = await followMergedEmployer(client, request.params.id);
        if (!canonical) return null;
        const result = await client.query(
          `SELECT employer.id, employer.name, employer.country_code, employer.status
             FROM employers AS employer
            WHERE employer.id = $1
              AND (
                employer.created_by_user_id = $2
                OR EXISTS (
                  SELECT 1 FROM employments AS employment
                   WHERE employment.employer_id = employer.id AND employment.user_id = $2
                )
              )`,
          [canonical.id, request.authUser!.id],
        );
        return result.rows[0] ?? null;
      });
      if (!row) throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
      return { data: employerFrom(row) };
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
      void request;
      throw new ApiError(409, "EMPLOYER_GLOBAL_IMMUTABLE", "Editá la empresa desde el empleo asociado.");
    },
  );

  app.delete<{ Params: IdParams }>(
    "/api/v1/employers/:id",
    {
      preHandler: requireAuth,
      schema: { params: idParamsSchema, response: responses(200, { type: "null" }) },
    },
    async (request) => {
      void request;
      throw new ApiError(409, "EMPLOYER_GLOBAL_IMMUTABLE", "La identidad global de empresa no se elimina desde esta ruta.");
    },
  );

  const employmentSelect = `
    SELECT e.id, e.employer_id, employer.name AS employer_name,
           employer.status AS employer_status, e.status,
           e.start_date, e.end_date, e.role, e.category, e.modality,
           e.country_code, e.currency_code, e.created_at, e.updated_at
      FROM employments e
      JOIN employers employer ON employer.id = e.employer_id`;

  const detectedEmploymentDocuments = `
    WITH latest_runs AS (
      SELECT DISTINCT ON (run.document_id) run.id, run.document_id, run.user_id
        FROM extraction_runs run
       WHERE run.user_id = $1 AND run.status = 'COMPLETED'
       ORDER BY run.document_id, run.processing_version DESC
    ), detected AS (
      SELECT document.id AS document_id, document.detected_employer_id,
             COALESCE(detected_employer.name, correction.corrected_value #>> '{}', field.interpreted_value #>> '{}') AS employer_name,
             settlement.payroll_period, settlement.currency_code
        FROM documents document
        JOIN latest_runs run
          ON run.document_id = document.id AND run.user_id = document.user_id
        LEFT JOIN employers detected_employer ON detected_employer.id = document.detected_employer_id
        LEFT JOIN LATERAL (
          SELECT current.corrected_value
            FROM user_corrections current
           WHERE current.user_id = run.user_id
             AND current.extraction_run_id = run.id
             AND current.field_path = 'employer.name'
           ORDER BY current.correction_version DESC LIMIT 1
        ) correction ON true
        LEFT JOIN LATERAL (
          SELECT current.interpreted_value
            FROM extracted_fields current
           WHERE current.user_id = run.user_id
             AND current.document_id = run.document_id
             AND current.extraction_run_id = run.id
             AND current.field_path = 'employer.name'
           LIMIT 1
        ) field ON true
        JOIN payroll_settlements settlement
          ON settlement.extraction_run_id = run.id AND settlement.user_id = run.user_id
       WHERE document.user_id = $1 AND document.employment_id IS NULL
         AND document.deleted_at IS NULL AND document.document_type = 'PAYROLL'
         AND document.processing_status IN ('COMPLETED', 'NEEDS_REVIEW')
    )`;

  app.get(
    "/api/v1/employment-detections",
    {
      preHandler: requireAuth,
      schema: { response: responses(200, { type: "array", items: employmentDetectionSchema }) },
    },
    async (request) => {
      const result = await pool.query(
        `${detectedEmploymentDocuments}
         SELECT (array_agg(employer_name ORDER BY payroll_period DESC))[1] AS employer_name,
                 max(detected_employer_id::text)::uuid AS employer_id,
                 currency_code, to_char(min(payroll_period), 'YYYY-MM') AS first_period,
                to_char(max(payroll_period), 'YYYY-MM') AS last_period,
                count(DISTINCT document_id)::integer AS document_count
           FROM detected
          WHERE employer_name IS NOT NULL AND btrim(normalize(employer_name, NFKC)) <> ''
          GROUP BY COALESCE(detected_employer_id::text, normalize_employer_name_conservative(employer_name)), currency_code
          ORDER BY max(payroll_period) DESC,
                   lower(btrim(normalize((array_agg(employer_name ORDER BY payroll_period DESC))[1], NFKC)) COLLATE "und-x-icu")`,
        [request.authUser!.id],
      );
      return { data: result.rows.map((row) => ({
        employerId: row.employer_id === null ? null : String(row.employer_id),
        employerName: String(row.employer_name),
        currencyCode: String(row.currency_code),
        firstPeriod: String(row.first_period),
        lastPeriod: String(row.last_period),
        documentCount: Number(row.document_count),
        state: "DETECTED",
      })) };
    },
  );

  app.post<{ Body: EmploymentDetectionBody }>(
    "/api/v1/employment-detections/confirm",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["employerName", "currencyCode"],
          properties: {
            employerName: { type: "string", minLength: 2, maxLength: 160 },
            employerId: { anyOf: [{ type: "string", pattern: UUID_PATTERN }, { type: "null" }] },
            employmentId: { type: "string", pattern: UUID_PATTERN },
            startDate: { type: "string", pattern: DATE_PATTERN },
            endDate: { anyOf: [{ type: "string", pattern: DATE_PATTERN }, { type: "null" }] },
            currencyCode: { type: "string", minLength: 3, maxLength: 3 },
          },
        },
        response: responses(201, {
          type: "object",
          additionalProperties: false,
          required: ["employment", "associatedDocuments"],
          properties: {
            employment: employmentSchema,
            associatedDocuments: { type: "integer", minimum: 1 },
          },
        }),
      },
    },
    async (request, reply) => {
      const employerName = text(request.body.employerName, 160);
      const selectedCurrency = currencyCode(request.body.currencyCode);
      const requestedDetectedEmployerId = request.body.employerId ?? null;
      const requestedEmploymentId = request.body.employmentId ?? null;
      if (!requestedEmploymentId && !request.body.startDate) {
        throw new ApiError(400, "VALIDATION_ERROR", "Elegí un empleo existente o indicá su fecha de inicio.");
      }
      const requestedDates = requestedEmploymentId
        ? null
        : validateEmploymentDates(request.body.startDate!, request.body.endDate ?? null);
        const result = await withTransaction(async (client) => {
        await lockEmployerMutation(client);
        await client.query("SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE", [request.authUser!.id]);
        let employmentId = requestedEmploymentId;
        let employerId: string;
        let detectedEmployerId: string | null = null;
        let startDate: unknown = requestedDates?.startDate;
        let endDate: unknown = requestedDates?.endDate ?? null;
        if (employmentId) {
          const observedEmployment = await client.query<{
            employer_id: string;
            currency_code: string;
          }>(
            `SELECT employer_id, currency_code
               FROM employments
              WHERE id = $1 AND user_id = $2`,
            [employmentId, request.authUser!.id],
          );
          if (!observedEmployment.rowCount || observedEmployment.rows[0]!.currency_code !== selectedCurrency) {
            throw new ApiError(404, "EMPLOYMENT_NOT_FOUND", "No encontramos ese empleo para la empresa detectada.");
          }
          const observedEmployerId = observedEmployment.rows[0]!.employer_id;
          const existingEmployer = await followMergedEmployer(client, observedEmployerId);
          if (!existingEmployer) {
            throw new ApiError(404, "EMPLOYMENT_NOT_FOUND", "No encontramos ese empleo para la empresa detectada.");
          }
          employerId = existingEmployer.id;
          if (requestedDetectedEmployerId) {
            const detectedEmployer = await followMergedEmployer(client, requestedDetectedEmployerId);
            if (!detectedEmployer || detectedEmployer.id !== employerId) {
              throw new ApiError(404, "DETECTION_NOT_FOUND", "No encontramos esa detección para el empleo elegido.");
            }
            detectedEmployerId = detectedEmployer.id;
          }
          const existingEmployment = await client.query(
            `${employmentSelect}
              WHERE e.id = $1 AND e.user_id = $2 AND e.currency_code = $3
              FOR UPDATE OF e`,
            [employmentId, request.authUser!.id, selectedCurrency],
          );
          if (!existingEmployment.rowCount
            || ![observedEmployerId, existingEmployer.id].includes(String(existingEmployment.rows[0].employer_id))) {
            throw new ApiError(409, "EMPLOYMENT_CHANGED", "El empleo cambió; recargá e intentá nuevamente.");
          }
          startDate = existingEmployment.rows[0].start_date;
          endDate = existingEmployment.rows[0].end_date;
        } else if (requestedDetectedEmployerId) {
          const detectedEmployer = await followMergedEmployer(client, requestedDetectedEmployerId);
          if (!detectedEmployer) {
            throw new ApiError(404, "DETECTION_NOT_FOUND", "No encontramos esa detección.");
          }
          employerId = detectedEmployer.id;
          detectedEmployerId = detectedEmployer.id;
        } else {
          employerId = (await resolveEmployerForApi(client, {
            name: employerName,
            countryCode: "AR",
            createdByUserId: request.authUser!.id,
            createdSource: "DOCUMENT",
          }, request)).id;
        }
        const detected = await client.query(
          `${detectedEmploymentDocuments}
           SELECT DISTINCT document_id
             FROM detected
            WHERE (
                    ($2::uuid IS NOT NULL AND detected_employer_id = $2)
                    OR ($2::uuid IS NULL AND (
                      detected_employer_id = $3
                      OR (detected_employer_id IS NULL
                          AND normalize_employer_name_conservative(employer_name)
                            = normalize_employer_name_conservative($4))
                    ))
                  )
              AND currency_code = $5
              AND payroll_period >= date_trunc('month', $6::date)::date
              AND ($7::date IS NULL OR payroll_period <= date_trunc('month', $7::date)::date)
            ORDER BY document_id`,
          [
            request.authUser!.id, detectedEmployerId, employerId, employerName,
            selectedCurrency, startDate, endDate,
          ],
        );
        if (!detected.rowCount) {
          throw new ApiError(404, "DETECTION_NOT_FOUND", "No encontramos recibos sin asociar para esa empresa y período.");
        }
        const lockedDocuments = await client.query(
          `SELECT id FROM documents
            WHERE user_id = $1 AND employment_id IS NULL AND deleted_at IS NULL
              AND id = ANY($2::uuid[])
            ORDER BY id FOR UPDATE`,
          [request.authUser!.id, detected.rows.map((row) => String(row.document_id))],
        );
        if (!lockedDocuments.rowCount) {
          throw new ApiError(404, "DETECTION_NOT_FOUND", "No encontramos recibos sin asociar para esa empresa y período.");
        }
        if (!employmentId) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM employments
              WHERE user_id = $1 AND employer_id = $2 AND country_code = 'AR'
                AND currency_code = $3 AND start_date = $4
                AND end_date IS NOT DISTINCT FROM $5::date
                AND role IS NULL AND category IS NULL AND modality IS NULL
              ORDER BY id LIMIT 1 FOR UPDATE`,
            [request.authUser!.id, employerId, selectedCurrency, startDate, endDate],
          );
          employmentId = existing.rows[0]?.id ?? randomUUID();
          if (!existing.rowCount) {
            await client.query(
              `INSERT INTO employments (
                 id, user_id, employer_id, status, start_date, end_date, country_code, currency_code
               ) VALUES ($1, $2, $3, $4, $5, $6, 'AR', $7)`,
              [employmentId, request.authUser!.id, employerId, endDate === null ? "ACTIVE" : "ENDED", startDate, endDate, selectedCurrency],
            );
          }
        }
        const documentIds = lockedDocuments.rows.map((row) => String(row.id));
        await client.query(
          `UPDATE documents SET employment_id = $1, detected_employer_id = $2
            WHERE user_id = $3 AND employment_id IS NULL AND id = ANY($4::uuid[])`,
          [employmentId, employerId, request.authUser!.id, documentIds],
        );
        await client.query(
          `UPDATE payroll_settlements SET employment_id = $1
            WHERE user_id = $2 AND document_id = ANY($3::uuid[])`,
          [employmentId, request.authUser!.id, documentIds],
        );
        await client.query(
          `UPDATE import_batch_items AS item SET employment_id = $1, updated_at = now()
            FROM documents AS document
           WHERE document.id = ANY($2::uuid[])
             AND document.import_batch_item_id = item.id
             AND document.user_id = $3 AND item.user_id = $3
             `,
          [employmentId, documentIds, request.authUser!.id],
        );
        await client.query(
          `INSERT INTO audit_events (
             id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
           ) VALUES ($1, $2, $2, 'EMPLOYMENT_DETECTION_CONFIRMED', 'EMPLOYMENT', $3, 'SUCCESS', $4::jsonb)`,
          [randomUUID(), request.authUser!.id, employmentId, JSON.stringify({ documentCount: documentIds.length })],
        );
        const selected = await client.query(
          `${employmentSelect} WHERE e.id = $1 AND e.user_id = $2`,
          [employmentId, request.authUser!.id],
        );
        return { employment: employmentFrom(selected.rows[0]), associatedDocuments: documentIds.length };
      });
      return reply.code(201).send({ data: result });
    },
  );

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
          required: ["startDate", "countryCode", "currencyCode"],
          properties: {
            employerId: { type: "string", pattern: UUID_PATTERN },
            employerName: { type: "string", minLength: 1, maxLength: 160 },
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
      if ((request.body.employerId === undefined) === (request.body.employerName === undefined)) {
        throw new ApiError(400, "VALIDATION_ERROR", "Indicá una empresa por nombre o por ID, no ambas.");
      }
      const { startDate, endDate } = validateEmploymentDates(request.body.startDate, request.body.endDate ?? null);
      const selectedCountry = countryCode(request.body.countryCode);
      const selectedCurrency = currencyCode(request.body.currencyCode);
      const role = optionalText(request.body.role, 120) ?? null;
      const category = optionalText(request.body.category, 120) ?? null;
      const modality = optionalText(request.body.modality, 80) ?? null;

      const created = await withTransaction(async (client) => {
        await lockEmployerMutation(client);
        await client.query(
          "SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE",
          [request.authUser!.id],
        );
        let employerId: string;
        if (request.body.employerName !== undefined) {
          employerId = (await resolveEmployerForApi(client, {
            name: text(request.body.employerName, 160),
            countryCode: selectedCountry,
            createdByUserId: request.authUser!.id,
            createdSource: "MANUAL",
          }, request)).id;
        } else {
          const canonical = await followMergedEmployer(client, request.body.employerId!);
          if (!canonical || canonical.countryCode !== selectedCountry) {
            throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
          }
          const allowed = await client.query(
            `SELECT 1 FROM employers AS employer
              WHERE employer.id = $1
                AND (
                  employer.status = 'VERIFIED'
                  OR employer.created_by_user_id = $2
                  OR EXISTS (
                    SELECT 1 FROM employments AS employment
                     WHERE employment.employer_id = employer.id AND employment.user_id = $2
                  )
                )`,
            [canonical.id, request.authUser!.id],
          );
          if (!allowed.rowCount) throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
          employerId = canonical.id;
        }
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM employments
            WHERE user_id = $1 AND employer_id = $2 AND start_date = $3
              AND end_date IS NOT DISTINCT FROM $4::date
              AND role IS NOT DISTINCT FROM $5::text
              AND category IS NOT DISTINCT FROM $6::text
              AND modality IS NOT DISTINCT FROM $7::text
              AND country_code = $8 AND currency_code = $9
            ORDER BY id LIMIT 1 FOR UPDATE`,
          [
            request.authUser!.id, employerId, startDate, endDate, role, category,
            modality, selectedCountry, selectedCurrency,
          ],
        );
        const employmentId = existing.rows[0]?.id ?? randomUUID();
        if (!existing.rowCount) {
          await client.query(
            `INSERT INTO employments (
               id, user_id, employer_id, status, start_date, end_date, role, category,
               modality, country_code, currency_code
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              employmentId, request.authUser!.id, employerId,
              endDate === null ? "ACTIVE" : "ENDED", startDate, endDate,
              role, category, modality, selectedCountry, selectedCurrency,
            ],
          );
        }
        const selected = await client.query(
          `${employmentSelect} WHERE e.id = $1 AND e.user_id = $2`,
          [employmentId, request.authUser!.id],
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
            employerName: { type: "string", minLength: 1, maxLength: 160 },
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
      if (request.body.employerId !== undefined && request.body.employerName !== undefined) {
        throw new ApiError(400, "VALIDATION_ERROR", "Indicá una empresa por nombre o por ID, no ambas.");
      }

      const row = await withTransaction(async (client) => {
        await lockEmployerMutation(client);
        await client.query("SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE", [userId]);
        const observed = await client.query(
          `SELECT e.employer_id, e.start_date::text, e.end_date::text, e.role, e.category,
                  e.modality, e.country_code, e.currency_code, e.updated_at::text
             FROM employments AS e
            WHERE e.id = $1 AND e.user_id = $2`,
          [request.params.id, userId],
        );
        if (observed.rowCount !== 1) {
          throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        }
        const beforeLock = observed.rows[0];
        const nextCountry = request.body.countryCode === undefined
          ? String(beforeLock.country_code)
          : countryCode(request.body.countryCode);
        let employerId = String(beforeLock.employer_id);
        if (request.body.employerName !== undefined) {
          employerId = (await resolveEmployerForApi(client, {
            name: text(request.body.employerName, 160),
            countryCode: nextCountry,
            createdByUserId: userId,
            createdSource: "MANUAL",
          }, request)).id;
        } else if (request.body.employerId !== undefined) {
          const canonical = await followMergedEmployer(client, request.body.employerId);
          if (!canonical || canonical.countryCode !== nextCountry) {
            throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
          }
          const allowed = await client.query(
            `SELECT 1 FROM employers AS employer
              WHERE employer.id = $1
                AND (
                  employer.status = 'VERIFIED'
                  OR employer.created_by_user_id = $2
                  OR EXISTS (
                    SELECT 1 FROM employments AS employment
                     WHERE employment.employer_id = employer.id AND employment.user_id = $2
                  )
                )`,
            [canonical.id, userId],
          );
          if (!allowed.rowCount) throw new ApiError(404, "NOT_FOUND", "Empleador no encontrado.");
          employerId = canonical.id;
        }
        const current = await client.query(
          `SELECT e.employer_id, e.start_date::text, e.end_date::text, e.role, e.category,
                  e.modality, e.country_code, e.currency_code, e.updated_at::text
             FROM employments AS e
            WHERE e.id = $1 AND e.user_id = $2
            FOR UPDATE`,
          [request.params.id, userId],
        );
        if (current.rowCount !== 1) {
          throw new ApiError(404, "NOT_FOUND", "Recurso no encontrado.");
        }
        if (String(current.rows[0].updated_at) !== String(beforeLock.updated_at)) {
          throw new ApiError(409, "EMPLOYMENT_CHANGED", "El empleo cambió; recargá e intentá nuevamente.");
        }
        const previous = current.rows[0];
        const nextStart = request.body.startDate === undefined
          ? String(previous.start_date)
          : date(request.body.startDate);
        const nextEnd = request.body.endDate === undefined
          ? previous.end_date === null ? null : String(previous.end_date)
          : request.body.endDate === null ? null : date(request.body.endDate);
        validateEmploymentDates(nextStart, nextEnd);
        const nextRole = request.body.role === undefined
          ? previous.role
          : optionalText(request.body.role, 120) ?? null;
        const nextCategory = request.body.category === undefined
          ? previous.category
          : optionalText(request.body.category, 120) ?? null;
        const nextModality = request.body.modality === undefined
          ? previous.modality
          : optionalText(request.body.modality, 80) ?? null;
        const nextCurrency = request.body.currencyCode === undefined
          ? String(previous.currency_code)
          : currencyCode(request.body.currencyCode);
        const duplicate = await client.query(
          `SELECT 1 FROM employments
            WHERE user_id = $1 AND id <> $2 AND employer_id = $3 AND start_date = $4
              AND end_date IS NOT DISTINCT FROM $5::date
              AND role IS NOT DISTINCT FROM $6::text
              AND category IS NOT DISTINCT FROM $7::text
              AND modality IS NOT DISTINCT FROM $8::text
              AND country_code = $9 AND currency_code = $10
            LIMIT 1`,
          [
            userId, request.params.id, employerId, nextStart, nextEnd, nextRole,
            nextCategory, nextModality, nextCountry, nextCurrency,
          ],
        );
        if (duplicate.rowCount) {
          throw new ApiError(409, "EMPLOYMENT_DUPLICATE", "Ese empleo ya existe.");
        }
        const updated = await client.query(
          `UPDATE employments
              SET employer_id = $3, status = $4, start_date = $5, end_date = $6,
                  role = $7, category = $8, modality = $9, country_code = $10,
                  currency_code = $11, updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING id, start_date::text, end_date::text`,
          [
            request.params.id, userId, employerId, nextEnd === null ? "ACTIVE" : "ENDED",
            nextStart, nextEnd, nextRole, nextCategory, nextModality, nextCountry, nextCurrency,
          ],
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
        await lockEmployerMutation(client);
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
