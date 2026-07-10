# API — Trips, Members, Invites, Collab — `.specs/api/trips.spec.md`

> **Task:** T-2.3 (TRIPS + MEMBERS + INVITES + COLLAB bundle) · **Status:**
> DRAFT — pending Sean approval. Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain (this spec's own AND the repeated
> upstream markers it depends on).
>
> **Sources:** `docs/PLANNING.md § Architecture` (collab sync v1: REST +
> optimistic + refetch-on-focus + push invalidation, NO sockets),
> `.specs/database/schema.spec.md` (CANONICAL — §3.3.4–§3.3.6 tables,
> R-db-8/9/16), `.specs/shared/contracts.spec.md` (CANONICAL — envelope,
> ErrorCode, descriptors, `domains/trip.ts` + `domains/member.ts`),
> `.specs/client/navigation.spec.md` (invite deep links, R-nav-11..16),
> ADR-005 (collab free forever), `.specs/research/competitors.md` (call #2:
> collaboration free forever — Wanderlog benchmark).
>
> **This spec owns the permission matrix (§3.2) — the authz source of truth
> for ALL domains.** Other API specs cite §3.2 rows; they do not redefine
> role rules.

---

## 1. Scope & conventions

Server-side contract for trip CRUD, trip membership (roles), invites, and
the collab-consistency rules every trip-scoped domain inherits. Routes live
in the `trips` + `members/invites` Hono routers (PLANNING § Component map).

Conventions inherited from `.specs/shared/contracts.spec.md` (not restated
per endpoint):

- **Auth:** every endpoint requires a valid access token (`UNAUTHENTICATED`
  401 otherwise). No endpoint in this spec is public.
- **Validation:** every body/param/query is validated by a `@gogo/shared`
  schema via `@hono/zod-validator` before handler logic (R-shared-3);
  failures → `VALIDATION_FAILED` 400.
- **Envelope:** success = documented schema directly, lists =
  `Paginated<T>`; errors = `ApiError` with `ErrorCode` (contracts §3.5).
- **Wire casing:** `snake_case`, mirroring DB columns (contracts §3.1).
- **Membership gate:** non-members of `:tripId` get `NOT_FOUND` — never
  `FORBIDDEN` — so resource existence is not revealed (IDOR posture,
  PLANNING § Security; mirror of R-nav-15). Members whose *role* lacks a
  capability get `FORBIDDEN`.

Out of scope (explicit): auth/session endpoints (auth spec); itinerary,
bookings, places, money, photos, packing, documents, capture, AI endpoints
(their own specs — they **cite §3.2** for authz); push transport + payload
schemas (notifications spec — this spec fixes only the domain event list,
§3.5); offline caching behavior (offline spec).

---

## 2. Requirements (EARS)

### Authz & trip CRUD

- **R-trips-1 (membership gate):** WHEN any `/trips/:tripId/*` endpoint
  executes THE SYSTEM SHALL resolve the caller's `trip_members` row before
  any handler logic; WHEN no row exists THE SYSTEM SHALL respond
  `NOT_FOUND`, indistinguishable from an absent trip.
- **R-trips-2 (matrix is law):** WHEN a member attempts an action their
  role does not permit per §3.2 THE SYSTEM SHALL respond `FORBIDDEN` and
  write nothing. The §3.2 matrix is the single authz source of truth for
  every trip-scoped domain.
- **R-trips-3 (create):** WHEN a trip is created THE SYSTEM SHALL insert
  the `trips` row and the creator's `trip_members` row with role `owner`
  in a single transaction (satisfies R-db-8's at-least-one-owner from birth).
- **R-trips-4 (list scope):** WHEN the trip list is requested THE SYSTEM
  SHALL return only trips where the caller holds a membership row, each
  item carrying the caller's `role`.
- **R-trips-5 (LWW):** WHEN a trip update succeeds THE SYSTEM SHALL apply
  last-write-wins at row grain (no field merging), bump `updated_at`, and
  return the full updated row.
- **R-trips-6 (conflict detection):** WHEN an update carries
  `expect_updated_at` and it differs from the row's current `updated_at`
  THE SYSTEM SHALL respond `CONFLICT` and write nothing.
- **R-trips-7 (status derivation) [PROVISIONAL]:** WHEN the §3.4 derived-
  status rule yields a status different from the stored `trips.status` THE
  SYSTEM SHALL reconcile them via the mechanism pinned by the schema spec's
  status marker (repeated in §3.4) — daily job, on-read, and/or manual
  override are the candidate mechanisms; this requirement finalizes with
  that marker.
- **R-trips-8 (delete):** WHEN a trip is deleted THE SYSTEM SHALL require
  role `owner`, cascade per schema spec §3.6, and emit `trip.deleted`
  (§3.5) to all other members captured before the delete.

### Members & ownership

- **R-trips-9 (one-owner invariant):** WHEN any membership write executes
  THE SYSTEM SHALL preserve exactly one owner per trip: at-most-one via the
  schema's partial unique index (R-db-8), at-least-one server-side. The
  role-change endpoint SHALL NOT grant or revoke `owner` — ownership moves
  only through the transfer endpoint.
- **R-trips-10 (ownership transfer) [PROVISIONAL]:** WHEN ownership is
  transferred THE SYSTEM SHALL demote the current owner to `editor` and
  promote the (already-member) target to `owner` in a single transaction,
  then emit `ownership.transferred`. Allowed flows pend the schema marker
  repeated in §3.3.4.
- **R-trips-11 (removal & leave):** WHEN a member is removed THE SYSTEM
  SHALL require the caller be the owner (removing a non-owner member) or
  the member themself (leave); WHEN the owner attempts to leave while other
  members exist THE SYSTEM SHALL reject with `CONFLICT` (transfer first —
  pends the §3.3.4 marker). A removed member loses access on their next
  request (per-request gate, R-trips-1) and receives the eviction push
  (§3.5).
- **R-trips-12 (financial history survives):** WHEN a member is removed or
  leaves THE SYSTEM SHALL NOT delete or reassign their expenses, expense
  shares, or settlements (R-db-16); attribution-only references detach per
  schema spec §3.6 alone. Balances involving the departed member remain
  computable and visible to remaining members.

### Invites

- **R-trips-13 (invite creation):** WHEN an invite is created THE SYSTEM
  SHALL require a §3.2-permitted role, accept only `role ∈ {editor,
  viewer}` no higher than the creator's own role, and generate a unique
  URL-safe token with ≥ 128 bits of entropy (R-db-9).
- **R-trips-14 (acceptance transaction):** WHEN an invite is accepted THE
  SYSTEM SHALL, in one transaction: validate the token is unexpired,
  unrevoked, and under `max_uses`; upsert the `trip_members` row; increment
  `use_count` (schema spec §3.3.6). WHEN concurrent acceptances race THE
  SYSTEM SHALL never allow `use_count` to exceed `max_uses`.
- **R-trips-15 (idempotent accept):** WHEN an existing member accepts an
  invite to the same trip THE SYSTEM SHALL return their current membership
  unchanged — no role change, no `use_count` increment.
- **R-trips-16 (dead invites):** WHEN acceptance or preview is attempted
  with an unknown token THE SYSTEM SHALL respond `NOT_FOUND`; WHEN the
  token is expired, revoked, or at `max_uses` THE SYSTEM SHALL respond
  `CONFLICT` with `details.reason ∈ {'expired','revoked',
  'max_uses_reached'}` (the client renders distinct error states,
  R-nav-11).
- **R-trips-17 (revocation):** WHEN an invite is revoked THE SYSTEM SHALL
  set `revoked_at` (rows are never deleted as a revocation path) and emit
  `invite.revoked`; owners may revoke any invite, editors only their own.

### Collab consistency

- **R-trips-18 (push invalidation):** WHEN any mutation in this domain
  commits THE SYSTEM SHALL emit its §3.5 event to all current members'
  devices except the actor's (plus the removed member's on removal);
  payloads SHALL carry ids and event names only — never entity content or
  PII.
- **R-trips-19 (mutations return rows):** WHEN any mutation succeeds THE
  SYSTEM SHALL return the full resulting row(s) (or 204 for deletes) so
  optimistic clients reconcile without an extra fetch.

### Trip settings

- **R-trips-20 (settings authz):** WHEN trip settings are changed THE
  SYSTEM SHALL enforce §3.2 per field: `name`/`destination_*`/`start_date`/
  `end_date`/`theme` require editor+; `base_currency` requires owner
  (change semantics marker, §3.6); `status` requires owner
  [PROVISIONAL, §3.4].

---

## 3. Design

### 3.1 Role semantics

Three roles (`trip_member_role`, schema spec §3.2 — locked):

| Role | One-line semantics |
|---|---|
| `owner` | Full control: everything an editor can, plus membership management, ownership transfer, destructive ops (delete trip), and owner-only settings. Exactly one per trip (R-db-8). |
| `editor` | Edits trip **content** (itinerary, bookings, places, budgets, shared packing) and can invite; cannot manage membership or destroy the trip. |
| `viewer` | Reads the plan. Participates **personally** where participation isn't plan-editing (settling their own debts; provisionally logging expenses and uploading photos — see P¹ marker below). |

### 3.2 Permission matrix — THE authz source of truth

Legend: ✓ allowed · ✗ denied · **own** = only rows they created/own ·
**self** = only when they are the acting party · **P¹** = provisional,
pending the viewer-participation marker below. Domain specs cite rows as
`trips.spec §3.2 "<capability>"`.

| Capability | owner | editor | viewer | Notes / canonical cites |
|---|---|---|---|---|
| **Trips** | | | | |
| View trip detail (all tabs) | ✓ | ✓ | ✓ | R-trips-1 gate first |
| Edit name / destination / dates | ✓ | ✓ | ✗ | R-trips-20 |
| Change trip theme | ✓ | ✓ | ✗ | Theme is trip-level display, content-adjacent |
| Change base currency | ✓ | ✗ | ✗ | Financial semantics; change-semantics marker §3.6 |
| Manual status override ("archive") | ✓ | ✗ | ✗ | PROVISIONAL — §3.4 marker |
| Delete trip | ✓ | ✗ | ✗ | Cascade per schema §3.6; R-trips-8 |
| Download offline pack | ✓ | ✓ | ✓ | Free forever (ADR-005) |
| **Members & invites** | | | | |
| View member list + roles (incl. payment handles per contracts §3.4 `UserProfile`) | ✓ | ✓ | ✓ | Handles are deliberately member-visible (settle-up) |
| Create invite (grantable role ≤ own, never `owner`) | ✓ | ✓ | ✗ | R-trips-13; schema `CHECK (role <> 'owner')` |
| View active invites | ✓ | ✓ | ✗ | |
| Revoke invite | ✓ any | ✓ own | ✗ | R-trips-17 |
| Change member role (editor ↔ viewer) | ✓ | ✗ | ✗ | Never grants/revokes `owner` (R-trips-9) |
| Remove member (non-owner) | ✓ | ✗ | ✗ | R-trips-11 |
| Leave trip | ✗* | self | self | *owner transfers first — §3.3.4 marker |
| Transfer ownership | ✓ | ✗ | ✗ | R-trips-10, PROVISIONAL |
| **Itinerary** (cited by itinerary spec) | | | | |
| View itinerary / calendar | ✓ | ✓ | ✓ | |
| Create / edit / delete / reorder items | ✓ | ✓ | ✗ | |
| **Bookings** (cited by bookings spec) | | | | |
| View bookings incl. `confirmation_code` | ✓ | ✓ | ✓ | Trip membership is the trust boundary; PNR visibility flagged for the threat model |
| Create / edit / delete bookings | ✓ | ✓ | ✗ | |
| Land a capture into this trip | ✓ | ✓ | ✗ | Creates a booking (capture spec) |
| **Places** (cited by maps/places spec) | | | | |
| View saved places | ✓ | ✓ | ✓ | |
| Save / unsave / edit note; create custom place | ✓ | ✓ | ✗ | |
| **Money** (cited by money spec) | | | | |
| View budgets / expenses / balances | ✓ | ✓ | ✓ | |
| Set / edit budget caps | ✓ | ✓ | ✗ | |
| Run AI expense estimate | ✓ | ✓ | ✗ | Debits the **caller's** AI cap (ADR-005) |
| Log an expense; edit/delete own-logged | ✓ | ✓ | P¹ | Payer may be any member |
| Edit / delete any expense | ✓ | ✗ | ✗ | Owner as dispute-breaker; audit-trail question is the schema §3.3.12 deletion marker (money spec inherits) |
| Record settlement (self as from/to party) | self | self | self | Either party may record (schema §3.3.14); viewers owe money regardless of P¹ |
| Send settle-up request link | self | self | self | Money spec owns the payload |
| **Photos** (cited by photos spec) | | | | |
| View trip photos (visibility-filtered — Law #3, `canViewPhoto`) | ✓ | ✓ | ✓ | contracts §3.4 `photo.ts` |
| Upload photos | ✓ | ✓ | P¹ | |
| Set visibility / delete — own photo | own | own | own | Uploader controls their photo at any role |
| Delete any photo (moderation) | ✓ | ✗ | ✗ | |
| **Packing** (cited by packing/utilities spec) | | | | |
| View lists | ✓ | ✓ | ✓ | |
| Edit shared trip list | ✓ | ✓ | ✗ | Shared-vs-personal model pends schema §3.3.21 marker |
| Edit own personal list | own | own | own | |
| **Documents** | | | | |
| Vault access | own | own | own | Role-irrelevant; trip association grants ZERO visibility (R-db-18, Law #3) |
| **Capture inbox** | | | | |
| View / manage own captures | own | own | own | User-scoped, not trip-scoped; landing gated by the bookings row above |
| **AI** (cited by AI spec) | | | | |
| Read pre-generated content (tour bundles, recs, estimates) | ✓ | ✓ | ✓ | |
| Trigger trip-scoped generation/regeneration | ✓ | ✓ | ✗ | Debits caller's cap |

- [NEEDS CLARIFICATION: viewer participation boundary (the P¹ cells) — can
  a `viewer` log expenses and upload photos? Recommended YES: "viewer"
  should mean plan-read-only, not excluded-from-the-group — a viewer friend
  still pays for dinner and takes photos; excluding them forces everyone to
  be an editor and guts the role. But it is user-visible authz policy, so
  it needs Sean's call. Resolving this marker flips P¹ cells to ✓ or ✗ and
  the money + photos specs inherit the answer.]

Enforcement shape: one middleware resolves `(trip_id, caller)` →
membership + role once per request (R-trips-1), handlers assert §3.2
capabilities (R-trips-2). UI hiding/disabling of affordances is convenience
only — the server matrix is the enforcement.

### 3.3 Endpoints

All paths are also `EndpointDescriptor`s exported from
`@gogo/shared/domains/{trip,member}` (contracts §3.6). New wire shapes this
spec adds to those modules: `TripListItem`, `TripUpdate.expect_updated_at`,
`InvitePreview`, `OwnershipTransfer` — companion-spec additions, no drift.

---

#### POST /trips

Create a trip; creator becomes owner in the same transaction. **Auth**: Required

**Request** — `TripCreate`:
`{ name, destination_name, destination_lat?, destination_lng?, start_date?,
end_date?, base_currency?, theme? }`
(`base_currency` defaults to `'USD'` per schema §3.3.4; client pre-fills
from `UserPrefs.home_currency` — client spec. Dates/destination
structure pend the §3.3.4-repeated markers in §3.6.)

**Response 201** — `Trip & { role: 'owner' }`

**Errors**: 400 `VALIDATION_FAILED` — bad shapes, `start_date > end_date`.

**Requirements covered**: R-trips-3

**Tests required**:
- [ ] Happy path: trip + owner membership row exist after one call; role returned
- [ ] Transactionality: forced membership-insert failure rolls back the trip row
- [ ] `start_date > end_date` rejected
- [ ] Unauthenticated → 401

---

#### GET /trips

List the caller's trips. **Auth**: Required

**Request** — query: `{ cursor?, limit? }`

**Response 200** — `Paginated<TripListItem>` where
`TripListItem = Trip & { role: trip_member_role, member_count: int }`

**Errors**: —

**Requirements covered**: R-trips-4

**Tests required**:
- [ ] Returns only trips with caller membership; correct `role` per trip
- [ ] Excludes trips the caller was removed from
- [ ] Pagination cursor round-trip

---

#### GET /trips/:tripId

Trip detail. **Auth**: Required (member)

**Response 200** — `Trip & { role: trip_member_role }`

**Errors**: 404 `NOT_FOUND` — absent trip OR non-member (indistinguishable).

**Requirements covered**: R-trips-1

**Tests required**:
- [ ] Member gets trip + own role
- [ ] Non-member and nonexistent id both → identical 404 body
- [ ] Authz (wrong user / wrong trip)

---

#### PATCH /trips/:tripId

Update trip fields (partial). **Auth**: Required (per-field per §3.2)

**Request** — `TripUpdate`:
`{ name?, destination_name?, destination_lat?, destination_lng?,
start_date?, end_date?, theme?, base_currency?, status?,
expect_updated_at? }`
— `base_currency` owner-only (§3.6 marker); `status` owner-only
PROVISIONAL (§3.4 marker); `expect_updated_at` is the optional §3.7
conflict precondition.

**Response 200** — full updated `Trip` (R-trips-19)

**Errors**: 404 non-member; 403 `FORBIDDEN` — role lacks a touched field;
409 `CONFLICT` — `expect_updated_at` mismatch; 400 date-order violation.

**Requirements covered**: R-trips-5, R-trips-6, R-trips-20

**Tests required**:
- [ ] Editor updates name/dates/theme; viewer → 403
- [ ] Editor touching `base_currency` → 403; owner succeeds
- [ ] Stale `expect_updated_at` → 409, row unchanged
- [ ] Omitted `expect_updated_at` → plain LWW applies
- [ ] `updated_at` bumped; full row returned
- [ ] Push event `trip.updated` emitted to other members, not actor

---

#### DELETE /trips/:tripId

Delete a trip and its world. **Auth**: Required (owner)

**Response 204**

**Errors**: 404 non-member; 403 non-owner member.

**Requirements covered**: R-trips-8

**Tests required**:
- [ ] Owner deletes; children cascade per schema §3.6 (spot-check members, invites, bookings)
- [ ] Editor/viewer → 403
- [ ] `trip.deleted` pushed to the pre-delete member set minus actor

---

#### GET /trips/:tripId/members

Member list. **Auth**: Required (member)

**Response 200** — `{ items: Array<{ user: UserProfile, role:
trip_member_role, joined_at }> }` — `UserProfile` per contracts §3.4
(display name, avatar, payment handles; handles member-visible by design).

**Errors**: 404 non-member.

**Requirements covered**: R-trips-1

**Tests required**:
- [ ] All members with roles returned; payment handles present
- [ ] Non-member → 404

---

#### PATCH /trips/:tripId/members/:userId

Change a member's role (editor ↔ viewer only). **Auth**: Required (owner)

**Request** — `{ role: 'editor' | 'viewer' }`

**Response 200** — updated member row

**Errors**: 404 non-member caller or target not a member; 403 non-owner;
400 `role` = `'owner'` (schema-invalid; transfer endpoint owns ownership);
400 target is the owner.

**Requirements covered**: R-trips-9

**Tests required**:
- [ ] Owner flips editor↔viewer; `member.role_changed` pushed (incl. to the target)
- [ ] `role: 'owner'` rejected; targeting the owner rejected
- [ ] Editor/viewer caller → 403

---

#### DELETE /trips/:tripId/members/:userId

Remove a member, or leave (self-target). **Auth**: Required (owner for
others; any member for self)

**Response 204**

**Errors**: 404 non-member caller / unknown target; 403 non-owner removing
someone else; 409 `CONFLICT` — owner self-removal while other members
exist (transfer first; sole-member owner path pends the §3.3.4 marker —
PROVISIONAL: sole owner leaving is equivalent to trip deletion and is
rejected in favor of explicit DELETE /trips/:tripId).

**Requirements covered**: R-trips-11, R-trips-12

**Tests required**:
- [ ] Owner removes editor; editor leaves self; viewer leaves self
- [ ] Editor removing another member → 403
- [ ] Owner leave with members present → 409
- [ ] Removed member's expenses/shares/settlements untouched (R-trips-12); `saved_places.created_by` etc. detach per schema §3.6
- [ ] Removed member's next request to the trip → 404
- [ ] `member.removed` pushed to remaining members AND the removed user; `member.left` on self-leave

---

#### POST /trips/:tripId/transfer-ownership

Hand ownership to another member. **Auth**: Required (owner) —
**PROVISIONAL pending the §3.3.4 ownership marker.**

**Request** — `{ to_user_id: Uuid }`

**Response 200** — `{ items: [updated member rows (both)] }`

**Errors**: 404 non-member caller / target not a member; 403 non-owner;
400 self-transfer.

**Requirements covered**: R-trips-9, R-trips-10

**Tests required**:
- [ ] Single transaction: old owner → editor, target → owner; partial-unique owner index never violated mid-flight
- [ ] Target not a member → 404; self-transfer → 400; non-owner → 403
- [ ] `ownership.transferred` pushed

---

#### POST /trips/:tripId/invites

Create an invite link. **Auth**: Required (owner/editor per §3.2)

**Request** — `InviteCreate`: `{ role: 'editor' | 'viewer', expires_at?,
max_uses? }` — defaults for `expires_at`/`max_uses` pend the §3.6-repeated
invite marker.

**Response 201** — `Invite & { url: string }` — `url` =
`https://<domain>/invite/<token>` per the nav deep-link registry; domain
pends the nav marker repeated in §3.6. Token: ≥128-bit entropy, URL-safe,
unique (R-db-9).

**Errors**: 404 non-member; 403 viewer; 403 editor granting above own role
(cannot occur with the current two grantable roles — guard exists for enum
growth); 400 `role: 'owner'`.

**Requirements covered**: R-trips-13

**Tests required**:
- [ ] Owner + editor create; viewer → 403
- [ ] `role: 'owner'` → 400
- [ ] Token uniqueness + entropy source asserted; URL format matches registry
- [ ] `invite.created` pushed

---

#### GET /trips/:tripId/invites

List invites (active and dead, flagged). **Auth**: Required (owner/editor)

**Response 200** — `Paginated<Invite & { state: 'active' | 'expired' |
'revoked' | 'max_uses_reached' }>`

**Errors**: 404 non-member; 403 viewer.

**Requirements covered**: R-trips-13, R-trips-17

**Tests required**:
- [ ] States computed correctly from `expires_at`/`revoked_at`/`use_count`
- [ ] Viewer → 403

---

#### DELETE /trips/:tripId/invites/:inviteId

Revoke an invite (sets `revoked_at`; row persists). **Auth**: Required
(owner: any; editor: own)

**Response 204**

**Errors**: 404 non-member / unknown invite; 403 editor revoking another's
invite; 409 already revoked.

**Requirements covered**: R-trips-17

**Tests required**:
- [ ] Owner revokes any; editor revokes own; editor revoking other's → 403
- [ ] Acceptance after revocation → 409 (see accept endpoint)
- [ ] `invite.revoked` pushed

---

#### GET /invites/:token

Invite preview for the join screen (trip name, destination, dates, inviter,
granted role, state). Token is the capability — any authenticated holder
may preview. **Auth**: Required (deep link stashes + resumes when
unauthenticated, R-nav-14)

**Response 200** — `InvitePreview`: `{ trip: { name, destination_name,
start_date?, end_date? }, inviter: { display_name, avatar_key? }, role,
state: 'active' | 'expired' | 'revoked' | 'max_uses_reached',
already_member: boolean }` — deliberately excludes `trip_id`, member list,
and all trip content until acceptance.

**Errors**: 404 unknown token; 429 `RATE_LIMITED` — token-guessing guard
(entropy already makes brute force infeasible; rate limit is
defense-in-depth for the threat model).

**Requirements covered**: R-trips-16

**Tests required**:
- [ ] Active/expired/revoked/maxed states rendered in `state`, 200 each
- [ ] Unknown token → 404
- [ ] No trip id / content beyond the preview fields in the payload
- [ ] `already_member` true for existing members

---

#### POST /invites/:token/accept

Accept an invite; become a member. **Auth**: Required

**Response 200** — `{ trip_id, role, joined_at, already_member: boolean }`
(the client navigates to `/[tripId]` with default-tab rules — R-nav-12).

**Errors**: 404 unknown token; 409 `CONFLICT` + `details.reason ∈
{'expired','revoked','max_uses_reached'}`.

**Requirements covered**: R-trips-14, R-trips-15, R-trips-16

**Tests required**:
- [ ] Happy path: membership row upserted at invite's role; `use_count` incremented; `member.added` pushed
- [ ] Transactionality: all-or-nothing (validate → upsert → increment)
- [ ] Already-member accept: 200, role unchanged (even if invite role is higher), `use_count` NOT incremented, `already_member: true`
- [ ] Expired / revoked / maxed → 409 with correct `details.reason`
- [ ] Concurrency: two racing accepts on `max_uses: 1` → exactly one member added, `use_count = 1`, loser gets 409
- [ ] Unknown token → 404

---

### 3.4 Status transitions & "archive"

Derived-status rule (single definition; `@gogo/shared` helper so server and
client cannot drift — same seam pattern as `canViewPhoto`):

```
derived_status(today, start_date, end_date) =
  start_date or end_date missing        → 'planning'
  today <  start_date                   → 'planning'
  start_date ≤ today ≤ end_date         → 'active'
  today >  end_date                     → 'past'
```

Timezone note: the nav spec evaluates active-ness client-side in the
user's tz (nav §2.5); the server MUST use the same `@gogo/shared` helper
with an explicit `today` input so the two surfaces agree on the boundary
day.

**The storage/override mechanism is unresolved.** Repeating the canonical
marker verbatim (schema spec §3.3.4, `trips.status` row):

[NEEDS CLARIFICATION: `status` transitions — PLANNING implies automatic
(`today` view "auto-default while trip active"). Is status purely derived
from dates by a daily job/on-read (planning→active on start_date,
active→past after end_date), or can users manually override (e.g. mark a
trip past early)? Manual override is user-visible.]

Bundle-scope note: T-2.3 names an "archive" operation. `trip_status` is
locked at `planning / active / past` (schema §3.2; enum values append-only)
— there is no `archived` value. **"Archive" in this spec = the manual
override to `'past'`** (owner-only per §3.2), which exists iff the marker
above resolves to allow manual overrides. If the marker resolves to
derived-only, archive-as-an-action is dropped and `PATCH /trips/:tripId`
rejects `status` outright.

### 3.5 Collab consistency rules (inherited by every trip-scoped domain)

Collab sync v1 per PLANNING § Cross-cutting: REST + optimistic updates +
refetch-on-focus + push invalidation. **No sockets; no event-log tables**
(the event-log seam stays an additive later migration, schema §3.7).

1. **Last-write-wins, row grain.** Concurrent mutations to the same row:
   the later commit wins wholesale. The server never field-merges. Fine
   for small groups (PLANNING); the visible-cost cases get rule 2.
2. **`updated_at` conflict detection — where it matters.** Any PATCH on a
   mutable row MAY carry `expect_updated_at` (`ISODateTime`); mismatch →
   `CONFLICT`, no write (R-trips-6). Required usage (this domain): the trip
   settings form (multi-field, slow-editing, two-editor collisions are
   real). Not used: role changes and removals (owner-only single actor);
   invite mutations (create/revoke are not edits). Other domain specs
   declare their own "required here" lists citing this rule.
3. **Deletes converge.** DELETE of an already-deleted row → `NOT_FOUND`;
   clients treat post-DELETE `NOT_FOUND` as success-equivalent and
   invalidate.
4. **Mutations return rows** (R-trips-19) — optimistic clients reconcile
   from the response, not a follow-up GET.
5. **Refetch-on-focus** is the client-side safety net (client spec
   `.specs/client/trips.spec.md` R-tripui-3); server-side requirement:
   list/detail endpoints are cheap enough to refetch freely (indexes per
   schema §3.5 — `trip_members(user_id)` is the root query).
6. **Push invalidation events** — emitted post-commit to all current
   members' Expo push tokens except the actor's (removed member included
   on removal so their device evicts). Silent/data-only; payload
   `{ event, trip_id, entity_id? }` — ids only, no content, no PII
   (R-trips-18). Transport + payload schema: notifications spec. Event
   names are `<entity>.<verb>`, the naming pattern all domains follow.

| Event | Emitted when | `entity_id` |
|---|---|---|
| `trip.updated` | PATCH /trips/:tripId succeeds (any field incl. theme/currency) | — |
| `trip.status_changed` | Stored status changes (derived reconciliation or manual override — §3.4) | — |
| `trip.deleted` | DELETE /trips/:tripId | — |
| `member.added` | Invite accepted | new member's `user_id` |
| `member.role_changed` | Role PATCH | target `user_id` |
| `member.removed` | Owner removes a member | removed `user_id` |
| `member.left` | Self-removal | departed `user_id` |
| `ownership.transferred` | Transfer endpoint | new owner's `user_id` |
| `invite.created` | Invite created | `invite_id` |
| `invite.revoked` | Invite revoked | `invite_id` |

### 3.6 Trip settings

Settings surface (client: trip-settings screen) maps to `PATCH
/trips/:tripId` fields. Authz per §3.2 / R-trips-20.

- **Theme** — `trips.theme`: key into `packages/tokens` themes; null = app
  default (schema §3.3.4). Owner + editor. Emits `trip.updated`.
- **Base currency** — `trips.base_currency`: owner-only.
  [NEEDS CLARIFICATION: base-currency change semantics once money exists —
  changing `base_currency` after expenses/budgets are written invalidates
  `expenses.base_amount_cents` conversions and the `budgets.currency ==
  trips.base_currency` invariant (schema §3.3.12/§3.3.15). Options:
  (a) freeze base currency once the first expense or budget row exists
  (simplest, recommended); (b) allow change + recompute all conversions
  (needs an FX source — compounds the schema §3.3.12 FX marker); (c) allow
  change, keep historical rows in old base (balances become mixed —
  probably unacceptable). User-visible money behavior → Sean's call; the
  money spec inherits the answer.]
- **Visibility** — [NEEDS CLARIFICATION: T-2.3 bundle scope names a trip
  "visibility" setting, but the canonical schema has NO `trips.visibility`
  column (schema §3.3.4) and PLANNING's data model defines visibility only
  for photos (`private/trip/public`, Law #3). Is trip-level visibility a
  real v1 concept (e.g. public read-only trip pages)? If yes, that is an
  entity-model addition requiring a schema-spec change + Sean's nod
  (Autonomy Contract §6 scope change). If "visibility" meant photo
  visibility, it is already owned by the photos domain and this row is
  dropped. This spec assumes NO trip-level visibility until resolved.]
- **Dates / destination / name** — editor+; same fields as create; date
  and destination markers repeated below.

Upstream markers this section depends on (verbatim, from schema spec
§3.3.4 and §3.3.6):

[NEEDS CLARIFICATION: are trip dates required at creation, or are date-less
trips allowed (dates added later)? Columns are nullable to keep both
options open; the create-trip UX decides.]

[NEEDS CLARIFICATION: destination input — picked from place/geocoder search
(structured; lat/lng always present) or free text (lat/lng optional)?
Affects nullability of `destination_lat/lng` and whether weather/AI
grounding can be guaranteed for every trip.]

[NEEDS CLARIFICATION: ownership transfer — can an owner hand off ownership
(owner demotes self + promotes another in one transaction), and can an
owner leave a trip that still has members? Schema supports transfer as-is;
the allowed flows are user-visible.]

[NEEDS CLARIFICATION: invite links — single-use per invitee or shareable
multi-use group links (Splitwise-style "anyone with the link joins")? Both
are supported by `max_uses`; which is the product default, and is there a
default expiry (e.g. 7 days)?]

And from the navigation spec (§1 Open questions) — the invite `url` field
depends on it:

[NEEDS CLARIFICATION: Universal-link domain — what domain do we own for
`https://` links (gogo.travel? gogotravel.app?)? Needed for AASA /
assetlinks and the link formats below. Custom scheme `gogo://` is assumed
as the fallback either way.]

### 3.7 Out of scope (explicit)

- Auth/session issuance + refresh (auth spec).
- Push transport, Expo receipt handling, notification payload Zod schema
  (notifications spec — consumes §3.5's event list).
- Itinerary/bookings/places/money/photos/packing/capture/AI endpoint
  definitions (their specs; they cite §3.2).
- Offline bundle contents + mutation-queue envelope (offline spec; note:
  invites and membership writes are online-only — no queued membership
  mutations in v1).
- Account deletion interplay with membership (schema R-db-16 marker owns
  it; member *removal* here never deletes user rows).
- Trip-level visibility (pends §3.6 marker — assumed nonexistent).

---

## 4. Tasks

Each sized to one agent session; queue as `T-N.M` rows at build time.
Depends on: SH-1 (shared contracts) + DB-1 (schema) landed.

### API-TRIPS-1 — Trip CRUD + settings + status seam

**Covers:** R-trips-1..8, R-trips-19, R-trips-20

- [ ] `trips` Hono router: POST/GET/GET:id/PATCH/DELETE per §3.3
- [ ] Membership-gate middleware (resolve role once; 404-for-non-member)
- [ ] `expect_updated_at` precondition helper (reusable across domains)
- [ ] `derived_status` helper in `@gogo/shared` + reconciliation seam
      (mechanism pends §3.4 marker — build the helper, stub the trigger)
- [ ] Tests: every endpoint's "Tests required" block above

### API-TRIPS-2 — Members: roles, removal, leave, ownership transfer

**Covers:** R-trips-9..12

- [ ] Members router: GET/PATCH/DELETE + transfer-ownership per §3.3
- [ ] One-owner invariant assertions (server-side at-least-one; DB
      partial-unique at-most-one)
- [ ] Tests: per-endpoint blocks incl. transaction + financial-history
      preservation (R-trips-12)

### API-TRIPS-3 — Invites lifecycle

**Covers:** R-trips-13..17

- [ ] Invites router: create/list/revoke + token preview/accept per §3.3
- [ ] Token generation (≥128-bit, URL-safe) + rate limit on `/invites/:token*`
- [ ] Acceptance transaction with race-safety (row lock or equivalent —
      invariant is the spec, mechanism is the implementer's)
- [ ] Tests: per-endpoint blocks incl. the max_uses race

### API-TRIPS-4 — Push-invalidation emitter (domain event seam)

**Covers:** R-trips-18

- [ ] Post-commit event emitter: §3.5 event list, member fan-out via
      `push_tokens`, actor exclusion, removed-member inclusion
- [ ] Payload = ids only (no content/PII) — asserted in tests
- [ ] Seam consumed by notifications spec's transport; other domains
      register their own events through the same emitter

---

*Trace: every R-trips-N cites its endpoint/section inline. Markers: 3 new
(§3.2 viewer participation; §3.6 base-currency change; §3.6 trip
visibility), 6 repeated verbatim from schema spec §3.3.4/§3.3.6 and nav
spec §1. Zero markers = approvable.*
