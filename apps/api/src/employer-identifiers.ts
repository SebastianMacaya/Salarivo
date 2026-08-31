import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import type { ProtectedEmployerIdentifier } from "@salarivo/database";

const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;
const CUIT_PREFIXES = new Set(["20", "23", "24", "27", "30", "33", "34"]);
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EmployerIdentifierProtection = Readonly<{
  encryptionKeyVersion: number;
  encryptionKey: Buffer;
  fingerprintKey: Buffer;
}>;

export class InvalidArgentineCuitError extends Error {
  constructor() {
    super("INVALID_AR_CUIT");
  }
}

export function normalizeArgentineCuit(value: string): string {
  const normalized = value.trim().replace(/[.\s-]+/gu, "");
  if (!/^\d{11}$/.test(normalized)) {
    throw new InvalidArgentineCuitError();
  }
  if (!CUIT_PREFIXES.has(normalized.slice(0, 2))) throw new InvalidArgentineCuitError();
  const sum = CUIT_WEIGHTS.reduce((total, weight, index) => total + Number(normalized[index]) * weight, 0);
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
  if (Number(normalized[10]) !== expected) throw new InvalidArgentineCuitError();
  return normalized;
}

export function protectArgentineCuit(
  value: string,
  protection: EmployerIdentifierProtection,
): ProtectedEmployerIdentifier {
  if (
    !Number.isSafeInteger(protection.encryptionKeyVersion)
    || protection.encryptionKeyVersion < 1
    || protection.encryptionKey.length !== 32
    || protection.fingerprintKey.length !== 32
  ) throw new Error("INVALID_EMPLOYER_IDENTIFIER_PROTECTION");

  const normalized = normalizeArgentineCuit(value);
  const context = Buffer.from("salarivo:employer-identifier:v1\0AR\0CUIT", "utf8");
  const fingerprint = createHmac("sha256", protection.fingerprintKey)
    .update(Buffer.from("salarivo:employer-identifier:fingerprint:v1\0", "utf8"))
    .update(context)
    .update("\0", "utf8")
    .update(normalized, "ascii")
    .digest("hex");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", protection.encryptionKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([
    Buffer.from("salarivo:employer-identifier:ciphertext:v1\0", "utf8"),
    context,
    Buffer.from(`\0${protection.encryptionKeyVersion}`, "ascii"),
  ]));
  const ciphertext = Buffer.concat([cipher.update(normalized, "ascii"), cipher.final()]);
  return {
    countryCode: "AR",
    type: "CUIT",
    fingerprint,
    ciphertext: Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]),
    keyVersion: String(protection.encryptionKeyVersion),
    maskedSuffix: normalized.slice(-4),
  };
}
