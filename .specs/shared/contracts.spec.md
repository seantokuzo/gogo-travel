# Shared Contracts Spec (`@gogo/shared`) — `.specs/shared/contracts.spec.md`

> **Task:** T-2.1 · **Status:** DRAFT — pending Sean approval (P-2 gate 2).
> Not approvable until zero `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** ADR-004 (stack: `@gogo/shared` = Zod schemas as single source
> of truth; all wire types `z.infer`), ADR-005 (plan/entitlement concept lives
> in shared), `docs/PLANNING.md § Architecture`,
> `.specs/research/ai-architecture.md` (structured-output limits),
> `.specs/database/schema.spec.md` (companion — table shapes, enum values,
> JSONB semantics; the two must never drift).

---

## 1. Scope

The `packages/shared` workspace (`@gogo/shared`): Zod schemas per domain,
inferred types, enum tuples, API envelope conventions, endpoint descriptors,
AI structured-output schemas, and the DI conventions that keep shared code
platform-agnostic. Consumed by `apps/server` (Hono + `@hono/zod-validator`,
Drizzle pgEnums) and `apps/mobile` (TanStack Query hooks, forms).

Non-goals: no React/React Native code, no I/O, no environment access, no
design tokens (that's `packages/tokens`).

---

## 2. Requirements (EARS)

- **R-shared-1 (single source of truth):** WHEN a type crosses the wire or a
  value set is shared between DB, server, and mobile THE SYSTEM SHALL define
  it once in `@gogo/shared` and derive all other representations from it
  (TS types via `z.infer`, pgEnums via the exported tuple). Hand-written
  duplicate interfaces for wire types SHALL NOT exist.
- **R-shared-2 (enum pattern):** WHEN an enum is defined THE SYSTEM SHALL
  export (a) a readonly const tuple, (b) a `z.enum` schema built from it, and
  (c) the inferred union type — and `apps/server` SHALL build its Drizzle
  `pgEnum` from that same tuple (values enumerated in schema spec §3.2).
- **R-shared-3 (validation at the boundary):** WHEN the server receives any
  request body, path param, or query string THE SYSTEM SHALL validate it with
  a `@gogo/shared` schema via `@hono/zod-validator` before any handler logic
  runs.
- **R-shared-4 (typed errors):** WHEN any request fails THE SYSTEM SHALL
  respond with a non-2xx status and the shared `ApiError` envelope
  (`{ error: { code, message, details?, requestId? } }`) where `code` is a
  member of the shared `ErrorCode` enum — never a bare string, stack trace,
  or ad-hoc shape.
- **R-shared-5 (success shape):** WHEN a request succeeds THE SYSTEM SHALL
  return the documented response schema directly (2xx, no wrapper object);
  list endpoints SHALL use the shared `Paginated<T>` shape
  (`{ items, nextCursor }`).
- **R-shared-6 (money on the wire):** WHEN a monetary amount crosses the wire
  THE SYSTEM SHALL encode it as integer cents validated by the shared `Cents`
  schema (`int`, `≥ 0` — Law #2), paired with a `CurrencyCode` field per the
  owning schema; floats SHALL fail validation.
- **R-shared-7 (Claude compatibility):** WHEN a schema is used as a Claude
  structured-output format THE SYSTEM SHALL keep it within the documented
  constraints (§3.7): no recursion, no numeric `.min()`/`.max()`/other
  numeric range constraints, flat-ish nesting (≤ 3 levels, arrays of flat
  objects allowed); numeric range and cross-field rules SHALL be enforced by
  a separate server-side refinement step after parsing.
- **R-shared-8 (AI schema versioning):** WHEN an AI output schema changes
  shape THE SYSTEM SHALL bump that schema's exported integer
  `SCHEMA_VERSION`; the `ai_cache` key derivation SHALL include it (schema
  spec R-db-10) so stale cached shapes can never be parsed against new
  schemas.
- **R-shared-9 (platform-agnostic):** THE `@gogo/shared` package SHALL import
  nothing from `react`, `react-native`, `expo-*`, `node:*`, or any I/O
  library; anything platform-bound (fetch, storage, clock, auth token) SHALL
  be consumed through an interface defined in shared and injected by the app
  (§3.6).
- **R-shared-10 (JSONB gatekeeping):** WHEN the server writes any JSONB
  column THE SYSTEM SHALL first parse the payload with the corresponding
  shared schema (strip unknown keys); DB writes of unvalidated JSONB SHALL
  NOT exist (mirror of schema spec R-db-17).
- **R-shared-11 (dates on the wire):** WHEN a date or datetime crosses the
  wire THE SYSTEM SHALL encode it as an ISO-8601 string (`ISODate` for
  calendar dates, `ISODateTime` for instants with offset) — never epoch
  numbers or `Date` objects.
- **R-shared-12 (entitlement config):** THE SYSTEM SHALL define plan defaults
  (e.g. `free.ai_calls_per_day = 30`) as shared config keyed by the `plan`
  enum, so gating changes are config edits, not migrations (ADR-005); the
  effective-entitlement resolver (`overrides ?? plan default`) SHALL live in
  shared and be the only resolution path.
- **R-shared-13 (no version guessing):** WHEN the package is scaffolded (P-3)
  THE SYSTEM SHALL pin Zod and every dependency via `npm view <pkg> version`
  and verify `zodOutputFormat` (from `@anthropic-ai/sdk/helpers/zod`)
  compatibility with the pinned Zod major via Context7 — never from training
  data (CLAUDE.md § Before you code).
- **R-shared-14 (module shape):** WHEN a domain module is added THE SYSTEM
  SHALL export, per schema: the Zod schema (`XSchema`), the inferred type
  (`type X = z.infer<typeof XSchema>`), and any enum tuples it owns — via
  subpath exports (`@gogo/shared/<domain>`), side-effect-free and
  tree-shakeable (`"sideEffects": false`).

---

## 3. Design

### 3.1 Package layout (schema-per-domain, mirroring the DB spec)

```
packages/shared/src/
├── enums.ts              # ALL const tuples + z.enum schemas (schema spec §3.2 + wire-only tuples, §3.2 note)
├── scalars.ts            # Cents, CurrencyCode, ISODate, ISODateTime, ISOTime, Uuid, Lat, Lng
├── api/
│   ├── envelope.ts       # ApiError, ErrorCode, Paginated<T>
│   └── descriptor.ts     # EndpointDescriptor + helper types (§3.6)
├── config/
│   └── entitlements.ts   # PLAN_DEFAULTS, resolveEntitlements()  (R-shared-12)
│   └── ai-pricing.ts     # feature→model map + per-model token pricing (kill-switch math)
├── domains/
│   ├── user.ts           # User, UserProfile (public view), UserPrefs, PaymentHandles
│   ├── auth.ts           # AppleSignInRequest, GoogleSignInRequest, RefreshRequest,
│   │                     #   SignInResponse, AuthTokens, LogoutRequest, AuthSessionInfo
│   ├── entitlement.ts    # Entitlement, EntitlementOverrides, EffectiveEntitlements
│   ├── trip.ts           # Trip, TripCreate/Update
│   ├── member.ts         # TripMember, Invite, InviteCreate/Accept
│   ├── place.ts          # Place, SavedPlace
│   ├── booking.ts        # Booking + BookingDetails discriminated union (8 shapes)
│   ├── itinerary.ts      # ItineraryItem, TravelLeg
│   ├── money.ts          # Expense, ExpenseShare, Settlement, Budget, Balance (computed)
│   ├── capture.ts        # CaptureItem, ProposedBooking
│   ├── photo.ts          # Photo, PhotoVisibility rules helpers
│   ├── packing.ts        # PackingList, PackingItem
│   ├── document.ts       # TravelDocument
│   ├── weather.ts        # WeatherForecast
│   ├── notification.ts   # NotificationPayload union (per NotificationCategory)
│   └── offline.ts        # OfflineMutation (offline queue entry)
└── ai/
    ├── constraints.md    # the §3.7 rules, colocated for implementers
    ├── cache-key.ts      # deriveAiCacheKey(feature, destination, travelStyle, season, schemaVersion)
    ├── refinement.ts     # shared AiRefinementError (added T-3.2 — §3.7 rule 2 support)
    ├── sha256.ts         # pure-TS SHA-256 for cache keys ONLY (exists because R-shared-9 forbids node:crypto; NOT for secrecy; WTF-8 lone-surrogate behavior pinned permanent)
    ├── recommendations.ts    # output schema + SCHEMA_VERSION
    ├── expense-estimate.ts
    ├── tour-guide.ts     # TourGuideBundle (also the jsonb shape)
    ├── packing-list.ts
    ├── recap.ts
    └── capture-extract.ts    # ProposedBooking extraction schema (LLM fallback)
```

Each `domains/*.ts` module mirrors its table(s) in
`.specs/database/schema.spec.md §3.3` — column names in `snake_case` on the
wire exactly as the DB columns (no casing translation layer; one name
everywhere). Entity schemas describe **rows as the API returns them**;
`*Create`/`*Update` input schemas subset them (server-generated fields —
`id`, `created_at`, `updated_at`, `created_by` — omitted).

### 3.2 Enum single-source pattern

One pattern, no exceptions (R-shared-2):

```
// enums.ts (pseudocode — pattern, not code to copy)
export const BOOKING_CATEGORIES = ['lodging','flight','train','car_rental',
  'moped_rental','activity','restaurant','other'] as const
export const BookingCategorySchema = z.enum(BOOKING_CATEGORIES)
export type BookingCategory = z.infer<typeof BookingCategorySchema>

// apps/server drizzle schema
export const bookingCategory = pgEnum('booking_category', BOOKING_CATEGORIES)
```

Canonical value lists live in schema spec §3.2 — its Gate-2 enum questions
are resolved there and flow here automatically: `expense_category` is a
fixed six-value taxonomy, `ai_feature` includes `capture_parse`, and
`request_status` joined with the `settlement_requests` entity. **Wire-only
enums** with no DB column (`NotificationCategory` — notifications spec §3.2;
`TRAVEL_STYLES` — §3.4 below) use the same tuple pattern minus the pgEnum
mirror. Enum tuples are append-only (Postgres constraint; also keeps old
clients parsing).

### 3.3 Scalar conventions (`scalars.ts`)

| Scalar | Definition | Notes |
|---|---|---|
| `Cents` | `z.number().int().nonnegative()` | Law #2. Sign conventions (who owes whom) are modeled structurally (`from`/`to`), never as negative amounts, except computed `Balance.net_cents` which is explicitly signed and documented. |
| `PositiveCents` | `Cents` + `> 0` refinement | Expenses/settlements |
| `CurrencyCode` | `z.string().length(3).regex(/^[A-Z]{3}$/)` | ISO-4217 |
| `ISODate` | `z.string().date()` | `YYYY-MM-DD` (calendar days: `itinerary_items.day`, `expenses.spent_at`) |
| `ISODateTime` | `z.string().datetime({ offset: true })` | Instants; serialized UTC by the server |
| `ISOTime` | `z.string()` + `HH:MM` 24-hour regex | Wall-clock times of day (`itinerary_items.start_time`/`end_time` cross the wire as strings — added per itinerary-bookings spec §3.7). (Added 2026-07-09, Gate 2 sync) |
| `Uuid` | `z.string().uuid()` | All ids |
| `Lat` / `Lng` | number with range refinement (±90 / ±180) | Range refinements are server-side only when the schema is reused for AI output (§3.7) |

### 3.4 Domain schema inventory (contract highlights)

Field-exact shapes follow the DB spec tables one-to-one; only
contract-specific notes listed here:

- **`user.ts`** — `User` (own profile: everything), `UserProfile` (what other
  trip members see: `id`, `display_name`, `avatar_key`, payment handles —
  handles are deliberately member-visible: settle-up renders the payee's
  buttons from them). `PaymentHandles` groups `venmo_username?`, `cashtag?`,
  `paypalme_username?`, `zelle_handle?`, `zelle_display_name?` with
  normalization refinements (strip `@`/`$`, E.164-or-email for Zelle).
  `UserPrefs`: `{ travel_style?: TravelStyle[], home_currency?: CurrencyCode,
  units?: 'metric' | 'imperial', notifications?:
  Partial<Record<NotificationCategory, boolean>> }` — an absent
  `notifications` key means enabled (notifications spec §3.2; field added
  2026-07-09, Gate 2 sync). Also gains `UserUpdate`,
  `PaymentHandlesUpdate`, `AvatarUploadRequest`/`AvatarUploadTicket`,
  `PushTokenCreate`/`PushToken` (auth-users spec §3.7).
  `travel_style` is **multi-tag** from the fixed, append-only wire-only tuple
  `TRAVEL_STYLES = ['budget', 'comfort', 'luxury', 'foodie', 'adventure',
  'culture', 'nightlife', 'family', 'relaxation']` (lives in prefs JSONB —
  no pgEnum). As an AI cache-key input it is canonicalized: sorted unique
  tags joined with `+`, empty → `'any'` — so tag order can never fork the
  cache. (Resolved 2026-07-09, Gate 2)
- **`booking.ts`** — `BookingDetailsSchema` =
  `z.discriminatedUnion('category', […8 shapes])` per schema spec §3.4.1;
  `BookingSchema` refines that `details.category` matches the row `category`.
  The same detail shapes are reused by `ai/capture-extract.ts` (§3.7), which
  is WHY they stay flat.
- **`money.ts`** — `ExpenseCreate` carries its shares inline
  (`shares: Array<{ user_id, share_cents }>`) — the atomic-write contract
  (schema spec R-db-2); a shares-sum-equals-amount `superRefine` runs in the
  API schema (allowed: it's not an AI schema). `Balance` (computed, never
  stored): `{ trip_id, user_id, counterparty_id, net_cents }` in trip base
  currency.
- **`capture.ts`** — `ProposedBooking` per schema spec §3.4.2; `parser` +
  `confidence` enums local to this domain.
- **`photo.ts`** — `PhotoVisibilitySchema` + a pure helper
  `canViewPhoto(viewer: {isOwner, isTripMember}, visibility): boolean` — the
  single shared implementation of Law #3's check, so server authz and mobile
  UI can't drift.
- **`weather.ts` / `packing.ts` / `document.ts`** — direct mirrors of schema
  spec §3.4.4/§3.4.5 and the `documents` table.
- **`auth.ts`** — `AppleSignInRequest`, `GoogleSignInRequest`,
  `RefreshRequest`, `SignInResponse`, `AuthTokens`, `LogoutRequest`,
  `AuthSessionInfo` + this domain's endpoint descriptors (shapes per
  auth-users spec §3.4/§3.7). Server-only material (JWT claims, token
  hashes, ciphertext) never gets a shared schema — it never crosses the
  wire. `entitlement.ts` gains `EffectiveEntitlements` (the
  `resolveEntitlements` return type, R-shared-12).
  (Added 2026-07-09, Gate 2 sync)
- **`notification.ts`** — `NotificationPayload`: discriminated union on
  `NotificationCategory` (wire-only enum tuple in `enums.ts`:
  `itinerary_change`, `daily_digest`, `leave_by`, `document_expiry`,
  `settle_up`, `flight_status` — append-only, no pgEnum). Common fields
  `{ category, title, body, route, trip_id? }` + per-category extras per
  notifications spec §3.3 (canonical for payload semantics).
  (Added 2026-07-09, Gate 2 sync)
- **`offline.ts`** — `OfflineMutation` queue entry: `{ id: Uuid, trip_id:
  Uuid, descriptor_key: string, params: object, payload: object, queued_at:
  ISODateTime, attempts: int, status: 'pending' | 'failed' }` (today spec
  §2.7 owns enqueue/drain/conflict semantics; entries replay through the
  standard descriptor-addressed `ApiClient`, §3.6).
  (Added 2026-07-09, Gate 2 sync)

### 3.5 API envelope conventions (`api/envelope.ts`)

**Success:** 2xx with the endpoint's response schema as the body — no `data`
wrapper (R-shared-5). Lists: `Paginated<T> = { items: T[], nextCursor:
string | null }` — opaque cursor, server-defined page size cap. Cursor
round-trip: list endpoints take the previous page's `nextCursor` as the
`?cursor` query param (`CursorQuerySchema` in `api/envelope.ts`; absent =
first page). *(Synced 2026-07-22, post-T-5.1 — request-param convention
pinned; already the shape used by the trips/photos route tables.)*

**Error (every non-2xx):**

```
ApiError = {
  error: {
    code: ErrorCode,        // machine-readable, stable
    message: string,        // human-readable, safe to display, English v1
    details?: unknown,      // e.g. zod flatten() for VALIDATION_FAILED
    requestId?: string      // correlation id for logs
  }
}
```

**`ErrorCode` enum (initial set — append-only):** `UNAUTHENTICATED` (401),
`FORBIDDEN` (403 — includes privacy-boundary denials; message never reveals
whether the resource exists), `NOT_FOUND` (404 — also returned for
resources hidden by visibility, indistinguishable from absent, Law #3),
`VALIDATION_FAILED` (400), `CONFLICT` (409 — e.g. duplicate saved place),
`RATE_LIMITED` (429), `AI_CAP_EXCEEDED` (429 — user daily cap, ADR-005 seam),
`AI_DISABLED` (503 — global kill-switch tripped), `PAYLOAD_TOO_LARGE` (413),
`INTERNAL` (500), `AI_UPSTREAM` (503 — Anthropic upstream failure / invalid
structured output after retry; transient and retryable, distinct from the
policy-stop `AI_DISABLED` — appended per ai spec §3.4, honoring the
append-only rule. Added 2026-07-09, Gate 2 sync).

Status↔code mapping is fixed by this table; handlers pick codes, the shared
Hono error middleware (server-side, typed against `ApiError`) owns
serialization. `@hono/zod-validator` failures are mapped to
`VALIDATION_FAILED` with `details = zodError.flatten()`.

### 3.6 Endpoint descriptors + DI conventions (platform-agnostic hooks)

The seam that keeps hooks platform-agnostic (R-shared-9):

- **`EndpointDescriptor`** (in shared): `{ method, path, // e.g. '/trips/:tripId/bookings'
  params?: ZodSchema, query?: ZodSchema, body?: ZodSchema,
  response: ZodSchema }`. Each domain module exports its endpoints'
  descriptors alongside its schemas (the API specs in `.specs/api/` define
  the routes; descriptors are their machine-readable mirror). *(Synced
  2026-07-22, post-T-5.2: descriptor `path`s are base-relative — e.g.
  `/auth/apple`. `apps/server` mounts the routers under an `/api` base
  (alongside `/api/health`), so the concrete URL is `/api/auth/apple`; the
  `apps/mobile` `ApiClient` base URL is therefore `origin + '/api'` and
  prepends it to every descriptor `path`.)*
- **`ApiClient` interface** (in shared, types only):
  `request<D extends EndpointDescriptor>(d: D, input: InferInput<D>) =>
  Promise<InferResponse<D>>` — implementations parse the response with
  `d.response` before returning (runtime-validated wire, both directions).
- **`apps/mobile`** implements `ApiClient` over `fetch` with an injected
  `TokenProvider` (`getAccessToken(): Promise<string | null>` — auth spec
  owns refresh rotation) and builds TanStack Query hooks generically from
  descriptors (`queryKey` derived from `path` + params). Zustand/TQ stay in
  the app; shared exports zero hooks — it exports the descriptors hooks are
  generated from.
- **`apps/server`** uses the same descriptors to type `@hono/zod-validator`
  middleware and response payloads — one descriptor, both ends typed.
- Other injected interfaces as needs arise (`Clock`, `IdGenerator` for
  client-generated `PackingItem.id`s) — defined in shared, implemented per
  platform. Rule of thumb: shared defines the port, apps provide the adapter.

### 3.7 AI structured-output schemas (`ai/`) — Claude compatibility

Constraints (research: structured-output limits; R-shared-7) — enforced by
convention + a unit test that walks each AI schema's definition:

1. **No recursion** (no `z.lazy`). Nesting ≤ 3 levels; prefer arrays of flat
   objects.
2. **No numeric range constraints** (`.min`/`.max`/`.gt`/`.lt` on numbers) —
   the SDK strips them; instead each AI module exports a paired
   `refine<X>(parsed)` server-side step that enforces ranges/cross-field
   rules after `client.messages.parse()` (with `zodOutputFormat`) returns.
3. **Every AI module exports `SCHEMA_VERSION: number`** — bumped on any shape
   change; feeds `deriveAiCacheKey()` (R-shared-8; schema spec R-db-10).
4. **Grounding contract in the schema shape:** generative schemas that
   mention venues reference **provided place ids from our spine**
   (`place_id: Uuid` referencing the prompt's candidate list) — the schema
   itself makes inventing venues unrepresentable (recommendations return
   ranked references + commentary, never free-text venue names without an id).
5. Output schemas allow `"unknown"`/omission wherever facts may be missing
   (anti-hallucination: permission to not know).

Per-feature output schemas (shapes finalized in the AI feature spec; this
spec fixes their contracts):

| Module | Output (summary) | Cached |
|---|---|---|
| `recommendations.ts` | ranked `Array<{ place_id, category, pitch, fit_reasons[] }>` | ai_cache, destination-keyed |
| `expense-estimate.ts` | per-`expense_category` `Array<{ category, low_cents, high_cents, basis }>` (ints; ranges validated server-side) | ai_cache |
| `tour-guide.ts` | `TourGuideBundle` (schema spec §3.4.3) — cite-or-retract source refs | tour_guide_bundles |
| `packing-list.ts` | `Array<PackingItem>` minus `checked` | live / uncached (Gate 2, H2) |
| `recap.ts` | `Recap` (schema spec §3.4.8: narrative sections + server-computed stats/trace/highlights) | `recaps` table (schema spec §3.3.26) |
| `capture-extract.ts` | `ProposedBooking` (reuses `BookingDetails` shapes — flat by design) | never cached (per-email) |

`config/ai-pricing.ts`: feature→model mapping + per-model token prices —
the kill-switch job's cost math (`ai_usage` stores tokens, not dollars;
schema spec §3.3.18) and the 30/day default cap constant (ADR-005 →
`config/entitlements.ts`).

### 3.8 Out of scope (explicit)

- Route inventory + authz rules per endpoint — `.specs/api/` specs (they
  import these envelope/descriptor conventions).
- Offline mutation-queue drain/conflict semantics — today/offline spec; its
  queue-entry schema landed here as `domains/offline.ts` (§3.4).
- Push notification triggers, audiences, and templates — notifications spec;
  its payload shapes landed here as `domains/notification.ts` (§3.4).
- "Send the bill" universal-link payload — expenses/settle-up API spec.
- Design tokens/theming — `packages/tokens`.
- Exact package versions — pinned at P-3 scaffold (R-shared-13).

---

## 4. Tasks

Sized for one build task (one agent session); queue as a `T-N.M` row at
build time. **Blocks:** DB task DB-1 (pgEnums import the tuples) — land this
first or in the same PR.

### SH-1 — Scaffold `@gogo/shared` with enums, scalars, domain schemas, envelope

**Covers:** R-shared-1 … R-shared-14.

Checklist:

- [ ] Workspace package scaffold (`packages/shared`), TS strict, subpath
      exports per §3.1, `"sideEffects": false`; deps pinned via
      `npm view` + `zodOutputFormat`/Zod-major compat verified via Context7
      (R-shared-13)
- [ ] `enums.ts` — every tuple from schema spec §3.2 in the §3.2 pattern
- [ ] `scalars.ts` per §3.3
- [ ] `api/envelope.ts` — `ApiError`, `ErrorCode`, `Paginated`, status map
- [ ] `api/descriptor.ts` — `EndpointDescriptor`, `ApiClient` interface,
      infer helpers
- [ ] `config/entitlements.ts` (PLAN_DEFAULTS + resolver) and
      `config/ai-pricing.ts`
- [ ] `domains/*` — all 16 modules mirroring schema spec §3.3/§3.4
      (incl. `auth`, `notification`, `offline` — Gate-2 sync additions),
      incl. `BookingDetails` discriminated union and `canViewPhoto`
- [ ] `ai/*` — output schemas + `SCHEMA_VERSION`s + paired server-side
      refiners + `deriveAiCacheKey`

**Tests required:**

- [ ] Enum tuples ↔ schema spec §3.2 parity (snapshot the value lists)
- [ ] `Cents` rejects floats/negatives; `PositiveCents` rejects 0;
      `CurrencyCode` rejects lowercase (R-shared-6)
- [ ] `BookingDetails` union: valid payload per category parses; mismatched
      `category`/details rejected; unknown keys stripped (R-shared-10)
- [ ] `ExpenseCreate` superRefine: shares summing ≠ amount rejected;
      exact-sum accepted (mirror of R-db-2)
- [ ] `canViewPhoto` truth table: owner/member/stranger × private/trip/public
      (Law #3)
- [ ] AI-schema constraint walker: every `ai/*` schema — no recursion, no
      numeric range constraints, depth ≤ 3 (R-shared-7)
- [ ] `deriveAiCacheKey` stable + changes when any input (incl.
      SCHEMA_VERSION) changes (R-shared-8)
- [ ] `resolveEntitlements`: override precedence over plan default
      (R-shared-12)
- [ ] Package imports nothing platform-bound (lint rule or dependency-cruiser
      check) (R-shared-9)

---

*Trace: R-shared-N ↔ §3 sections inline. Zero open markers — the
`travel_style` taxonomy resolved 2026-07-09 (Gate 2); enum-content values
remain canonical in the DB spec and flow here via §3.2.*
