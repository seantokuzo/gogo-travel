# Database Schema Spec — `.specs/database/schema.spec.md`

> **Task:** T-2.1 · **Status:** DRAFT — pending Sean approval (P-2 gate 2:
> architecture/data model). Not approvable until zero `[NEEDS CLARIFICATION]`
> markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (entity-level data model,
> provider table), `CLAUDE.md` Laws #2/#3/#6, ADR-004 (stack), ADR-005
> (entitlement seams), `.specs/research/payments-settle-up.md`,
> `.specs/research/maps-places.md`, `.specs/research/ai-architecture.md`,
> `.specs/research/booking-integrations.md`.
>
> **Companion spec:** `.specs/shared/contracts.spec.md` — every enum and JSONB
> shape named here is defined once in `@gogo/shared` and imported by the
> Drizzle schema. This file is the Postgres-side contract; that file is the
> TypeScript-side contract. They must never drift.

---

## 1. Scope & global conventions

Column-exact Postgres (Neon) schema for every entity in PLANNING's data model,
implemented with Drizzle ORM in `apps/server/src/db/schema/` and managed by
drizzle-kit migrations (Law #6: a migration for every schema change).

### Global conventions (apply to every table unless noted)

| Convention | Rule |
|---|---|
| Primary keys | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` (built-in, no extension). Exceptions: natural-key tables (`trip_members`, `expense_shares`, `ai_usage`, `entitlements`, `weather_cache`, `ai_cache`) use composite/natural PKs as specced. |
| Timestamps | `timestamptz`, always UTC. `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also get `updated_at timestamptz NOT NULL DEFAULT now()` (maintained via Drizzle `$onUpdate`, no triggers). |
| Money | **`bigint` integer cents, columns suffixed `_cents`** (Law #2). No `real`/`double precision`/`float` monetary columns anywhere, ever. Fractional-cent internals (AI cost) are stored as integer token counts and priced at read time — never as float money. |
| Currency | `char(3)` ISO-4217 uppercase, `CHECK (col = upper(col))`. |
| Coordinates | `numeric(9,6)` for both lat and lng (±0.11 m precision; covers ±180). No PostGIS in v1 — btree composite indexes suffice at our scale; PostGIS is a later, additive migration if proximity search outgrows bbox queries. |
| Enums | Postgres `pgEnum`s whose value tuples are **imported from `@gogo/shared`** (single source of truth — see contracts spec §3.2). Enum values are append-only (PG can't drop enum values without a rewrite). |
| JSONB | Every `jsonb` column has a documented shape (§3.4) and is **Zod-validated by `@gogo/shared` before every write**. The DB never trusts JSONB content. |
| FK indexes | Every FK column gets a btree index unless it is the leading column of a listed composite/unique index. (Prevents seq-scans on cascade/SET NULL and on the common join direction.) Only *additional* or *composite* indexes are called out per table, with justification. |
| Delete behavior | `trips` cascade to all trip-scoped children. Required references to shared/spine rows (`places`) RESTRICT; optional pins SET NULL. User FKs RESTRICT pending the account-deletion decision (R-db-16 marker). Full matrix in §3.6. |
| Soft deletes | None by default; exceptions are explicit per table. |

---

## 2. Requirements (EARS)

Structural invariants. Each is testable against a migrated database (see
Tasks §4 for the test plan).

- **R-db-1 (money law):** WHEN any monetary value is persisted THE SYSTEM
  SHALL store it as `bigint` integer cents in a column suffixed `_cents`;
  the schema SHALL contain zero floating-point monetary columns
  (CI test: `information_schema.columns` scan — no `real`/`double precision`
  columns at all, and every `*_cents` column is `bigint`).
- **R-db-2 (expense atomicity):** WHEN an expense is created, or its amount /
  split is modified, THE SYSTEM SHALL write the `expenses` row and all its
  `expense_shares` rows in a single database transaction, and SHALL reject
  the write unless `SUM(expense_shares.share_cents) = expenses.amount_cents`
  exactly (validated server-side pre-commit; no rounding remainder may be
  dropped — remainder cents are assigned deterministically to shares).
- **R-db-3 (photo privacy default):** WHEN a `photos` row is inserted without
  an explicit visibility THE SYSTEM SHALL persist `visibility = 'private'`
  (enforced by a `NOT NULL DEFAULT 'private'` column, not application code
  alone). (Law #3.)
- **R-db-4 (visibility is a DB-level boundary):** WHEN any query reads photos
  on behalf of a user who is not the photo's owner THE SYSTEM SHALL filter by
  visibility (`'trip'` requires trip membership; `'public'` is the only level
  readable by non-members). The schema SHALL provide the indexes that make the
  filtered queries the natural, cheap path (§ photos).
- **R-db-5 (entitlement seam):** WHEN a `users` row is created THE SYSTEM
  SHALL create its `entitlements` row (plan `'free'`) in the same transaction;
  WHEN any AI endpoint executes THE SYSTEM SHALL read `entitlements` +
  `ai_usage` for the caller within the request before calling the model
  (ADR-005; structural support: `ai_usage` PK `(user_id, feature, day)`
  enables a single upsert-increment).
- **R-db-6 (places spine identity):** WHEN open-data places are imported THE
  SYSTEM SHALL upsert on `(source, source_id)`; the schema SHALL enforce
  uniqueness of `(source, source_id)` where `source_id IS NOT NULL`, and
  SHALL require `source_id IS NULL` exactly when `source = 'custom'`.
- **R-db-7 (capture is never silent):** WHEN capture parsing fails or is
  low-confidence THE SYSTEM SHALL persist the `capture_inbox` row with
  `parse_status` `'failed'` or `'needs_review'` and an `error`/`parsed`
  payload — capture rows are never deleted as a failure-handling path.
- **R-db-8 (one owner):** THE SYSTEM SHALL allow at most one
  `trip_members` row with `role = 'owner'` per trip (partial unique index)
  and SHALL enforce at-least-one-owner server-side on every membership write.
- **R-db-9 (invite tokens):** WHEN an invite is created THE SYSTEM SHALL
  generate a token with ≥ 128 bits of entropy, stored unique; expired or
  revoked invites SHALL be rejected at acceptance time (schema: `expires_at`,
  `revoked_at`).
- **R-db-10 (AI cache is user-anonymous):** WHEN an AI response is cached THE
  SYSTEM SHALL key it as
  `hash(feature, destination, travel_style, season, schema_version)` and the
  `ai_cache` row SHALL contain no user identifier (shareable across users).
- **R-db-11 (booking details are typed):** WHEN a booking is persisted THE
  SYSTEM SHALL validate `details` against the `@gogo/shared` schema for its
  `category` (discriminated union, §3.4.1) before write; unknown keys are
  stripped.
- **R-db-12 (migration law):** WHEN the schema changes THE SYSTEM SHALL ship
  a drizzle-kit migration in the same PR; no ad-hoc drift (Law #6). The
  initial migration created by this spec's task is the baseline.
- **R-db-13 (currency integrity):** WHEN a monetary column is non-null THE
  SYSTEM SHALL have a non-null ISO-4217 uppercase currency alongside it
  (checks per table), and `expense_shares` SHALL inherit their currency from
  the parent expense (no per-share currency column — shares are always in the
  expense's currency).
- **R-db-14 (settlements are record-only):** THE SYSTEM SHALL store
  settlements as ledger entries only — no external transaction IDs, no
  payment-state machine, no money movement (research: record-only +
  deeplink handoff; "Mark as settled" always works standalone).
- **R-db-15 (leg identity):** THE SYSTEM SHALL store at most one travel leg
  per `(from_item_id, to_item_id, mode)`; legs are derived data, recomputed
  at sync, and safe to delete/rebuild.
- **R-db-16 (user rows are load-bearing):** WHILE the account-deletion
  strategy is undecided THE SYSTEM SHALL use `ON DELETE RESTRICT` for all
  FKs to `users` that carry shared financial or collaborative history
  (`expenses.paid_by`, `expense_shares.user_id`, `settlements.from/to`,
  `trips.created_by`), so no migration path is foreclosed.
  [NEEDS CLARIFICATION: account deletion strategy — hard delete with cascade,
  or soft-delete + PII scrub (keeping expense/settlement ledger integrity for
  other trip members)? App Store requires account deletion to exist; the
  ledger-integrity question is user-visible for the surviving group.]
- **R-db-17 (jsonb validation):** WHEN any JSONB column is written THE SYSTEM
  SHALL have validated the payload against its `@gogo/shared` schema in the
  same request (R-shared-10 is the mirror requirement).
- **R-db-18 (documents are private):** THE SYSTEM SHALL scope every
  `documents` read to `user_id = caller` — documents never gain trip-level or
  public visibility regardless of `trip_id` association (Law #3; the vault is
  personal).

---

## 3. Design

### 3.1 ERD

```mermaid
erDiagram
    users ||--|| entitlements : has
    users ||--o{ push_tokens : registers
    users ||--o{ documents : owns
    users ||--o{ capture_inbox : forwards
    users ||--o{ trip_members : joins

    trips ||--o{ trip_members : has
    trips ||--o{ invites : issues
    trips ||--o{ saved_places : pins
    trips ||--o{ bookings : contains
    trips ||--o{ itinerary_items : schedules
    trips ||--o{ travel_legs : precomputes
    trips ||--o{ expenses : logs
    trips ||--o{ settlements : records
    trips ||--o{ budgets : caps
    trips ||--o{ photos : collects
    trips ||--o{ tour_guide_bundles : pregens
    trips ||--o{ packing_lists : has

    places ||--o{ saved_places : referenced
    places ||--o{ bookings : located_at
    places ||--o{ itinerary_items : visited
    places ||--o{ photos : pinned
    places ||--o{ tour_guide_bundles : narrates

    bookings ||--o{ itinerary_items : scheduled_as
    bookings ||--o{ expenses : spawned
    capture_inbox ||--o| bookings : lands_as

    itinerary_items ||--o{ travel_legs : from_or_to
    itinerary_items ||--o{ photos : pinned

    expenses ||--|{ expense_shares : split_into
    users ||--o{ expenses : paid
    users ||--o{ expense_shares : owes
    users ||--o{ settlements : settles

    users ||--o{ ai_usage : consumes
```

Standalone (no FK relationships): `ai_cache`, `weather_cache` — pure
destination-keyed caches, deliberately user- and trip-anonymous.

### 3.2 Enums (canonical values — defined in `@gogo/shared`, mirrored as pgEnums)

| pgEnum | Values | Notes |
|---|---|---|
| `place_source` | `overture`, `fsq_os`, `custom` | Open-data spine provenance |
| `trip_status` | `planning`, `active`, `past` | Per PLANNING exactly |
| `trip_member_role` | `owner`, `editor`, `viewer` | Reused by `invites.role` with `CHECK (role <> 'owner')` |
| `booking_category` | `lodging`, `flight`, `train`, `car_rental`, `moped_rental`, `activity`, `restaurant`, `other` | Per PLANNING exactly |
| `booking_status` | `idea`, `planned`, `booked`, `cancelled` | `cancelled` added per T-2.1 scope beyond PLANNING's three — capture emails include cancellations and deletion would destroy expense links. Semantics: `idea` = candidate under consideration; `planned` = committed to the itinerary, not yet purchased; `booked` = confirmed/purchased; `cancelled` = terminal, kept for history. |
| `booking_source` | `manual`, `email`, `share`, `deeplink_return` | `deeplink_return` = user confirmed a booking after returning from a deeplink-out |
| `itinerary_item_kind` | `booking`, `place_visit`, `custom` | Per PLANNING ("booking-ref \| place-visit \| custom") |
| `travel_mode` | `driving`, `walking`, `cycling`, `transit` | Mapbox profiles + Transitous; transit degrades gracefully (rows simply absent) |
| `expense_category` | `lodging`, `transport`, `food`, `activities`, `shopping`, `other` — PROVISIONAL | [NEEDS CLARIFICATION: budget/expense category taxonomy — is this fixed set right, and are categories a fixed enum or user-definable? PLANNING names "food, transport, etc." for AI estimation but never enumerates. User-visible in budget UI and AI estimates.] |
| `settlement_method` | `venmo`, `cashapp`, `paypal`, `zelle`, `cash` | Per PLANNING exactly; record-only |
| `capture_source` | `email`, `share` | |
| `parse_status` | `pending`, `parsed`, `needs_review`, `failed` | Per PLANNING exactly. "Landed" is not a status — a capture has landed iff a `bookings.capture_id` row references it. |
| `photo_visibility` | `private`, `trip`, `public` | Law #3; DB default `private` |
| `ai_feature` | `recommendations`, `expense_estimate`, `tour_guide`, `packing_list`, `recap` (+ `capture_parse`?) | [NEEDS CLARIFICATION: does the capture-pipeline LLM fallback count against the user's 30/day AI cap (i.e., is `capture_parse` an `ai_feature` value tracked in `ai_usage`)? It costs money per the kill-switch policy either way, but charging it to the user cap is user-visible — a heavy email-forwarder could exhaust their recommendations quota.] |
| `document_kind` | `passport`, `visa`, `insurance`, `other` | Append-only extendable; `other` + `title` covers the tail |
| `plan` | `free` | ADR-005: seams now, plans later; append-only |
| `push_platform` | `ios`, `android` | |
| `bundle_status` | `pending`, `ready`, `failed` | Batch pre-gen is async (hours) |

### 3.3 Tables (column-exact)

Conventions from §1 apply; `created_at`/`updated_at` are listed only in the
convention, not repeated per table (every table has `created_at`; mutable
tables have `updated_at` — immutable ledger tables `settlements`,
`expense_shares`, `travel_legs`, `ai_cache`, `weather_cache` omit it).

---

#### 3.3.1 `users`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `email` | `text` | no | — | Unique on `lower(email)`. Apple private-relay addresses are still emails. |
| `display_name` | `text` | no | — | |
| `avatar_key` | `text` | yes | — | Object-storage key (provider-agnostic; storage provider is a P-3 escalation, see §3.7) |
| `apple_sub` | `text` | yes | — | Apple `sub` claim; UNIQUE |
| `google_sub` | `text` | yes | — | Google `sub` claim; UNIQUE |
| `prefs` | `jsonb` | no | `'{}'` | `UserPrefs` shape (§3.4.6; defined in contracts spec — includes `travel_style`, which feeds the AI cache key) |
| `venmo_username` | `text` | yes | — | Stored without `@` (research: `recipients=` takes bare usernames) |
| `cashtag` | `text` | yes | — | Stored without `$`; HEAD-validated against `cash.app` at save time (research: 404 = invalid) |
| `paypalme_username` | `text` | yes | — | |
| `zelle_handle` | `text` | yes | — | Email or US phone (E.164); no deeplink exists — rendered as copyable handle |
| `zelle_display_name` | `text` | yes | — | Shown next to the handle so the payer can verify the recipient (Zelle QR payload precedent: `{token, name}`) |
| `forward_email_slug` | `text` | yes | — | UNIQUE. Local part of the user's permanent capture address (`<slug>@in.<domain>` → CloudMailin webhook attributes inbound mail to the user). Generated at first capture-feature use. |

- **PK:** `id` · **Unique:** `lower(email)`, `apple_sub`, `google_sub`, `forward_email_slug`
- **Checks:** `apple_sub IS NOT NULL OR google_sub IS NOT NULL` (every account has ≥ 1 identity; zero passwords stored — Gate-1 auth lock)
- **Indexes:** unique indexes above cover all lookup paths (login by provider sub, capture by slug).
- [NEEDS CLARIFICATION: identity linking — if a user signs in with Google using the same email as an existing Apple-created account, do we auto-link to one account, prompt to link, or create a separate account? User-visible; affects whether `email` uniqueness can be relied on for merging.]
- Account deletion strategy: see R-db-16 marker.
- Out of scope here: refresh-token/session storage — owned by the auth spec
  (`.specs/api/` area); it will add its own table + migration and must follow
  this spec's conventions.

#### 3.3.2 `entitlements` (ADR-005)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `uuid` | no | — | PK; FK → `users.id` ON DELETE CASCADE |
| `plan` | `plan` | no | `'free'` | |
| `overrides` | `jsonb` | no | `'{}'` | `EntitlementOverrides` shape (§3.4.7). Per-user exceptions to the plan's defaults. Plan **defaults** (e.g. `ai_calls_per_day: 30`) live in `@gogo/shared` config keyed by plan — gating later is config, not migration (ADR-005). |

- **PK:** `user_id` · Created in the same transaction as the user (R-db-5).
- Seam semantics: effective cap = `overrides.ai_calls_per_day ?? PLAN_DEFAULTS[plan].ai_calls_per_day`. Free-forever list (offline, collab, splitting) has **no seam columns by design** — ADR-005 forbids ever gating them.

#### 3.3.3 `push_tokens`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE |
| `token` | `text` | no | — | Expo push token; UNIQUE (a token re-registered by another account moves, not duplicates) |
| `platform` | `push_platform` | no | — | |
| `last_seen_at` | `timestamptz` | no | `now()` | Bumped on app foreground; prune job deletes stale (>90d) and `DeviceNotRegistered` tokens |

- **Unique:** `token` · **Indexes:** `(user_id)` — fan-out "notify trip members" resolves members → tokens.

#### 3.3.4 `trips`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `name` | `text` | no | — | |
| `destination_name` | `text` | no | — | Display string ("Tokyo, Japan") |
| `destination_lat` | `numeric(9,6)` | yes | — | Map centering, weather, AI grounding |
| `destination_lng` | `numeric(9,6)` | yes | — | |
| `start_date` | `date` | yes | — | |
| `end_date` | `date` | yes | — | |
| `status` | `trip_status` | no | `'planning'` | |
| `base_currency` | `char(3)` | no | `'USD'` | Budget/balance reporting currency for the trip; expenses in other currencies convert into it (see `expenses` FX marker) |
| `theme` | `text` | yes | — | Theme key into `packages/tokens` (re-skinnable, bartling ThemeProvider pattern); null = app default |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT. Immutable creator; *ownership* lives in `trip_members.role` |

- **Checks:** `(start_date IS NULL OR end_date IS NULL OR start_date <= end_date)`; `base_currency = upper(base_currency)`
- **Indexes:** FK index on `created_by`. Trip lists are queried through `trip_members(user_id)` — no extra index here.
- [NEEDS CLARIFICATION: are trip dates required at creation, or are date-less trips allowed (dates added later)? Columns are nullable to keep both options open; the create-trip UX decides.]
- [NEEDS CLARIFICATION: destination input — picked from place/geocoder search (structured; lat/lng always present) or free text (lat/lng optional)? Affects nullability of `destination_lat/lng` and whether weather/AI grounding can be guaranteed for every trip.]
- [NEEDS CLARIFICATION: `status` transitions — PLANNING implies automatic (`today` view "auto-default while trip active"). Is status purely derived from dates by a daily job/on-read (planning→active on start_date, active→past after end_date), or can users manually override (e.g. mark a trip past early)? Manual override is user-visible.]

#### 3.3.5 `trip_members`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE |
| `role` | `trip_member_role` | no | — | |
| `joined_at` | `timestamptz` | no | `now()` | |

- **PK:** `(trip_id, user_id)`
- **Unique (partial):** `uq_trip_single_owner` on `(trip_id) WHERE role = 'owner'` — at most one owner (R-db-8); at-least-one enforced server-side.
- **Indexes:** `(user_id)` — "my trips" is the app's root query.
- [NEEDS CLARIFICATION: ownership transfer — can an owner hand off ownership (owner demotes self + promotes another in one transaction), and can an owner leave a trip that still has members? Schema supports transfer as-is; the allowed flows are user-visible.]

#### 3.3.6 `invites`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `token` | `text` | no | — | UNIQUE; ≥128-bit entropy, URL-safe (R-db-9) |
| `role` | `trip_member_role` | no | — | `CHECK (role <> 'owner')` — invites grant editor/viewer only |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT |
| `expires_at` | `timestamptz` | no | — | |
| `revoked_at` | `timestamptz` | yes | — | |
| `max_uses` | `integer` | yes | — | `CHECK (max_uses > 0)`; NULL = unlimited until expiry — PROVISIONAL pending marker |
| `use_count` | `integer` | no | `0` | Incremented on acceptance |

- **Unique:** `token` · **Indexes:** FK indexes (`trip_id`, `created_by`).
- Acceptance (server-side, one transaction): validate token not expired/revoked, `use_count < max_uses` (when set), upsert `trip_members`, increment `use_count`.
- [NEEDS CLARIFICATION: invite links — single-use per invitee or shareable multi-use group links (Splitwise-style "anyone with the link joins")? Both are supported by `max_uses`; which is the product default, and is there a default expiry (e.g. 7 days)?]

#### 3.3.7 `places` — the open-data spine

Legally storable forever, LLM-safe (Overture CDLA-P-2.0/Apache-2.0/CC0; FSQ OS
Apache-2.0). Deliberately minimal: rich/volatile details (hours, ratings,
photos) are **fetch-fresh from the Foursquare hosted API and never cached**
(licensing) — do not add such columns.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK — our stable id; everything references this, never `source_id` |
| `source` | `place_source` | no | — | `overture` / `fsq_os` / `custom` |
| `source_id` | `text` | yes | — | Upstream id (Overture GERS id / FSQ id); NULL iff `source = 'custom'` |
| `name` | `text` | no | — | |
| `lat` | `numeric(9,6)` | no | — | |
| `lng` | `numeric(9,6)` | no | — | |
| `category` | `text` | yes | — | Source taxonomy string, normalized where cheap (Overture and FSQ taxonomies differ; normalization mapping is a places-domain concern, not schema) |
| `wiki_ref` | `text` | yes | — | Wikidata QID preferred (`Q…`); Wikipedia title accepted. Grounds the tour guide (Wikipedia/Wikivoyage enrichment) |
| `created_by` | `uuid` | yes | — | FK → `users.id` ON DELETE RESTRICT; set iff `source = 'custom'` (authz for edits to user-created places) |

- **Unique (partial):** `(source, source_id) WHERE source_id IS NOT NULL` — import upsert key (R-db-6)
- **Checks:** `(source = 'custom') = (source_id IS NULL)`; `source <> 'custom' OR created_by IS NOT NULL`
- **Indexes:** `(lat, lng)` composite — bbox queries for map viewport; GIN `gin_trgm_ops` on `name` (extension `pg_trgm`, enabled in the initial migration) — type-ahead place search against our spine before any paid autocomplete.
- Bulk Overture/FSQ import tooling is **out of scope** for this spec (places-domain task); the upsert key above is its contract.

#### 3.3.8 `saved_places`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `place_id` | `uuid` | no | — | FK → `places.id` ON DELETE RESTRICT (a pinned spine row must not vanish) |
| `note` | `text` | yes | — | |
| `created_by` | `uuid` | yes | — | FK → `users.id` ON DELETE SET NULL — attribution in collab trips; nullable so member removal doesn't lose the pin |

- **Unique:** `(trip_id, place_id)` — a place is saved once per trip (also serves the trip's saved-list query)
- **Indexes:** FK index on `place_id`.

#### 3.3.9 `bookings`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `category` | `booking_category` | no | — | |
| `status` | `booking_status` | no | `'idea'` | |
| `title` | `text` | no | — | Display name ("UA 837 SFO→NRT", "Park Hyatt Tokyo") |
| `details` | `jsonb` | no | `'{}'` | Per-category shape (§3.4.1), Zod-validated (R-db-11) |
| `starts_at` | `timestamptz` | yes | — | **Denormalized** from `details` (UTC instant) for sorting/leg computation; source of truth for display times (incl. local-time semantics) is `details` |
| `ends_at` | `timestamptz` | yes | — | Same; `CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at <= ends_at)` |
| `price_cents` | `bigint` | yes | — | `CHECK (price_cents >= 0)`; NULL = unknown (ideas often have no price) |
| `currency` | `char(3)` | yes | — | `CHECK (price_cents IS NULL OR currency IS NOT NULL)` (R-db-13); uppercase check |
| `confirmation_code` | `text` | yes | — | PNR / reservation code |
| `source` | `booking_source` | no | `'manual'` | |
| `capture_id` | `uuid` | yes | — | FK → `capture_inbox.id` ON DELETE SET NULL; **partial unique WHERE NOT NULL** — one booking per capture; "capture landed" = this reverse reference exists |
| `place_id` | `uuid` | yes | — | FK → `places.id` ON DELETE SET NULL — map pin (hotel, venue, restaurant) |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT |

- **Indexes:** `(trip_id, starts_at)` — chronological booking list + leg/today-view queries; `(trip_id, status)` — "ideas" vs "booked" tabs; partial unique on `capture_id`; FK index on `place_id`.
- Scheduling relationship: a booking's calendar presence is its
  `itinerary_items` row(s) (kind `booking`). For those items, `day`/times
  derive from the booking and are updated in the same transaction when the
  booking's times change (single source of truth: the booking).

#### 3.3.10 `itinerary_items`

Everything on the calendar: booking refs, place visits, custom blocks.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `kind` | `itinerary_item_kind` | no | — | |
| `booking_id` | `uuid` | yes | — | FK → `bookings.id` ON DELETE CASCADE (booking removed ⇒ its calendar item goes) |
| `place_id` | `uuid` | yes | — | FK → `places.id` ON DELETE RESTRICT |
| `title` | `text` | yes | — | Required for `custom`; derived from booking/place otherwise |
| `notes` | `text` | yes | — | |
| `day` | `date` | no | — | Trip-local calendar day (wall-date, no tz math — itineraries are planned in destination local time by nature) |
| `end_day` | `date` | yes | — | `CHECK (end_day IS NULL OR end_day >= day)` — PROVISIONAL, pending marker below |
| `start_time` | `time` | yes | — | Local wall-time on `day`; NULL = all-day/unscheduled |
| `end_time` | `time` | yes | — | |
| `sort_order` | `integer` | no | `0` | Order within a day; app assigns gapped values (1024 steps) and re-indexes the day's items when gaps exhaust |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT |

- **Checks (kind shape):** `kind = 'booking'` ⇒ `booking_id IS NOT NULL`; `kind = 'place_visit'` ⇒ `place_id IS NOT NULL`; `kind = 'custom'` ⇒ `title IS NOT NULL`; `booking_id IS NULL OR kind = 'booking'`.
- **Indexes:** `(trip_id, day, sort_order)` — THE itinerary query (day list and calendar grid both read a day/range ordered); FK indexes on `booking_id` (booking→item sync on time change) and `place_id`.
- [NEEDS CLARIFICATION: multi-day bookings (lodging check-in→check-out) on the calendar — one spanning item (`end_day` used, rendered across days) or two point items (check-in item + check-out item)? Affects whether `end_day` stays; user-visible calendar rendering.]

#### 3.3.11 `travel_legs`

Derived data — precomputed at trip sync for offline ETAs (Mapbox
drive/walk/cycle, Transitous transit; directions APIs are online-only).
Rebuildable at any time; no `updated_at` (rows are replaced, not edited).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `from_item_id` | `uuid` | no | — | FK → `itinerary_items.id` ON DELETE CASCADE |
| `to_item_id` | `uuid` | no | — | FK → `itinerary_items.id` ON DELETE CASCADE; `CHECK (from_item_id <> to_item_id)` |
| `mode` | `travel_mode` | no | — | Transit rows simply absent when Transitous degrades (graceful degradation — hide the mode, don't fail) |
| `duration_seconds` | `integer` | no | — | `CHECK (>= 0)` |
| `distance_meters` | `integer` | no | — | `CHECK (>= 0)` |
| `provider` | `text` | no | — | `'mapbox'` / `'transitous'` — text, not enum (providers are a moving target; no migration per provider change) |
| `computed_at` | `timestamptz` | no | — | Staleness input for the leg-ETA refresh job |

- **Unique:** `(from_item_id, to_item_id, mode)` (R-db-15) · **Indexes:** `(trip_id)` — offline bundle downloads all legs for a trip in one query.
- App-layer invariant: both items belong to `trip_id` (not expressible as a simple FK; enforced by the leg-computation job which is the only writer).
- Route geometry (polyline) intentionally excluded in v1 — PLANNING specs duration/distance only; adding geometry later is additive.

#### 3.3.12 `expenses`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `description` | `text` | no | — | |
| `category` | `expense_category` | no | — | Counts against `budgets` caps (enum marker in §3.2) |
| `paid_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT (R-db-16) |
| `amount_cents` | `bigint` | no | — | `CHECK (amount_cents > 0)` |
| `currency` | `char(3)` | no | — | As logged (spend-in-local-currency); uppercase check |
| `fx_rate` | `numeric(18,8)` | yes | — | Rate `currency → trip.base_currency` captured when the expense currency differs — PROVISIONAL pending FX marker |
| `base_amount_cents` | `bigint` | yes | — | `amount_cents` converted to trip base currency; app invariant: equals `amount_cents` (rate 1) when `currency = trip.base_currency`. `CHECK ((fx_rate IS NULL) = (base_amount_cents IS NULL))` |
| `booking_id` | `uuid` | yes | — | FK → `bookings.id` ON DELETE SET NULL — expense spawned from a booking's price |
| `spent_at` | `date` | no | `CURRENT_DATE` | Daily-spend views |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT — logger may differ from payer |

- **Indexes:** `(trip_id, spent_at)` — money screen lists and daily rollups; FK indexes on `paid_by`, `booking_id`.
- **Atomicity:** R-db-2 — expense + shares single transaction, `SUM(share_cents) = amount_cents`, deterministic remainder assignment (largest-remainder by member id order; exact algorithm is the expenses API spec's to pin, the invariant is this spec's).
- Balances are computed, never stored: pairwise balances derive from
  `expenses`/`expense_shares`/`settlements` per trip in base currency.
- [NEEDS CLARIFICATION: multi-currency policy — when an expense's currency ≠ trip base currency, where does `fx_rate` come from (live rate API at entry time? manual entry? both with manual override?) and is it ever re-fetched? Balances shown always in trip base currency? Affects whether an FX-rate provider becomes a new external dependency (Autonomy Contract §3).]
- [NEEDS CLARIFICATION: expense deletion — hard delete, or soft delete with a visible audit trail ("Sean deleted 'Dinner ¥12,000'"), Splitwise-style? Group money + trust says audit; schema would gain `deleted_at`/`deleted_by` and balance queries would filter. User-visible.]

#### 3.3.13 `expense_shares`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `expense_id` | `uuid` | no | — | FK → `expenses.id` ON DELETE CASCADE |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT (R-db-16) |
| `share_cents` | `bigint` | no | — | `CHECK (share_cents >= 0)`; currency inherited from parent expense (R-db-13) |

- **PK:** `(expense_id, user_id)` · **Indexes:** `(user_id)` — cross-trip "what do I owe" summaries.
- The payer normally holds a share too (their own portion); a zero share is legal (payer covered others entirely).

#### 3.3.14 `settlements`

Record-only ledger entries (R-db-14). Immutable once written (no `updated_at`).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `from_user_id` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT; payer |
| `to_user_id` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT; `CHECK (from_user_id <> to_user_id)` |
| `amount_cents` | `bigint` | no | — | `CHECK (amount_cents > 0)` |
| `currency` | `char(3)` | no | — | Trip base currency by convention (balances are computed in base) |
| `method` | `settlement_method` | no | — | `venmo`/`cashapp`/`paypal`/`zelle`/`cash` — how the user says they paid; self-reported everywhere (no rail has webhooks) |
| `note` | `text` | yes | — | |
| `settled_at` | `timestamptz` | no | `now()` | |
| `created_by` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT — who recorded it (either party may) |

- **Indexes:** `(trip_id)` — balance computation scans per trip; FK indexes on user columns.

#### 3.3.15 `budgets`

One row per trip per category (PLANNING: "category caps + AI estimate").

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `category` | `expense_category` | no | — | |
| `cap_cents` | `bigint` | yes | — | User-set cap; `CHECK (cap_cents >= 0)`; NULL = no cap, estimate only |
| `ai_estimate_cents` | `bigint` | yes | — | `CHECK (>= 0)`; from `/ai/expense-estimate` (Haiku, destination-cached) |
| `ai_estimated_at` | `timestamptz` | yes | — | |
| `currency` | `char(3)` | no | — | App invariant: equals `trips.base_currency` (stored explicitly so budget rows are self-describing) |

- **Unique:** `(trip_id, category)` — also the budget-screen query.
- [NEEDS CLARIFICATION: is there an overall trip budget cap in addition to per-category caps? If yes: extra `budgets` row with a `total` pseudo-category vs a `trips.budget_cap_cents` column — pick after the product answer. User-visible.]

#### 3.3.16 `capture_inbox`

The visible review queue (PLANNING: failures visible, never silent — R-db-7).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE — attributed via `forward_email_slug` (email) or session (share) |
| `trip_id` | `uuid` | yes | — | FK → `trips.id` ON DELETE SET NULL — NULL until inferred/assigned at review (an email arrives with no trip context) |
| `source` | `capture_source` | no | — | `email` / `share` |
| `raw_ref` | `text` | no | — | Object-storage key of the raw payload (MIME message / shared PDF/text) |
| `parse_status` | `parse_status` | no | `'pending'` | |
| `parsed` | `jsonb` | yes | — | `ProposedBooking` shape (§3.4.2) — schema.org JSON-LD first, Haiku structured-output fallback |
| `error` | `text` | yes | — | Failure reason, user-visible in the review queue |
| `parsed_at` | `timestamptz` | yes | — | |

- **Indexes:** `(user_id, parse_status)` — the review-queue query ("your captures needing review"); FK index on `trip_id`.
- Landing: user confirms/edits → `bookings` row created with `capture_id = this.id` (transaction). Status stays `parsed` — landed-ness is the reverse FK (§3.2 `parse_status` note).
- [NEEDS CLARIFICATION: raw capture retention — forwarded emails are PII-heavy (names, loyalty numbers, sometimes payment tails). Delete `raw_ref` object after successful landing? After N days? Keep indefinitely for re-parse? Privacy-policy disclosure (already flagged in research) depends on this answer.]

#### 3.3.17 `photos`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE RESTRICT — uploader/owner |
| `storage_key` | `text` | no | — | UNIQUE; object-storage key |
| `taken_at` | `timestamptz` | yes | — | EXIF |
| `lat` | `numeric(9,6)` | yes | — | EXIF GPS — location data, Law #3 applies to every read |
| `lng` | `numeric(9,6)` | yes | — | |
| `place_id` | `uuid` | yes | — | FK → `places.id` ON DELETE SET NULL — "pictures by place" |
| `itinerary_item_id` | `uuid` | yes | — | FK → `itinerary_items.id` ON DELETE SET NULL — pinned to itinerary |
| `visibility` | `photo_visibility` | no | `'private'` | **NOT NULL DEFAULT 'private'** — Law #3, R-db-3 |
| `caption` | `text` | yes | — | PROVISIONAL pending marker below |
| `blurhash` | `text` | yes | — | Placeholder rendering |
| `width` | `integer` | yes | — | Layout without fetching |
| `height` | `integer` | yes | — | |

- **Indexes (each justified):**
  - `(trip_id, place_id)` — "photos by place within a trip" (map pin tap → photos), the headline photos feature;
  - `(trip_id, taken_at)` — trip timeline/album ordering;
  - partial `(place_id) WHERE visibility = 'public'` — the cross-user surface ("others planning the same destination see experiences at this place") touches ONLY public rows; the partial index makes the privacy-correct query also the cheap one (R-db-4);
  - FK index on `itinerary_item_id`; unique on `storage_key`.
- [NEEDS CLARIFICATION: PLANNING says public photos let others "see experiences/reviews" — is a photo + caption the whole v1 review surface, or are ratings/review text a separate concept? Determines whether `caption` suffices or a review entity must be specced (none exists in PLANNING's entity list).]
- [NEEDS CLARIFICATION: where do public photos surface for non-members — browsing a place's detail view, a destination gallery, both? Affects API authz spec and whether the partial index above needs `taken_at` for ordering. Schema keeps the minimal partial index until the surface is defined.]
- Storage-object lifecycle: DB cascade on trip delete does NOT delete storage
  objects — a cleanup job reconciles orphaned `storage_key`s (photos-domain
  spec owns this; noted so the cascade isn't mistaken for full deletion).

#### 3.3.18 `ai_usage`

Per user/feature/day counters — caps + kill-switch (ADR-005 seam, R-db-5).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE |
| `feature` | `ai_feature` | no | — | |
| `day` | `date` | no | — | UTC day |
| `calls` | `integer` | no | `0` | |
| `input_tokens` | `bigint` | no | `0` | |
| `output_tokens` | `bigint` | no | `0` | |

- **PK:** `(user_id, feature, day)` — single upsert-increment per call (`INSERT … ON CONFLICT … DO UPDATE SET calls = calls + 1, …`).
- **Indexes:** `(day)` — global daily/monthly rollup for the $50 alert / $100 kill-switch job.
- Cost is **computed at read time** from token counts × per-model pricing config in `@gogo/shared` (feature→model mapping) — storing tokens, not dollars, keeps Law #2 clean and survives price changes. Approximation across mid-month model swaps is acceptable for a kill-switch.
- `capture_parse` cap question: see `ai_feature` marker in §3.2.

#### 3.3.19 `ai_cache`

Destination-keyed response cache, shareable across users (R-db-10). The cost
lever (response caching, not prompt caching — research). Immutable rows.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `cache_key` | `text` | no | — | PK — `sha256(feature ∥ destination ∥ travel_style ∥ season ∥ schema_version)`; key derivation function lives in `@gogo/shared` (contracts spec §3.7) |
| `feature` | `ai_feature` | no | — | |
| `schema_version` | `integer` | no | — | Bumped when the output schema changes (stale shapes never parse against new schemas) |
| `model` | `text` | no | — | e.g. `claude-haiku-4-5` — observability + cost attribution |
| `payload` | `jsonb` | no | — | The Zod-validated structured output (per-feature shapes in contracts spec) |
| `expires_at` | `timestamptz` | no | — | 14–30d TTL per feature (config) |

- **Indexes:** `(expires_at)` — eviction sweep.
- **No user_id, no trip_id** — by design (R-db-10).
- [NEEDS CLARIFICATION: is AI-generated content (recommendations, tour guide, packing) English-only for v1? If localized, `locale` must join the cache-key inputs and the key derivation — cheap now, a cache-buster later. User-visible.]

#### 3.3.20 `tour_guide_bundles`

Per trip+place, Batch-pre-generated at trip creation, offline-downloadable
into device SQLite (research: SmartGuide pattern).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `place_id` | `uuid` | no | — | FK → `places.id` ON DELETE RESTRICT |
| `status` | `bundle_status` | no | `'pending'` | Batch API is async (hours) |
| `content` | `jsonb` | yes | — | `TourGuideBundle` shape (§3.4.3); `CHECK (status <> 'ready' OR content IS NOT NULL)` |
| `model` | `text` | yes | — | |
| `batch_id` | `text` | yes | — | Anthropic Batch API id — job reconciliation |
| `generated_at` | `timestamptz` | yes | — | |

- **Unique:** `(trip_id, place_id)` — one bundle per place per trip; also the download-manifest query (index on `trip_id` implied as its leading column... it is not the leading unique column order `(trip_id, place_id)` — it is; covered).
- **Indexes:** FK index on `place_id`; partial `(batch_id) WHERE status = 'pending'` — batch-result reconciliation job lookup.

#### 3.3.21 `packing_lists`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `trip_id` | `uuid` | no | — | FK → `trips.id` ON DELETE CASCADE |
| `user_id` | `uuid` | yes | — | FK → `users.id` ON DELETE CASCADE — PROVISIONAL: NULL = shared trip list, set = personal list; pending marker |
| `title` | `text` | no | `'Packing list'` | |
| `items` | `jsonb` | no | `'[]'` | `PackingItem[]` (§3.4.4) — items live in JSONB, not a child table (entity list has no `packing_list_items`; item edits are whole-list PATCHes, fine at packing-list scale) |
| `ai_generated` | `boolean` | no | `false` | Seeded from `/ai/packing-list` (destination/weather/duration inputs) then user-edited |

- **Indexes:** `(trip_id)`.
- [NEEDS CLARIFICATION: packing lists — one shared list per trip, per-member personal lists, or both? Column shape above supports all three; the product answer sets uniqueness (`unique(trip_id)` vs `unique(trip_id, user_id)`) and the UX.]

#### 3.3.22 `documents`

Travel-document vault. Strictly private to the owning user (R-db-18).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | no | — | FK → `users.id` ON DELETE CASCADE |
| `trip_id` | `uuid` | yes | — | FK → `trips.id` ON DELETE SET NULL — association only ("visa for the Japan trip"); NEVER grants trip members visibility |
| `kind` | `document_kind` | no | — | |
| `title` | `text` | no | — | |
| `storage_key` | `text` | yes | — | Scan/photo object key; NULL = metadata-only reminder entry |
| `expires_at` | `date` | yes | — | |
| `remind_days_before` | `integer` | yes | — | `CHECK (> 0)`; NULL = no reminder |
| `last_reminded_at` | `timestamptz` | yes | — | Reminder-job dedup |

- **Indexes:** `(user_id)` — vault screen; partial `(expires_at) WHERE expires_at IS NOT NULL` — the document-expiry reminder job scans by date.
- Security note: document scans are the most sensitive objects in the system (passports). Storage-side encryption/ACL requirements belong to the storage/infra decision (§3.7) — flagged for the threat model.

#### 3.3.23 `weather_cache`

Provider-agnostic forecast cache (weather provider is not locked by S-2 —
selection is a build-phase escalation per Autonomy Contract §3; this shape
assumes nothing beyond "daily forecast entries for a location").

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `location_key` | `text` | no | — | PK — `"{lat:.2f},{lng:.2f}"` rounded to 2 dp (~1.1 km cell); derivation in `@gogo/shared` |
| `payload` | `jsonb` | no | — | `WeatherForecast` (§3.4.5): array of daily entries covering the provider's horizon |
| `fetched_at` | `timestamptz` | no | — | |
| `expires_at` | `timestamptz` | no | — | Short TTL (hours; config) — volatile data, online-refreshed, degrade-gracefully offline |

- **PK:** `location_key` (one current forecast blob per cell; refresh = upsert). No per-day rows — itinerary weather reads slice the blob.

### 3.4 JSONB shape documentation

All shapes are **defined as Zod schemas in `@gogo/shared`** (contracts spec
§3.4) — this section fixes their semantic content; field-exact definitions
live there to avoid drift. Notation: `?` = optional, all times ISO-8601.

#### 3.4.1 `bookings.details` — discriminated by `bookings.category`

Common conventions: local times stored as ISO-8601 **with UTC offset** plus an
IANA `*_tz` field where a timezone is display-relevant (flights/trains show
airport/station local time — industry standard); free-text `notes?` allowed in
every shape; every shape is flat (no nesting beyond one array of flat objects)
so the same schemas serve Claude structured-output extraction in the capture
pipeline (contracts spec §3.7 constraint).

| Category | Shape (fields) |
|---|---|
| `flight` | `airline?`, `flight_number?`, `origin_iata?`, `destination_iata?`, `departs_at?`, `departs_tz?`, `arrives_at?`, `arrives_tz?`, `cabin_class?`, `seat?`, `passenger_names?: string[]`, `segments?: FlightSegment[]` (same fields minus `segments` — one level, no recursion) |
| `lodging` | `property_name?`, `address?`, `check_in?`, `check_out?`, `guests?: int`, `room_type?`, `provider?` (airbnb/booking/expedia/vrbo/direct/other) |
| `train` | `carrier?`, `train_number?`, `origin_station?`, `destination_station?`, `departs_at?`, `departs_tz?`, `arrives_at?`, `arrives_tz?`, `coach?`, `seat?` |
| `car_rental` | `company?`, `pickup_location?`, `dropoff_location?`, `pickup_at?`, `dropoff_at?`, `vehicle_class?` |
| `moped_rental` | `company?`, `pickup_location?`, `dropoff_location?`, `pickup_at?`, `dropoff_at?`, `vehicle_description?`, `helmet_count?: int` |
| `activity` | `provider?` (viator/ticketmaster/other), `venue_name?`, `address?`, `starts_at?`, `ends_at?`, `ticket_count?: int`, `ticket_type?`, `external_url?` |
| `restaurant` | `address?`, `reserved_at?`, `party_size?: int`, `provider?` |
| `other` | `description?`, `starts_at?`, `ends_at?`, `external_url?` |

All fields optional by design: an `idea` may know nothing; capture fills what
it finds; the UI prompts for gaps. `bookings.starts_at/ends_at` (UTC) are
derived from the shape's primary times at write time.

#### 3.4.2 `capture_inbox.parsed` — `ProposedBooking`

`{ category: booking_category, title?, details: <per-category shape above>,
price_cents?, currency?, confirmation_code?, trip_guess?: uuid,
confidence: 'high' | 'medium' | 'low', parser: 'jsonld' | 'llm' }`

`confidence`+`parser` drive routing: JSON-LD or high-confidence LLM →
`parsed`; low/medium → `needs_review` (threshold pinned in the capture spec).

#### 3.4.3 `tour_guide_bundles.content` — `TourGuideBundle`

`{ place_name, summary, sections: Array<{ title, body }>,
facts: Array<{ text, source_ref }>, sources: Array<{ id, kind: 'wikipedia' |
'wikivoyage' | 'spine', ref }> }`

Every fact carries a `source_ref` into `sources` (cite-or-retract
anti-hallucination pattern; grounded in our spine + Wikipedia — never
invented venues). Evergreen narrative only — volatile facts (hours, prices)
are explicitly forbidden in bundle content (rendered online from fresh data).

#### 3.4.4 `packing_lists.items` — `PackingItem[]`

`Array<{ id: string, label: string, category?: string, qty?: int,
checked: boolean }>` — `id` is a client-generated stable key (check-off
mutations target items without index races).

#### 3.4.5 `weather_cache.payload` — `WeatherForecast`

`{ provider: string, days: Array<{ date, temp_min_c, temp_max_c,
precip_probability?, condition_code, condition_text? }> }` — Celsius
canonical; unit conversion is presentation.

#### 3.4.6 `users.prefs` — `UserPrefs`

Defined in contracts spec §3.4 (`travel_style` taxonomy has its own marker
there — it feeds the AI cache key). Schema-side contract: object, unknown
keys stripped on write, `'{}'` default.

#### 3.4.7 `entitlements.overrides` — `EntitlementOverrides`

`{ ai_calls_per_day?: int, alerts_enabled?: boolean,
premium_place_details?: boolean }` — all optional; absent key = plan default
from `@gogo/shared` config (ADR-005: the gateable candidates — AI above caps,
proactive alerts, premium place details; nothing else grows a seam without an
ADR).

### 3.5 Index catalog (summary)

Blanket rule (§1): every FK column is btree-indexed unless it leads a listed
composite. Beyond that, the deliberate composites and their justification:

| Index | Table | Why |
|---|---|---|
| `(user_id)` | `trip_members` | Root query: "my trips" |
| partial unique `(trip_id) WHERE role='owner'` | `trip_members` | ≤1 owner invariant (R-db-8) |
| `(trip_id, day, sort_order)` | `itinerary_items` | The itinerary read (day + range views, ordered) |
| `(trip_id, starts_at)` | `bookings` | Chronological bookings; today-view "next event" |
| `(trip_id, status)` | `bookings` | Ideas/planned/booked tabs |
| partial unique `(capture_id) WHERE NOT NULL` | `bookings` | 1 booking per capture; "landed" detection |
| unique `(source, source_id) WHERE source_id IS NOT NULL` | `places` | Import upsert key (R-db-6) |
| `(lat, lng)` | `places` | Map viewport bbox |
| GIN trgm `(name)` | `places` | Type-ahead search on our spine (free before paid autocomplete) |
| unique `(trip_id, place_id)` | `saved_places`, `tour_guide_bundles` | Once-per-trip semantics + trip-scoped list/manifest reads |
| unique `(from_item_id, to_item_id, mode)` | `travel_legs` | Leg identity (R-db-15) |
| `(trip_id, spent_at)` | `expenses` | Money screen + daily rollups |
| `(user_id)` | `expense_shares` | Cross-trip "what I owe" |
| unique `(trip_id, category)` | `budgets` | One row per category; budget screen |
| `(user_id, parse_status)` | `capture_inbox` | Review-queue query (R-db-7 visibility) |
| `(trip_id, place_id)` | `photos` | Photos-by-place (map pin tap) |
| `(trip_id, taken_at)` | `photos` | Trip timeline/album |
| partial `(place_id) WHERE visibility='public'` | `photos` | Cross-user public surface; privacy-correct query is the cheap one (R-db-4) |
| PK `(user_id, feature, day)` + `(day)` | `ai_usage` | Cap check upsert; kill-switch rollup |
| `(expires_at)` | `ai_cache` | Eviction sweep |
| partial `(batch_id) WHERE status='pending'` | `tour_guide_bundles` | Batch reconciliation |
| partial `(expires_at) WHERE NOT NULL` | `documents` | Expiry-reminder job |

### 3.6 Referential-integrity matrix (delete behavior)

| Parent | Child.column | Behavior | Rationale |
|---|---|---|---|
| `trips` | all trip-scoped children (`trip_members`, `invites`, `saved_places`, `bookings`, `itinerary_items`, `travel_legs`, `expenses`(+shares via expense cascade), `settlements`, `budgets`, `photos`, `tour_guide_bundles`, `packing_lists`) | CASCADE | Trip deletion removes the trip's world; storage objects reconciled by job |
| `trips` | `capture_inbox.trip_id`, `documents.trip_id` | SET NULL | User-owned rows outlive the trip |
| `users` | `entitlements`, `push_tokens`, `capture_inbox`, `documents`, `ai_usage`, `packing_lists.user_id`, `trip_members.user_id` | CASCADE | Pure per-user rows |
| `users` | `trips.created_by`, `expenses.paid_by/created_by`, `expense_shares.user_id`, `settlements.*_user_id/created_by`, `photos.user_id`, `invites.created_by`, `itinerary_items.created_by`, `bookings.created_by`, `places.created_by` | RESTRICT | Shared/financial history — R-db-16 (pending deletion-strategy answer) |
| `users` | `saved_places.created_by` | SET NULL | Attribution only |
| `places` | `saved_places.place_id`, `itinerary_items.place_id`, `tour_guide_bundles.place_id` | RESTRICT | Required references to the spine |
| `places` | `bookings.place_id`, `photos.place_id` | SET NULL | Optional pins detach |
| `bookings` | `itinerary_items.booking_id` | CASCADE | Booking's calendar presence dies with it |
| `bookings` | `expenses.booking_id` | SET NULL | Expense ledger outlives the booking |
| `capture_inbox` | `bookings.capture_id` | SET NULL | Booking outlives its capture row |
| `itinerary_items` | `travel_legs.from/to_item_id` | CASCADE | Legs are derived |
| `itinerary_items` | `photos.itinerary_item_id` | SET NULL | Photo outlives the plan |
| `expenses` | `expense_shares.expense_id` | CASCADE | Shares are the expense's parts (written/removed atomically anyway, R-db-2) |

### 3.7 Out of scope (explicit)

- **Auth session/refresh-token storage** — auth spec (`.specs/api/`); adds its
  own table honoring these conventions.
- **Object-storage provider choice** (photos/avatars/documents/capture raw) —
  P-3 infra escalation; schema stores provider-agnostic keys.
- **Weather provider selection** — build-phase escalation; `weather_cache` is
  provider-agnostic.
- **Places bulk import tooling** (Overture/FSQ GeoParquet → Postgres) —
  places-domain task; contract is the `(source, source_id)` upsert key.
- **Post-trip recap persistence** — [NEEDS CLARIFICATION: PLANNING says
  "recaps generated post-trip (Batch)" but lists no `recaps` table in the
  entity model. Where does a generated recap live — a new `recaps` table
  (trip-scoped, jsonb content + status like tour bundles), or reuse
  `ai_cache` (wrong fit: trip-scoped and permanent, not destination-keyed
  TTL)? A new table is the obvious design but it's an entity-list addition —
  needs Sean's nod.]
- **FX-rate provider** — pending the expenses FX marker (§3.3.12).
- **Realtime/event-log tables** — collab v1 is REST + refetch (PLANNING);
  the event-log seam is an additive later migration.
- **Storage-side encryption/ACLs** for documents & photos — threat model
  (P-2) + infra.

---

## 4. Tasks

Sized for **one migration-establishing build task** (one agent session), to be
queued as a `T-N.M` row when the build phase starts. Depends on the
`@gogo/shared` enums task (contracts spec §4) landing first or in the same PR
— pgEnums import shared tuples.

### DB-1 — Establish schema + initial migration

**Covers:** R-db-1 … R-db-18 (structural portions; behavioral halves like
R-db-2's transaction body land with their domain APIs).

Checklist:

- [ ] `apps/server/src/db/schema/` Drizzle files per domain (`identity.ts`,
      `trips.ts`, `places.ts`, `bookings.ts`, `itinerary.ts`, `money.ts`,
      `capture.ts`, `photos.ts`, `ai.ts`, `utilities.ts`), enums imported
      from `@gogo/shared`
- [ ] All columns/PKs/FKs/uniques/checks/partial indexes exactly as §3.3/§3.5
      (incl. `pg_trgm` extension + GIN index)
- [ ] Initial migration generated via drizzle-kit; committed (Law #6;
      R-db-12 baseline)
- [ ] Migration applies cleanly to a blank Postgres (`postgres-js` test
      harness per ADR-004)

**Tests required (constraint/invariant suite, runs against migrated DB):**

- [ ] Money-law scan: no float columns exist; every `*_cents` is `bigint`
      (R-db-1)
- [ ] `photos.visibility` inserts default to `'private'`; NOT NULL enforced
      (R-db-3)
- [ ] Partial uniques reject: second owner per trip (R-db-8), duplicate
      `(source, source_id)` (R-db-6), second booking per capture, duplicate
      `(trip_id, place_id)` saved place/bundle, duplicate leg (R-db-15)
- [ ] Checks reject: negative cents, non-uppercase currency, `price_cents`
      without currency (R-db-13), custom place with `source_id`, itinerary
      kind/column mismatches, `from = to` leg, ready bundle without content,
      self-settlement
- [ ] Cascade matrix spot-checks (§3.6): trip delete cascades children;
      booking delete cascades its itinerary item but SET-NULLs its expense;
      user delete RESTRICTed while financial history exists (R-db-16)
- [ ] Users check: account without any provider sub rejected
- [ ] Entitlements: user-creation helper writes `users` + `entitlements`
      atomically (R-db-5)
- [ ] `ai_usage` upsert-increment round-trip on PK `(user_id, feature, day)`

---

*Requirements → design trace: every R-db-N cites its table/section inline;
every marker is a P-2 interview question for Sean. Zero markers = approvable.*
