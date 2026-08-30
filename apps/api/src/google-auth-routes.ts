import { createHash, randomUUID } from "node:crypto";
import { pool, withTransaction, type PoolClient } from "@salarivo/database";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiConfig } from "./config.ts";
import type { GoogleIdentity, GoogleOidcClient } from "./google-oidc.ts";
import { oauthCookieName, opaqueToken, sessionCookieName, tokenHash } from "./security.ts";
import { rotateSession } from "./session-assurance.ts";

type ErrorConstructor = new (statusCode: number, code: string, message: string) => Error;
type LegalBody = {
  acceptedTerms: true;
  acknowledgedPrivacy: true;
  termsVersion: string;
  privacyVersion: string;
};
type CallbackQuery = { code?: string; state?: string; error?: string };
type AuthResult =
  | "google-success"
  | "google-registration"
  | "google-step-up"
  | "google-cancelled"
  | "google-failed"
  | "invalid-callback"
  | "account-disabled"
  | "account-link-required";
type Attempt = {
  id: string;
  purpose: "LOGIN" | "STEP_UP";
  codeVerifier: string;
  nonce: string;
  userId: string | null;
  sessionId: string | null;
};
type RegistrationLegalDocument = {
  id: unknown;
  document_type: unknown;
  version: unknown;
  requires_acceptance: unknown;
  approved_for_production: unknown;
};
type Options = {
  config: ApiConfig;
  google: GoogleOidcClient | null;
  ApiError: ErrorConstructor;
  requirePrimaryAuth: (request: FastifyRequest) => Promise<void>;
  setSession: (reply: FastifyReply, token: string) => void;
  userSchema: object;
  userFrom: (row: Record<string, unknown>) => object;
  validateLegalDocuments: (
    appEnv: ApiConfig["appEnv"],
    documents: RegistrationLegalDocument[],
  ) => { terms: RegistrationLegalDocument; privacy: RegistrationLegalDocument };
};

const ATTEMPT_TTL_MS = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function envelope(data: object): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: { data },
  };
}

function googleIdentity(identity: GoogleIdentity): GoogleIdentity {
  const email = identity.email.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.length > 254
    || !identity.emailVerified
    || !/^[A-Za-z0-9_-]{1,255}$/.test(identity.subject)
  ) {
    throw new Error("INVALID_GOOGLE_IDENTITY");
  }
  const name = identity.displayName?.trim();
  return { ...identity, email, displayName: name && name.length <= 100 ? name : null };
}

async function audit(client: PoolClient, userId: string, action: string): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       id, user_id, actor_user_id, action, resource_type, resource_id, result,
       metadata_no_sensitive, created_at
     ) VALUES ($1, $2, $2, $3, 'ACCOUNT', $2, 'SUCCESS', '{}'::jsonb, clock_timestamp())`,
    [randomUUID(), userId, action],
  );
}

export async function registerGoogleAuthRoutes(app: FastifyInstance, options: Options): Promise<void> {
  const {
    config,
    google,
    ApiError,
    requirePrimaryAuth,
    setSession,
    userSchema,
    userFrom,
    validateLegalDocuments,
  } = options;
  const cookieName = oauthCookieName(config.appEnv);
  const cookieOptions = {
    httpOnly: true,
    secure: config.appEnv === "production",
    sameSite: "lax" as const,
    path: "/",
  };

  const clearAttemptCookie = (reply: FastifyReply) => reply.clearCookie(cookieName, cookieOptions);
  const redirect = (reply: FastifyReply, result: AuthResult) => reply.redirect(`${config.publicOrigin}/?auth=${result}`);

  async function start(request: FastifyRequest, reply: FastifyReply, purpose: "LOGIN" | "STEP_UP") {
    if (!google) throw new ApiError(503, "GOOGLE_AUTH_UNAVAILABLE", "El acceso con Google no está configurado.");

    const browserToken = opaqueToken();
    const state = opaqueToken();
    const nonce = opaqueToken();
    const codeVerifier = opaqueToken();
    const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
    let userId: string | null = null;
    let sessionId: string | null = null;
    let loginHint: string | undefined;

    if (purpose === "STEP_UP") {
      userId = request.authUser!.id;
      const linked = await pool.query(
        `SELECT session.id, account.provider_account_id
           FROM sessions AS session
          JOIN auth_accounts AS account
             ON account.user_id = session.user_id AND account.provider = 'GOOGLE'
          WHERE session.user_id = $1 AND session.token_hash = $2
            AND session.revoked_at IS NULL AND session.expires_at > now()`,
        [userId, request.authSessionHash],
      );
      if (linked.rowCount !== 1) {
        throw new ApiError(409, "GOOGLE_ACCOUNT_REQUIRED", "La cuenta no tiene un acceso de Google vinculado.");
      }
      sessionId = String(linked.rows[0].id);
      loginHint = String(linked.rows[0].provider_account_id);
    }

    let authorizationUrl: string;
    try {
      authorizationUrl = await google.authorizationUrl({
        state,
        nonce,
        codeChallenge,
        stepUp: purpose === "STEP_UP",
        ...(loginHint ? { loginHint } : {}),
      });
    } catch {
      throw new ApiError(503, "GOOGLE_AUTH_UNAVAILABLE", "El acceso con Google no está disponible temporalmente.");
    }
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM oauth_attempts WHERE expires_at <= now()`);
      await client.query(
        `INSERT INTO oauth_attempts (
           id, provider, purpose, browser_token_hash, state_hash, pkce_verifier, nonce,
           user_id, session_id, status
         ) VALUES ($1, 'GOOGLE', $2, $3, $4, $5, $6, $7, $8, 'STARTED')`,
        [
          randomUUID(),
          purpose,
          tokenHash(browserToken),
          tokenHash(state),
          codeVerifier,
          nonce,
          userId,
          sessionId,
        ],
      );
    });
    reply.setCookie(cookieName, browserToken, { ...cookieOptions, maxAge: ATTEMPT_TTL_MS / 1000 });
    return { data: { authorizationUrl } };
  }

  app.post(
    "/api/v1/auth/google/start",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["authorizationUrl"],
            properties: { authorizationUrl: { type: "string", format: "uri" } },
          }),
        },
      },
    },
    (request, reply) => start(request, reply, "LOGIN"),
  );

  app.post(
    "/api/v1/auth/google/step-up/start",
    {
      preHandler: requirePrimaryAuth,
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        response: {
          200: envelope({
            type: "object",
            additionalProperties: false,
            required: ["authorizationUrl"],
            properties: { authorizationUrl: { type: "string", format: "uri" } },
          }),
        },
      },
    },
    (request, reply) => {
      if (request.authUser!.authState === "MFA_REQUIRED") {
        throw new ApiError(403, "MFA_REQUIRED", "Ingresá el código de tu segundo factor para continuar.");
      }
      return start(request, reply, "STEP_UP");
    },
  );

  app.get<{ Querystring: CallbackQuery }>(
    "/api/v1/auth/google/callback",
    {
      config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            code: { type: "string", maxLength: 4096 },
            state: { type: "string", maxLength: 256 },
            error: { type: "string", maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const browserToken = request.cookies[cookieName];
      const state = request.query.state;
      if (!google || !browserToken || !TOKEN_PATTERN.test(browserToken) || !state || !TOKEN_PATTERN.test(state)) {
        clearAttemptCookie(reply);
        return redirect(reply, "invalid-callback");
      }

      if (request.query.error) {
        const deleted = await pool.query(
          `DELETE FROM oauth_attempts
            WHERE provider = 'GOOGLE' AND browser_token_hash = $1 AND state_hash = $2
              AND status = 'STARTED' AND expires_at > now()
            RETURNING id`,
          [tokenHash(browserToken), tokenHash(state)],
        );
        clearAttemptCookie(reply);
        return redirect(reply, deleted.rowCount === 1 && request.query.error === "access_denied"
          ? "google-cancelled"
          : "google-failed");
      }

      const claimed = await pool.query(
        `UPDATE oauth_attempts
            SET status = 'EXCHANGING', updated_at = now()
          WHERE provider = 'GOOGLE' AND browser_token_hash = $1 AND state_hash = $2
            AND status = 'STARTED' AND expires_at > now()
          RETURNING id, purpose, pkce_verifier, nonce, user_id, session_id`,
        [tokenHash(browserToken), tokenHash(state)],
      );
      if (claimed.rowCount !== 1) {
        clearAttemptCookie(reply);
        return redirect(reply, "invalid-callback");
      }
      if (!request.query.code) {
        await pool.query(`DELETE FROM oauth_attempts WHERE id = $1`, [claimed.rows[0].id]);
        clearAttemptCookie(reply);
        return redirect(reply, "invalid-callback");
      }
      const row = claimed.rows[0];
      const attempt: Attempt = {
        id: String(row.id),
        purpose: row.purpose === "STEP_UP" ? "STEP_UP" : "LOGIN",
        codeVerifier: String(row.pkce_verifier),
        nonce: String(row.nonce),
        userId: row.user_id === null ? null : String(row.user_id),
        sessionId: row.session_id === null ? null : String(row.session_id),
      };

      let identity: GoogleIdentity;
      try {
        const callbackBase = config.googleOAuth?.redirectUri ?? "http://localhost/api/v1/auth/google/callback";
        identity = googleIdentity(await google.exchange({
          callbackUrl: new URL(request.raw.url!, callbackBase),
          state,
          nonce: attempt.nonce,
          codeVerifier: attempt.codeVerifier,
          stepUp: attempt.purpose === "STEP_UP",
        }));
      } catch {
        await pool.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
        clearAttemptCookie(reply);
        return redirect(reply, "google-failed");
      }

      if (attempt.purpose === "STEP_UP") {
        const rawSession = request.cookies[sessionCookieName(config.appEnv)];
        const outcome = await withTransaction(async (client) => {
          const activeAttempt = await client.query(
            `SELECT id FROM oauth_attempts
              WHERE id = $1 AND status = 'EXCHANGING' AND expires_at > now()
              FOR UPDATE`,
            [attempt.id],
          );
          if (activeAttempt.rowCount !== 1) return "INVALID" as const;
          const account = await client.query(
            `SELECT users.status, users.deleted_at
               FROM auth_accounts AS account
               JOIN users ON users.id = account.user_id
               JOIN sessions AS session ON session.id = $4 AND session.user_id = users.id
              WHERE account.provider = 'GOOGLE' AND account.provider_account_id = $1
                AND users.id = $2 AND session.token_hash = $3
                AND session.revoked_at IS NULL AND session.expires_at > now()
              FOR UPDATE OF users, account, session`,
            [
              identity.subject,
              attempt.userId,
              rawSession && TOKEN_PATTERN.test(rawSession) ? tokenHash(rawSession) : "",
              attempt.sessionId,
            ],
          );
          if (account.rowCount !== 1) {
            await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
            return "INVALID" as const;
          }
          if (account.rows[0].status !== "ACTIVE" || account.rows[0].deleted_at !== null) {
            await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
            return "DISABLED" as const;
          }
          const session = await rotateSession(client, tokenHash(rawSession!), { stepUp: true });
          await audit(client, attempt.userId!, "AUTH_GOOGLE_STEP_UP");
          await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
          return { session } as const;
        });
        clearAttemptCookie(reply);
        if (outcome === "INVALID") return redirect(reply, "invalid-callback");
        if (outcome === "DISABLED") return redirect(reply, "account-disabled");
        setSession(reply, outcome.session.token);
        return redirect(reply, "google-step-up");
      }

      const outcome = await withTransaction(async (client) => {
        const activeAttempt = await client.query(
          `SELECT id FROM oauth_attempts
            WHERE id = $1 AND status = 'EXCHANGING' AND expires_at > now()
            FOR UPDATE`,
          [attempt.id],
        );
        if (activeAttempt.rowCount !== 1) return { status: "INVALID" } as const;
        const account = await client.query(
          `SELECT users.id, users.email, users.display_name, users.role, users.created_at,
                  users.status, users.deleted_at, users.onboarding_completed_at,
                  true AS google_enabled,
                  EXISTS (SELECT 1 FROM mfa_factors factor
                    WHERE factor.user_id = users.id AND factor.status = 'ACTIVE') AS mfa_enabled
             FROM auth_accounts AS account
             JOIN users ON users.id = account.user_id
            WHERE account.provider = 'GOOGLE' AND account.provider_account_id = $1
            FOR UPDATE OF account, users`,
          [identity.subject],
        );
        if (account.rowCount === 1) {
          const user = account.rows[0];
          if (user.status !== "ACTIVE" || user.deleted_at !== null) {
            await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
            return { status: "DISABLED" } as const;
          }
          const token = opaqueToken();
          await client.query(
            `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
             VALUES ($1, $2, $3, $4, clock_timestamp())`,
            [randomUUID(), user.id, tokenHash(token), new Date(Date.now() + config.sessionTtlSeconds * 1000)],
          );
          await client.query(
            `UPDATE users
                SET last_login_at = GREATEST(created_at, clock_timestamp()),
                    updated_at = GREATEST(updated_at, clock_timestamp())
              WHERE id = $1`,
            [user.id],
          );
          await client.query(
            `UPDATE auth_accounts
                SET last_login_at = GREATEST(created_at, clock_timestamp()),
                    updated_at = GREATEST(updated_at, clock_timestamp())
              WHERE provider = 'GOOGLE' AND provider_account_id = $1`,
            [identity.subject],
          );
          await audit(client, String(user.id), "AUTH_GOOGLE_LOGIN");
          await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
          return { status: "LOGIN", token } as const;
        }

        const collision = await client.query(`SELECT id FROM users WHERE email = $1`, [identity.email]);
        if (collision.rowCount !== 0) {
          await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [attempt.id]);
          return { status: "LINK_REQUIRED" } as const;
        }
        const pending = await client.query(
          `UPDATE oauth_attempts
              SET status = 'IDENTITY_VERIFIED', pending_subject = $2,
                  pending_email = $3, pending_display_name = $4, updated_at = now()
            WHERE id = $1 AND status = 'EXCHANGING'`,
          [attempt.id, identity.subject, identity.email, identity.displayName],
        );
        return { status: pending.rowCount === 1 ? "REGISTER" : "INVALID" } as const;
      });

      if (outcome.status !== "REGISTER") clearAttemptCookie(reply);
      if (outcome.status === "INVALID") return redirect(reply, "invalid-callback");
      if (outcome.status === "DISABLED") return redirect(reply, "account-disabled");
      if (outcome.status === "LINK_REQUIRED") return redirect(reply, "account-link-required");
      if (outcome.status === "LOGIN") {
        setSession(reply, outcome.token);
        return redirect(reply, "google-success");
      }
      return redirect(reply, "google-registration");
    },
  );

  app.post<{ Body: LegalBody }>(
    "/api/v1/auth/google/register",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["acceptedTerms", "acknowledgedPrivacy", "termsVersion", "privacyVersion"],
          properties: {
            acceptedTerms: { type: "boolean", const: true },
            acknowledgedPrivacy: { type: "boolean", const: true },
            termsVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
            privacyVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
          },
        },
        response: { 201: envelope(userSchema) },
      },
    },
    async (request, reply) => {
      const browserToken = request.cookies[cookieName];
      if (!browserToken || !TOKEN_PATTERN.test(browserToken)) {
        throw new ApiError(409, "GOOGLE_REGISTRATION_EXPIRED", "El alta con Google venció. Iniciá el acceso nuevamente.");
      }
      const token = opaqueToken();
      const outcome = await withTransaction(async (client) => {
        const attempt = await client.query(
          `SELECT id, pending_subject, pending_email, pending_display_name
             FROM oauth_attempts
            WHERE provider = 'GOOGLE' AND purpose = 'LOGIN' AND browser_token_hash = $1
              AND status = 'IDENTITY_VERIFIED' AND expires_at > now()
            FOR UPDATE`,
          [tokenHash(browserToken)],
        );
        if (attempt.rowCount !== 1) return { status: "EXPIRED" } as const;
        const pending = attempt.rows[0];
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `GOOGLE:${pending.pending_subject}`,
        ]);

        const existing = await client.query(
          `SELECT users.id, users.email, users.display_name, users.role, users.created_at,
                  users.status, users.deleted_at, users.onboarding_completed_at,
                  true AS google_enabled,
                  EXISTS (SELECT 1 FROM mfa_factors factor
                    WHERE factor.user_id = users.id AND factor.status = 'ACTIVE') AS mfa_enabled
             FROM auth_accounts AS account
             JOIN users ON users.id = account.user_id
            WHERE account.provider = 'GOOGLE' AND account.provider_account_id = $1
            FOR UPDATE OF account, users`,
          [pending.pending_subject],
        );
        let row: Record<string, unknown>;
        if (existing.rowCount === 1) {
          row = existing.rows[0];
          if (row.status !== "ACTIVE" || row.deleted_at !== null) {
            await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [pending.id]);
            return { status: "DISABLED" } as const;
          }
        } else {
          const collision = await client.query(`SELECT id FROM users WHERE email = $1`, [pending.pending_email]);
          if (collision.rowCount !== 0) {
            await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [pending.id]);
            return { status: "LINK_REQUIRED" } as const;
          }
          const legalDocuments = await client.query(
            `SELECT DISTINCT ON (document_type) id, document_type, version, requires_acceptance, approved_for_production
               FROM legal_document_versions
              WHERE document_type IN ('TERMS', 'PRIVACY_NOTICE')
                AND locale = 'es-AR' AND published_at <= now() AND effective_at <= now()
              ORDER BY document_type, effective_at DESC, published_at DESC`,
          );
          const { terms, privacy } = validateLegalDocuments(config.appEnv, legalDocuments.rows);
          if (
            request.body.termsVersion !== String(terms.version)
            || request.body.privacyVersion !== String(privacy.version)
          ) {
            throw new ApiError(409, "LEGAL_DOCUMENTS_CHANGED", "Los documentos legales cambiaron. Revisá las versiones vigentes antes de continuar.");
          }
          const userId = randomUUID();
          const inserted = await client.query(
            `INSERT INTO users (
               id, email, password_hash, display_name, status, default_retention_policy,
               email_verified_at, last_login_at
             ) VALUES ($1, $2, NULL, $3, 'ACTIVE', 'KEEP_ORIGINAL', now(), now())
             RETURNING id, email, display_name, role, created_at, onboarding_completed_at,
                       true AS google_enabled, false AS mfa_enabled`,
            [userId, pending.pending_email, pending.pending_display_name],
          );
          row = inserted.rows[0];
          await client.query(
            `INSERT INTO auth_accounts (
               id, user_id, provider, provider_account_id, last_login_at
             ) VALUES ($1, $2, 'GOOGLE', $3, now())`,
            [randomUUID(), userId, pending.pending_subject],
          );
          await client.query(
            `INSERT INTO legal_acknowledgements (user_id, document_version_id)
             SELECT $1, unnest($2::uuid[])`,
            [userId, [terms.id, privacy.id]],
          );
          await client.query(
            `INSERT INTO audit_events (
               id, user_id, actor_user_id, action, resource_type, resource_id, result, metadata_no_sensitive
             ) VALUES ($1, $2, $2, 'LEGAL_DOCUMENTS_RECORDED', 'ACCOUNT', $2, 'SUCCESS', $3::jsonb)`,
            [randomUUID(), userId, JSON.stringify({
              termsAcceptedVersion: terms.version,
              privacyAcknowledgedVersion: privacy.version,
            })],
          );
        }

        await client.query(
          `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())`,
          [randomUUID(), row.id, tokenHash(token), new Date(Date.now() + config.sessionTtlSeconds * 1000)],
        );
        await client.query(
          `UPDATE users
              SET last_login_at = GREATEST(created_at, clock_timestamp()),
                  updated_at = GREATEST(updated_at, clock_timestamp())
            WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `UPDATE auth_accounts
              SET last_login_at = GREATEST(created_at, clock_timestamp()),
                  updated_at = GREATEST(updated_at, clock_timestamp())
            WHERE user_id = $1 AND provider = 'GOOGLE'`,
          [row.id],
        );
        await audit(client, String(row.id), existing.rowCount === 1 ? "AUTH_GOOGLE_LOGIN" : "AUTH_GOOGLE_REGISTERED");
        await client.query(`DELETE FROM oauth_attempts WHERE id = $1`, [pending.id]);
        return { status: "OK", row } as const;
      });

      if (outcome.status !== "OK") clearAttemptCookie(reply);
      if (outcome.status === "EXPIRED") {
        throw new ApiError(409, "GOOGLE_REGISTRATION_EXPIRED", "El alta con Google venció. Iniciá el acceso nuevamente.");
      }
      if (outcome.status === "DISABLED") {
        throw new ApiError(403, "ACCOUNT_DISABLED", "La cuenta no está habilitada.");
      }
      if (outcome.status === "LINK_REQUIRED") {
        throw new ApiError(409, "ACCOUNT_LINK_REQUIRED", "Ese email ya pertenece a otra cuenta y no se puede vincular automáticamente.");
      }
      clearAttemptCookie(reply);
      setSession(reply, token);
      return reply.code(201).send({ data: userFrom(outcome.row) });
    },
  );
}
