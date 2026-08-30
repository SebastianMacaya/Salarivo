export function assertSecureDatabaseUrl(
  databaseUrl: string,
  appEnv: string | undefined,
  nodeTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED,
): void {
  if (appEnv !== "production") return;
  if (nodeTlsRejectUnauthorized?.trim() === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden in production");
  }
  const parsed = new URL(databaseUrl);
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
    throw new Error("DATABASE_URL must use sslmode=verify-full in production");
  }
  if (parsed.searchParams.has("uselibpqcompat")) {
    throw new Error("DATABASE_URL cannot weaken TLS verification in production");
  }
}
