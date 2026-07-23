/**
 * Server config constants — the single config module pinned by auth-users
 * spec §3.2: TTLs and limits live here so tests can assert them; changing a
 * value is a config PR, not a spec change, unless semantics change.
 *
 * Secrets NEVER live here (Law #1) — key material comes from env via
 * `loadEnv()` (src/env.ts), the only `process.env` reader.
 */
import type { TripMemberRole } from "@gogo/shared/enums";

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

// ---------------------------------------------------------------------------
// Rate limits on auth surfaces (auth-users spec §3.6.3, R-auth-14)
// ---------------------------------------------------------------------------

/**
 * One rate-limit window: at most `limit` requests per rolling `windowMs`,
 * measured against a key (IP / session / user). Exceeding any window returns
 * 429 `RATE_LIMITED` + `Retry-After` and processes nothing (R-auth-14).
 */
export interface RateLimitWindow {
  limit: number;
  windowMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * §3.6.3 table — server config constants (a limit change is a config PR, not a
 * spec change). Backing store is single-instance in-memory (§3.6.3: acceptable
 * until ≥ 2 server instances); see `http/rate-limit.ts`.
 *
 * AU-5 wires the surfaces that exist today: the two sign-in routes and refresh
 * (IP + session). The user-keyed rows (`avatarUpload`, `paymentHandles`,
 * `deleteAccount`) are pinned here now so AU-6/AU-8 mount them without
 * re-deriving the numbers — the same `rateLimit` middleware, user-keyed.
 */
export const RATE_LIMITS = {
  /** `POST /auth/apple`, `POST /auth/google` — keyed by IP (credential grinding). */
  signIn: [
    { limit: 10, windowMs: MINUTE_MS },
    { limit: 50, windowMs: DAY_MS },
  ],
  /** `POST /auth/refresh` — per-IP theft-probing bound. */
  refreshPerIp: { limit: 60, windowMs: HOUR_MS },
  /** `POST /auth/refresh` — per-session rotation-abuse bound (sid via token row). */
  refreshPerSession: { limit: 30, windowMs: HOUR_MS },
  /** `POST /users/me/avatar-upload` — per user (presign farming); AU-6. */
  avatarUpload: { limit: 10, windowMs: HOUR_MS },
  /** `PATCH /users/me/payment-handles` — per user (bounds cash.app HEADs); AU-6. */
  paymentHandles: { limit: 10, windowMs: HOUR_MS },
  /** `DELETE /users/me` — per user (fat-finger + abuse); AU-8. */
  deleteAccount: { limit: 3, windowMs: DAY_MS },
} as const satisfies Record<string, RateLimitWindow | readonly RateLimitWindow[]>;

// ---------------------------------------------------------------------------
// Trip role ladder (auth-users spec §2.5 R-authz-3; `requireTripMember`)
// ---------------------------------------------------------------------------

/**
 * `viewer < editor < owner` (R-authz-3). Numeric ranks make the min-role
 * comparison a `>=`; per-endpoint declarations may only tighten (raise the
 * minimum), never loosen. Reads need `viewer`, mutations `editor`, and
 * membership/role/invite/trip-deletion management `owner`.
 */
export const TRIP_ROLE_RANK: Readonly<Record<TripMemberRole, number>> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};
