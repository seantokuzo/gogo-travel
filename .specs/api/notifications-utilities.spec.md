# API — Notifications & Trip Utilities — `.specs/api/notifications-utilities.spec.md`

> **Task:** T-2.3 · **Status:** DRAFT — pending Sean approval (P-2 gate 3:
> per-feature specs). Not approvable until zero `[NEEDS CLARIFICATION]`
> markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (jobs list, collab-sync
> pattern "push-notification invalidation", `notifications` router) +
> `§ Overview` (extras: flight status/delay notifications, weather, docs
> vault, packing) · `.specs/database/schema.spec.md` — **CANONICAL** for
> `push_tokens` (§3.3.3), `documents` (§3.3.22), `weather_cache` (§3.3.23),
> `packing_lists` (§3.3.21) · `.specs/shared/contracts.spec.md` —
> **CANONICAL** for envelope (§3.5), descriptors (§3.6), `UserPrefs` (§3.4),
> and the §3.8 handoff ("push notification payload schemas — notifications
> spec") · `.specs/client/navigation.spec.md` (deep-link registry §2.3) ·
> `.specs/research/competitors.md` (TripIt Pro flight alerts = what users pay
> for; leave-by prompts) · `.agents/agents/mobile-engineer.md` (EAS
> `projectId` landmine) · ADR-003 / Law #5 (no scheduled LLM jobs) · ADR-005
> (`alerts_enabled` entitlement seam).
>
> **Companion:** `.specs/client/today.spec.md` — the client surface that
> consumes this catalog (notification tap-routing, offline rendering, sync
> orchestration). The two must never drift.

---

## 1. Scope

Server + client contract for five things:

1. **Push infrastructure** — Expo push token lifecycle (per-device), iOS/
   Android permission posture, per-category notification preferences,
   delivery + receipt handling.
2. **Notification catalog** — every notification the system emits: trigger,
   audience, delivery mechanism (server push vs device-local scheduling),
   dedup/coalescing rules, content template, tap route.
3. **Weather** — trip-scoped forecast endpoint over the provider-agnostic
   `weather_cache`.
4. **Documents vault** — CRUD + presigned upload/download + expiry-reminder
   scheduling + encryption-at-rest posture.
5. **Packing lists** — trip-scoped CRUD with whole-list item PATCH semantics.

**Non-goals:** AI generation endpoints (`/ai/packing-list` — the AI spec owns
them; this spec consumes their output), the settle-up request entity and
"send the bill" flow (money spec — this spec only defines its push), the
flight-status data integration (deferred to v2 — R-notif-6), notification
tap-routing UX (today spec §2.8, routed through the navigation deep-link
registry), provider choices for weather and object storage (escalations,
§3.10).

---

## 2. Requirements (EARS)

### 2.1 Push infrastructure

- **R-push-1 (per-device registration):** WHEN the client obtains an Expo
  push token THE SYSTEM SHALL register it via `POST /push-tokens` as an
  upsert keyed on the token value — a token re-registered by another account
  MOVES to that account, never duplicates (schema §3.3.3 `token` UNIQUE).
  One row per device; a user with two devices has two rows.
- **R-push-2 (EAS projectId — landmine):** WHEN the client requests the Expo
  push token THE SYSTEM SHALL pass the EAS `projectId` from app config, and
  WHEN token acquisition returns null or throws THE SYSTEM SHALL surface a
  visible degraded state (e.g. "push unavailable" row in notification
  settings) and log the cause — never silently proceed without a token
  (mobile-engineer landmine: without `projectId`, `getExpoPushToken()`
  silently returns `null`).
- **R-push-3 (permission timing):** WHEN the app first needs notification
  permission THE SYSTEM SHALL request the OS permission at a moment of
  demonstrated value (first trip activation approach, or the user enabling a
  notification toggle), preceded by an in-app priming screen; a cold OS
  permission prompt at first launch SHALL NOT occur. WHEN permission is
  denied THE SYSTEM SHALL degrade silently (no nagging) and expose a
  settings deep link to re-enable. (Onboarding includes the priming step —
  resolved Gate 2, §2.6.)
- **R-push-4 (preferences):** WHEN any server send point executes THE SYSTEM
  SHALL check the recipient's per-category preference before sending, and
  WHEN any device-local scheduling point executes THE SYSTEM SHALL check the
  same preference before scheduling. All categories default to enabled;
  absence of a stored pref means enabled.
- **R-push-5 (sign-out):** WHEN the user signs out THE SYSTEM SHALL delete
  that device's push token (server row via `DELETE /push-tokens/:token` +
  local registration state) and cancel all locally scheduled notifications.
- **R-push-6 (receipts & pruning):** WHEN Expo delivery receipts report
  `DeviceNotRegistered` THE SYSTEM SHALL delete the token row; the client
  SHALL bump `last_seen_at` on app foreground (re-register call is the
  bump); tokens stale > 90 days SHALL be pruned by job (schema §3.3.3).
- **R-push-7 (payload contract):** WHEN any push is sent THE SYSTEM SHALL
  build the payload from the shared `NotificationPayload` schema
  (category-discriminated union, §3.3) — every payload carries `category`
  and a `route`, and the client SHALL resolve `route` exclusively through
  the navigation deep-link registry (never ad-hoc string routing).
- **R-push-8 (entitlement seam):** WHEN a proactive-alert category is sent
  server-side THE SYSTEM SHALL consult
  `resolveEntitlements(...)` → `alerts_enabled` (ADR-005; schema §3.4.7
  `EntitlementOverrides`) for the recipient; the free plan's default is
  enabled — the seam exists, nothing is gated in v1.
- **R-push-9 (no LLM — Law #5):** Notification content SHALL be produced by
  deterministic templates over trip data. No notification path or scheduled
  job SHALL call an LLM (ADR-003: no scheduled LLM jobs; the digest is a
  template, not a generation).
- **R-push-10 (lock-screen PII posture):** Notification title/body SHALL
  contain at most first names, trip names, item titles, and formatted
  amounts — never document contents, confirmation codes, payment handles, or
  location coordinates (lock screens are semi-public surfaces).

### 2.2 Notification catalog

- **R-notif-1 (itinerary changes by collaborators):** WHEN a trip member
  creates, updates, or deletes an itinerary item or booking THE SYSTEM SHALL
  push to all *other* trip members (never the actor) an itinerary-change
  notification whose payload carries cache-invalidation hints (PLANNING
  collab sync v1: "push-notification invalidation"); WHEN multiple mutations
  by the same actor in the same trip occur within the coalescing window
  (default 120 s, shared config) THE SYSTEM SHALL send one coalesced
  notification ("Alex made 3 changes to Tokyo 2027") rather than one per
  mutation.
- **R-notif-2 (day-ahead digest):** WHEN a trip is `active` (or becomes
  active tomorrow) THE SYSTEM SHALL send each member with the pref enabled
  one digest per trip day, at **20:00 the evening before in the trip
  destination's timezone** (derived server-side from destination
  coordinates — tz-lookup table, no external API), falling back to the
  user's most-recent device timezone when coordinates are absent,
  summarizing tomorrow: item count, first event title + start time,
  leave-by for the first event with a leg, and tomorrow's forecast from
  `weather_cache` (template, R-push-9). At most one digest per
  (user, trip, day) — job-side dedup. (Resolved 2026-07-09, Gate 2)
- **R-notif-3 (leave-by alerts):** WHEN the active-trip offline bundle
  contains an itinerary item with a scheduled start and a preceding
  `travel_legs` row THE SYSTEM SHALL schedule a **device-local**
  notification at `leave_by = item start − leg.duration_seconds − buffer`
  (buffer default 10 min, shared config). Local scheduling — not server
  push — because leave-by must fire offline and legs are precomputed
  exactly for offline use (schema §3.3.11). THE SYSTEM SHALL schedule only
  a rolling window ≤ 48 h ahead (iOS caps pending local notifications at
  64) and SHALL reschedule the window on bundle refresh, app foreground,
  and any local itinerary mutation.
- **R-notif-4 (document expiry reminders):** WHEN a document has
  `expires_at` and `remind_days_before` set and
  `today ≥ expires_at − remind_days_before` THE SYSTEM SHALL send the
  owning user one reminder push, deduplicated via `last_reminded_at`
  (schema §3.3.22 — single reminder per document in v1; the daily job scans
  the partial `(expires_at)` index per PLANNING's "document expiry
  reminders" job).
- **R-notif-5 (settle-up requests):** WHEN a settle-up request is created
  for a member (money spec owns the entity and endpoint) THE SYSTEM SHALL
  push to the debtor with a route to the request detail
  (`/t/[tripId]/request/[requestId]` per the navigation deep-link
  registry §2.3). Amount rendered from integer cents (Law #2).
- **R-notif-6 (flight status — DEFERRED to v2):** Flight-status / delay
  notifications are explicitly deferred to v2: no flight-data provider was
  researched (alerts are TripIt's paid moat — do it right later, with a
  proper provider evaluation and Autonomy Contract §3 escalation). v1
  ships the `flight_status` category value + pref toggle as a reserved
  stub; integration is later and additive. Nothing else in this bundle
  depends on it. (Resolved 2026-07-09, Gate 2)
- **R-notif-7 (delivery hygiene):** WHEN a notification is sent THE SYSTEM
  SHALL fan out to all of the recipient's `push_tokens` rows, log failures
  with a request id, and never retry more than the Expo-recommended
  backoff; a send failure SHALL never fail the triggering request
  (notifications are fire-and-forget side effects, dispatched after the
  triggering transaction commits).

### 2.3 Weather

- **R-wx-1 (cache-first):** WHEN `GET /trips/:tripId/weather` executes THE
  SYSTEM SHALL derive `location_key` from the trip's destination
  coordinates (rounding + derivation live in `@gogo/shared`; schema
  §3.3.23) and serve the cached `WeatherForecast` when `expires_at` is in
  the future — no provider call on a fresh hit.
- **R-wx-2 (refresh & degrade):** WHEN the cache row is missing or expired
  THE SYSTEM SHALL fetch via the provider adapter, upsert the cache row,
  and return it; WHEN the provider call fails THE SYSTEM SHALL serve the
  stale row flagged stale if one exists, else return `forecast: null` —
  forecast unavailability SHALL never be a non-2xx error (degrade
  gracefully; PLANNING cross-cutting: volatile data, online-refreshed).
- **R-wx-3 (provider-agnostic):** THE SYSTEM SHALL access weather only
  through a `WeatherProvider` port (server-side interface: daily forecast
  for lat/lng → `WeatherForecast`, schema §3.4.5 shape — Celsius canonical;
  unit conversion is client presentation per `UserPrefs.units`). Provider
  selection is a build-phase escalation (schema §3.7) — nothing in this
  spec names a provider.
- **R-wx-4 (coordless trips):** WHEN the trip has no destination
  coordinates THE SYSTEM SHALL return `forecast: null` with
  `reason: 'no_destination_coords'` — a rare robustness branch, since
  destination input is structured with guaranteed coords (§2.6, resolved
  Gate 2).

### 2.4 Documents vault

- **R-docs-1 (strictly private):** WHEN any documents read or write
  executes THE SYSTEM SHALL scope it to `user_id = caller` (mirror of
  schema R-db-18); `trip_id` association NEVER grants trip members
  visibility; requests for another user's document SHALL return 404
  `NOT_FOUND` (indistinguishable from absent — contracts spec §3.5, Law #3).
- **R-docs-2 (presigned upload):** WHEN a document file is uploaded THE
  SYSTEM SHALL mint a short-TTL presigned PUT (`POST
  /documents/:documentId/upload-url`) and the client SHALL upload directly
  to object storage — document bytes never transit the API server.
- **R-docs-3 (signed download only):** WHEN a document scan is viewed THE
  SYSTEM SHALL mint a short-TTL (≤ 5 min) signed GET URL after the R-docs-1
  ownership check; public or long-lived URLs SHALL NOT exist for document
  objects.
- **R-docs-4 (encryption-at-rest posture):** Document objects SHALL be
  stored with storage-side encryption at rest enabled, private ACLs, and no
  bucket listing; encryption keys SHALL never reach the client. The storage
  provider is a P-3 infra escalation (schema §3.7 — restated, not decided
  here); these are the acceptance conditions any chosen provider must
  satisfy, and passport scans are the most sensitive objects in the system
  (schema §3.3.22 security note → threat model).
- **R-docs-5 (upload validation):** WHEN an upload URL is minted THE SYSTEM
  SHALL constrain it to an allowlisted content type (JPEG / PNG / HEIC /
  WebP / PDF) and a size cap (20 MB; violations → 413
  `PAYLOAD_TOO_LARGE`).
- **R-docs-6 (reminder scheduling):** WHEN a document is created or updated
  with `expires_at` and `remind_days_before` THE SYSTEM SHALL require
  `remind_days_before > 0` (schema check) and the reminder job SHALL pick
  it up per R-notif-4 — no separate scheduling call; the row is the
  schedule.
- **R-docs-7 (metadata-only entries):** WHEN a document is created without
  a file THE SYSTEM SHALL accept it (`storage_key` NULL — schema §3.3.22:
  metadata-only reminder entry, e.g. "passport expires 2028-03" without a
  scan).

### 2.5 Packing lists

- **R-pack-1 (trip-scoped CRUD):** WHEN a trip member reads or writes a
  packing list THE SYSTEM SHALL verify trip membership (roles: any member
  reads; editors+ write); packing lists live under
  `/trips/:tripId/packing-lists`.
- **R-pack-2 (whole-list item semantics):** WHEN items change (add, edit,
  check off) THE SYSTEM SHALL PATCH the full `items` array (schema §3.3.21:
  items live in JSONB, whole-list PATCHes at packing-list scale); each item
  carries a client-generated stable `id` (`PackingItem` §3.4.4) so
  check-offs target items without index races; concurrent writes resolve
  last-write-wins (PLANNING collab sync v1).
- **R-pack-3 (offline-editable):** WHEN the device is offline during an
  active trip THE SYSTEM SHALL queue packing-list PATCHes in the offline
  mutation queue and drain on reconnect (contract: today spec §2.7) —
  packing is a during-trip surface.
- **R-pack-4 (AI seed):** WHEN a list is generated via `/ai/packing-list`
  (AI spec owns the endpoint) THE SYSTEM SHALL persist it with
  `ai_generated = true`; user edits keep the flag (provenance, not state).

### 2.6 Upstream resolutions inherited from canonical specs

All formerly repeated markers are resolved at their homes (Gate 2,
2026-07-09):

- Resolved at `.specs/database/schema.spec.md`:§3.3.21 `packing_lists`
  (Gate 2, 2026-07-09): one **shared list per trip** in v1 (uniqueness
  `unique(trip_id)`); per-member personal lists are a later phase.
- Resolved at `.specs/database/schema.spec.md`:§3.3.4 `trips` (Gate 2,
  2026-07-09): destination input is structured (Overture-backed search;
  lat/lng always present) — R-wx-4's null branch is rare robustness, not a
  common path.
- Resolved at `.specs/database/schema.spec.md`:§3.3.4 `trips.status`
  (Gate 2, 2026-07-09): status is date-derived with manual owner override
  (override wins until cleared) — the digest job honors the stored/derived
  status per that rule.
- Resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09):
  onboarding collects name/avatar → home currency → payment handles
  (skippable) → **notification priming** — R-push-3's priming screen lives
  there, with the deferred OS prompt still fired at a moment of
  demonstrated value.

### 2.7 Decisions owned by this spec (formerly new markers)

- Flight-status — deferred to v2; see R-notif-6 (§2.2). (Resolved
  2026-07-09, Gate 2)
- Day-ahead digest delivery time — decided: **20:00 the evening before, in
  the trip destination's timezone** (server-side tz-lookup table from
  destination coordinates; no external API); coordinates absent → fall back
  to the user's most-recent device timezone, captured as an optional
  `timezone` (IANA) field on push-token registration (one-column companion
  addition to schema §3.3.3, flagged for the schema spec). See R-notif-2.
  (Resolved 2026-07-09, Gate 2)
- Offline availability of document scans — decided: **no offline document
  scans in v1** (option a — security > convenience; a passport scan cached
  on-device is the highest-value at-rest target). The vault stays excluded
  from the active-trip offline bundle; revisit with an encrypted
  per-document opt-in design post-v1. (Resolved 2026-07-09, Gate 2)

---

## 3. Design

### 3.1 Push architecture & token lifecycle

```
client                              server                          Expo Push
──────                              ──────                          ─────────
prime → OS permission
getExpoPushToken({ projectId })     POST /push-tokens (upsert)
  (null/throw → degraded state,       → push_tokens row
   R-push-2)
app foreground → re-register        bumps last_seen_at (R-push-6)
sign-out → DELETE /push-tokens/:t   row deleted; local schedules cancelled

trigger (mutation/job)              audience resolve (trip_members →
                                    push_tokens) → pref check (R-push-4)
                                    → entitlement seam (R-push-8)
                                    → NotificationPayload build (§3.3)
                                    → batch send ──────────────────▶ tickets
                                    receipt poll ◀───────────────── receipts
                                    DeviceNotRegistered → delete row
```

- Sends are dispatched **after** the triggering DB transaction commits
  (R-notif-7): a failed push never rolls back a mutation, and a rolled-back
  mutation never notifies.
- Android: one notification channel per category (channel id = category
  value) so OS-level per-category control matches in-app prefs. iOS uses
  category identifiers the same way. Exact expo-notifications /
  expo-server-sdk APIs are verified via Context7 at build time and versions
  pinned via `npm view` (CLAUDE.md § Before you code; R-shared-13 pattern) —
  this spec pins behavior, not API signatures.
- The `notifications` router (PLANNING component map) owns §3.5's endpoints;
  a `notifications` service module owns audience resolution + send so
  domain routers (itinerary, money) call one seam.

### 3.2 Preferences

- **Home:** `users.prefs.notifications` — extends the shared `UserPrefs`
  schema (contracts spec §3.4 `user.ts`) with
  `notifications?: Partial<Record<NotificationCategory, boolean>>`; an
  absent key means enabled (R-push-4). JSONB — no migration needed
  (`prefs` already exists; unknown keys stripped on write per R-db-17).
  The contracts spec's `UserPrefs` gains this field when this spec is
  approved (coordination note, not a marker — additive).
- **`NotificationCategory`** — new shared enum tuple in
  `@gogo/shared/enums.ts` (R-shared-2 pattern): `itinerary_change`,
  `daily_digest`, `leave_by`, `document_expiry`, `settle_up`,
  `flight_status`. Wire + prefs only — **no pgEnum** (no DB column stores
  it; prefs are JSONB keys, payloads are wire shapes). Append-only.
- `leave_by` is device-local (R-notif-3) but still a pref: the toggle gates
  local scheduling client-side, and syncs through the same prefs object so
  it follows the user across devices.
- Per-trip muting is explicitly **out of scope** for v1 (§3.10) — prefs are
  global per category; a per-trip mute is an additive later feature.

### 3.3 `NotificationPayload` (shared `domains/notification.ts`)

Fulfills the contracts spec §3.8 handoff ("push notification payload
schemas — notifications spec; shared module added under `domains/`").
Discriminated union on `category`; common fields:

```
{ category: NotificationCategory,
  title: string, body: string,            // template output (R-push-9/10)
  route: string,                          // deep-link registry path (R-push-7)
  trip_id?: Uuid }
```

Per-category extras:

| Category | Extra fields | Notes |
|---|---|---|
| `itinerary_change` | `invalidate: Array<'itinerary' \| 'bookings' \| 'legs' \| 'expenses' \| 'members'>`, `actor_id: Uuid` | Client maps `invalidate` scopes → TanStack Query key invalidation (today spec §2.7); `actor_id` lets a device suppress self-echo |
| `daily_digest` | `day: ISODate` | Routes to today tab (today spec §2.8) |
| `leave_by` | `item_id: Uuid`, `leave_at: ISODateTime` | **Local-only** — never crosses the wire; same schema for uniformity |
| `document_expiry` | `document_id: Uuid` | |
| `settle_up` | `request_id: Uuid` | Entity owned by money spec |
| `flight_status` | reserved | Deferred to v2 (R-notif-6, resolved Gate 2) |

### 3.4 Notification catalog (summary table)

| # | Category | Trigger | Audience | Delivery | Dedup / coalesce | Route (registry) |
|---|---|---|---|---|---|---|
| 3.4.1 | `itinerary_change` | itinerary item / booking create·update·delete by a member | other trip members | server push | 120 s window per (trip, actor), one coalesced send | trip default tab; single-item change → item detail |
| 3.4.2 | `daily_digest` | digest job tick crosses send-time for an active-trip day | members w/ pref on | server push (template) | once per (user, trip, day) | `/t/[tripId]` → today tab |
| 3.4.3 | `leave_by` | scheduled locally from bundle legs + item starts | this device | **device-local** | ≤ 48 h rolling window; rescheduled on refresh (R-notif-3) | today tab, hero focused on `item_id` |
| 3.4.4 | `document_expiry` | daily job: `today ≥ expires_at − remind_days_before` | document owner | server push | `last_reminded_at` (one reminder v1) | documents vault (`more/documents`) |
| 3.4.5 | `settle_up` | settle-up request created (money spec) | debtor | server push | one per request | `/t/[tripId]/money/request/[requestId]` |
| 3.4.6 | `flight_status` | — deferred to v2 (R-notif-6, resolved Gate 2) | — | — | — | reserved |

Content templates (deterministic, R-push-9; PII posture R-push-10) live
beside the sender in `apps/server`; exact copy is an implementation detail,
the *inputs* per template are fixed by the table + payload schema.

### 3.5 Endpoints

All endpoints: **Auth: Required** (session user). Envelope + error codes per
contracts spec §3.5. Descriptors exported per contracts spec §3.6.

---

#### POST /push-tokens

Register (upsert) the calling device's Expo push token. Re-registration by a
different user moves the token. Bumps `last_seen_at`.

**Request** `{ token: string, platform: 'ios' | 'android' }`
**Response 200** `{ id, user_id, token, platform, last_seen_at }`

**Errors**: 400 `VALIDATION_FAILED` — malformed token/platform.

**Requirements covered**: R-push-1, R-push-2 (client half), R-push-6

**Tests required**:
- [ ] Happy path: new token row created for caller
- [ ] Upsert: same token re-registered by another user moves (no duplicate)
- [ ] Re-registration bumps `last_seen_at`
- [ ] Authz: unauthenticated → 401

#### DELETE /push-tokens/:token

Unregister on sign-out. Idempotent (deleting an absent token → 204).

**Response 204**

**Errors**: 403 `FORBIDDEN` — token belongs to another user.

**Requirements covered**: R-push-5

**Tests required**:
- [ ] Happy path deletes the row; repeat call still 204
- [ ] Another user's token → 403, row survives

#### GET /me/notification-prefs

Effective per-category preferences (stored ∪ defaults — absent = enabled).

**Response 200** `{ prefs: Record<NotificationCategory, boolean> }`

**Requirements covered**: R-push-4

**Tests required**:
- [ ] No stored prefs → all categories true
- [ ] Stored overrides reflected

#### PUT /me/notification-prefs

Replace stored preference overrides (validated against the
`NotificationCategory` enum; unknown keys stripped, R-db-17/R-shared-10).
Writes `users.prefs.notifications`.

**Request** `{ prefs: Partial<Record<NotificationCategory, boolean>> }`
**Response 200** `{ prefs: Record<NotificationCategory, boolean> }` (effective)

**Errors**: 400 `VALIDATION_FAILED` — unknown category key / non-boolean.

**Requirements covered**: R-push-4

**Tests required**:
- [ ] Disable a category → subsequent send-point check skips recipient
- [ ] Unknown key stripped, not persisted

#### GET /trips/:tripId/weather

Forecast for the trip destination, cache-first (`weather_cache`).

**Response 200**
`{ location: { lat, lng } | null, forecast: WeatherForecast | null,
   fetched_at?: ISODateTime, expires_at?: ISODateTime, stale: boolean,
   reason?: 'no_destination_coords' | 'provider_unavailable' }`

**Errors**: 404 `NOT_FOUND` — trip absent or caller not a member (IDOR
posture). Provider failure is NOT an error (R-wx-2).

**Requirements covered**: R-wx-1..4

**Tests required**:
- [ ] Fresh cache hit → no provider call
- [ ] Expired cache → provider fetch + upsert
- [ ] Provider down + stale row → 200 stale:true with old payload
- [ ] Provider down + no row → 200 forecast:null reason:provider_unavailable
- [ ] Coordless trip → 200 forecast:null reason:no_destination_coords
- [ ] Authz: non-member → 404

#### GET /documents

The caller's vault, newest first. Optional `?trip_id=` filter
(association only — still owner-scoped).

**Response 200** `Paginated<TravelDocument>` — `TravelDocument` mirrors
schema §3.3.22 (no signed URLs in list payloads).

**Requirements covered**: R-docs-1

**Tests required**:
- [ ] Returns only caller's documents (seeded with another user's rows)
- [ ] trip_id filter narrows without leaking other users' docs

#### POST /documents

Create a document (metadata; file attaches via upload-url). Metadata-only
entries legal (R-docs-7).

**Request** `{ kind: document_kind, title: string, trip_id?: Uuid,
expires_at?: ISODate, remind_days_before?: int }`
**Response 201** `TravelDocument`

**Errors**: 400 `VALIDATION_FAILED` — `remind_days_before ≤ 0`, unknown
kind; 404 `NOT_FOUND` — trip_id the caller isn't a member of.

**Requirements covered**: R-docs-6, R-docs-7

**Tests required**:
- [ ] Metadata-only create (no file) succeeds
- [ ] remind_days_before=0 rejected
- [ ] trip_id association requires membership

#### POST /documents/:documentId/upload-url

Mint a presigned PUT for the document's scan. Re-minting replaces the
pending target (idempotent retry path). Sets/rotates `storage_key`
(`documents/{user_id}/{document_id}/{uuid}`); orphaned objects reconciled
by job (photos precedent, schema §3.3.17 note).

**Request** `{ content_type: string, byte_size: int }`
**Response 200** `{ url, method: 'PUT', headers, expires_at }`

**Errors**: 400 `VALIDATION_FAILED` — content type off allowlist;
413 `PAYLOAD_TOO_LARGE` — over 20 MB; 404 `NOT_FOUND` — not caller's doc.

**Requirements covered**: R-docs-2, R-docs-4, R-docs-5

**Tests required**:
- [ ] Allowlisted type mints URL with TTL
- [ ] Disallowed type / oversize rejected
- [ ] Another user's documentId → 404

#### GET /documents/:documentId/download-url

Short-TTL signed GET for the scan.

**Response 200** `{ url, expires_at }` — TTL ≤ 5 min.

**Errors**: 404 `NOT_FOUND` — not caller's doc, or `storage_key` is NULL.

**Requirements covered**: R-docs-1, R-docs-3

**Tests required**:
- [ ] Owner gets URL; TTL within bound
- [ ] Trip member who isn't owner → 404 (Law #3 / R-db-18)
- [ ] Metadata-only doc → 404

#### PATCH /documents/:documentId

Update metadata: `kind`, `title`, `trip_id`, `expires_at`,
`remind_days_before`. Clearing `expires_at` also clears reminder state.

**Request** partial of POST body (all optional)
**Response 200** `TravelDocument`

**Errors**: as POST.

**Requirements covered**: R-docs-1, R-docs-6

**Tests required**:
- [ ] Setting expiry+reminder makes the job pick it up (job test §3.6)
- [ ] Non-owner → 404

#### DELETE /documents/:documentId

Delete row; storage object cleaned by reconciliation job.

**Response 204**

**Requirements covered**: R-docs-1

**Tests required**:
- [ ] Owner deletes; non-owner → 404

#### GET /trips/:tripId/packing-lists

Lists for the trip — one shared list per trip in v1 (§2.6, resolved
Gate 2), so `items` has at most one element; the array shape is kept for
forward compatibility with per-member lists.

**Response 200** `{ items: PackingList[] }`

**Requirements covered**: R-pack-1

**Tests required**:
- [ ] Member reads; non-member → 404

#### POST /trips/:tripId/packing-lists

Create the trip's shared list (manual, or persisting an `/ai/packing-list`
result — `ai_generated` set by the server based on provenance flag in
request). One per trip (`unique(trip_id)`, resolved Gate 2).

**Request** `{ title?: string, items?: PackingItem[], ai_generated?: boolean }`
**Response 201** `PackingList`

**Errors**: 409 `CONFLICT` — the trip already has its shared list.

**Requirements covered**: R-pack-1, R-pack-4

**Tests required**:
- [ ] Create with/without items; viewer role rejected (403)
- [ ] Second create for the same trip → 409

#### PATCH /trips/:tripId/packing-lists/:listId

Whole-list update: `title` and/or full `items` replacement (R-pack-2).
Last-write-wins on concurrent PATCH.

**Request** `{ title?: string, items?: PackingItem[] }`
**Response 200** `PackingList`

**Errors**: 400 `VALIDATION_FAILED` — duplicate item ids, malformed item.

**Requirements covered**: R-pack-2, R-pack-3

**Tests required**:
- [ ] Check-off round-trip preserves other items (stable ids)
- [ ] Duplicate item id rejected
- [ ] Offline-queued PATCH drains correctly (integration w/ today spec §2.7)

#### DELETE /trips/:tripId/packing-lists/:listId

**Response 204** — editors+; Confirm handled client-side.

**Requirements covered**: R-pack-1

**Tests required**:
- [ ] Editor deletes; viewer 403; non-member 404

---

### 3.6 Jobs (extends PLANNING § Component map jobs list)

All non-LLM (R-push-9). Job runner mechanics belong to the server
scaffold; contracts here:

| Job | Cadence | Contract |
|---|---|---|
| `notification-digest` | hourly tick | For each active trip (status = derived + override, §2.6 resolved Gate 2) and member with `daily_digest` on: when destination-local time (fallback: device tz) crosses 20:00 for tomorrow's trip day and no digest sent for (user, trip, day) → build template from itinerary + legs + `weather_cache`, send (R-notif-2, resolved Gate 2) |
| `document-expiry` | daily | Scan partial `(expires_at)` index; threshold rows without `last_reminded_at` → send + stamp (R-notif-4) |
| `push-token-prune` | daily | Delete rows `last_seen_at < now() − 90d` (R-push-6) |
| `push-receipt-poll` | minutes after each batch | Fetch Expo receipts; `DeviceNotRegistered` → delete token (R-push-6) |

The leg-ETA refresh job (PLANNING) is owned by the maps/itinerary domain;
leave-by scheduling consumes its output via the bundle (R-notif-3) —
no notification job for leave-by exists.

### 3.7 Weather design notes

- `location_key` derivation (`"{lat:.2f},{lng:.2f}"`, ~1.1 km cell) is the
  shared function cited by schema §3.3.23 — one implementation, used by the
  endpoint and any prefetch.
- TTL: 6 h default (config; schema says "hours"). The active-trip bundle
  snapshot (today spec §2.6) stores the last-served payload client-side;
  offline the client renders that snapshot with its `fetched_at` — this
  endpoint never needs an offline mode itself.
- `WeatherProvider` port lives in `apps/server` (it does I/O — not
  `@gogo/shared`, R-shared-9); the `WeatherForecast` shape it returns is
  shared (`domains/weather.ts`).

### 3.8 Documents design notes

- Storage layout `documents/{user_id}/{document_id}/{uuid}` — key encodes
  owner for bucket-policy defense in depth; rotation on re-mint prevents
  stale-URL reuse across replaced scans.
- Deleting a document (or its owning user cascade) leaves the object for
  the reconciliation job — same lifecycle note as photos (schema §3.3.17).
- Offline caching of scans: excluded from v1 (§2.7, resolved Gate 2 —
  security > convenience).

### 3.9 Packing design notes

- `PackingItem.id` generation uses the injected `IdGenerator` port
  (contracts spec §3.6; RN landmine: no `crypto.randomUUID()` — polyfilled
  uuid/nanoid, pinned at build).
- AI generation flow: client calls `/ai/packing-list` (AI spec; counts
  against the AI cap) → receives `PackingItem[]` minus `checked` →
  POSTs here with `ai_generated: true`. This spec's endpoints never call
  the model.

### 3.10 Out of scope (explicit)

- **Flight-status data integration** — deferred to v2 (R-notif-6, resolved
  Gate 2); category value reserved.
- **Settle-up request entity + endpoints** — money spec; only the push
  (R-notif-5) lives here.
- **AI endpoints** (`/ai/packing-list` etc.) — AI spec.
- **Notification tap-routing UX + offline sync orchestration** — today spec
  (`.specs/client/today.spec.md`), which consumes §3.3/§3.4.
- **Weather provider selection** — build-phase escalation (schema §3.7).
- **Object-storage provider + storage-side encryption implementation** —
  P-3 infra escalation (schema §3.7); posture fixed by R-docs-4.
- **In-app notification center / history** — no `notifications` table
  exists in the data model; pushes are fire-and-forget in v1. Adding a
  persisted feed later is additive (new table + backfill-free).
- **Per-trip notification muting** — v1 prefs are global per category
  (§3.2); additive later.
- **Live Activities / lock-screen widgets** (flight countdown etc.) —
  post-v1 platform work.

---

## 4. Tasks

Sized to one agent session each; become `T-N.M` rows at build time.
Dependencies: NTF-1 before NTF-2/3; UTL-* independent of NTF-* except
UTL-2's reminder test needs NTF-3's job harness.

### NTF-1 — Shared notification contracts + push-token endpoints

**Covers:** R-push-1, R-push-4 (schema half), R-push-5, R-push-6 (row
lifecycle), R-push-7 (schema)

- [ ] `@gogo/shared`: `NotificationCategory` enum (§3.2),
      `domains/notification.ts` payload union (§3.3), `UserPrefs.notifications`
      extension (coordinated edit to contracts spec module)
- [ ] `POST /push-tokens`, `DELETE /push-tokens/:token`,
      `GET|PUT /me/notification-prefs` + descriptors
- [ ] Tests per §3.5 endpoint checklists

### NTF-2 — Client push registration + permission priming + prefs UI

**Covers:** R-push-2, R-push-3, R-push-4 (client half), R-push-5 (client)

- [ ] Expo push token acquisition with EAS `projectId` from app config;
      null/throw → visible degraded state (landmine test)
- [ ] Priming flow + deferred OS prompt; denied-state settings deep link
- [ ] Prefs screen wired to `GET|PUT /me/notification-prefs` (testIDs per
      navigation §2.7 grammar)
- [ ] Foreground re-registration (last_seen_at bump)
- [ ] Tests: token null path never silently passes; prefs round-trip;
      sign-out cancels local schedules + deletes token

### NTF-3 — Send pipeline + catalog senders + jobs

**Covers:** R-notif-1, R-notif-2, R-notif-4, R-notif-5, R-notif-7,
R-push-8, R-push-9, R-push-10; jobs §3.6

- [ ] Notification service: audience resolve → prefs → entitlement seam →
      payload build → Expo batch send → receipt poll (post-commit dispatch)
- [ ] Itinerary-change sender w/ 120 s coalescing + invalidation hints
- [ ] Digest job (template only — CI check: no LLM import in
      notification/job modules), document-expiry job, token-prune job
- [ ] Tests: actor excluded; coalescing window; digest dedup per
      (user, trip, day); expiry dedup via `last_reminded_at`;
      DeviceNotRegistered deletes token; payloads validate against shared
      schema; no PII beyond R-push-10 in templates

### NTF-4 — Leave-by local scheduling (client)

**Covers:** R-notif-3, R-push-4 (local half)

- [ ] Scheduler: bundle (items + legs) → leave_by computation → local
      notifications within 48 h window; reschedule on foreground/bundle
      refresh/local mutation; pref-gated
- [ ] Tests: window cap respected (≤ 64 pending); buffer math; items
      without legs/start times skipped; pref off → nothing scheduled

### UTL-1 — Weather endpoint + provider port

**Covers:** R-wx-1..4

- [ ] `WeatherProvider` port + fake provider for tests; cache-first
      endpoint; stale-serve; coordless branch
- [ ] Tests per §3.5 checklist

### UTL-2 — Documents vault API

**Covers:** R-docs-1..7

- [ ] CRUD + upload-url + download-url endpoints; storage adapter port
      (presign PUT/GET) — provider-agnostic
- [ ] Tests per §3.5 checklists + TTL bounds + ownership matrix
      (owner / trip-member / stranger × every endpoint)

### UTL-3 — Packing-list API

**Covers:** R-pack-1..4

- [ ] CRUD endpoints, whole-list PATCH, role checks
- [ ] Tests per §3.5 checklists + LWW concurrent PATCH behavior

---

*Trace: every R-push/R-notif/R-wx/R-docs/R-pack cites its design section
inline. All markers resolved at Gate 2 (2026-07-09): §2.6 inherited
(packing = shared per trip; destination structured; status derived +
override; onboarding includes priming); §2.7 owned here (flight status →
deferred to v2; digest → 20:00 destination-local, device-tz fallback;
offline doc scans → excluded from v1). Zero markers remain.*
