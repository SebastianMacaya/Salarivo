import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleOidc } from "../src/google-oidc.ts";

test("Google discovery retries after a transient failure without weakening the authorization request", async (context) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) throw new Error("synthetic discovery failure");
    return new Response(JSON.stringify({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    }), { headers: { "content-type": "application/json" } });
  };
  context.after(() => { globalThis.fetch = originalFetch; });

  const client = createGoogleOidc({
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    redirectUri: "http://localhost:3001/api/v1/auth/google/callback",
  });
  assert.ok(client);
  const input = {
    state: "state",
    nonce: "nonce",
    codeChallenge: "challenge",
    stepUp: false,
  };
  await assert.rejects(() => client.authorizationUrl(input));
  const authorizationUrl = new URL(await client.authorizationUrl(input));
  assert.equal(requests, 2);
  assert.equal(authorizationUrl.origin, "https://accounts.google.com");
  assert.equal(authorizationUrl.searchParams.get("scope"), "openid email profile");
  assert.equal(authorizationUrl.searchParams.get("state"), input.state);
  assert.equal(authorizationUrl.searchParams.get("nonce"), input.nonce);
  assert.equal(authorizationUrl.searchParams.get("code_challenge"), input.codeChallenge);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const stepUpUrl = new URL(await client.authorizationUrl({ ...input, stepUp: true }));
  assert.equal(stepUpUrl.searchParams.get("max_age"), "0");
});
