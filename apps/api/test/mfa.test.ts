import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTotpUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpCode,
  normalizeRecoveryCode,
  recoveryCodeHash,
  validateTotpCode,
} from "../src/mfa.ts";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const context = { userId: "user-1", factorId: "factor-1" };
const keyring = { activeVersion: 7, keys: new Map([[7, Buffer.alloc(32, 7)]]) };

test("TOTP uses RFC-compatible codes, a short drift window and replay protection", () => {
  assert.equal(generateTotpCode(secret, 59_000), "287082");
  assert.equal(validateTotpCode(secret, "287082", null, 59_000), 1n);
  assert.equal(validateTotpCode(secret, "287082", 1n, 59_000), null);
  assert.equal(validateTotpCode(secret, generateTotpCode(secret, 30_000), null, 60_000), 1n);
  assert.equal(validateTotpCode(secret, "12345", null, 59_000), null);
  assert.match(buildTotpUri(secret, "persona+sintetica@example.test"), /^otpauth:\/\/totp\//);
});

test("MFA secrets are authenticated with their user, factor and key version", () => {
  const encrypted = encryptMfaSecret(secret, context, keyring);
  assert.notEqual(encrypted.encryptedSecret, secret);
  assert.equal(decryptMfaSecret(encrypted.encryptedSecret, 7, context, keyring), secret);
  assert.throws(() => decryptMfaSecret(encrypted.encryptedSecret, 7, { ...context, userId: "other" }, keyring));
  assert.throws(() => decryptMfaSecret(`${encrypted.encryptedSecret}x`, 7, context, keyring));
});

test("recovery codes have 128 bits, normalize safely and persist only hashes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^(?:[0-9A-F]{8}-){3}[0-9A-F]{8}$/);
    assert.equal(normalizeRecoveryCode(code.toLowerCase()), code.replaceAll("-", ""));
    assert.match(recoveryCodeHash("user-1", code), /^[0-9a-f]{64}$/);
    assert.ok(!recoveryCodeHash("user-1", code).includes(normalizeRecoveryCode(code)));
  }
  assert.equal(recoveryCodeHash("user-1", "bad"), "");
});
