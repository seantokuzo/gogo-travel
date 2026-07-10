# API — Itinerary + Bookings + Travel Legs — `.specs/api/itinerary-bookings.spec.md`

> **Task:** T-2.3 (ITINERARY + BOOKINGS + DEEPLINK-OUT bundle) · **Status:**
> DRAFT — pending Sean approval. Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources (canonical, this spec never contradicts them):**
> `.specs/database/schema.spec.md` §3.3.9–§3.3.11, §3.4.1 (tables + JSONB
> shapes — CANONICAL), `.specs/shared/contracts.spec.md` (envelope, scalars,
> enum pattern — CANONICAL), `docs/PLANNING.md § Architecture` (provider
> table, component map, collab-sync v1), `.specs/research/competitors.md`
> (itinerary UX evidence), `.specs/research/booking-integrations.md`
> (deeplink/capture landscape).
>
> **Companions:** `.specs/client/itinerary.spec.md` (screens consuming these
> endpoints; deeplink-out URL construction lives THERE — it is a pure client
> concern). The capture spec's landing flow MUST write bookings through this
> spec's service invariants (§3.1), never raw inserts.

---

## 1. Scope & conventions

Hono routers `itinerary` and `bookings` (PLANNING § Component map) plus the
`leg-ETA refresh` job contract. All request/response shapes are `@gogo/shared`
Zod schemas (contracts spec §3.1: entity schemas mirror DB rows, snake_case
wire, `*Create`/`*Update` subsets); all validation runs via
`@hono/zod-validator` before handler logic (R-shared-3). Errors use the shared
`ApiError` envelope and `ErrorCode` enum only (contracts §3.5). Money follows
Law #2 (`Cents`). Concurrency model is PLANNING's collab v1: REST + optimistic
updates, **last-write-wins**, refetch-on-focus — no version tokens in v1.

Authorization baseline (every endpoint below): authenticated; caller must be a
`trip_members` row for `:tripId`. Non-members receive `404 NOT_FOUND`,
indistinguishable from absent (contracts §3.5 NOT_FOUND semantics; navigation
spec R-nav-15 posture). Reads: any role. Writes: `editor` or `owner`;
`viewer` writes → `403 FORBIDDEN`.

---

## 2. Requirements (EARS)

### Bookings

- **R-ib-1 (details are typed):** WHEN a booking is created or its `details`
  updated THE SYSTEM SHALL validate `details` against the `@gogo/shared`
  `BookingDetails` discriminated-union member for the row's `category` before
  any write, stripping unknown keys; a `details` payload whose discriminant
  mismatches the row `category` SHALL be rejected `VALIDATION_FAILED`
  (mirror of schema R-db-11 / contracts R-shared-10).
- **R-ib-2 (category is immutable):** WHEN a booking update attempts to change
  `category` THE SYSTEM SHALL reject it `VALIDATION_FAILED` — the details
  shape is category-discriminated; the correction path is delete + recreate.
- **R-ib-3 (status machine):** WHEN a status change is requested THE SYSTEM
  SHALL permit only the transitions in §3.2; any transition out of
  `cancelled` SHALL be rejected `VALIDATION_FAILED` (cancelled is terminal,
  schema §3.2 `booking_status` semantics).
- **R-ib-4 (denormalized instants):** WHEN `details` carrying the category's
  primary times (§3.3 table) is written THE SYSTEM SHALL derive
  `starts_at`/`ends_at` (UTC instants) in the same write; WHEN primary times
  are absent THE SYSTEM SHALL leave them NULL (schema §3.3.9: source of truth
  for display times is `details`).
- **R-ib-5 (auto-item / single source of truth):** WHEN a booking is created
  or updated such that `status ∈ {planned, booked}` AND its primary times are
  known THE SYSTEM SHALL create or resync its `itinerary_items` row(s) —
  day/times derived per §3.3 — **in the same transaction** as the booking
  write (schema §3.3.9 scheduling relationship). Booking-time changes SHALL
  overwrite item day/times (the booking wins).
- **R-ib-6 (ideas are off-calendar):** WHEN a booking's status is or becomes
  `idea` THE SYSTEM SHALL ensure it has zero `itinerary_items` rows, deleting
  any in the same transaction on demotion.
- **R-ib-7 (cancel keeps history):** WHEN a booking becomes `cancelled` THE
  SYSTEM SHALL delete its itinerary item(s) in the same transaction and
  retain the booking row and its expense links unchanged (expenses reference
  survives; only booking DELETE SET-NULLs them, schema §3.6).
- **R-ib-8 (scheduling a timeless booking):** WHEN a booking with NULL
  `starts_at` is scheduled to a day THE SYSTEM SHALL create its `booking`-kind
  item with the given `day`/`start_time`/`end_time`, and SHALL advance status
  `idea → planned` when it was `idea`; WHEN the booking already has items THE
  SYSTEM SHALL reject `CONFLICT`; WHEN the booking has known times THE SYSTEM
  SHALL reject `VALIDATION_FAILED` (its calendar presence is automatic,
  R-ib-5).
- **R-ib-9 (unscheduling):** WHEN a `booking`-kind item is deleted and its
  parent booking is `planned` THE SYSTEM SHALL revert the booking to `idea`
  in the same transaction; WHEN the parent is `booked` THE SYSTEM SHALL
  reject `CONFLICT` (cancel or demote the booking instead — a purchased
  booking never silently leaves the calendar).
- **R-ib-10 (unscheduled bucket):** WHEN the bookings list is queried with
  `unscheduled=true` THE SYSTEM SHALL return exactly the bookings having zero
  `itinerary_items` rows (ideas + timeless planned/booked; `cancelled`
  excluded unless `status=cancelled` is explicitly requested).
- **R-ib-11 (source tracking):** WHEN a booking is created through this API
  THE SYSTEM SHALL accept `source` only as `manual` (default) or
  `deeplink_return` (client confirmed a booking after a deeplink-out —
  navigation spec R-nav-18 flow); `email`/`share` SHALL be settable only by
  the capture pipeline's landing service, never by direct client input.
- **R-ib-12 (money):** WHEN `price_cents` is non-null THE SYSTEM SHALL
  require a `currency` and validate both with shared scalars (`Cents`,
  `CurrencyCode`) — mirror of schema R-db-13 / contracts R-shared-6.

### Itinerary items

- **R-ib-13 (one-shot itinerary read):** WHEN the itinerary is read for a day
  range THE SYSTEM SHALL return, in one response, the range's items ordered
  by `(day, sort_order)` and the travel legs whose endpoints are both in the
  range (the `(trip_id, day, sort_order)` index is THE itinerary query,
  schema §3.5).
- **R-ib-14 (creatable kinds):** WHEN an item is created directly THE SYSTEM
  SHALL accept kind `place_visit` (requires `place_id`) or `custom` (requires
  `title`) only; direct creation of `booking`-kind items SHALL be rejected
  `VALIDATION_FAILED` (they exist only via R-ib-5/R-ib-8).
- **R-ib-15 (ordering):** WHEN an item is created without explicit position
  THE SYSTEM SHALL append it with a gapped `sort_order` (last-in-day + 1024,
  schema §3.3.10); WHEN a day's order is PUT THE SYSTEM SHALL atomically
  reassign the listed items to that day with `sort_order = 1024 × position`;
  ids in the list that no longer exist SHALL be ignored (last-write-wins),
  ids belonging to another trip SHALL be rejected `VALIDATION_FAILED`.
- **R-ib-16 (booking-item field protection):** WHEN a `booking`-kind item's
  `day`/`start_time`/`end_time` are edited THE SYSTEM SHALL accept the edit
  only while the parent booking's `starts_at` IS NULL (the item owns its
  times, R-ib-8); otherwise reject `VALIDATION_FAILED` directing the caller
  to edit the booking (R-ib-5). `notes` and `sort_order` are always editable.
- **R-ib-17 (overlaps are legal):** WHEN item times overlap other items on
  the same day THE SYSTEM SHALL accept the write — overlaps are never
  rejected; exposing them is the calendar-grid differentiator (client spec).
  Only structural validity is enforced (`end_day ≥ day`; where both times set
  on a single-day item, `end_time ≥ start_time`).
- **R-ib-18 (LWW + post-state):** WHEN any itinerary/booking mutation
  succeeds THE SYSTEM SHALL return the resulting entity state (or the day's
  resulting item list for reorder) so optimistic clients reconcile without a
  second round-trip; conflicting concurrent edits resolve last-write-wins
  (PLANNING § Cross-cutting patterns, collab v1).

### Travel legs

- **R-ib-19 (recompute trigger, never blocking):** WHEN any mutation changes
  a day's located ordered sequence (item create/delete/move/reorder,
  booking time or place change, item place change) THE SYSTEM SHALL mark the
  affected day(s) dirty and recompute legs **asynchronously**; itinerary and
  booking mutations SHALL never fail or block on leg computation or provider
  availability.
- **R-ib-20 (adjacency contract):** THE SYSTEM SHALL maintain legs exactly
  for consecutive **located** item pairs within a day (day order = `sort_order`;
  unlocated items are transparent — the chain connects across them), per
  computed mode. Location resolution: `booking`-kind → parent
  `bookings.place_id`; else item `place_id`; no place ⇒ unlocated. Legs never
  span days.
- **R-ib-21 (modes & providers):** WHEN a pair is computed THE SYSTEM SHALL
  request `driving`, `walking`, `cycling` from Mapbox Directions
  (server-side) and `transit` from Transitous; WHEN Transitous is unavailable
  or returns no route THE SYSTEM SHALL simply omit the transit row — absent,
  never an error (schema §3.3.11: hide the mode, don't fail). The mode set is
  shared config, not code.
- **R-ib-22 (identity, cleanup, single writer):** THE SYSTEM SHALL store at
  most one leg per `(from_item_id, to_item_id, mode)` (mirror of R-db-15),
  SHALL delete legs whose pair is no longer adjacent-located during
  recompute, and SHALL write `travel_legs` from the leg-computation job only
  (schema §3.3.11 app-layer invariant: it alone guarantees both items belong
  to `trip_id`).
- **R-ib-23 (staleness & refresh):** WHEN legs are computed THE SYSTEM SHALL
  set `computed_at`; the leg-ETA refresh job (PLANNING § Component map jobs)
  SHALL recompute legs older than the TTL (config; default 24 h) for trips
  that are `active` or start within 7 days; an explicit refresh request SHALL
  enqueue recomputation and return `202`.

### Authorization

- **R-ib-24 (membership + roles):** WHEN any endpoint in this spec is called
  THE SYSTEM SHALL require authentication and trip membership (non-member →
  `404 NOT_FOUND`, indistinguishable from absent); write endpoints SHALL
  additionally require role `editor` or `owner` (`viewer` → `403 FORBIDDEN`).

### Open markers (blocking approval)

Repeated verbatim from the canonical schema spec — they bind this API's
behavior and must resolve there first:

- From `.specs/database/schema.spec.md` §3.3.10 (`itinerary_items`):
  [NEEDS CLARIFICATION: multi-day bookings (lodging check-in→check-out) on the calendar — one spanning item (`end_day` used, rendered across days) or two point items (check-in item + check-out item)? Affects whether `end_day` stays; user-visible calendar rendering.]
  Consequences for this API are mapped in §3.6 — lodging auto-item derivation
  (R-ib-5) cannot be finalized until this resolves. The same choice governs
  cross-midnight point events (red-eye flights: arrival wall-date >
  departure wall-date).
- From `.specs/database/schema.spec.md` §3.3.4 (`trips`):
  [NEEDS CLARIFICATION: are trip dates required at creation, or are date-less trips allowed (dates added later)? Columns are nullable to keep both options open; the create-trip UX decides.]
  This API is engineered to tolerate either answer: the itinerary read's
  default range is trip dates when set, else the min→max of existing item
  days (§3.4 `GET /trips/:tripId/itinerary`), and no endpoint restricts
  `day` to the trip's date range (pre-trip flights are legal).

---

## 3. Design

### 3.1 Domain invariants (the booking↔item contract)

All booking writers — this router, the capture landing service, any future
job — go through one booking domain service that enforces, transactionally:

| # | Invariant | Requirement |
|---|---|---|
| I-1 | `status = 'idea'` ⇒ zero itinerary items | R-ib-6 |
| I-2 | `status ∈ {planned, booked}` ∧ `starts_at` known ⇒ exactly the derived item(s) exist, day/times synced from the booking | R-ib-5 |
| I-3 | `status ∈ {planned, booked}` ∧ `starts_at` NULL ⇒ zero items (unscheduled bucket) or exactly the user-scheduled item(s), which own their day/times | R-ib-8, R-ib-16 |
| I-4 | `status = 'cancelled'` ⇒ zero items; booking row retained | R-ib-7 |
| I-5 | Every booking/item mutation that can change a day's located sequence marks legs dirty | R-ib-19 |

Precedence rule for I-3 → I-2: when a timeless-but-scheduled booking later
gains real times (user edits details; capture updates it), the booking wins —
its derived day/times overwrite the item's in the same transaction. When a
booking's times are *removed* (details edited to drop them), existing items
keep their current day/times and become item-owned (I-3); nothing silently
vanishes from the calendar.

### 3.2 Booking status machine

`booking_status` values and semantics are canonical in schema §3.2. Allowed
transitions (anything absent is `VALIDATION_FAILED`):

| From \ To | idea | planned | booked | cancelled |
|---|---|---|---|---|
| **idea** | — | ✔ (schedule R-ib-8, or manual) | ✔ | ✔ |
| **planned** | ✔ (unschedule R-ib-9, or manual — deletes items) | — | ✔ | ✔ |
| **booked** | ✖ (demote to planned first — deliberate two-step friction) | ✔ ("didn't actually book"; items unaffected) | — | ✔ |
| **cancelled** | ✖ | ✖ | ✖ | — |

Side effects ride the transition in one transaction: `→ idea` and
`→ cancelled` delete items (I-1/I-4); `idea → planned|booked` with known
times creates items (I-2). Scheduling via `POST …/schedule` is the only
transition path that also writes item position data.

### 3.3 Time model (details → instants → calendar)

Canonical facts (schema §3.4.1): detail-shape times are ISO-8601 **with UTC
offset** representing destination-local wall time; `bookings.starts_at/ends_at`
are UTC instants denormalized from them; `itinerary_items.day/start_time/
end_time` are trip-local **wall values, no tz math**.

Derivations (all pure, defined once in `@gogo/shared` alongside the booking
schemas so server and client agree):

- `starts_at` (UTC) = the instant of the category's **primary start** field;
  `ends_at` = primary end. Primary fields per category:

| Category | Primary start | Primary end | Auto-item shape (R-ib-5) |
|---|---|---|---|
| `flight` | `departs_at` | `arrives_at` | 1 item on departure wall-date |
| `train` | `departs_at` | `arrives_at` | 1 item on departure wall-date |
| `lodging` | `check_in` | `check_out` | pends the multi-day marker (§3.6) |
| `car_rental` | `pickup_at` | `dropoff_at` | 2 point items: pickup event + dropoff event (each `booking`-kind; schema §3.3.9 "row(s)" anticipates plurality). Dropoff item exists only when `dropoff_at` is set. |
| `moped_rental` | `pickup_at` | `dropoff_at` | same as `car_rental` |
| `activity` | `starts_at` | `ends_at` | 1 item |
| `restaurant` | `reserved_at` | — | 1 item, `end_time` NULL |
| `other` | `starts_at` | `ends_at` | 1 item |

- Item `day` = wall-date component of the primary-start ISO string (offset
  dropped — no tz database needed); `start_time`/`end_time` = wall-time
  components. Cross-midnight ends (arrival wall-date > `day`) pend the
  multi-day marker (§3.6).
- Auto-item `sort_order` placement: inserted after the last item on that day
  whose `start_time ≤` the new item's (midpoint value); untimed → appended.

### 3.4 Endpoints

All shapes below are `@gogo/shared` schemas (§3.7). `Booking`,
`ItineraryItem`, `TravelLeg` mirror their schema-spec tables one-to-one.

---

#### GET /trips/:tripId/bookings

List a trip's bookings for the bookings/ideas surfaces.
**Auth**: Required — member (any role).

**Request** (query): `status?` (repeatable `booking_status`; default: all
except `cancelled`), `category?` (`booking_category`), `unscheduled?`
(boolean — R-ib-10), `cursor?`, `limit?`.

**Response 200**: `Paginated<Booking>` — ordered `starts_at ASC NULLS LAST,
updated_at DESC` (timeless ideas trail, freshest first; uses schema
`(trip_id, starts_at)` / `(trip_id, status)` indexes).

**Errors**: 401 UNAUTHENTICATED · 404 NOT_FOUND (no such trip / non-member) ·
400 VALIDATION_FAILED (bad query).

**Requirements covered**: R-ib-10, R-ib-24

**Tests required**:
- [ ] Happy path: filters by status/category; pagination cursor round-trip
- [ ] `unscheduled=true` returns exactly zero-item bookings; excludes cancelled by default
- [ ] Authz: non-member gets 404 with zero data; viewer can read

---

#### POST /trips/:tripId/bookings

Create a booking in any category. The manual-entry and deeplink-return paths.
**Auth**: Required — editor/owner.

**Request** (body `BookingCreate`): `category` (required, immutable),
`title` (required), `details?` (per-category shape, default `{}`), `status?`
(default `'idea'`; `cancelled` not creatable), `price_cents?` + `currency?`
(paired, R-ib-12), `confirmation_code?`, `place_id?`, `source?`
(`'manual'` default | `'deeplink_return'` — R-ib-11).

**Response 201**: `Booking`. Side effects per §3.1: `starts_at/ends_at`
derived (R-ib-4); auto-item(s) created when I-2 applies; legs marked dirty.

**Errors**: 400 VALIDATION_FAILED (details/category mismatch, unpaired price,
disallowed source/status) · 401 · 403 FORBIDDEN (viewer) · 404 (non-member).

**Requirements covered**: R-ib-1, R-ib-4, R-ib-5, R-ib-11, R-ib-12, R-ib-24

**Tests required**:
- [ ] Happy path per all 8 categories (valid details parse; unknown keys stripped)
- [ ] Mismatched category/details rejected; `source: 'email'` from client rejected
- [ ] Timed `planned` create auto-creates item(s) atomically; `idea` create does not
- [ ] Authz: viewer 403; non-member 404

---

#### GET /trips/:tripId/bookings/:bookingId

Booking detail (drives the per-category detail screen).
**Auth**: Required — member (any role).

**Response 200**: `BookingWithItems` = `Booking` + `items: ItineraryItem[]`
(its calendar presence, possibly empty).

**Errors**: 401 · 404 (no such booking / no such trip / non-member —
indistinguishable).

**Requirements covered**: R-ib-24

**Tests required**:
- [ ] Happy path incl. items array for scheduled + empty for ideas
- [ ] Authz: wrong-trip bookingId 404; non-member 404

---

#### PATCH /trips/:tripId/bookings/:bookingId

Partial update: `title`, `details`, `status`, `price_cents`, `currency`,
`confirmation_code`, `place_id`. `category` immutable (R-ib-2).
**Auth**: Required — editor/owner.

**Response 200**: `BookingWithItems` (post-state, R-ib-18). Side effects:
status transitions per §3.2 with their item effects; time changes resync
items (I-2); place/time changes mark legs dirty.

**Errors**: 400 VALIDATION_FAILED (illegal transition, category change,
details mismatch) · 401 · 403 · 404.

**Requirements covered**: R-ib-1..R-ib-7, R-ib-12, R-ib-18, R-ib-24

**Tests required**:
- [ ] Every legal transition of §3.2 applies its item side effects atomically; every illegal one 400s
- [ ] Booking time change moves its item's day/times in the same transaction (I-2)
- [ ] Removing times leaves scheduled item untouched (I-3 precedence)
- [ ] Category change rejected; transition out of cancelled rejected
- [ ] Authz: viewer 403; non-member 404

---

#### DELETE /trips/:tripId/bookings/:bookingId

Hard delete. Items cascade (DB); expense links SET NULL (schema §3.6) — the
expense ledger outlives the booking.
**Auth**: Required — editor/owner.

**Response 204**. Side effect: legs dirty for affected day(s).

**Errors**: 401 · 403 · 404.

**Requirements covered**: R-ib-19, R-ib-24

**Tests required**:
- [ ] Delete cascades items, SET-NULLs expenses, triggers leg recompute
- [ ] Authz: viewer 403; non-member 404

---

#### POST /trips/:tripId/bookings/:bookingId/schedule

Place a **timeless** booking onto the calendar (the ideas-bucket "Add to
day" action).
**Auth**: Required — editor/owner.

**Request** (body): `day` (ISODate, required), `start_time?`/`end_time?`
(ISOTime), `after_item_id?` (position; default append).

**Response 201**: `BookingWithItems` — item created, status advanced
`idea → planned` when applicable (R-ib-8).

**Errors**: 400 VALIDATION_FAILED (booking has known times; bad body) ·
409 CONFLICT (already scheduled) · 401 · 403 · 404.

**Requirements covered**: R-ib-8, R-ib-18, R-ib-24

**Tests required**:
- [ ] Idea scheduled → item exists, status planned, one transaction
- [ ] Timed booking 400; already-scheduled 409
- [ ] Authz: viewer 403; non-member 404

---

#### GET /trips/:tripId/itinerary

The one-shot calendar read: items + legs for a range (R-ib-13). Composite
resource, deliberately **not** `Paginated<T>` — the calendar needs both
collections mutually consistent in one response and is bounded by trip
length; R-shared-5's pagination rule applies to open-ended lists (bookings
above), not this bounded composite.
**Auth**: Required — member (any role).

**Request** (query): `from?`/`to?` (ISODate). Default range: trip
`start_date…end_date` unioned with the min→max of existing item days (also
covers date-less trips — §2 marker).

**Response 200**: `{ items: ItineraryItem[], legs: TravelLeg[] }` — items
ordered `(day, sort_order)`; legs limited to pairs with both endpoints in
range.

**Errors**: 400 VALIDATION_FAILED (`to < from`) · 401 · 404.

**Requirements covered**: R-ib-13, R-ib-24

**Tests required**:
- [ ] Ordering is `(day, sort_order)`; range filtering of items and legs
- [ ] Default range covers items outside trip dates and date-less trips
- [ ] Authz: non-member 404

---

#### POST /trips/:tripId/itinerary/items

Create a `place_visit` or `custom` item (R-ib-14).
**Auth**: Required — editor/owner.

**Request** (body `ItineraryItemCreate`): `kind` (`place_visit` | `custom`),
`place_id` (required iff `place_visit`), `title` (required iff `custom`),
`notes?`, `day` (required), `end_day?`, `start_time?`, `end_time?`,
`after_item_id?` (position; default append with +1024 gap, R-ib-15).

**Response 201**: `ItineraryItem`. Side effect: legs dirty for `day`.

**Errors**: 400 VALIDATION_FAILED (kind `booking`; kind/field mismatch per
schema §3.3.10 checks; structural time violations per R-ib-17) · 401 · 403 ·
404.

**Requirements covered**: R-ib-14, R-ib-15, R-ib-17, R-ib-19, R-ib-24

**Tests required**:
- [ ] Happy path both kinds; server-assigned gapped sort_order appends
- [ ] kind=booking rejected; place_visit without place_id rejected
- [ ] Overlapping times accepted (R-ib-17)
- [ ] Authz: viewer 403; non-member 404

---

#### PATCH /trips/:tripId/itinerary/items/:itemId

Edit an item: `title` (custom only), `notes`, `place_id` (place_visit only),
`day`, `end_day`, `start_time`, `end_time`, `sort_order`.
**Auth**: Required — editor/owner.

**Response 200**: `ItineraryItem` (post-state). Booking-kind items: field
protection per R-ib-16. Side effect: legs dirty for source/target day(s).

**Errors**: 400 VALIDATION_FAILED (protected booking-item fields; kind/field
mismatch) · 401 · 403 · 404.

**Requirements covered**: R-ib-16, R-ib-17, R-ib-18, R-ib-19, R-ib-24

**Tests required**:
- [ ] Time/day edit on item of timed booking 400s; on timeless-booking item succeeds
- [ ] notes/sort_order editable on any kind
- [ ] Day move marks both days' legs dirty
- [ ] Authz: viewer 403; non-member 404

---

#### DELETE /trips/:tripId/itinerary/items/:itemId

Delete an item. For `booking`-kind: unschedule semantics (R-ib-9).
**Auth**: Required — editor/owner.

**Response 204** (`place_visit`/`custom`, and `booking`-kind when parent is
`planned` — parent reverts to `idea` atomically).

**Errors**: 409 CONFLICT (`booking`-kind with `booked` parent — cancel or
demote the booking instead) · 401 · 403 · 404.

**Requirements covered**: R-ib-9, R-ib-19, R-ib-24

**Tests required**:
- [ ] planned-booking item delete reverts status to idea in one transaction
- [ ] booked-booking item delete 409s; custom/place_visit deletes cleanly
- [ ] Legs recomputed for the day
- [ ] Authz: viewer 403; non-member 404

---

#### PUT /trips/:tripId/itinerary/days/:day/order

Atomic day reorder — the drag-drop commit and the re-index path when
midpoint gaps exhaust (schema §3.3.10).
**Auth**: Required — editor/owner.

**Request**: `:day` ISODate; body `{ item_ids: Uuid[] }` — the day's full
intended order. Items currently on other days are pulled to `:day` (a
cross-day drag is one call) **except** `booking`-kind items with
booking-derived days, which are rejected (R-ib-16).

**Response 200**: `{ items: ItineraryItem[] }` — the day's resulting ordered
items (`sort_order = 1024 × position`, R-ib-15). Missing ids ignored (LWW,
R-ib-15); side effect: legs dirty for `:day` and any source days.

**Errors**: 400 VALIDATION_FAILED (id from another trip; derived-day booking
item pulled across days) · 401 · 403 · 404.

**Requirements covered**: R-ib-15, R-ib-16, R-ib-18, R-ib-19, R-ib-24

**Tests required**:
- [ ] Reorder assigns 1024-gapped values; response reflects post-state
- [ ] Cross-day pull works for custom/place_visit/timeless-booking items; rejected for timed-booking items
- [ ] Deleted-elsewhere ids silently ignored; foreign-trip ids 400
- [ ] Concurrent PUTs: last write wins, no partial interleave (transaction)
- [ ] Authz: viewer 403; non-member 404

---

#### POST /trips/:tripId/itinerary/refresh-legs

Explicit leg recompute request (e.g. pull-to-refresh after a long offline
stretch).
**Auth**: Required — member (any role — read-affecting derived data only).

**Response 202**: `{ enqueued: true }` — recompute is asynchronous (R-ib-23);
rate-limited per trip (`RATE_LIMITED` on abuse; window is config).

**Errors**: 401 · 404 · 429 RATE_LIMITED.

**Requirements covered**: R-ib-19, R-ib-23, R-ib-24

**Tests required**:
- [ ] Enqueues exactly one pending recompute per trip (dedup)
- [ ] Rate limit enforced; authz non-member 404

---

### 3.5 Travel-leg computation contract

The `travel_legs` table (schema §3.3.11) is derived data with a single
writer: the leg-computation job. Contract:

1. **Dirty marking** (R-ib-19): every mutation in §3.4 that can change a
   day's located sequence enqueues `{trip_id, day}` markers. The worker
   coalesces markers over a short debounce window (config; single-digit
   seconds) so a drag session costs one recompute, not one per drop.
2. **Pair derivation** (R-ib-20): per dirty day — order items by
   `sort_order`, resolve each item's location (booking place → item place →
   unlocated), filter to located, take consecutive pairs. Same-place pairs
   (identical `place_id`) get a zero-duration/zero-distance leg per mode
   without a provider call.
3. **Provider calls** (R-ib-21): Mapbox Directions per pair per profile
   (`driving`, `walking`, `cycling`); Transitous for `transit`. Store
   `duration_seconds`, `distance_meters`, `provider`
   (`'mapbox'`/`'transitous'`), `computed_at`. Route geometry stays excluded
   (schema §3.3.11 — v1 stores duration/distance only).
4. **Diffing**: recompute only pairs that are new or whose endpoints'
   locations/times changed; upsert on `(from_item_id, to_item_id, mode)`;
   delete rows whose pair is no longer adjacent-located (R-ib-22).
5. **Degradation**: per-pair provider failure ⇒ row absent, retried next
   cycle; Transitous outage ⇒ no transit rows (never surfaced as an error);
   the itinerary read simply returns fewer legs. Offline ETAs come from the
   last precomputed rows (PLANNING: precomputed at sync for offline).
6. **Quota posture**: Mapbox free tier is 100k req/mo (PLANNING provider
   table). Diff-based recompute + debounce + zero-distance shortcut keep
   steady-state cost near zero; the mode set is config (R-ib-21) — the lever
   if quota pressure appears. No new provider, no new spend (Autonomy
   Contract §3 not triggered).
7. **Refresh job** (R-ib-23): recomputes stale legs (TTL config, default
   24 h) for `active` trips and trips starting within 7 days. Day-of,
   traffic-aware cadence belongs to the today bundle — out of scope here.

### 3.6 Multi-day bookings on the calendar (blocked on marker)

The schema marker repeated in §2 governs lodging (and cross-midnight
arrivals). API consequences of each branch, pre-mapped so resolution is a
small diff:

- **Branch A — one spanning item:** lodging auto-item = single row,
  `day = check_in` wall-date, `end_day = check_out` wall-date, times =
  check-in/check-out wall times. `end_day` column stays. Cross-midnight
  flights set `end_day = arrival wall-date`. Legs treat the spanning item as
  located at its single place for both days' chains (it participates in the
  `day` chain by `sort_order`; calendar rendering handles the span).
- **Branch B — two point items:** lodging auto-items = check-in item on
  `check_in` date + check-out item on `check_out` date (the `car_rental`
  §3.3 pattern generalizes); `end_day` is dropped from the schema (its own
  migration note there). Cross-midnight flights stay one item on the
  departure date; the client renders a "+1" day affordance.

Everything else in this spec is branch-independent. Implementation of
lodging auto-items and `end_day` handling MUST NOT start until the marker
resolves.

### 3.7 Shared schema additions (`@gogo/shared`)

Flag for contracts-spec sync (its §3.1 inventory grows; conventions
unchanged):

- `domains/booking.ts` adds `BookingCreate`, `BookingUpdate`,
  `BookingWithItems`, `ScheduleBookingInput` + this router's
  `EndpointDescriptor`s (contracts §3.6 pattern).
- `domains/itinerary.ts` adds `ItineraryItemCreate`, `ItineraryItemUpdate`,
  `DayOrderInput`, `ItineraryRead` (`{ items, legs }`) + descriptors, and
  the pure time-derivation helpers of §3.3 (used by server writes and client
  optimistic updates alike).
- `scalars.ts` adds `ISOTime` (`HH:MM`, 24-hour) — `time` columns cross the
  wire as strings; contracts spec §3.3 currently lacks a time-of-day scalar.

### 3.8 Out of scope (explicit)

- **Capture pipeline endpoints** (webhook, review queue, landing) — capture
  spec; its landing flow calls this spec's booking service (§3.1) so
  invariants hold for `email`/`share` sources.
- **Deeplink-out URL construction** — pure client concern;
  `.specs/client/itinerary.spec.md` §2.7.
- **Expenses spawned from bookings** (`bookings ||--o{ expenses` in the ERD)
  — money spec; `expenses.booking_id` is its seam.
- **Today view / leave-by / flight-status alerts** — today bundle (separate
  spec; competitors research call #4 keeps plan mode and today mode
  distinct).
- **Viator / Ticketmaster in-app discovery APIs** — activities/AI bundle;
  when it lands, results create bookings through `POST …/bookings`.
- **Offline mutation queue + replay semantics** — offline/sync spec
  (contracts §3.8 already assigns it); these endpoints' LWW semantics
  (R-ib-18) are its foundation.
- **Push-notification invalidation fan-out** — notifications spec.
- **Weather on itinerary days** — weather bundle.

---

## 4. Tasks

Sized one agent session each; queued as `T-N.M` rows at build time.
**Depends on:** DB-1 (schema + migration) and SH-1 (shared contracts) landed.

### IB-1 — Booking domain service + bookings router

**Covers:** R-ib-1..R-ib-12, R-ib-18, R-ib-24 (+ §3.1 invariants I-1..I-4).

- [ ] Booking service enforcing §3.1/§3.2 transactionally (single write path)
- [ ] §3.3 derivation helpers in `@gogo/shared` + unit tests
- [ ] Routes: bookings CRUD + schedule (§3.4) with zod-validator + envelope
- [ ] Tests: every endpoint's checklist above, plus §3.2 transition matrix

### IB-2 — Itinerary router (items, reorder, composite read)

**Covers:** R-ib-13..R-ib-18, R-ib-24.

- [ ] Composite itinerary read (items + legs, range logic incl. date-less)
- [ ] Item create/patch/delete with kind checks + booking-item protection
- [ ] Day-order PUT (atomic reassign, LWW tolerance, cross-day pull rules)
- [ ] Tests: every endpoint's checklist above

### IB-3 — Travel-leg computation job + refresh

**Covers:** R-ib-19..R-ib-23 (+ I-5).

- [ ] Dirty-day queue + debounced worker (§3.5 steps 1–5); only-writer rule
- [ ] Mapbox Directions + Transitous adapters (server-side; keys server-only)
- [ ] Staleness refresh job + `refresh-legs` endpoint with rate limit
- [ ] Tests: adjacency/diff/cleanup matrix; transit-degradation returns
      absent rows; mutation latency unaffected by provider outage (R-ib-19)

---

*Trace: every R-ib-N cites its enforcing section/endpoint inline. Markers:
two, both repeated verbatim from the canonical schema spec (§2) — they
resolve there and unblock §3.3/§3.6 here. Zero native markers.*
