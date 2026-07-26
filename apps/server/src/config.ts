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
// Avatar presign flow (auth-users spec §3.4.2, R-user-3) — AU-6
// ---------------------------------------------------------------------------

/** Presigned avatar upload-ticket TTL — spec pins "≤ 10 min"; this IS 10 min. */
export const AVATAR_TICKET_TTL_SECONDS = 10 * 60;

/**
 * Outbound `HEAD https://cash.app/$<cashtag>` timeout (R-user-6). Short on
 * purpose: the check is best-effort UX sugar and fails OPEN — a save must
 * never hang on a third party (spec §3.4.2).
 */
export const CASHTAG_HEAD_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// Provider verification (auth-users spec §2.1, R-auth-1/2)
// ---------------------------------------------------------------------------

/** Apple identity tokens: `iss` must be exactly this (R-auth-1). */
export const APPLE_ISSUER = "https://appleid.apple.com";
/** Apple's published JWKS — free public endpoint (Law #5 compatible). */
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
/** Apple's code-exchange endpoint (R-auth-7). */
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
/**
 * Apple's token-revocation endpoint (R-user-9 / App Store guideline
 * 5.1.1(v)) — consumes the stored Apple refresh token at account deletion.
 */
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

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
  /**
   * `GET /invites/:token` + `POST /invites/:token/accept` — token-guessing
   * guard (trips spec §3.3: entropy already makes brute force infeasible;
   * this is defense-in-depth). Both routes are Auth: Required, so the primary
   * key is the authenticated user; the IP window backs it (T-6.2).
   */
  inviteTokenPerUser: { limit: 30, windowMs: MINUTE_MS },
  inviteTokenPerIp: { limit: 100, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitWindow | readonly RateLimitWindow[]>;

// ---------------------------------------------------------------------------
// Trips surface (trips spec §3.3) — T-6.1
// ---------------------------------------------------------------------------

/**
 * `GET /trips` default page size when the client omits `limit` (trips spec
 * §3.3: page-size caps are server-defined). The hard cap (100) lives in the
 * shared `TripListQuerySchema` — client and server validate the same bound.
 */
export const TRIPS_PAGE_SIZE_DEFAULT = 50;

// ---------------------------------------------------------------------------
// Members & invites surface (trips spec §3.3) — T-6.2
// ---------------------------------------------------------------------------

/**
 * Invite token entropy: 32 random bytes = 256 bits, double the R-db-9 floor
 * (≥128-bit), encoded base64url (URL-safe). A constant so the entropy test
 * can assert the floor structurally.
 */
export const INVITE_TOKEN_BYTES = 32;

/** Invite default lifetime — `expires_at` defaults to now + 7 days (Gate 2). */
export const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `GET /trips/:tripId/invites` page size (keyset-paginated, §3.3). */
export const INVITES_PAGE_SIZE = 50;

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
