import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  discovery,
  type Configuration,
} from "openid-client";
import type { ApiConfig } from "./config.ts";

export type GoogleIdentity = Readonly<{
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}>;

export type GoogleOidcClient = Readonly<{
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    stepUp: boolean;
    loginHint?: string;
  }): Promise<string>;
  exchange(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
    stepUp: boolean;
  }): Promise<GoogleIdentity>;
}>;

export function createGoogleOidc(config: ApiConfig["googleOAuth"]): GoogleOidcClient | null {
  if (!config) return null;
  let discovered: Promise<Configuration> | null = null;
  const configuration = () => {
    if (!discovered) {
      discovered = discovery(
        new URL("https://accounts.google.com"),
        config.clientId,
        config.clientSecret,
      ).catch((error: unknown) => {
        discovered = null;
        throw error;
      });
    }
    return discovered;
  };

  return {
    async authorizationUrl(input) {
      const parameters: Record<string, string> = {
        redirect_uri: config.redirectUri,
        scope: "openid email profile",
        state: input.state,
        nonce: input.nonce,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
      };
      if (input.stepUp) parameters.max_age = "0";
      if (input.loginHint) parameters.login_hint = input.loginHint;
      return buildAuthorizationUrl(await configuration(), parameters).href;
    },

    async exchange(input) {
      const tokens = await authorizationCodeGrant(
        await configuration(),
        input.callbackUrl,
        {
          expectedState: input.state,
          expectedNonce: input.nonce,
          pkceCodeVerifier: input.codeVerifier,
          idTokenExpected: true,
          ...(input.stepUp ? { maxAge: 0 } : {}),
        },
      );
      const claims = tokens.claims();
      return {
        subject: typeof claims?.sub === "string" ? claims.sub : "",
        email: typeof claims?.email === "string" ? claims.email : "",
        emailVerified: claims?.email_verified === true,
        displayName: typeof claims?.name === "string" ? claims.name : null,
      };
    },
  };
}
