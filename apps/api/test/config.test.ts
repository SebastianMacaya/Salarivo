import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const productionEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  APP_ENV: "production",
  PUBLIC_ORIGIN: "https://example.test",
  API_HOST: "0.0.0.0",
  API_PORT: "3001",
  LOG_LEVEL: "info",
  SESSION_TTL_SECONDS: "3600",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_OAUTH_REDIRECT_URI: "https://example.test/api/v1/auth/google/callback",
  MFA_ENCRYPTION_KEY_VERSION: "1",
  MFA_ENCRYPTION_KEY_BASE64: "bG9jYWwtbWZhLWtleS1vbmx5LWZvci10ZXN0cyEhISE=",
  MAX_FILE_BYTES: "20971520",
  MAX_FILES_PER_BATCH: "200",
  MAX_BATCH_BYTES: "536870912",
  MAX_ACTIVE_IMPORTS_PER_USER: "1",
  MAX_USER_DOCUMENTS: "5000",
  MAX_USER_STORAGE_BYTES: "5368709120",
  UPLOAD_TTL_SECONDS: "300",
  OBJECT_STORAGE_PROVIDER: "aws",
  OBJECT_STORAGE_ACCESS_KEY: "access-key",
  OBJECT_STORAGE_SECRET_KEY: "secret-key",
  OBJECT_STORAGE_BUCKET: "documents",
  OBJECT_STORAGE_INTERNAL_ENDPOINT: "https://s3.example.test",
  OBJECT_STORAGE_PUBLIC_ENDPOINT: "https://s3.example.test",
  OBJECT_STORAGE_KMS_KEY_ID: "kms-key",
  OBJECT_STORAGE_REGION: "us-east-1",
  ...overrides,
});

test("config keeps local defaults but requires explicit production security settings", () => {
  const local = loadConfig({ APP_ENV: "test" });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.publicOrigin, "http://localhost:3000");
  assert.equal(local.maxActiveImportsPerUser, 1);
  assert.equal(local.maxBatchBytes, 512 * 1024 * 1024);
  assert.equal(local.maxUserDocuments, 5_000);
  assert.equal(local.mfaKeyring.activeVersion, 1);
  assert.equal(local.mfaKeyring.keys.get(1)?.length, 32);
  assert.equal(local.googleOAuth, null);

  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /PUBLIC_ORIGIN/);
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", APP_ENV: "test" }),
    /cannot override/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    /forbidden/,
  );
  assert.throws(() => loadConfig({ APP_ENV: "production" }), /PUBLIC_ORIGIN/);
  assert.throws(
    () => loadConfig({
      APP_ENV: "production",
      PUBLIC_ORIGIN: "https://example.test",
      API_HOST: "0.0.0.0",
      API_PORT: "3001",
      LOG_LEVEL: "info",
      SESSION_TTL_SECONDS: "3600",
      OBJECT_STORAGE_PROVIDER: "aws",
    }),
    /GOOGLE_CLIENT_ID/,
  );
  assert.throws(
    () =>
      loadConfig({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "http://example.test",
        API_HOST: "0.0.0.0",
        API_PORT: "3001",
        LOG_LEVEL: "info",
        SESSION_TTL_SECONDS: "3600",
      }),
    /HTTPS/,
  );
  assert.throws(
    () => loadConfig({
      APP_ENV: "production",
      PUBLIC_ORIGIN: "https://example.test",
      API_HOST: "0.0.0.0",
      API_PORT: "3001",
      LOG_LEVEL: "info",
      SESSION_TTL_SECONDS: "3600",
      MFA_ENCRYPTION_KEY_VERSION: "1",
      MFA_ENCRYPTION_KEY_BASE64: "bG9jYWwtbWZhLWtleS1vbmx5LWZvci10ZXN0cyEhISE=",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://api.example.test/api/v1/auth/google/callback",
      OBJECT_STORAGE_PROVIDER: "aws",
    }),
    /MAX_FILE_BYTES/,
  );
});

test("production selects an explicit storage provider and derives the exact R2 endpoint", () => {
  assert.throws(
    () => loadConfig(productionEnv({ OBJECT_STORAGE_PROVIDER: undefined })),
    /OBJECT_STORAGE_PROVIDER is required/,
  );
  assert.throws(
    () => loadConfig(productionEnv({ OBJECT_STORAGE_PROVIDER: "other" })),
    /must be aws or r2/,
  );

  const accountId = "0123456789abcdef0123456789abcdef";
  const r2 = loadConfig(productionEnv({
    OBJECT_STORAGE_PROVIDER: "r2",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_R2_API_TOKEN: "read-only-token",
    OBJECT_STORAGE_INTERNAL_ENDPOINT: undefined,
    OBJECT_STORAGE_PUBLIC_ENDPOINT: undefined,
    OBJECT_STORAGE_KMS_KEY_ID: undefined,
    OBJECT_STORAGE_REGION: undefined,
  }));
  assert.equal(r2.storageProvider, "r2");
  assert.equal(r2.storageInternalEndpoint, `https://${accountId}.r2.cloudflarestorage.com`);
  assert.equal(r2.storagePublicEndpoint, r2.storageInternalEndpoint);
  assert.equal(r2.storageRegion, "auto");
  assert.equal(r2.storageKmsKeyId, null);
  assert.equal(r2.cloudflareAccountId, accountId);

  assert.throws(
    () => loadConfig(productionEnv({
      OBJECT_STORAGE_PROVIDER: "r2",
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_R2_API_TOKEN: "read-only-token",
      OBJECT_STORAGE_KMS_KEY_ID: "not-valid-for-r2",
    })),
    /KMS_KEY_ID must be absent/,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      OBJECT_STORAGE_PROVIDER: "r2",
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_R2_API_TOKEN: "read-only-token",
      OBJECT_STORAGE_KMS_KEY_ID: undefined,
      OBJECT_STORAGE_INTERNAL_ENDPOINT: "https://other.example.test",
    })),
    /must match the Cloudflare account/,
  );
  assert.throws(
    () => loadConfig(productionEnv({
      OBJECT_STORAGE_PROVIDER: "r2",
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_R2_API_TOKEN: "read-only-token",
      OBJECT_STORAGE_KMS_KEY_ID: undefined,
      OBJECT_STORAGE_INTERNAL_ENDPOINT: undefined,
      OBJECT_STORAGE_PUBLIC_ENDPOINT: undefined,
      OBJECT_STORAGE_REGION: "us-east-1",
    })),
    /must be auto for r2/,
  );
});

test("Google OAuth configuration is all-or-nothing and validates its fixed callback", () => {
  assert.throws(
    () => loadConfig({ APP_ENV: "test", GOOGLE_CLIENT_ID: "client-id" }),
    /configured together/,
  );
  assert.throws(
    () => loadConfig({
      APP_ENV: "test",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/other/callback",
    }),
    /google\/callback/,
  );
  const configured = loadConfig({
    APP_ENV: "test",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3001/api/v1/auth/google/callback",
  });
  assert.deepEqual(configured.googleOAuth, {
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3001/api/v1/auth/google/callback",
  });
});

test("config rejects non-origin URLs and unsafe integer values", () => {
  assert.throws(
    () => loadConfig({ APP_ENV: "test", PUBLIC_ORIGIN: "http://localhost:3000/path" }),
    /origin/,
  );
  assert.throws(() => loadConfig({ APP_ENV: "test", API_PORT: "0" }), /between/);
  assert.throws(() => loadConfig({ APP_ENV: "test", API_PORT: "3001x" }), /integer/);
  assert.throws(() => loadConfig({ APP_ENV: "test", MAX_ACTIVE_IMPORTS_PER_USER: "0" }), /between/);
  assert.throws(() => loadConfig({ APP_ENV: "test", MAX_USER_STORAGE_BYTES: "0" }), /between/);
  assert.throws(
    () => loadConfig({ APP_ENV: "test", MFA_ENCRYPTION_KEY_BASE64: "not-a-key" }),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => loadConfig({
      APP_ENV: "test",
      MFA_ENCRYPTION_PREVIOUS_KEYS_JSON: "{bad",
    }),
    /valid JSON/,
  );
});
