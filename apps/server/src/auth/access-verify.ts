/**
 * Stateless access-token verification (T-5.3 / AU-4 — R-auth-12).
 *
 * Verifies our own ES256 access tokens with NO database read: pinned
 * algorithm allowlist `[ES256]` (`none`/HS-family rejected at the `jwtVerify`
 * boundary before any claim is read — algorithm-confusion defense), `iss`/
 * `aud` match, and `exp` **present and valid** (R-auth-12 lists `exp` as a
 * required check; jose only validates `exp` when it is present, so we pin its
 * presence with `requiredClaims: ["exp"]` — an `exp`-less token would otherwise
 * verify as non-expiring). On success it returns exactly the two claims
 * `requireAuth` attaches to the request context (`sub` → userId, `sid` →
 * sessionId); nothing else escapes.
 *
 * Session revocation is deliberately NOT consulted here (spec §R-auth-12):
 * revocation takes effect at the next refresh boundary (≤ `ACCESS_TOKEN_TTL`),
 * a bounded latency accepted by design. The refresh token is the credential
 * that dies immediately (token-rotation.ts); the access token is a 15-minute
 * stateless bearer.
 *
 * Failure posture: every failure collapses into `AccessTokenInvalidError` —
 * the middleware serializes all of them as one undifferentiated 401
 * `UNAUTHENTICATED`. No claim value, token fragment, or key material ever
 * rides on an error message (Law #1 / R-auth-9 hygiene).
 */
import { jwtVerify, type CryptoKey, type JWTPayload, type KeyObject } from "jose";
import { ACCESS_TOKEN_ALGORITHMS, JWT_AUDIENCE, JWT_ISSUER } from "../config.js";

/**
 * ES256 verification material — the PUBLIC part of the signing key, derived
 * at boot (wire.ts) from `AUTH_ES256_PRIVATE_KEY`. Verification only; a
 * `kid`-keyed key set is the rotation story (spec §3.2), unneeded for v1's
 * single active key.
 */
export interface AccessTokenVerifier {
  publicKey: CryptoKey | KeyObject;
}

/** The auth context a verified access token yields (spec §3.5 `requireAuth`). */
export interface AccessTokenClaims {
  /** `sub` claim — `users.id`. */
  userId: string;
  /** `sid` claim — `auth_sessions.id`. */
  sessionId: string;
}

/** One bucket for every verification failure — the wire body never varies. */
export class AccessTokenInvalidError extends Error {
  constructor(cause?: unknown) {
    // Fixed message; callers never surface it — they emit the uniform 401.
    super("access token verification failed", cause !== undefined ? { cause } : undefined);
    this.name = "AccessTokenInvalidError";
  }
}

/**
 * Verify a bearer access token statelessly. Throws `AccessTokenInvalidError`
 * on any failure (bad signature, wrong alg/iss/aud, expired, malformed, or a
 * signed token missing `sub`/`sid`).
 */
export async function verifyAccessToken(
  verifier: AccessTokenVerifier,
  token: string,
): Promise<AccessTokenClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, verifier.publicKey, {
      algorithms: [...ACCESS_TOKEN_ALGORITHMS],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      // jose enforces `exp` only when present; require its presence so a
      // signed-but-`exp`-less token can't verify as non-expiring (R-auth-12).
      requiredClaims: ["exp"],
    }));
  } catch (cause) {
    // Signature, alg allowlist, iss, aud, missing/invalid exp, malformed
    // compact form — one bucket.
    throw new AccessTokenInvalidError(cause);
  }

  const userId = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
  const sid = payload.sid;
  const sessionId = typeof sid === "string" && sid.length > 0 ? sid : null;
  // A validly-signed token from our own issuer must carry both — a missing
  // claim means a token we would never have minted (issuance pins §3.2).
  if (!userId || !sessionId) throw new AccessTokenInvalidError();

  return { userId, sessionId };
}
