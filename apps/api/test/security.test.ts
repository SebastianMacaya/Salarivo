import assert from "node:assert/strict";
import test from "node:test";
import {
  hashPassword,
  hasTrustedMutationOrigin,
  oauthCookieName,
  opaqueToken,
  sessionCookieName,
  tokenHash,
  verifyPassword,
} from "../src/security.ts";

test("password hashes are salted and verified without accepting malformed values", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
  assert.equal(await verifyPassword("anything", "broken"), false);
});

test("opaque tokens are only persisted through a stable one-way digest", () => {
  const token = opaqueToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokenHash(token), /^[0-9a-f]{64}$/);
  assert.equal(tokenHash(token), tokenHash(token));
  assert.notEqual(tokenHash(token), token);
});

test("cookie-backed mutations require the configured browser origin", () => {
  const expected = "http://localhost:3000";
  assert.equal(hasTrustedMutationOrigin("GET", undefined, expected), true);
  assert.equal(hasTrustedMutationOrigin("POST", expected, expected), true);
  assert.equal(hasTrustedMutationOrigin("POST", undefined, expected), false);
  assert.equal(hasTrustedMutationOrigin("DELETE", "https://attacker.test", expected), false);
});

test("production sessions use a host-only cookie prefix", () => {
  assert.equal(sessionCookieName("production"), "__Host-salarivo_session");
  assert.equal(sessionCookieName("test"), "salarivo_session");
  assert.equal(oauthCookieName("production"), "__Host-salarivo_oauth");
  assert.equal(oauthCookieName("test"), "salarivo_oauth");
});
