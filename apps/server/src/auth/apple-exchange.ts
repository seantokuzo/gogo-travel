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
import { APPLE_TOKEN_URL } from "../config.js";
import {
  createAppleClientSecretSigner,
  type AppleClientSecretConfig,
} from "./apple-client-secret.js";

export interface AppleCodeExchanger {
  /** Resolves to Apple's refresh token; throws on any failure (caller logs + continues, R-auth-7). */
  exchange(authorizationCode: string): Promise<string>;
}

/** Alias of the shared client-secret config — exchange needs nothing more. */
export type AppleExchangeConfig = AppleClientSecretConfig;

/**
 * Cap the Apple token-endpoint round-trip. R-auth-7 says exchange FAILURE
 * never fails the sign-in — but a hang is not a failure until it times out,
 * and undici's default (~300s) would pin every Apple sign-in on a degraded
 * endpoint (the credential store is awaited before token issuance). Aborting
 * at 5s turns a stall into the specced caught-and-logged failure so sign-in
 * proceeds and the credential is retried next sign-in.
 */
const EXCHANGE_TIMEOUT_MS = 5_000;

export async function createAppleCodeExchanger(
  config: AppleExchangeConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  timeoutMs: number = EXCHANGE_TIMEOUT_MS,
): Promise<AppleCodeExchanger> {
  // Sign the client secret off a key imported ONCE at wire time (the shared
  // signer awaits `importPKCS8` — a malformed APPLE_PRIVATE_KEY fails LOUD at
  // boot, not inside the error-swallowed store path on first sign-in; see
  // apple-client-secret.ts). This construction-time await preserves that
  // fail-loud posture through the exchanger.
  const signClientSecret = await createAppleClientSecretSigner(config);
  return {
    async exchange(authorizationCode: string): Promise<string> {
      const clientSecret = await signClientSecret(now());
      const response = await fetchImpl(APPLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          client_id: config.clientId,
          client_secret: clientSecret,
        }).toString(),
        // A hung endpoint aborts here → caught by the caller, sign-in continues.
        signal: AbortSignal.timeout(timeoutMs),
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
