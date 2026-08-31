import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidArgentineCuitError,
  normalizeArgentineCuit,
  protectArgentineCuit,
} from "../src/employer-identifiers.ts";

const protection = {
  encryptionKeyVersion: 7,
  encryptionKey: Buffer.from("local-employer-encryption-v1!!!!", "utf8"),
  fingerprintKey: Buffer.from("local-employer-fingerprint-v1!!!", "utf8"),
};

test("Argentine CUIT accepts reasonable formatting and validates the real checksum", () => {
  assert.equal(normalizeArgentineCuit(" 30-71234567-1 "), "30712345671");
  assert.equal(normalizeArgentineCuit("30.71234567 1"), "30712345671");
  assert.equal(normalizeArgentineCuit("33-67890123-2"), "33678901232");
  assert.throws(() => normalizeArgentineCuit("00-00000000-0"), InvalidArgentineCuitError);
  assert.throws(() => normalizeArgentineCuit("30-71234567-2"), InvalidArgentineCuitError);
  assert.throws(() => normalizeArgentineCuit("30-7123456-1"), InvalidArgentineCuitError);
  assert.throws(() => normalizeArgentineCuit("CUIT 30-71234567-1"), InvalidArgentineCuitError);
});

test("CUIT protection encrypts without plaintext and fingerprints deterministically", () => {
  const first = protectArgentineCuit("30-71234567-1", protection);
  const second = protectArgentineCuit("30712345671", protection);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint.length, 64);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.byteLength, 40);
  assert.equal(Buffer.from(first.ciphertext).includes(Buffer.from("30712345671", "ascii")), false);
  assert.equal(first.keyVersion, "7");
  assert.equal(first.maskedSuffix, "5671");
  assert.deepEqual({ countryCode: first.countryCode, type: first.type }, { countryCode: "AR", type: "CUIT" });
});
