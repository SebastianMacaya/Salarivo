import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("config keeps local defaults but requires explicit production security settings", () => {
  const local = loadConfig({ APP_ENV: "test" });
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.publicOrigin, "http://localhost:3000");
  assert.equal(local.maxActiveImportsPerUser, 1);
  assert.equal(local.maxBatchBytes, 512 * 1024 * 1024);
  assert.equal(local.maxUserDocuments, 5_000);
  assert.equal(local.mfaKeyring.activeVersion, 1);
  assert.equal(local.mfaKeyring.keys.get(1)?.length, 32);

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
    () =>
      loadConfig({
        APP_ENV: "production",
        PUBLIC_ORIGIN: "http://example.test",
        API_HOST: "0.0.0.0",
        API_PORT: "3001",
        LOG_LEVEL: "info",
        SESSION_TTL_SECONDS: "3600",
        PASSWORD_RESET_TTL_SECONDS: "900",
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
      PASSWORD_RESET_TTL_SECONDS: "900",
      MFA_ENCRYPTION_KEY_VERSION: "1",
      MFA_ENCRYPTION_KEY_BASE64: "bG9jYWwtbWZhLWtleS1vbmx5LWZvci10ZXN0cyEhISE=",
    }),
    /MAX_FILE_BYTES/,
  );
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
