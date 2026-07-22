/**
 * Server config constants — the single config module pinned by auth-users
 * spec §3.2: TTLs and limits live here so tests can assert them; changing a
 * value is a config PR, not a spec change, unless semantics change.
 *
 * Secrets NEVER live here (Law #1) — key material comes from env via
 * `loadEnv()` (src/env.ts), the only `process.env` reader.
 */

// ---------------------------------------------------------------------------
// Our tokens (auth-users spec §3.2)
// ---------------------------------------------------------------------------

/** Access-token TTL — `expires_in` on the wire is this value, in seconds. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh-token TTL, sliding via rotation (spec §3.2). */
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Access-token claims are pinned: `{iss, aud, sub, sid, iat, exp}` — nothing else. */
export const JWT_ISSUER = "gogo-api";
export const JWT_AUDIENCE = "gogo-mobile";

/**
 * The ONLY algorithm our access tokens are signed/verified with
 * (R-auth-12: pinned allowlist; `none`/HS-family unrepresentable).
 */
export const ACCESS_TOKEN_ALGORITHMS = ["ES256"] as const;

/**
 * `GET /auth/sessions` page size (spec §3.4.1 — `Paginated<AuthSessionInfo>`).
 * Devices per user are few; this is a keyset-pagination guard, not a tuning
 * knob. A config constant so the test can assert the page boundary.
 */
export const SESSIONS_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Provider verification (auth-users spec §2.1, R-auth-1/2)
// ---------------------------------------------------------------------------

/** Apple identity tokens: `iss` must be exactly this (R-auth-1). */
export const APPLE_ISSUER = "https://appleid.apple.com";
/** Apple's published JWKS — free public endpoint (Law #5 compatible). */
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
/** Apple's code-exchange endpoint (R-auth-7). */
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

/** Google ID tokens: `iss` ∈ this set (R-auth-2). */
export const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"] as const;
/** Google's published JWKS — free public endpoint (Law #5 compatible). */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * Both providers sign identity/ID tokens with RS256 — the pinned allowlist
 * for provider verification. `none`, HS-family, and EC algs are rejected at
 * the `jwtVerify` boundary before any claim is read.
 */
export const PROVIDER_TOKEN_ALGORITHMS = ["RS256"] as const;
