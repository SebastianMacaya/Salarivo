import type { PoolClient } from '@salarivo/database';
import { opaqueToken, tokenHash } from "./security.ts";

const STEP_UP_TTL_MS = 10 * 60_000;

export async function lockValidStepUpSession(
  client: PoolClient,
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  const session = await client.query(
    `SELECT id FROM sessions
      WHERE token_hash = $1 AND user_id = $2
        AND revoked_at IS NULL AND expires_at > now() AND step_up_expires_at > now()
      FOR UPDATE`,
    [sessionHash, userId],
  );
  return session.rowCount === 1;
}

export async function rotateSession(
  client: PoolClient,
  sessionHash: string,
  options: { mfaVerified?: boolean; clearAssurance?: boolean; stepUp?: boolean } = {},
): Promise<{ token: string; stepUpExpiresAt: string | null }> {
  const token = opaqueToken();
  const now = new Date();
  const stepUpExpiresAt = options.stepUp ? new Date(now.valueOf() + STEP_UP_TTL_MS) : null;
  const result = await client.query(
    `UPDATE sessions
        SET token_hash = $2,
            mfa_verified_at = CASE
              WHEN $3 THEN NULL
              WHEN $4 THEN $5
              ELSE mfa_verified_at
            END,
            step_up_expires_at = CASE
              WHEN $3 THEN NULL
              WHEN $6 THEN $7
              ELSE step_up_expires_at
            END
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > $5
      RETURNING user_id`,
    [
      sessionHash,
      tokenHash(token),
      options.clearAssurance === true,
      options.mfaVerified === true,
      now,
      options.stepUp === true,
      stepUpExpiresAt,
    ],
  );
  if (result.rowCount !== 1) throw new Error("SESSION_ROTATION_FAILED");
  return { token, stepUpExpiresAt: stepUpExpiresAt?.toISOString() ?? null };
}
