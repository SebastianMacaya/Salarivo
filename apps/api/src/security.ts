import {
  createHash,
  randomBytes,
} from "node:crypto";

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sessionCookieName(appEnv: string): string {
  return appEnv === "production" ? "__Host-salarivo_session" : "salarivo_session";
}

export function oauthCookieName(appEnv: string): string {
  return appEnv === "production" ? "__Host-salarivo_oauth" : "salarivo_oauth";
}

export function hasTrustedMutationOrigin(
  method: string,
  requestOrigin: string | undefined,
  expectedOrigin: string,
): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method) || requestOrigin === expectedOrigin;
}
