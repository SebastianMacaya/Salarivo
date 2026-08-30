import type { MfaKeyring } from "./mfa.ts";

export type AppEnvironment = "development" | "test" | "production";

export type ApiConfig = Readonly<{
  appEnv: AppEnvironment;
  host: string;
  port: number;
  publicOrigin: string;
  logLevel: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  sessionTtlSeconds: number;
  passwordResetTtlSeconds: number;
  mfaKeyring: MfaKeyring;
  maxFileBytes: number;
  maxFilesPerBatch: number;
  maxBatchBytes: number;
  maxActiveImportsPerUser: number;
  maxUserDocuments: number;
  maxUserStorageBytes: number;
  uploadTtlSeconds: number;
  storageAccessKey: string;
  storageSecretKey: string;
  storageBucket: string;
  storageInternalEndpoint: string;
  storageKmsKeyId: string | null;
  storagePublicEndpoint: string;
  storageRegion: string;
}>;

const LOG_LEVELS = new Set<ApiConfig["logLevel"]>([
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

function integer(
  value: string | undefined,
  name: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }

  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an absolute HTTP(S) origin");
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only an absolute HTTP(S) origin");
  }
  return parsed.origin;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function endpoint(value: string, name: string, production: boolean): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) origin`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value) {
    throw new Error(`${name} must contain only an absolute HTTP(S) origin`);
  }
  if (production && parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  return parsed.origin;
}

function encryptionKey(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${name} must be canonical base64 for exactly 32 bytes`);
  }
  return decoded;
}

function mfaKeyring(env: NodeJS.ProcessEnv, production: boolean): MfaKeyring {
  const activeVersion = integer(
    env.MFA_ENCRYPTION_KEY_VERSION,
    "MFA_ENCRYPTION_KEY_VERSION",
    production ? undefined : 1,
    1,
    2_147_483_647,
  );
  const activeKey = production
    ? required(env.MFA_ENCRYPTION_KEY_BASE64, "MFA_ENCRYPTION_KEY_BASE64")
    : (env.MFA_ENCRYPTION_KEY_BASE64 ?? "bG9jYWwtbWZhLWtleS1vbmx5LWZvci10ZXN0cyEhISE=");
  const keys = new Map<number, Buffer>([[
    activeVersion,
    encryptionKey(activeKey, "MFA_ENCRYPTION_KEY_BASE64"),
  ]]);
  if (env.MFA_ENCRYPTION_PREVIOUS_KEYS_JSON) {
    let previous: unknown;
    try {
      previous = JSON.parse(env.MFA_ENCRYPTION_PREVIOUS_KEYS_JSON);
    } catch {
      throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS_JSON must be valid JSON");
    }
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
      throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS_JSON must be a version-to-key object");
    }
    for (const [rawVersion, rawKey] of Object.entries(previous)) {
      if (!/^[1-9]\d*$/.test(rawVersion) || typeof rawKey !== "string") {
        throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS_JSON contains an invalid entry");
      }
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version === activeVersion) {
        throw new Error("MFA_ENCRYPTION_PREVIOUS_KEYS_JSON contains an invalid version");
      }
      keys.set(version, encryptionKey(rawKey, `MFA previous key ${version}`));
    }
  }
  return Object.freeze({ activeVersion, keys });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const configuredAppEnv = env.APP_ENV?.trim();
  if (env.NODE_ENV === "production" && configuredAppEnv && configuredAppEnv !== "production") {
    throw new Error("APP_ENV cannot override NODE_ENV=production");
  }
  const appEnv = env.NODE_ENV === "production" ? "production" : (configuredAppEnv || "development");
  if (!["development", "test", "production"].includes(appEnv)) {
    throw new Error("APP_ENV must be development, test or production");
  }
  const production = appEnv === "production";
  if (production && env.NODE_TLS_REJECT_UNAUTHORIZED?.trim() === "0") {
    throw new Error("NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden in production");
  }
  const publicOrigin = origin(
    production ? required(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN") : (env.PUBLIC_ORIGIN ?? "http://localhost:3000"),
  );
  if (production && !publicOrigin.startsWith("https://")) {
    throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
  }

  const logLevel = production ? required(env.LOG_LEVEL, "LOG_LEVEL") : (env.LOG_LEVEL ?? "info");
  if (!LOG_LEVELS.has(logLevel as ApiConfig["logLevel"])) {
    throw new Error("LOG_LEVEL is invalid");
  }

  const host = production ? required(env.API_HOST, "API_HOST") : (env.API_HOST ?? "127.0.0.1");
  if (/\s/.test(host)) throw new Error("API_HOST is invalid");

  return Object.freeze({
    appEnv: appEnv as AppEnvironment,
    host,
    port: integer(env.API_PORT, "API_PORT", production ? undefined : 3001, 1, 65_535),
    publicOrigin,
    logLevel: logLevel as ApiConfig["logLevel"],
    sessionTtlSeconds: integer(
      env.SESSION_TTL_SECONDS,
      "SESSION_TTL_SECONDS",
      production ? undefined : 604_800,
      300,
      2_592_000,
    ),
    passwordResetTtlSeconds: integer(
      env.PASSWORD_RESET_TTL_SECONDS,
      "PASSWORD_RESET_TTL_SECONDS",
      production ? undefined : 1_800,
      300,
      86_400,
    ),
    mfaKeyring: mfaKeyring(env, production),
    maxFileBytes: integer(env.MAX_FILE_BYTES, "MAX_FILE_BYTES", production ? undefined : 20 * 1024 * 1024, 1_024, 100 * 1024 * 1024),
    maxFilesPerBatch: integer(env.MAX_FILES_PER_BATCH, "MAX_FILES_PER_BATCH", production ? undefined : 200, 1, 1_000),
    maxBatchBytes: integer(env.MAX_BATCH_BYTES, "MAX_BATCH_BYTES", production ? undefined : 512 * 1024 * 1024, 1_024, 10 * 1024 * 1024 * 1024),
    maxActiveImportsPerUser: integer(env.MAX_ACTIVE_IMPORTS_PER_USER, "MAX_ACTIVE_IMPORTS_PER_USER", production ? undefined : 1, 1, 10),
    maxUserDocuments: integer(env.MAX_USER_DOCUMENTS, "MAX_USER_DOCUMENTS", production ? undefined : 5_000, 1, 100_000),
    maxUserStorageBytes: integer(env.MAX_USER_STORAGE_BYTES, "MAX_USER_STORAGE_BYTES", production ? undefined : 5 * 1024 * 1024 * 1024, 1_024, 1024 * 1024 * 1024 * 1024),
    uploadTtlSeconds: integer(env.UPLOAD_TTL_SECONDS, "UPLOAD_TTL_SECONDS", 300, 60, 900),
    storageAccessKey: production
      ? required(env.OBJECT_STORAGE_ACCESS_KEY, "OBJECT_STORAGE_ACCESS_KEY")
      : (env.OBJECT_STORAGE_ACCESS_KEY ?? env.MINIO_ROOT_USER ?? "salarivo"),
    storageSecretKey: production
      ? required(env.OBJECT_STORAGE_SECRET_KEY, "OBJECT_STORAGE_SECRET_KEY")
      : (env.OBJECT_STORAGE_SECRET_KEY ?? env.MINIO_ROOT_PASSWORD ?? "salarivo_local_change_me_123"),
    storageBucket: production
      ? required(env.OBJECT_STORAGE_BUCKET, "OBJECT_STORAGE_BUCKET")
      : (env.OBJECT_STORAGE_BUCKET ?? "salarivo-documents-local"),
    storageInternalEndpoint: endpoint(
      production
        ? required(env.OBJECT_STORAGE_INTERNAL_ENDPOINT, "OBJECT_STORAGE_INTERNAL_ENDPOINT")
        : (env.OBJECT_STORAGE_INTERNAL_ENDPOINT ?? `http://127.0.0.1:${env.MINIO_API_PORT ?? "9000"}`),
      "OBJECT_STORAGE_INTERNAL_ENDPOINT",
      production,
    ),
    storageKmsKeyId: production
      ? required(env.OBJECT_STORAGE_KMS_KEY_ID, "OBJECT_STORAGE_KMS_KEY_ID")
      : (env.OBJECT_STORAGE_KMS_KEY_ID ?? null),
    storagePublicEndpoint: endpoint(
      production
        ? required(env.OBJECT_STORAGE_PUBLIC_ENDPOINT, "OBJECT_STORAGE_PUBLIC_ENDPOINT")
        : (env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? `http://127.0.0.1:${env.MINIO_API_PORT ?? "9000"}`),
      "OBJECT_STORAGE_PUBLIC_ENDPOINT",
      production,
    ),
    storageRegion: env.OBJECT_STORAGE_REGION ?? "us-east-1",
  });
}
