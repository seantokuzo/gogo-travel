/**
 * Apple client-secret signer (shared by the code-exchange, R-auth-7, and the
 * revocation, R-user-9). Both of Apple's server endpoints authenticate with an
 * ES256 JWT "client secret" carrying the identical registration claims — one
 * signer, no drift, imported ONCE at wire time.
 *
 * Token hygiene: this module signs a short-lived JWT; it never logs, throws
 * with, or embeds any credential material.
 */
import { importPKCS8, SignJWT } from "jose";
import { APPLE_ISSUER } from "../config.js";

export interface AppleClientSecretConfig {
  /** Our bundle id — the client-secret `sub` and each request's `client_id`. */
  clientId: string;
  /** Apple developer team id — client-secret `iss`. */
  teamId: string;
  /** Apple Sign-in key id — client-secret `kid`. */
  keyId: string;
  /** The .p8 private key, PKCS#8 PEM. */
  privateKeyPem: string;
}

/** Client secrets are short-lived — minted per request, 5 minutes is ample. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/** Mints a fresh ES256 client-secret JWT for the given clock reading. */
export type AppleClientSecretSigner = (now: Date) => Promise<string>;

/**
 * Import the .p8 PEM ONCE and AWAIT it HERE at wire time — the key is static
 * for the process lifetime and the import is the expensive step, so hoisting
 * saves per-request work. The await is load-bearing (boot-parse-awaited
 * landmine, `.claude/rules/server.md`): a malformed key must fail LOUDLY at
 * boot, never defer its rejection to a first sign-in/deletion where an
 * error-swallowing catch would silently break Apple revocation (R-user-9).
 */
export async function createAppleClientSecretSigner(
  config: AppleClientSecretConfig,
): Promise<AppleClientSecretSigner> {
  const signingKey = await importPKCS8(config.privateKeyPem, "ES256");
  return async (now: Date): Promise<string> => {
    const iat = Math.floor(now.getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.clientId)
      .setAudience(APPLE_ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(iat + CLIENT_SECRET_TTL_SECONDS)
      .sign(signingKey);
  };
}
