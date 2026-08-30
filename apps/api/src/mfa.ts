import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TOTP_PERIOD_MS = 30_000;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type MfaKeyring = Readonly<{
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}>;

export type MfaSecretContext = Readonly<{
  factorId: string;
  userId: string;
}>;

export type EncryptedMfaSecret = Readonly<{
  encryptedSecret: string;
  keyVersion: number;
}>;

function aad(context: MfaSecretContext, keyVersion: number): Buffer {
  if (!context.factorId || !context.userId) throw new Error("INVALID_MFA_CONTEXT");
  return Buffer.from(
    `salarivo:mfa-secret:v1\0TOTP\0${context.userId}\0${context.factorId}\0${keyVersion}`,
    "utf8",
  );
}

function decodeEnvelopePart(value: string, expectedLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_MFA_SECRET");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value
    || (expectedLength !== undefined && decoded.length !== expectedLength)
  ) throw new Error("INVALID_MFA_SECRET");
  return decoded;
}

export function encryptMfaSecret(
  secret: string,
  context: MfaSecretContext,
  keyring: MfaKeyring,
): EncryptedMfaSecret {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error("INVALID_MFA_SECRET");
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key || key.length !== 32) throw new Error("INVALID_MFA_KEYRING");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(context, keyring.activeVersion));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    encryptedSecret: [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join("."),
    keyVersion: keyring.activeVersion,
  };
}

export function decryptMfaSecret(
  encryptedSecret: string,
  keyVersion: number,
  context: MfaSecretContext,
  keyring: MfaKeyring,
): string {
  const key = keyring.keys.get(keyVersion);
  const parts = encryptedSecret.split(".");
  if (!key || key.length !== 32 || parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("INVALID_MFA_SECRET");
  }
  const iv = decodeEnvelopePart(parts[1]!, IV_BYTES);
  const tag = decodeEnvelopePart(parts[2]!, TAG_BYTES);
  const ciphertext = decodeEnvelopePart(parts[3]!);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad(context, keyVersion));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function base32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(input: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(input)) throw new Error("INVALID_MFA_SECRET");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of input) {
    const index = BASE32_ALPHABET.indexOf(character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32(randomBytes(20));
}

export function buildTotpUri(secret: string, email: string): string {
  if (!/^[A-Z2-7]{32}$/.test(secret) || email.length < 3 || email.length > 254) {
    throw new Error("INVALID_MFA_ENROLLMENT");
  }
  const label = encodeURIComponent(`Salarivo:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Salarivo&algorithm=SHA1&digits=6&period=30`;
}

function hotp(secret: Buffer, counter: bigint): string {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(input).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = (
    ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!
  ) % (10 ** TOTP_DIGITS);
  return String(value).padStart(TOTP_DIGITS, "0");
}

export function generateTotpCode(secret: string, now = Date.now()): string {
  return hotp(decodeBase32(secret), BigInt(Math.floor(now / TOTP_PERIOD_MS)));
}

export function validateTotpCode(
  secret: string,
  code: string,
  lastAcceptedCounter: bigint | null,
  now = Date.now(),
): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = decodeBase32(secret);
  const current = BigInt(Math.floor(now / TOTP_PERIOD_MS));
  for (const offset of [0n, -1n, 1n]) {
    const counter = current + offset;
    if (counter < 0n || (lastAcceptedCounter !== null && counter <= lastAcceptedCounter)) continue;
    const expected = Buffer.from(hotp(key, counter), "ascii");
    if (timingSafeEqual(expected, Buffer.from(code, "ascii"))) return counter;
  }
  return null;
}

export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error("INVALID_RECOVERY_COUNT");
  const codes = new Set<string>();
  while (codes.size < count) {
    const raw = randomBytes(16).toString("hex").toUpperCase();
    codes.add(raw.match(/.{1,8}/g)!.join("-"));
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

export function recoveryCodeHash(userId: string, code: string): string {
  const normalized = normalizeRecoveryCode(code);
  if (!/^[0-9A-F]{32}$/.test(normalized)) return "";
  return createHash("sha256")
    .update("salarivo:mfa:recovery-code:v1\0", "utf8")
    .update(userId, "utf8")
    .update("\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}
