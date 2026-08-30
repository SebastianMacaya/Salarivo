import type { PoolClient } from '@salarivo/database';

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
