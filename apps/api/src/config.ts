import type { MfaKeyring } from "./mfa.ts";
import type { EmployerIdentifierProtection } from "./employer-identifiers.ts";

export type AppEnvironment = "development" | "test" | "production";
export type ObjectStorageProvider = "aws" | "r2";

export type ApiConfig = Readonly<{
  appEnv: AppEnvironment;
  host: string;
  port: number;
  publicOrigin: string;
  logLevel: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  sessionTtlSeconds: number;
  googleOAuth: Readonly<{
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }> | null;
  mfaKeyring: MfaKeyring;
  employerIdentifierProtection: EmployerIdentifierProtection;
  maxFileBytes: number;
  maxFilesPerBatch: number;
  maxBatchBytes: number;
  maxActiveImportsPerUser: number;
  maxUserDocuments: number;
  maxUserStorageBytes: number;
  uploadTtlSeconds: number;
  storageProvider: ObjectStorageProvider;
  storageAccessKey: string;
  storageSecretKey: string;
  storageBucket: string;
  storageInternalEndpoint: string;
  storageKmsKeyId: string | null;
  storagePublicEndpoint: string;
  storageRegion: string;
  cloudflareAccountId: string | null;
  cloudflareR2ApiToken: string | null;
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

function googleOAuth(env: NodeJS.ProcessEnv, production: boolean): ApiConfig["googleOAuth"] {
  const values = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_OAUTH_REDIRECT_URI]
    .map((value) => value?.trim());
  if (values.every((value) => !value)) {
    if (production) throw new Error("GOOGLE_CLIENT_ID is required in production");
    return null;
  }
  if (values.some((value) => !value)) {
    throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI must be configured together");
  }

  let redirect: URL;
  try {
    redirect = new URL(values[2]!);
  } catch {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must be an absolute HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(redirect.protocol)
    || redirect.username !== ""
    || redirect.password !== ""
    || redirect.search !== ""
    || redirect.hash !== ""
    || redirect.pathname !== "/api/v1/auth/google/callback"
  ) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must be an absolute HTTP(S) URL ending at /api/v1/auth/google/callback");
  }
  if (production && redirect.protocol !== "https:") {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production");
  }
  return Object.freeze({ clientId: values[0]!, clientSecret: values[1]!, redirectUri: redirect.href });
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

function employerIdentifierProtection(
  env: NodeJS.ProcessEnv,
  production: boolean,
  mfa: MfaKeyring,
): EmployerIdentifierProtection {
  const encryptionKeyVersion = integer(
    env.EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_VERSION,
    "EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_VERSION",
    production ? undefined : 1,
    1,
    2_147_483_647,
  );
  const encryption = production
    ? required(env.EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_BASE64, "EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_BASE64")
    : (env.EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_BASE64 ?? "bG9jYWwtZW1wbG95ZXItZW5jcnlwdGlvbi12MSEhISE=");
  const fingerprint = production
    ? required(env.EMPLOYER_IDENTIFIER_FINGERPRINT_KEY_BASE64, "EMPLOYER_IDENTIFIER_FINGERPRINT_KEY_BASE64")
    : (env.EMPLOYER_IDENTIFIER_FINGERPRINT_KEY_BASE64 ?? "bG9jYWwtZW1wbG95ZXItZmluZ2VycHJpbnQtdjEhISE=");
  const identifierEncryptionKey = encryptionKey(encryption, "EMPLOYER_IDENTIFIER_ENCRYPTION_KEY_BASE64");
  const fingerprintKey = encryptionKey(fingerprint, "EMPLOYER_IDENTIFIER_FINGERPRINT_KEY_BASE64");
  if (
    identifierEncryptionKey.equals(fingerprintKey)
    || [...mfa.keys.values()].some((key) => key.equals(identifierEncryptionKey) || key.equals(fingerprintKey))
  ) {
    throw new Error("Employer identifier encryption, fingerprint and MFA keys must be distinct");
  }
  return Object.freeze({ encryptionKeyVersion, encryptionKey: identifierEncryptionKey, fingerprintKey });
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

  const configuredStorageProvider = env.OBJECT_STORAGE_PROVIDER?.trim();
  if (production && !configuredStorageProvider) {
    throw new Error("OBJECT_STORAGE_PROVIDER is required in production");
  }
  if (configuredStorageProvider && !["aws", "r2"].includes(configuredStorageProvider)) {
    throw new Error("OBJECT_STORAGE_PROVIDER must be aws or r2");
  }
  const storageProvider = (configuredStorageProvider ?? "aws") as ObjectStorageProvider;
  const cloudflareAccountId = storageProvider === "r2"
    ? required(env.CLOUDFLARE_ACCOUNT_ID?.trim(), "CLOUDFLARE_ACCOUNT_ID").toLowerCase()
    : null;
  if (cloudflareAccountId !== null && !/^[a-f0-9]{32}$/.test(cloudflareAccountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  const cloudflareR2ApiToken = storageProvider === "r2"
    ? required(env.CLOUDFLARE_R2_API_TOKEN?.trim(), "CLOUDFLARE_R2_API_TOKEN")
    : null;
  const r2Endpoint = cloudflareAccountId === null
    ? null
    : `https://${cloudflareAccountId}.r2.cloudflarestorage.com`;
  if (storageProvider === "r2") {
    if (env.OBJECT_STORAGE_KMS_KEY_ID?.trim()) {
      throw new Error("OBJECT_STORAGE_KMS_KEY_ID must be absent for r2");
    }
    for (const [name, value] of [
      ["OBJECT_STORAGE_INTERNAL_ENDPOINT", env.OBJECT_STORAGE_INTERNAL_ENDPOINT],
      ["OBJECT_STORAGE_PUBLIC_ENDPOINT", env.OBJECT_STORAGE_PUBLIC_ENDPOINT],
    ] as const) {
      if (value !== undefined && endpoint(value, name, true) !== r2Endpoint) {
        throw new Error(`${name} must match the Cloudflare account R2 endpoint`);
      }
    }
    if (env.OBJECT_STORAGE_REGION !== undefined && env.OBJECT_STORAGE_REGION !== "auto") {
      throw new Error("OBJECT_STORAGE_REGION must be auto for r2");
    }
  }

  const configuredGoogleOAuth = googleOAuth(env, production);
  const configuredMfaKeyring = mfaKeyring(env, production);
  const configuredEmployerIdentifierProtection = employerIdentifierProtection(
    env,
    production,
    configuredMfaKeyring,
  );

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
    googleOAuth: configuredGoogleOAuth,
    mfaKeyring: configuredMfaKeyring,
    employerIdentifierProtection: configuredEmployerIdentifierProtection,
    maxFileBytes: integer(env.MAX_FILE_BYTES, "MAX_FILE_BYTES", production ? undefined : 20 * 1024 * 1024, 1_024, 100 * 1024 * 1024),
    maxFilesPerBatch: integer(env.MAX_FILES_PER_BATCH, "MAX_FILES_PER_BATCH", production ? undefined : 200, 1, 1_000),
    maxBatchBytes: integer(env.MAX_BATCH_BYTES, "MAX_BATCH_BYTES", production ? undefined : 512 * 1024 * 1024, 1_024, 10 * 1024 * 1024 * 1024),
    maxActiveImportsPerUser: integer(env.MAX_ACTIVE_IMPORTS_PER_USER, "MAX_ACTIVE_IMPORTS_PER_USER", production ? undefined : 1, 1, 10),
    maxUserDocuments: integer(env.MAX_USER_DOCUMENTS, "MAX_USER_DOCUMENTS", production ? undefined : 5_000, 1, 100_000),
    maxUserStorageBytes: integer(env.MAX_USER_STORAGE_BYTES, "MAX_USER_STORAGE_BYTES", production ? undefined : 5 * 1024 * 1024 * 1024, 1_024, 1024 * 1024 * 1024 * 1024),
    uploadTtlSeconds: integer(env.UPLOAD_TTL_SECONDS, "UPLOAD_TTL_SECONDS", 300, 60, 900),
    storageProvider,
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
      r2Endpoint ?? (production
        ? required(env.OBJECT_STORAGE_INTERNAL_ENDPOINT, "OBJECT_STORAGE_INTERNAL_ENDPOINT")
        : (env.OBJECT_STORAGE_INTERNAL_ENDPOINT ?? `http://127.0.0.1:${env.MINIO_API_PORT ?? "9000"}`)),
      "OBJECT_STORAGE_INTERNAL_ENDPOINT",
      production,
    ),
    storageKmsKeyId: storageProvider === "r2"
      ? null
      : production
      ? required(env.OBJECT_STORAGE_KMS_KEY_ID, "OBJECT_STORAGE_KMS_KEY_ID")
      : (env.OBJECT_STORAGE_KMS_KEY_ID ?? null),
    storagePublicEndpoint: endpoint(
      r2Endpoint ?? (production
        ? required(env.OBJECT_STORAGE_PUBLIC_ENDPOINT, "OBJECT_STORAGE_PUBLIC_ENDPOINT")
        : (env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? `http://127.0.0.1:${env.MINIO_API_PORT ?? "9000"}`)),
      "OBJECT_STORAGE_PUBLIC_ENDPOINT",
      production,
    ),
    storageRegion: storageProvider === "r2" ? "auto" : (env.OBJECT_STORAGE_REGION ?? "us-east-1"),
    cloudflareAccountId,
    cloudflareR2ApiToken,
  });
}
