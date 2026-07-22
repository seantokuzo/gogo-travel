/**
 * Apple authorization-code exchange (T-5.2 / AU-3 — R-auth-7).
 *
 * Exchanges the sign-in request's `authorization_code` at Apple's token
 * endpoint for the Apple refresh token we must hold (encrypted, §3.3.3) to
 * perform App-Store-mandated revocation at account deletion (guideline
 * 5.1.1(v)). The client secret is an ES256 JWT signed with the Apple Sign-in
 * key (env — Law #1).
 *
 * DI seam: the route depends on the `AppleCodeExchanger` interface; prod
 * wires `createAppleCodeExchanger` (real fetch to Apple's free endpoint —
 * Law #5 compatible); tests inject a fake and never touch the network.
 *
 * Token hygiene: errors carry HTTP status / reason codes only — the
 * authorization code, client secret, and returned tokens NEVER appear in an
 * error message or log line.
 */
import { importPKCS8, SignJWT } from "jose";
import { APPLE_ISSUER, APPLE_TOKEN_URL } from "../config.js";

export interface AppleCodeExchanger {
  /** Resolves to Apple's refresh token; throws on any failure (caller logs + continues, R-auth-7). */
  exchange(authorizationCode: string): Promise<string>;
}

export interface AppleExchangeConfig {
  /** Our bundle id — the token request's `client_id`. */
  clientId: string;
  /** Apple developer team id — client-secret `iss`. */
  teamId: string;
  /** Apple Sign-in key id — client-secret `kid`. */
  keyId: string;
  /** The .p8 private key, PKCS#8 PEM. */
  privateKeyPem: string;
}

/** Client secrets are short-lived — minted per exchange, 5 minutes is ample. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

async function signClientSecret(config: AppleExchangeConfig, now: Date): Promise<string> {
  const key = await importPKCS8(config.privateKeyPem, "ES256");
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
}

export function createAppleCodeExchanger(
  config: AppleExchangeConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): AppleCodeExchanger {
  return {
    async exchange(authorizationCode: string): Promise<string> {
      const clientSecret = await signClientSecret(config, now());
      const response = await fetchImpl(APPLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          client_id: config.clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      if (!response.ok) {
        // Status only — Apple's error body is not echoed (hygiene).
        throw new Error(`apple token exchange failed (status ${response.status})`);
      }
      const body: unknown = await response.json();
      const refreshToken =
        typeof body === "object" && body !== null && "refresh_token" in body
          ? body.refresh_token
          : undefined;
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw new Error("apple token exchange succeeded but returned no refresh_token");
      }
      return refreshToken;
    },
  };
}
