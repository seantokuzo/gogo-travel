/**
 * Provider identity-token verification (T-5.2 / AU-3 — R-auth-1..3).
 *
 * Verifies Apple identity tokens and Google ID tokens server-side before any
 * account logic: JWKS signature (pinned RS256 allowlist — `none`/HS/EC are
 * rejected at the `jwtVerify` boundary), `iss`, `aud`, `exp`, and nonce
 * binding (Apple: `nonce = SHA-256(raw_nonce)` hex; Google: raw match).
 *
 * DI seam: JWKS resolution is injected as jose's `JWTVerifyGetKey` — prod
 * wires `createRemoteJWKSet` (cached, `kid`-keyed, one refetch on unknown
 * `kid` then failure — jose's built-in rotation tolerance, spec §3.1); tests
 * wire `createLocalJWKSet` over in-test-minted keys and NEVER touch the
 * network.
 *
 * Failure posture (R-auth-1): every failure collapses into
 * `ProviderVerificationError` with a machine reason for internal logs only —
 * the route serializes all of them as one undifferentiated 401
 * `UNAUTHENTICATED`. No claim value, token fragment, or key material ever
 * rides on an error message.
 */
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { APPLE_ISSUER, GOOGLE_ISSUERS, PROVIDER_TOKEN_ALGORITHMS } from "../config.js";
import { safeEqual, sha256Hex } from "./crypto.js";

export type AuthProvider = "apple" | "google";

/** Internal-only reason codes — logged with a requestId, never on the wire. */
export type VerificationFailureReason =
  | "token_invalid" // signature / iss / aud / exp / alg / kid / malformed
  | "nonce_mismatch" // R-auth-3: token minted for a different sign-in attempt
  | "nonce_missing";

export class ProviderVerificationError extends Error {
  readonly reason: VerificationFailureReason;

  constructor(reason: VerificationFailureReason, cause?: unknown) {
    // Fixed message — callers log `reason`; the wire body never varies.
    super("provider token verification failed", { cause });
    this.name = "ProviderVerificationError";
    this.reason = reason;
  }
}

/** What sign-in needs from a verified token — nothing else escapes. */
export interface VerifiedIdentity {
  provider: AuthProvider;
  /** The provider's stable subject — `users.apple_sub` / `users.google_sub`. */
  sub: string;
  email: string | null;
  /**
   * R-auth-6 gate. Apple: verified by construction (spec §3.6.2) unless the
   * token itself says otherwise; Google: the `email_verified` claim, which
   * some issuer paths serialize as the string "true".
   */
  emailVerified: boolean;
  /** Google-only display-name material (Apple names arrive in the request body). */
  name: {
    fullName?: string | undefined;
    givenName?: string | undefined;
    familyName?: string | undefined;
  };
}

export interface ProviderVerifierDeps {
  /** JWKS seam — jose `JWTVerifyGetKey` (remote in prod, local in tests). */
  appleJwks: JWTVerifyGetKey;
  googleJwks: JWTVerifyGetKey;
  /** Our bundle id (R-auth-1). */
  appleAudience: string;
  /** Our OAuth client id(s) (R-auth-2). */
  googleAudiences: readonly string[];
}

function claimString(payload: JWTPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Providers serialize boolean claims inconsistently ("true" vs true). */
function claimBoolean(payload: JWTPayload, key: string): boolean | null {
  const value = payload[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/**
 * `sub` is mandatory post-verification; a signed token without one is
 * malformed. jose has already enforced signature/iss/aud/exp by the time
 * this runs.
 */
function requireSub(payload: JWTPayload): string {
  const sub = claimString(payload, "sub");
  if (!sub) throw new ProviderVerificationError("token_invalid");
  return sub;
}

/** Nonce binding (R-auth-3) — `expected` is derived from the request's `raw_nonce`. */
function requireNonce(payload: JWTPayload, expected: string): void {
  const nonce = claimString(payload, "nonce");
  if (!nonce) throw new ProviderVerificationError("nonce_missing");
  if (!safeEqual(nonce, expected)) throw new ProviderVerificationError("nonce_mismatch");
}

async function verifyProviderJwt(
  token: string,
  jwks: JWTVerifyGetKey,
  issuer: string | string[],
  audience: string | string[],
): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: [...PROVIDER_TOKEN_ALGORITHMS],
      issuer,
      audience,
    });
    return payload;
  } catch (cause) {
    // Signature, alg, kid, iss, aud, exp, malformed compact form — one bucket.
    throw new ProviderVerificationError("token_invalid", cause);
  }
}

/**
 * R-auth-1 + R-auth-3 (Apple): the token's `nonce` claim must equal
 * `SHA-256(raw_nonce)` — the client hashes the raw nonce into the
 * ASAuthorization request and posts the raw value here.
 */
export async function verifyAppleToken(
  deps: ProviderVerifierDeps,
  identityToken: string,
  rawNonce: string,
): Promise<VerifiedIdentity> {
  const payload = await verifyProviderJwt(
    identityToken,
    deps.appleJwks,
    APPLE_ISSUER,
    deps.appleAudience,
  );
  requireNonce(payload, sha256Hex(rawNonce));

  const email = claimString(payload, "email");
  // Verified by construction (spec §3.6.2) — but if Apple explicitly says
  // `email_verified: false` (legacy/managed Apple IDs), believe the token:
  // trusting an email the provider disowns is the R-auth-6 takeover vector.
  const emailVerified = email !== null && claimBoolean(payload, "email_verified") !== false;

  return {
    provider: "apple",
    sub: requireSub(payload),
    email,
    emailVerified,
    name: {},
  };
}

/**
 * R-auth-2 + R-auth-3 (Google): `iss` ∈ {accounts.google.com,
 * https://accounts.google.com}; the `nonce` claim is the raw nonce verbatim.
 */
export async function verifyGoogleToken(
  deps: ProviderVerifierDeps,
  idToken: string,
  rawNonce: string,
): Promise<VerifiedIdentity> {
  const payload = await verifyProviderJwt(
    idToken,
    deps.googleJwks,
    [...GOOGLE_ISSUERS],
    [...deps.googleAudiences],
  );
  requireNonce(payload, rawNonce);

  const email = claimString(payload, "email");
  const emailVerified = email !== null && claimBoolean(payload, "email_verified") === true;

  return {
    provider: "google",
    sub: requireSub(payload),
    email,
    emailVerified,
    name: {
      fullName: claimString(payload, "name") ?? undefined,
      givenName: claimString(payload, "given_name") ?? undefined,
      familyName: claimString(payload, "family_name") ?? undefined,
    },
  };
}
