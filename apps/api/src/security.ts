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

export type SessionClientMetadata = {
  deviceType: "DESKTOP" | "MOBILE" | "TABLET" | "UNKNOWN";
  browserFamily: "CHROME" | "EDGE" | "FIREFOX" | "SAFARI" | "OTHER";
  osFamily: "WINDOWS" | "MACOS" | "IOS" | "ANDROID" | "LINUX" | "OTHER";
};

export function parseUserAgent(userAgent: string | undefined): SessionClientMetadata {
  const value = (userAgent ?? "").slice(0, 512).toLowerCase();
  const ios = /iphone|ipad|ipod/.test(value) || (value.includes("macintosh") && value.includes("mobile/"));
  const android = value.includes("android");
  const osFamily = ios
    ? "IOS"
    : android
      ? "ANDROID"
      : value.includes("windows")
        ? "WINDOWS"
        : value.includes("macintosh") || value.includes("mac os x")
          ? "MACOS"
          : value.includes("linux") || value.includes("x11")
            ? "LINUX"
            : "OTHER";
  const deviceType = ios
    ? /iphone|ipod/.test(value) ? "MOBILE" : "TABLET"
    : android
      ? value.includes("mobile") ? "MOBILE" : "TABLET"
      : value.includes("windows phone") || value.includes("mobile")
        ? "MOBILE"
        : /windows|macintosh|mac os x|linux|x11|cros/.test(value)
          ? "DESKTOP"
          : "UNKNOWN";
  const browserFamily = /edg(?:e|a|ios)?\//.test(value)
    ? "EDGE"
    : /(?:chrome|crios)\//.test(value)
      ? "CHROME"
      : /(?:firefox|fxios)\//.test(value)
        ? "FIREFOX"
        : value.includes("safari/")
          ? "SAFARI"
          : "OTHER";
  return { deviceType, browserFamily, osFamily };
}

export function hasTrustedMutationOrigin(
  method: string,
  requestOrigin: string | undefined,
  expectedOrigin: string,
): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method) || requestOrigin === expectedOrigin;
}
