import { randomUUID } from "node:crypto";
import { pool, withTransaction, type PoolClient } from "@salarivo/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.ts";
import {
  buildTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  recoveryCodeHash,
  validateTotpCode,
} from "./mfa.ts";
import { tokenHash } from "./security.ts";
import { lockValidStepUpSession, rotateSession } from "./session-assurance.ts";

type ErrorConstructor = new (statusCode: number, code: string, message: string) => Error;
type Options = {
  config: ApiConfig;
  ApiError: ErrorConstructor;
  requirePrimaryAuth: (request: FastifyRequest) => Promise<void>;
  requireAssuredAuth: (request: FastifyRequest) => Promise<void>;
  requireAssuredStepUp: (request: FastifyRequest) => Promise<void>;
  setSession: (reply: FastifyReply, token: string) => void;
  userSchema: object;
};
type CodeBody = { code: string };

const ENROLLMENT_TTL_MS = 10 * 60_000;
const RECENT_PRIMARY_TTL_MINUTES = 15;
const LOCK_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const codeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["code"],
  properties: { code: { type: "string", minLength: 6, maxLength: 39 } },
};

function envelope(data: object): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data },
  };
}

async function audit(client: PoolClient, userId: string, action: string, factorId: string | null) {
  await client.query(
    `INSERT INTO audit_events (
       id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
     ) VALUES ($1, $2, $2, $3, 'MFA_FACTOR', $4, 'SUCCESS', '{}'::jsonb)`,
    [randomUUID(), userId, action, factorId],
  );
}

type Verification = { ok: true; factorId: string } | { ok: false; locked: boolean } | { ok: false; missing: true };

export async function registerMfaRoutes(app: FastifyInstance, options: Options): Promise<void> {
  const { config, ApiError, requirePrimaryAuth, requireAssuredAuth, requireAssuredStepUp, setSession, userSchema } = options;

  async function verifyFactor(client: PoolClient, userId: string, code: string): Promise<Verification> {
    const result = await client.query(
      `SELECT id, encrypted_secret, key_version, last_used_counter, failed_attempts, locked_until
         FROM mfa_factors
        WHERE user_id = $1 AND status = 'ACTIVE'
        FOR UPDATE`,
      [userId],
    );
    if (result.rowCount !== 1) return { ok: false, missing: true };
    const factor = result.rows[0];
    const now = new Date();
    const lockedUntil = factor.locked_until === null ? null : new Date(factor.locked_until);
    if (lockedUntil && lockedUntil > now) return { ok: false, locked: true };

    const factorId = String(factor.id);
    const secret = decryptMfaSecret(
      String(factor.encrypted_secret),
      Number(factor.key_version),
      { userId, factorId },
      config.mfaKeyring,
    );
    const previousCounter = factor.last_used_counter === null ? null : BigInt(String(factor.last_used_counter));
    const counter = validateTotpCode(secret, code, previousCounter, now.valueOf());
    const recoveryHash = recoveryCodeHash(userId, code);
    const recovery = recoveryHash
      ? await client.query(
          `UPDATE mfa_recovery_codes
              SET used_at = $4
            WHERE user_id = $1 AND factor_id = $2 AND code_hash = $3 AND used_at IS NULL
            RETURNING id`,
          [userId, factorId, recoveryHash, now],
        )
      : { rowCount: 0 };
    if (counter !== null || recovery.rowCount === 1) {
      const rewrapped = Number(factor.key_version) === config.mfaKeyring.activeVersion
        ? null
        : encryptMfaSecret(secret, { userId, factorId }, config.mfaKeyring);
      await client.query(
        `UPDATE mfa_factors
            SET last_used_counter = COALESCE($3, last_used_counter),
                failed_attempts = 0, locked_until = NULL, updated_at = $4,
                encrypted_secret = COALESCE($5, encrypted_secret),
                key_version = COALESCE($6, key_version)
          WHERE id = $1 AND user_id = $2`,
        [factorId, userId, counter?.toString() ?? null, now, rewrapped?.encryptedSecret ?? null, rewrapped?.keyVersion ?? null],
      );
      return { ok: true, factorId };
    }

    const attempts = lockedUntil && lockedUntil <= now ? 1 : Math.min(MAX_ATTEMPTS, Number(factor.failed_attempts) + 1);
    await client.query(
      `UPDATE mfa_factors
          SET failed_attempts = $3,
              locked_until = CASE WHEN $3 = $4 THEN $5 ELSE NULL END,
              updated_at = $6
        WHERE id = $1 AND user_id = $2`,
      [factorId, userId, attempts, MAX_ATTEMPTS, new Date(now.valueOf() + LOCK_TTL_MS), now],
    );
    return { ok: false, locked: attempts === MAX_ATTEMPTS };
  }

  function throwVerification(result: Verification): never {
    if (result.ok) throw new Error("INVALID_MFA_VERIFICATION_STATE");
    if ("missing" in result) throw new ApiError(409, "MFA_NOT_ENABLED", "No hay un segundo factor activo.");
    if (result.locked) throw new ApiError(429, "MFA_LOCKED", "El segundo factor quedó bloqueado temporalmente.");
    throw new ApiError(401, "INVALID_MFA_CODE", "El código no es válido o ya fue usado.");
  }

  async function insertRecoveryCodes(client: PoolClient, userId: string, factorId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await client.query(
      `INSERT INTO mfa_recovery_codes (id, user_id, factor_id, code_hash)
       SELECT ids.id, $2, $3, hashes.code_hash
         FROM unnest($1::uuid[]) WITH ORDINALITY AS ids(id, n)
         JOIN unnest($4::text[]) WITH ORDINALITY AS hashes(code_hash, n) USING (n)`,
      [codes.map(() => randomUUID()), userId, factorId, codes.map((code) => recoveryCodeHash(userId, code))],
    );
    return codes;
  }

  app.get(
    "/api/v1/auth/mfa",
    {
      preHandler: requirePrimaryAuth,
      schema: {
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["enabled", "method", "enabledAt", "pendingEnrollment", "recoveryCodesRemaining"],
            properties: {
              enabled: { type: "boolean" },
              method: { anyOf: [{ type: "string", const: "TOTP" }, { type: "null" }] },
              enabledAt: { anyOf: [{ type: "string" }, { type: "null" }] },
              pendingEnrollment: { type: "boolean" },
              recoveryCodesRemaining: { type: "integer", minimum: 0 },
            },
          }),
        },
      },
    },
    async (request) => {
      const result = await pool.query(
        `SELECT active.id IS NOT NULL AS enabled, active.factor_type AS method, active.enabled_at,
           EXISTS (SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'PENDING' AND pending_expires_at > now()) AS pending,
           (SELECT count(*)::integer
              FROM mfa_recovery_codes code
              JOIN mfa_factors factor ON factor.id = code.factor_id AND factor.user_id = code.user_id
             WHERE code.user_id = $1 AND factor.status = 'ACTIVE' AND code.used_at IS NULL) AS remaining
           FROM (SELECT $1::uuid AS user_id) owner
           LEFT JOIN mfa_factors active ON active.user_id = owner.user_id AND active.status = 'ACTIVE'`,
        [request.authUser!.id],
      );
      return {
        data: {
          enabled: Boolean(result.rows[0].enabled),
          method: result.rows[0].method === "TOTP" ? "TOTP" : null,
          enabledAt: result.rows[0].enabled_at === null ? null : new Date(result.rows[0].enabled_at).toISOString(),
          pendingEnrollment: Boolean(result.rows[0].pending),
          recoveryCodesRemaining: Number(result.rows[0].remaining),
        },
      };
    },
  );

  app.post(
    "/api/v1/auth/mfa/enrollment",
    {
      preHandler: requirePrimaryAuth,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["secret", "otpauthUri", "expiresAt"],
            properties: {
              secret: { type: "string", pattern: "^[A-Z2-7]{32}$" },
              otpauthUri: { type: "string" },
              expiresAt: { type: "string" },
            },
          }),
        },
      },
    },
    async (request) => {
      const userId = request.authUser!.id;
      const factorId = randomUUID();
      const secret = generateTotpSecret();
      const encrypted = encryptMfaSecret(secret, { userId, factorId }, config.mfaKeyring);
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);

      const outcome = await withTransaction(async (client) => {
        const user = await client.query(
          `SELECT session.id AS session_id,
                  session.step_up_expires_at > now() AS stepped_up,
                  session.created_at >= now() - ($3::integer * interval '1 minute') AS recent_primary,
                  EXISTS (
                    SELECT 1 FROM mfa_factors
                     WHERE user_id = u.id AND status = 'ACTIVE'
                  ) AS has_active_factor
             FROM users u
             JOIN sessions AS session
               ON session.user_id = u.id AND session.token_hash = $2
              AND session.revoked_at IS NULL AND session.expires_at > now()
            WHERE u.id = $1 FOR UPDATE OF u, session`,
          [userId, request.authSessionHash, RECENT_PRIMARY_TTL_MINUTES],
        );
        if (user.rowCount !== 1) return "AUTHENTICATION_REQUIRED";
        if (user.rows[0].has_active_factor && !user.rows[0].stepped_up) return "STEP_UP_REQUIRED";
        if (!user.rows[0].has_active_factor && !user.rows[0].recent_primary) return "MFA_ENROLLMENT_REAUTH_REQUIRED";
        await client.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND status = 'PENDING'`, [userId]);
        await client.query(
          `INSERT INTO mfa_factors (
             id, user_id, status, encrypted_secret, key_version, pending_expires_at, pending_session_id
           ) VALUES ($1, $2, 'PENDING', $3, $4, $5, $6)`,
          [factorId, userId, encrypted.encryptedSecret, encrypted.keyVersion, expiresAt, user.rows[0].session_id],
        );
        return "OK";
      });
      if (outcome === "AUTHENTICATION_REQUIRED") throw new ApiError(401, outcome, "Iniciá sesión para continuar.");
      if (outcome === "STEP_UP_REQUIRED") throw new ApiError(403, outcome, "Confirmá tu identidad para continuar.");
      if (outcome === "MFA_ENROLLMENT_REAUTH_REQUIRED") {
        throw new ApiError(403, outcome, `Para configurar la protección, cerrá sesión, volvé a ingresar y repetí el intento dentro de ${RECENT_PRIMARY_TTL_MINUTES} minutos.`);
      }
      return { data: { secret, otpauthUri: buildTotpUri(secret, request.authUser!.email), expiresAt: expiresAt.toISOString() } };
    },
  );

  app.post<{ Body: CodeBody }>(
    "/api/v1/auth/mfa/enrollment/confirm",
    {
      preHandler: requirePrimaryAuth,
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        body: codeBodySchema,
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["recoveryCodes"],
            properties: {
              recoveryCodes: { type: "array", minItems: 10, maxItems: 10, items: { type: "string" } },
            },
          }),
        },
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const outcome = await withTransaction(async (client) => {
        const result = await client.query(
          `SELECT factor.id, factor.encrypted_secret, factor.key_version, factor.last_used_counter,
                  factor.failed_attempts, factor.locked_until, factor.pending_expires_at
             FROM mfa_factors AS factor
             JOIN sessions AS session
               ON session.id = factor.pending_session_id AND session.user_id = factor.user_id
              AND session.token_hash = $2 AND session.revoked_at IS NULL AND session.expires_at > now()
            WHERE factor.user_id = $1 AND factor.status = 'PENDING'
            FOR UPDATE OF factor, session`,
          [userId, request.authSessionHash],
        );
        if (result.rowCount !== 1) return { status: "MISSING" } as const;
        const factor = result.rows[0];
        const now = new Date();
        if (new Date(factor.pending_expires_at) <= now) {
          await client.query(`DELETE FROM mfa_factors WHERE id = $1 AND user_id = $2`, [factor.id, userId]);
          return { status: "EXPIRED" } as const;
        }
        if (factor.locked_until !== null && new Date(factor.locked_until) > now) {
          return { status: "LOCKED" } as const;
        }
        const activeFactor = await client.query(
          `SELECT id FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
          [userId],
        );
        if (
          activeFactor.rowCount !== 0
          && !await lockValidStepUpSession(client, request.authSessionHash!, userId)
        ) return { status: "STEP_UP_REQUIRED" } as const;
        const factorId = String(factor.id);
        const secret = decryptMfaSecret(
          String(factor.encrypted_secret),
          Number(factor.key_version),
          { userId, factorId },
          config.mfaKeyring,
        );
        const previous = factor.last_used_counter === null ? null : BigInt(String(factor.last_used_counter));
        const counter = validateTotpCode(secret, request.body.code, previous, now.valueOf());
        if (counter === null) {
          const expiredLock = factor.locked_until !== null && new Date(factor.locked_until) <= now;
          const attempts = expiredLock ? 1 : Math.min(MAX_ATTEMPTS, Number(factor.failed_attempts) + 1);
          await client.query(
            `UPDATE mfa_factors
                SET failed_attempts = $3,
                    locked_until = CASE WHEN $3 = $4 THEN $5 ELSE NULL END,
                    updated_at = $6
              WHERE id = $1 AND user_id = $2`,
            [factorId, userId, attempts, MAX_ATTEMPTS, new Date(now.valueOf() + LOCK_TTL_MS), now],
          );
          return { status: attempts === MAX_ATTEMPTS ? "LOCKED" : "INVALID" } as const;
        }

        await client.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
        await client.query(
          `UPDATE mfa_factors
              SET status = 'ACTIVE', pending_expires_at = NULL, pending_session_id = NULL, enabled_at = $3,
                  last_used_counter = $4, failed_attempts = 0, locked_until = NULL, updated_at = $3
            WHERE id = $1 AND user_id = $2`,
          [factorId, userId, now, counter.toString()],
        );
        const recoveryCodes = await insertRecoveryCodes(client, userId, factorId);
        const session = await rotateSession(client, request.authSessionHash!, { mfaVerified: true, stepUp: true });
        await client.query(
          `UPDATE sessions SET revoked_at = $3
            WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
          [userId, tokenHash(session.token), now],
        );
        await audit(client, userId, "MFA_ENABLED", factorId);
        return { status: "OK", recoveryCodes, session } as const;
      });
      if (outcome.status === "MISSING") throw new ApiError(409, "MFA_ENROLLMENT_NOT_FOUND", "No hay un enrolamiento pendiente.");
      if (outcome.status === "EXPIRED") throw new ApiError(409, "MFA_ENROLLMENT_EXPIRED", "El enrolamiento venció. Iniciá uno nuevo.");
      if (outcome.status === "LOCKED") throw new ApiError(429, "MFA_LOCKED", "El segundo factor quedó bloqueado temporalmente.");
      if (outcome.status === "STEP_UP_REQUIRED") throw new ApiError(403, outcome.status, "Confirmá tu identidad para continuar.");
      if (outcome.status === "INVALID") throw new ApiError(401, "INVALID_MFA_CODE", "El código no es válido o ya fue usado.");
      if (outcome.status !== "OK") throw new Error("INVALID_MFA_ENROLLMENT_STATE");
      setSession(reply, outcome.session.token);
      return { data: { recoveryCodes: outcome.recoveryCodes } };
    },
  );

  app.post<{ Body: CodeBody }>(
    "/api/v1/auth/mfa/verify",
    {
      preHandler: requirePrimaryAuth,
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: { body: codeBodySchema, response: { 200: envelope(userSchema) } },
    },
    async (request, reply) => {
      const result = await withTransaction(async (client) => {
        const verification = await verifyFactor(client, request.authUser!.id, request.body.code);
        if (!verification.ok) return { verification } as const;
        const session = await rotateSession(client, request.authSessionHash!, { mfaVerified: true, stepUp: true });
        await audit(client, request.authUser!.id, "MFA_VERIFIED", verification.factorId);
        return { verification, session } as const;
      });
      if (!("session" in result)) throwVerification(result.verification);
      setSession(reply, result.session.token);
      return { data: { ...request.authUser!, authState: "AUTHENTICATED", mfaEnabled: true } };
    },
  );

  app.post<{ Body: CodeBody }>(
    "/api/v1/auth/step-up",
    {
      preHandler: requireAssuredAuth,
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        body: codeBodySchema,
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["stepUpExpiresAt"],
            properties: { stepUpExpiresAt: { type: "string" } },
          }),
        },
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const outcome = await withTransaction(async (client) => {
        const verification = await verifyFactor(client, userId, request.body.code);
        if (!verification.ok) return { status: "FACTOR_FAILED", verification } as const;
        const session = await rotateSession(client, request.authSessionHash!, { stepUp: true });
        await audit(client, userId, "AUTH_STEP_UP", null);
        return { status: "OK", session } as const;
      });
      if (outcome.status === "FACTOR_FAILED") throwVerification(outcome.verification);
      setSession(reply, outcome.session.token);
      return { data: { stepUpExpiresAt: outcome.session.stepUpExpiresAt! } };
    },
  );

  app.post(
    "/api/v1/auth/mfa/recovery-codes",
    {
      preHandler: requireAssuredStepUp,
      schema: {
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["recoveryCodes"],
            properties: { recoveryCodes: { type: "array", minItems: 10, maxItems: 10, items: { type: "string" } } },
          }),
        },
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const outcome = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, userId)) return { status: "STEP_UP_REQUIRED" } as const;
        const factor = await client.query(
          `SELECT id FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
          [userId],
        );
        if (factor.rowCount !== 1) return { status: "MFA_NOT_ENABLED" } as const;
        const factorId = String(factor.rows[0].id);
        await client.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND factor_id = $2`, [userId, factorId]);
        const recoveryCodes = await insertRecoveryCodes(client, userId, factorId);
        const session = await rotateSession(client, request.authSessionHash!, { stepUp: true });
        await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
          [userId, tokenHash(session.token)],
        );
        await audit(client, userId, "MFA_RECOVERY_CODES_REGENERATED", factorId);
        return { status: "OK", recoveryCodes, session } as const;
      });
      if (outcome.status === "STEP_UP_REQUIRED") throw new ApiError(403, outcome.status, "Confirmá tu identidad para continuar.");
      if (outcome.status === "MFA_NOT_ENABLED") throw new ApiError(409, outcome.status, "No hay un segundo factor activo.");
      setSession(reply, outcome.session.token);
      return { data: { recoveryCodes: outcome.recoveryCodes } };
    },
  );

  app.delete(
    "/api/v1/auth/mfa",
    {
      preHandler: requireAssuredStepUp,
      schema: { response: { 200: envelope({ type: "null" }) } },
    },
    async (request, reply) => {
      if (request.authUser!.role === "ADMIN") {
        throw new ApiError(409, "ADMIN_MFA_REQUIRED", "Un administrador no puede desactivar su segundo factor.");
      }
      const userId = request.authUser!.id;
      const outcome = await withTransaction(async (client) => {
        if (!await lockValidStepUpSession(client, request.authSessionHash!, userId)) return { status: "STEP_UP_REQUIRED" } as const;
        const current = await client.query(
          `SELECT role FROM users WHERE id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL FOR UPDATE`,
          [userId],
        );
        if (current.rowCount !== 1) return { status: "AUTHENTICATION_REQUIRED" } as const;
        if (current.rows[0].role === "ADMIN") return { status: "ADMIN_MFA_REQUIRED" } as const;
        const factor = await client.query(
          `DELETE FROM mfa_factors WHERE user_id = $1 AND status = 'ACTIVE' RETURNING id`,
          [userId],
        );
        if (factor.rowCount !== 1) return { status: "MFA_NOT_ENABLED" } as const;
        const session = await rotateSession(client, request.authSessionHash!, { clearAssurance: true });
        await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND token_hash <> $2 AND revoked_at IS NULL`,
          [userId, tokenHash(session.token)],
        );
        await audit(client, userId, "MFA_DISABLED", String(factor.rows[0].id));
        return { status: "OK", session } as const;
      });
      if (outcome.status === "STEP_UP_REQUIRED") throw new ApiError(403, outcome.status, "Confirmá tu identidad para continuar.");
      if (outcome.status === "AUTHENTICATION_REQUIRED") throw new ApiError(401, outcome.status, "Iniciá sesión para continuar.");
      if (outcome.status === "ADMIN_MFA_REQUIRED") throw new ApiError(409, outcome.status, "Un administrador no puede desactivar su segundo factor.");
      if (outcome.status === "MFA_NOT_ENABLED") throw new ApiError(409, outcome.status, "No hay un segundo factor activo.");
      setSession(reply, outcome.session.token);
      return { data: null };
    },
  );
}
