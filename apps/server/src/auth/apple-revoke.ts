/**
 * Apple token revocation (T-5.6 / AU-8 — R-user-9).
 *
 * At account deletion the App Store mandates we revoke the Sign-in-with-Apple
 * refresh token we stored (guideline 5.1.1(v)). This posts the token to Apple's
 * REST revocation endpoint with an ES256 client secret — the SAME credential
 * construction as the code exchange (shared signer, apple-client-secret.ts).
 *
 * DI seam: the deletion route depends on the `AppleTokenRevoker` interface;
 * prod wires `createAppleTokenRevoker` (real fetch to Apple's free endpoint —
 * Law #5 compatible); tests inject a fake and never touch the network.
 *
 * Failure posture (R-user-9): `revoke` throws on any non-2xx / network error;
 * the CALLER logs it and continues — a revocation failure NEVER rolls back the
 * deletion (the local scrub is the source of truth; App Store mandate satisfied
 * by the scrub per schema spec R-db-16).
 *
 * Token hygiene: errors carry HTTP status only — the refresh token and Apple's
 * response body NEVER appear in an error message or log line.
 */
import { APPLE_REVOKE_URL } from "../config.js";
import {
  createAppleClientSecretSigner,
  type AppleClientSecretConfig,
} from "./apple-client-secret.js";

export interface AppleTokenRevoker {
  /** Revoke an Apple refresh token; throws on any failure (caller logs + continues, R-user-9). */
  revoke(refreshToken: string): Promise<void>;
}

/** Alias of the shared client-secret config — revocation needs nothing more. */
export type AppleRevokeConfig = AppleClientSecretConfig;

/**
 * Cap the Apple revoke round-trip. R-user-9 says a revocation failure never
 * blocks the (already-committed) deletion — but a hang is not a failure until
 * it times out, and undici's ~300s default would pin the deletion response on a
 * degraded endpoint. Aborting at 5s turns a stall into the caught-and-logged
 * failure the route already tolerates.
 */
const REVOKE_TIMEOUT_MS = 5_000;

export async function createAppleTokenRevoker(
  config: AppleRevokeConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  timeoutMs: number = REVOKE_TIMEOUT_MS,
): Promise<AppleTokenRevoker> {
  // Key imported ONCE at wire time via the shared signer — a malformed
  // APPLE_PRIVATE_KEY fails LOUD at boot (boot-parse-awaited landmine),
  // never deferred to a first deletion.
  const signClientSecret = await createAppleClientSecretSigner(config);
  return {
    async revoke(refreshToken: string): Promise<void> {
      const clientSecret = await signClientSecret(now());
      const response = await fetchImpl(APPLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: clientSecret,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
        // A hung endpoint aborts here → caught by the caller, deletion stands.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Status only — never echo the token or Apple's error body (hygiene).
        throw new Error(`apple token revoke failed (status ${response.status})`);
      }
    },
  };
}
