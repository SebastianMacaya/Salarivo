import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTrustedMutationOrigin,
  oauthCookieName,
  opaqueToken,
  parseUserAgent,
  sessionCookieName,
  tokenHash,
} from "../src/security.ts";

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

test("user agents are reduced to coarse session metadata", () => {
  assert.deepEqual(
    parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0 Safari/537.36"),
    { deviceType: "DESKTOP", browserFamily: "CHROME", osFamily: "WINDOWS" },
  );
  assert.deepEqual(
    parseUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/127.0 Mobile Safari/537.36 EdgA/127.0"),
    { deviceType: "MOBILE", browserFamily: "EDGE", osFamily: "ANDROID" },
  );
  assert.deepEqual(
    parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"),
    { deviceType: "TABLET", browserFamily: "SAFARI", osFamily: "IOS" },
  );
  assert.deepEqual(
    parseUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"),
    { deviceType: "DESKTOP", browserFamily: "FIREFOX", osFamily: "LINUX" },
  );
  assert.deepEqual(parseUserAgent(undefined), {
    deviceType: "UNKNOWN",
    browserFamily: "OTHER",
    osFamily: "OTHER",
  });
});
