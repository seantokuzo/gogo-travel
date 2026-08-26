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
  /**
   * `GET /places/search` — per authenticated user (T-6.5; the T-6.4 round-1
   * enqueue-volume defer, §3.6.3 posture). Unlike keyed CRUD reads, search
   * takes UNBOUNDED-COST inputs (arbitrary trgm text, arbitrary geo windows)
   * AND is the reachable mouth of the search-miss ingest seam — so it gets a
   * limiter where GET /trips does not. 120/min ≈ 2 rps sustained: far above
   * debounced type-ahead + map panning, far below attack utility. Layered
   * with the per-search cell cap and the queue's per-cell throttle + global
   * hourly budget below.
   */
  placesSearch: { limit: 120, windowMs: MINUTE_MS },
  /**
   * `POST /trips/:tripId/itinerary/refresh-legs` — per TRIP (§3.4: "rate-
   * limited per trip; window is config"; T-7.3). Keyed on the gate-proven
   * tripId, not the caller: refresh fans out provider quota per trip, so the
   * budget is the trip's however many members pull. 6/min ≫ human
   * pull-to-refresh, ≪ enqueue-spam utility — and the worker's debounce
   * coalesces whatever gets through into one recompute per window anyway.
   */
  refreshLegs: { limit: 6, windowMs: MINUTE_MS },
  /**
   * `GET /fx/rate` — per authenticated user (T-9.4; P-9 ruling ③). The
   * per-day cache stores only PROVIDER-CONFIRMED pairs, so misses on
   * never-confirmed pairs always reach the keyless third party — without a
   * limiter one client could fan unbounded traffic (and timeout holds) at
   * Frankfurter. 20/min ≫ real expense entry (one fetch per currency pick,
   * then day-cached), ≪ probe-spam utility.
   */
  fxRate: { limit: 20, windowMs: MINUTE_MS },
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

/**
 * Push-invalidation drop-log cap (T-6.3 round-1 advisory #3) — one line of
 * ops context, never a dump; same posture as PLACES_INGEST_ERROR_MAX_CHARS.
 * Applied AFTER token redaction in `push-invalidation.ts`.
 */
export const PUSH_EVENT_LOG_MAX_CHARS = 300;

// ---------------------------------------------------------------------------
// Places spine ingest (places spec §3.1, R-places-4/5/7) — T-6.4 / PL-1.
// Grid + dedup thresholds live in `@gogo/shared/config/places` (§3.1.4:
// shared with the map client); these are the SERVER-side job knobs.
// ---------------------------------------------------------------------------

/** Refresh window: a `ready` region younger than this is not re-ingested
 * (R-places-5 — "default 90 days, config"). Demand-driven only; no cron. */
export const PLACES_REFRESH_WINDOW_DAYS = 90;
export const PLACES_REFRESH_WINDOW_MS = PLACES_REFRESH_WINDOW_DAYS * DAY_MS;

/** Rows per upsert statement (§3.1.4 step 4 pins 500–1,000; GIN pending-list
 * churns badly under row-by-row writes — places schema breadcrumb). */
export const PLACES_INGEST_BATCH_SIZE = 500;

/** Per-source attempts before the region row goes `failed` (§3.1.4 step 6:
 * "retry with backoff (max 3)"). */
export const PLACES_INGEST_MAX_ATTEMPTS = 3;
/** Backoff base — attempt N waits base × 2^(N−1). */
export const PLACES_INGEST_RETRY_BASE_MS = 1_000;

/** Secondary-trigger throttle: one enqueue per cell per hour (§3.1.3 —
 * scan-the-globe panning must not stampede jobs; R-places-7). */
export const PLACES_SEARCH_MISS_THROTTLE_MS = HOUR_MS;

/** Region-row `error` cap — visible in ops queries, never a stack dump. */
export const PLACES_INGEST_ERROR_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// Place search (places spec §3.3 GET /places/search, R-places-6..8) — T-6.5.
// Enqueue-volume bounds are the T-6.4 round-1 security defer: the search
// endpoint makes DISTINCT-CELL spam reachable (a panned globe is ~260k grid
// cells, each enqueued cell = remote parquet scans + queue memory), so the
// seam gets layered, config-pinned bounds — per-request, per-cell (throttle
// above), per-user (RATE_LIMITS.placesSearch), and global-per-hour.
// ---------------------------------------------------------------------------

/** `GET /places/search` default page size (`limit` omitted). The hard cap
 * (50) lives in the shared `PlaceSearchQuerySchema` — spec §3.3. */
export const PLACES_SEARCH_PAGE_SIZE_DEFAULT = 20;

/** `near` search radius when `radius_m` is omitted (spec §3.3: default
 * 2,000 m; the 50,000 m max is the shared schema's bound). */
export const PLACES_SEARCH_RADIUS_M_DEFAULT = 2_000;

/** Max cells ONE search's coverage miss may enqueue (R-places-7 secondary
 * trigger). Center-out selection keeps the cells the user is looking at;
 * 9 mirrors the primary trigger's 3×3 destination coverage. */
export const PLACES_SEARCH_MISS_MAX_CELLS = 9;

/** Global search-miss enqueue budget: at most this many cells per rolling
 * window across ALL users (queue-level hard ceiling — bounds job volume and
 * queue memory even under distinct-cell spam; destination-tier enqueues are
 * deliberately NOT charged, they are bounded by trip writes). Exhaustion is
 * logged and non-fatal: backfill resumes next window (R-places-7 — never an
 * error, never a block). */
export const PLACES_SEARCH_MISS_GLOBAL_PER_WINDOW = 200;
export const PLACES_SEARCH_MISS_GLOBAL_WINDOW_MS = HOUR_MS;

/**
 * `GET /trips/:tripId/saved-places` default page size when the client omits
 * `limit` (places spec §3.3: default 100 — the map wants the full pin set in
 * one page for typical trips). The hard cap (100) lives in the shared
 * `SavedPlacesListQuerySchema` — spec §3.3.
 */
export const SAVED_PLACES_PAGE_SIZE_DEFAULT = 100;

// ---------------------------------------------------------------------------
// Bookings surface (itinerary-bookings spec §3.4) — T-7.1
// ---------------------------------------------------------------------------

/**
 * `GET /trips/:tripId/bookings` default page size when the client omits
 * `limit` (page-size caps are server-defined). The hard cap (100) lives in
 * the shared `BookingListQuerySchema` — client and server validate the same
 * bound (trips convention).
 */
export const BOOKINGS_PAGE_SIZE_DEFAULT = 50;

// ---------------------------------------------------------------------------
// Travel-leg computation job (itinerary-bookings spec §3.5, R-ib-19..23) —
// T-7.3 / IB-3. The MODE set is shared config (`@gogo/shared/config/
// travel-legs`, R-ib-21); these are the SERVER-side job knobs.
// ---------------------------------------------------------------------------

/** Dirty-day debounce window (§3.5 step 1: "single-digit seconds" — a drag
 * session costs one recompute, not one per drop). Fixed from a trip's FIRST
 * mark; never extended (bounded settlement). */
export const TRAVEL_LEGS_DEBOUNCE_MS = 3_000;

/** Leg staleness TTL (R-ib-23: "config; default 24 h") — one rule for the
 * diff path AND the sweep: a row past TTL is never reused. */
export const TRAVEL_LEGS_TTL_MS = 24 * HOUR_MS;

/** Refresh-job trip horizon (R-ib-23: trips `active` or starting within 7
 * days). */
export const TRAVEL_LEGS_REFRESH_HORIZON_DAYS = 7;

/** Staleness-sweep cadence (in-process interval; §3.5 step 7 — day-of
 * traffic-aware cadence is the today bundle's, out of scope here). */
export const TRAVEL_LEGS_SWEEP_INTERVAL_MS = HOUR_MS;

/** Per provider call bound — both the adapters' AbortSignal AND the
 * recompute's deterministic race (a hanging provider can never wedge the
 * serial drain; T-6.3 bounded-settlement lesson). */
export const TRAVEL_LEGS_PROVIDER_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Money surface (money spec §3.2) — T-9.2/T-9.3; page-size defaults hoisted
// here at T-9.4 (the QUEUE dispatch-obligations row: one `config.ts` home
// for the `*_PAGE_SIZE_DEFAULT` family — the W2 parallel-worktree split kept
// them module-local, which was three-homes drift waiting to happen).
// ---------------------------------------------------------------------------

/**
 * `GET /trips/:tripId/expenses` default page size when the client omits
 * `limit` (E2). The hard cap (100) lives in the shared
 * `ExpenseListQuerySchema` — client and server validate the same bound
 * (trips convention).
 */
export const EXPENSES_PAGE_SIZE_DEFAULT = 50;

/**
 * `GET /trips/:tripId/settlements` default page size when the client omits
 * `limit` (S2). The hard cap (100) lives in the shared
 * `SettlementListQuerySchema` — same convention.
 */
export const SETTLEMENTS_PAGE_SIZE_DEFAULT = 50;

// ---------------------------------------------------------------------------
// FX proxy (P-9 ruling ③ — keyless Frankfurter v2 behind GET /fx/rate) — T-9.4
// ---------------------------------------------------------------------------

/**
 * Outbound Frankfurter call bound (AbortSignal.timeout in the adapter — the
 * travel-legs provider posture). Short on purpose: the fetch is interactive
 * expense-entry sugar with a guaranteed manual-rate fallback (R-money-6), so
 * it fails FAST toward manual entry rather than hanging a form — the
 * `CASHTAG_HEAD_TIMEOUT_MS` best-effort rationale, same number.
 */
export const FX_PROVIDER_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// App-wide request-body cap (PR #11 R1 security defer) — createApp
// ---------------------------------------------------------------------------

/**
 * Hono `bodyLimit` cap, applied ONCE app-wide before every router: without
 * it, every POST/PATCH buffers + JSON-parses arbitrarily large bodies before
 * zod ever runs. 256 KiB is ~50× the largest legitimate payload on any
 * current surface (a maxed-out flight `details` with 8 segments is single-
 * digit KiB; avatar bytes go direct-to-storage via presign, never through
 * JSON) while starving memory-amplification abuse. Exceeding it returns the
 * shared envelope's `PAYLOAD_TOO_LARGE` (413).
 */
export const BODY_LIMIT_MAX_BYTES = 256 * 1024;

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
