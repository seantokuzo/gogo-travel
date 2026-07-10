# Client — Trips: List, Create, Join, Members, Settings — `.specs/client/trips.spec.md`

> **Task:** T-2.3 (TRIPS + MEMBERS + INVITES + COLLAB bundle) · **Status:**
> DRAFT — pending Sean approval. Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain (own + repeated upstream).
>
> **Sources:** `.specs/api/trips.spec.md` (CANONICAL for authz — §3.2
> matrix — and endpoint shapes), `.specs/client/navigation.spec.md`
> (CANONICAL for routes, deep links, modal conventions §2.6, testID grammar
> §2.7), `.specs/database/schema.spec.md` §3.3.4–§3.3.6,
> `.specs/design-system/tokens.spec.md` §2.9 (components),
> `docs/PLANNING.md § Cross-cutting` (collab sync v1: REST + optimistic +
> refetch-on-focus + push invalidation, NO sockets),
> `.specs/research/competitors.md` (collab free forever — call #2).
>
> Screens owned here: `trip-list`, `trip-new`, `invite-join`, `members`,
> `trip-settings`. Routes per nav spec §2.1: `(trips)/index.tsx`,
> `(trips)/new.tsx`, `(trips)/join/[token].tsx`, `[tripId]/more/members.tsx`,
> `[tripId]/more/settings.tsx`.

---

## 1. Requirements (EARS)

### Trip list (`trip-list`)

- **R-tripui-1 (sections):** WHEN the trip list renders THE SYSTEM SHALL
  group trips into sections by `trip_status` in the order `active` →
  `planning` → `past` (display labels §2.1; enum values are the keys —
  schema spec §3.2), sorting `active`/`planning` by `start_date` ascending
  and `past` by `end_date` descending (dates are required at creation —
  §2.2, resolved Gate 2 — so every trip sorts by date).
- **R-tripui-2 (row content + tap):** WHEN a trip row renders THE SYSTEM
  SHALL show name, destination, date range, and member count; WHEN tapped
  THE SYSTEM SHALL navigate to `/[tripId]` where the default-tab rules
  apply (nav R-nav-7/8).
- **R-tripui-3 (freshness):** WHEN any screen in this spec gains focus or
  the app returns to foreground THE SYSTEM SHALL refetch its stale queries
  (collab v1 refetch-on-focus — PLANNING § Cross-cutting).
- **R-tripui-4 (push invalidation):** WHEN a push-invalidation event from
  the API spec §3.5 list arrives THE SYSTEM SHALL invalidate the mapped
  query keys (§2.6) — and WHEN the event is `trip.deleted` or
  `member.removed` targeting the current user while they are inside that
  trip THE SYSTEM SHALL exit to the trip list with a non-blocking notice.
- **R-tripui-5 (empty state):** WHEN the user has zero trips THE SYSTEM
  SHALL render an EmptyState with create-trip and join-by-link guidance —
  never a blank region (design-system R-ds-16).

### Create trip (`trip-new`, modal)

- **R-tripui-6 (form):** WHEN the create-trip modal opens THE SYSTEM SHALL
  present name (required), destination (structured search — §2.2, resolved
  Gate 2), and required dates (§2.2, resolved Gate 2); `base_currency`
  SHALL default to `UserPrefs.home_currency ?? 'USD'` without occupying
  the form (editable later in trip settings until the first expense locks
  it, API spec §3.6).
- **R-tripui-7 (submit):** WHEN the form is submitted THE SYSTEM SHALL
  disable the submit control while pending, and on success navigate into
  the new trip (itinerary tab per nav R-nav-8); on failure render an
  ErrorBanner with retry, preserving all entered values.
- **R-tripui-8 (dirty dismissal):** WHEN the modal is dismissed with
  entered data THE SYSTEM SHALL intercept with a discard Confirm (nav §2.6
  form-modal rule).

### Join via invite (`invite-join`, deep-link target)

- **R-tripui-9 (preview before joining):** WHEN the join screen opens with
  a token THE SYSTEM SHALL fetch and render the invite preview (trip name,
  destination, dates, inviter, granted role — `GET /invites/:token`) before
  any membership change; joining SHALL require an explicit accept action.
- **R-tripui-10 (cold/warm parity):** WHEN the invite link arrives via cold
  or warm start, authenticated or not, THE SYSTEM SHALL reach this screen
  through the nav deep-link registry (`/invite/[token]` →
  `/(trips)/join/[token]`), including stash-and-resume when
  unauthenticated (nav R-nav-11/14/16).
- **R-tripui-11 (dead invites):** WHEN the token is unknown, expired,
  revoked, or at max uses THE SYSTEM SHALL render a distinct error state
  per `state`/`details.reason` (copy for "expired" differs from "invalid")
  with a "Back to trips" path and zero trip data beyond the preview
  endpoint's fields (nav R-nav-11/15 posture).
- **R-tripui-12 (accept):** WHEN accept succeeds THE SYSTEM SHALL
  invalidate the trips list and navigate inside the trip with default-tab
  rules (nav R-nav-12); WHEN the response says `already_member` THE SYSTEM
  SHALL show a notice and navigate straight in; decline/dismiss SHALL
  simply return to the trip list (no server call).

### Members (`members`)

- **R-tripui-13 (list):** WHEN the members screen renders THE SYSTEM SHALL
  list every member with avatar, display name, and role badge, the caller
  marked "(you)".
- **R-tripui-14 (role gating in UI):** WHEN the caller's role lacks a
  capability per API spec §3.2 THE SYSTEM SHALL hide or disable that
  affordance (role change, remove, invite, transfer). UI gating is
  convenience only — the server matrix enforces (API R-trips-2); a 403
  still renders an ErrorBanner, never a crash.
- **R-tripui-15 (role change & removal):** WHEN the owner changes a
  member's role THE SYSTEM SHALL apply it optimistically (§2.6); WHEN the
  owner removes a member THE SYSTEM SHALL first present a ConfirmDialog
  naming the member (design-system R-ds-18), and note that their expenses
  and balances remain (API R-trips-12).
- **R-tripui-16 (invite flow):** WHEN the invite action is triggered THE
  SYSTEM SHALL create an invite (shareable multi-use link, 7-day default
  expiry, role choice defaulting to `editor` — §2.2, resolved Gate 2) and
  open the OS share sheet with the invite URL; active invites SHALL be
  listed with revoke affordances per §3.2 (owner: any; editor: own).
- **R-tripui-17 (transfer ownership):** WHEN the owner invokes "Make
  owner" on a member THE SYSTEM SHALL present a ConfirmDialog explaining
  the demotion to editor, then call the transfer endpoint (transfer
  confirmed — §2.2, resolved Gate 2).

### Trip settings (`trip-settings`)

- **R-tripui-18 (rows):** WHEN trip settings renders THE SYSTEM SHALL show:
  trip details form (name, destination, dates — editor+), theme picker
  (editor+), base currency (owner-only; locked once the first expense
  exists — API §3.6, resolved Gate 2), offline pack status/download (all
  members; content owned by the offline spec), leave trip (non-owner
  members), delete trip (owner). Rows the caller's role cannot use are
  hidden/disabled per R-tripui-14.
- **R-tripui-19 (conflict UX):** WHEN the settings form save returns
  `CONFLICT` (stale `expect_updated_at` — API §3.5 rule 2; the form always
  sends it) THE SYSTEM SHALL refetch, re-render the form with fresh values,
  and show a non-blocking "Updated by someone else — review and re-save"
  notice; it SHALL NOT silently overwrite.
- **R-tripui-20 (destructive ops):** WHEN leave or delete is invoked THE
  SYSTEM SHALL present a ConfirmDialog (delete states it is permanent and
  removes the trip for ALL members); WHEN the owner invokes leave THE
  SYSTEM SHALL explain transfer-first and deep-link to the members screen
  (transfer-first confirmed — §2.2, resolved Gate 2).

### Collab behavior (all screens in this spec)

- **R-tripui-21 (optimistic mutations):** WHEN the user performs a mutation
  THE SYSTEM SHALL apply the expected result optimistically, reconcile with
  the returned row (API R-trips-19), and on failure roll back and render an
  ErrorBanner.
- **R-tripui-22 (testIDs):** WHEN any screen in this spec renders THE
  SYSTEM SHALL carry testIDs per the nav §2.7 grammar on its root and every
  interactive element — exact IDs in §2.7 tables (nav R-nav-22).

---

## 2. Design

### 2.1 Trip list (`(trips)/index.tsx`)

Sections keyed by `trip_status` (schema §3.2: `planning/active/past`);
display labels are presentation only: `active` → "Happening now",
`planning` → "Upcoming", `past` → "Past". (Nav spec §2.4 says "grouped
active/upcoming/past" — "upcoming" is the `planning` label, not a fourth
status.) Data: `GET /trips` (`TripListItem`: trip + caller role +
member_count).

- Row: Card/ListItem — name, destination, date range, member count;
  section-relevant accent (active trips visually lead).
- Header: PageHeader (large) + profile avatar entry — avatar button on the
  trip-list header is the confirmed profile surface (§2.2, resolved
  Gate 2).
- Actions: FAB → create modal; "Join a trip" affordance appears in the
  EmptyState and header overflow (invite links are the primary join path —
  deep link, not manual entry; no token-typing UI in v1).
- States: loading (Skeleton rows), empty (R-tripui-5), error (ErrorBanner +
  retry — design-system R-ds-17).
- Launch behavior (which screen the app lands on, incl. the 2+ active-trips
  case) is the nav spec's, not this screen's — resolved there Gate 2:
  most-recently-viewed active trip, with a trip switcher in the header.

### 2.2 Upstream resolutions this spec depends on (canonical homes)

All resolved at Gate 2 (2026-07-09):

- Resolved at `.specs/database/schema.spec.md`:§3.3.4 `trips` (Gate 2,
  2026-07-09): trip dates are **required at creation** v1; date-less trips
  deferred.
- Resolved at `.specs/database/schema.spec.md`:§3.3.4 `trips` (Gate 2,
  2026-07-09): destination input is **structured** — search against the
  Overture city/locality subset; `destination_lat/lng` always present.
- Resolved at `.specs/database/schema.spec.md`:§3.3.5 `trip_members`
  (Gate 2, 2026-07-09): owner may transfer ownership; leaving a trip with
  other members requires transfer first.
- Resolved at `.specs/database/schema.spec.md`:§3.3.6 `invites` (Gate 2,
  2026-07-09): invites are shareable multi-use links, 7-day default
  expiry, revocable, optional `max_uses`.
- Resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09):
  universal-link domain — Sean picks/buys (gogo.travel / gogotravel.app /
  seantokuzo.dev subdomain); `gogo://` stays the fallback scheme.
- Resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09):
  profile/app-settings surface = **avatar button on the trip-list header**
  → pushed profile screen (profile edit, payment handles,
  appearance/theme, sign-out).

### 2.3 Create trip (`(trips)/new.tsx`, form modal per nav §2.6)

Single-screen form (nav §2.4: "name, destination, dates"):

1. **Name** — required, text input.
2. **Destination** — structured search-as-you-type; selecting a result
   fills `destination_name` + `destination_lat/lng`. No free-text
   fallback. Data source — decided: **city/region subset of the Overture
   spine imported into `places`** (option a — free, no new dependency; the
   import-task scope grows to include the city/locality subset). Mapbox
   Geocoding rejected (new metered product); free-text rejected (kills
   guaranteed weather/AI grounding). (Resolved 2026-07-09, Gate 2)
3. **Dates** — **required** range picker (§2.2, resolved Gate 2); the
   "No dates yet" states across this spec drop out.

Not in the form: `base_currency` (defaulted per R-tripui-6, edited in
settings), `theme` (settings). Submit → `POST /trips` → replace-navigate to
`/[tripId]` (lands itinerary per nav R-nav-8).

### 2.4 Join via invite (`(trips)/join/[token].tsx`)

Deep-link target per nav registry (`/invite/[token]`; cold/warm parity
R-nav-16; unauthenticated stash-and-resume R-nav-14).

States (from `GET /invites/:token`):

| State | Render |
|---|---|
| loading | Skeleton preview card |
| `active` | Preview card (trip name, destination, dates, inviter avatar + name, "joining as <role>") + Accept + Decline |
| `active` + `already_member` | Notice "You're already in this trip" + Open trip |
| `expired` | Error card: "This invite has expired — ask <inviter> for a new link" + Back to trips |
| `revoked` / `max_uses_reached` | Error card: "This invite is no longer valid" + Back to trips |
| 404 unknown | Generic "Invite not found" + Back to trips (no oracle for token guessing) |

Accept → `POST /invites/:token/accept` → invalidate `['trips']` →
`router.replace('/[tripId]')` (default tab per nav R-nav-7/8). Decline →
back to trip list, no server call.

### 2.5 Members (`[tripId]/more/members.tsx`) & trip settings (`[tripId]/more/settings.tsx`)

**Members** — sections:

1. **Members** — ListItem per member: avatar, display name ("(you)" for
   caller), role Badge. Owner-only row actions (swipe/overflow): change
   role (editor ↔ viewer — Sheet with the two options), remove
   (ConfirmDialog, notes balances remain — R-tripui-15), make owner
   (ConfirmDialog — R-tripui-17).
2. **Invite** — primary Button "Invite to trip" (owner/editor per matrix):
   creates the invite (`POST /trips/:tripId/invites`; shareable multi-use
   link with 7-day default expiry — §2.2, resolved Gate 2; the UI offers a
   role choice defaulting to `editor`) then opens the OS share sheet with
   the returned `url`.
3. **Active invites** (owner/editor only) — ListItem per invite: role,
   expiry, uses; revoke action (Confirm) per matrix (owner any / editor
   own).

**Trip settings** — ListItem rows (R-tripui-18), role-gated per API §3.2:

| Row | Roles shown | Behavior |
|---|---|---|
| Trip details (name, destination, dates) | owner, editor | Push → form; save sends `expect_updated_at` (R-tripui-19) |
| Theme | owner, editor | Push → theme picker (tokens spec themes); optimistic apply |
| Base currency | owner | Push → currency picker; locked (read-only row with explainer) once the first expense exists (API §3.6 / R-trips-22, resolved Gate 2) |
| Trip visibility | — | NOT RENDERED — dropped from v1 (no trip-level visibility; API §3.6, resolved Gate 2) |
| Offline pack | all | Status pill + download/refresh (offline spec owns content) |
| Members | all | Shortcut → members screen |
| Leave trip | editor, viewer | ConfirmDialog → `DELETE /trips/:tripId/members/:me` → trip list |
| Leave trip (owner) | owner | Disabled row + "Transfer ownership first" hint → members screen (resolved Gate 2) |
| Delete trip | owner | ConfirmDialog (permanent, all members) → `DELETE /trips/:tripId` → trip list |

### 2.6 Collab client rules (optimistic · refetch-on-focus · push)

PLANNING § Cross-cutting, client half. TanStack Query throughout; query
keys derive from endpoint descriptors (contracts §3.6).

- **Refetch-on-focus (R-tripui-3):** screen focus (navigation focus event)
  and `AppState → active` mark this spec's queries stale and refetch.
- **Optimistic writes (R-tripui-21):** role change, member remove/leave,
  invite revoke, theme change, settings save — optimistic cache update →
  reconcile with returned row → rollback + ErrorBanner on error. Trip
  create and invite accept are NOT optimistic (server-generated
  identity/membership; spinner instead).
- **Conflict (R-tripui-19):** settings form always sends
  `expect_updated_at`; 409 → refetch + re-render + notice. All other
  mutations in this spec rely on row-grain LWW (API §3.5 rule 1).
- **Push invalidation mapping (R-tripui-4):**

| Event (API §3.5) | Invalidate | Extra behavior |
|---|---|---|
| `trip.updated`, `trip.status_changed` | `['trips']`, `['trip', tripId]` | Theme/status changes re-render trip context |
| `trip.deleted` | `['trips']`; evict `['trip', tripId]` subtree | If inside that trip → exit to list + notice |
| `member.added` / `member.left` / `member.removed` / `member.role_changed` / `ownership.transferred` | `['trip', tripId, 'members']`, `['trips']` | If `entity_id` = me: refetch own role (gates re-render); `member.removed` targeting me → evict + exit + notice |
| `invite.created` / `invite.revoked` | `['trip', tripId, 'invites']` | — |

### 2.7 testIDs (nav §2.7 grammar — `<screen>-<element>[-<qualifier>]`)

Screen roots: `trip-list-screen`, `trip-new-screen`, `invite-join-screen`,
`members-screen`, `trip-settings-screen`.

| Screen | testID | Element |
|---|---|---|
| trip-list | `trip-list-fab-create` | create FAB |
| | `trip-list-list-item-{tripId}` | trip row |
| | `trip-list-button-profile` | header avatar (profile surface confirmed — resolved Gate 2) |
| | `trip-list-button-join` | join entry (EmptyState/overflow) |
| | `trip-list-retry` | error retry |
| trip-new | `trip-new-input-name` | name input |
| | `trip-new-input-destination` | destination search input |
| | `trip-new-list-item-{placeId}` | destination result row |
| | `trip-new-input-dates` | date-range control |
| | `trip-new-button-create` | submit |
| | `trip-new-button-cancel` | dismiss (dirty → `trip-new-button-cancel-confirm` via ConfirmDialog derivation) |
| invite-join | `invite-join-button-accept` | accept |
| | `invite-join-button-decline` | decline |
| | `invite-join-button-open-trip` | already-member open |
| | `invite-join-button-back` | error-state back to trips |
| members | `members-list-item-{userId}` | member row |
| | `members-button-invite` | invite CTA |
| | `members-button-role-{userId}` | role-change action |
| | `members-button-remove-{userId}` | remove action (Confirm derives `-confirm`/`-cancel`) |
| | `members-button-transfer-{userId}` | make-owner action |
| | `members-list-item-invite-{inviteId}` | active invite row |
| | `members-button-revoke-{inviteId}` | revoke invite |
| trip-settings | `trip-settings-list-item-details` | details row |
| | `trip-settings-list-item-theme` | theme row |
| | `trip-settings-list-item-currency` | base currency row |
| | `trip-settings-list-item-offline` | offline pack row |
| | `trip-settings-list-item-members` | members shortcut |
| | `trip-settings-button-leave` | leave trip |
| | `trip-settings-button-delete` | delete trip |
| | `trip-settings-button-save` | details form save |

Dynamic qualifiers are stable entity ids, never render indexes (nav §2.7
rule; ConfirmDialog children derive `-confirm`/`-cancel` per rule 4).

### 2.8 Out of scope (explicit)

- Route topology, auth gating, deep-link transport, stash-and-resume
  mechanics (navigation spec — this spec plugs into its registry).
- Profile screen itself (navigation spec owns it — avatar-button entry
  resolved Gate 2; only the entry point is noted here).
- The `[tripId]` tab screens (today/itinerary/map/money) and other
  `more/*` screens (their bundles' specs).
- Offline pack contents/behavior (offline spec) — only the settings row
  placement is here.
- Push transport/registration (notifications spec) — only the
  event → query-key mapping is here.
- Manual invite-code entry UI (not v1; links only).

---

## 3. Tasks

Each sized to one agent session; become `T-N.M` rows at build time.
Depends on: NAV-1..5 (routes, guards, deep links), DS-7..9 (components),
API-TRIPS-1..4.

| ID | Task | Covers |
|---|---|---|
| CT-1 | Trip list: sections, rows, empty/loading/error states, FAB + join entries, refetch-on-focus wiring. | R-tripui-1..3, 5, 22 |
| CT-2 | Create-trip modal: form, destination structured search (Overture city subset — resolved Gate 2), required dates, submit/land, dirty-dismiss guard. | R-tripui-6..8, 22 |
| CT-3 | Invite-join screen: preview, accept/decline, all dead-token states, already-member path (cold/warm via nav registry). | R-tripui-9..12, 22 |
| CT-4 | Members screen: list + role badges, role-gated actions (role change, remove, transfer), invite create + share sheet, active-invite list + revoke. | R-tripui-13..17, 21, 22 |
| CT-5 | Trip settings screen: role-gated rows, details form with `expect_updated_at` conflict UX, leave/delete flows. | R-tripui-14, 18..20, 21, 22 |
| CT-6 | Collab client layer: push-event → query-key invalidation map, optimistic mutation helpers with rollback, forced-exit handling (trip deleted / self removed). | R-tripui-3, 4, 21 |

**Tests required (minimum):**

- [ ] Sections group/sort by status correctly (CT-1)
- [ ] Empty state renders with both CTAs; error state has retry (CT-1)
- [ ] Create: validation (required name/destination/dates), pending-disable, success lands itinerary tab, failure preserves input, dirty dismiss confirms (CT-2)
- [ ] Join: each of active/expired/revoked/maxed/unknown/already-member renders its distinct state; accept navigates with default-tab rules (CT-3)
- [ ] Join cold start + warm start + unauthenticated stash/resume (with nav NAV-5 harness) (CT-3)
- [ ] Members: viewer sees no manage affordances; editor sees invite only; owner sees all; server 403 renders ErrorBanner (CT-4)
- [ ] Remove member Confirm flow; optimistic role change rolls back on error (CT-4)
- [ ] Invite create opens share sheet with returned URL; revoke gated owner-any/editor-own (CT-4)
- [ ] Settings: role-gated row visibility matrix; 409 save → refetch + notice, no silent overwrite (CT-5)
- [ ] Leave (non-owner) and delete (owner) Confirm flows land on trip list (CT-5)
- [ ] Push events invalidate mapped keys; `trip.deleted`/self-`member.removed` force-exits with notice (CT-6)
- [ ] Every §2.7 testID present on the rendered screen (CT-1..5)

---

*Trace: every R-tripui-N cites its §2 section inline. All markers resolved
at Gate 2 (2026-07-09): 1 owned here (destination search source → Overture
city/locality subset), 6 inherited (§2.2 — dates required; structured
destination; ownership transfer; multi-use invites; universal-link domain;
profile = trip-list header avatar); the API spec's 3 markers (viewer
participation, base-currency lock, trip visibility dropped) resolved
there. Zero markers remain.*
