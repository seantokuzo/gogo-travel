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
  (date-less trips last — pends the dates marker, §2.2) and `past` by
  `end_date` descending.
- **R-tripui-2 (row content + tap):** WHEN a trip row renders THE SYSTEM
  SHALL show name, destination, date range (or "No dates yet"), and member
  count; WHEN tapped THE SYSTEM SHALL navigate to `/[tripId]` where the
  default-tab rules apply (nav R-nav-7/8).
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
  present name (required), destination (structured search — §2.2), and
  optional dates (pends the dates marker); `base_currency` SHALL default to
  `UserPrefs.home_currency ?? 'USD'` without occupying the form (editable
  later in trip settings, API spec §3.6).
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
  SYSTEM SHALL create an invite (role + defaults pend the invite marker,
  §2.2) and open the OS share sheet with the invite URL; active invites
  SHALL be listed with revoke affordances per §3.2 (owner: any; editor:
  own).
- **R-tripui-17 (transfer ownership) [PROVISIONAL]:** WHEN the owner
  invokes "Make owner" on a member THE SYSTEM SHALL present a ConfirmDialog
  explaining the demotion to editor, then call the transfer endpoint —
  entire flow pends the ownership marker (§2.2).

### Trip settings (`trip-settings`)

- **R-tripui-18 (rows):** WHEN trip settings renders THE SYSTEM SHALL show:
  trip details form (name, destination, dates — editor+), theme picker
  (editor+), base currency (owner-only; pends API §3.6 marker), offline
  pack status/download (all members; content owned by the offline spec),
  leave trip (non-owner members), delete trip (owner). Rows the caller's
  role cannot use are hidden/disabled per R-tripui-14.
- **R-tripui-19 (conflict UX):** WHEN the settings form save returns
  `CONFLICT` (stale `expect_updated_at` — API §3.5 rule 2; the form always
  sends it) THE SYSTEM SHALL refetch, re-render the form with fresh values,
  and show a non-blocking "Updated by someone else — review and re-save"
  notice; it SHALL NOT silently overwrite.
- **R-tripui-20 (destructive ops):** WHEN leave or delete is invoked THE
  SYSTEM SHALL present a ConfirmDialog (delete states it is permanent and
  removes the trip for ALL members); WHEN the owner invokes leave THE
  SYSTEM SHALL explain transfer-first and deep-link to the members screen
  [PROVISIONAL — ownership marker].

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
- Header: PageHeader (large) + profile avatar entry — placement pends the
  nav profile marker (§2.2).
- Actions: FAB → create modal; "Join a trip" affordance appears in the
  EmptyState and header overflow (invite links are the primary join path —
  deep link, not manual entry; no token-typing UI in v1).
- States: loading (Skeleton rows), empty (R-tripui-5), error (ErrorBanner +
  retry — design-system R-ds-17).
- Launch behavior (which screen the app lands on, incl. the 2+ active-trips
  case) is the nav spec's, not this screen's — see nav §1 open question on
  multiple active trips.

### 2.2 Upstream markers this spec depends on (verbatim)

From schema spec §3.3.4 (`trips` table):

[NEEDS CLARIFICATION: are trip dates required at creation, or are date-less
trips allowed (dates added later)? Columns are nullable to keep both
options open; the create-trip UX decides.]

[NEEDS CLARIFICATION: destination input — picked from place/geocoder search
(structured; lat/lng always present) or free text (lat/lng optional)?
Affects nullability of `destination_lat/lng` and whether weather/AI
grounding can be guaranteed for every trip.]

From schema spec §3.3.5 (`trip_members`):

[NEEDS CLARIFICATION: ownership transfer — can an owner hand off ownership
(owner demotes self + promotes another in one transaction), and can an
owner leave a trip that still has members? Schema supports transfer as-is;
the allowed flows are user-visible.]

From schema spec §3.3.6 (`invites`):

[NEEDS CLARIFICATION: invite links — single-use per invitee or shareable
multi-use group links (Splitwise-style "anyone with the link joins")? Both
are supported by `max_uses`; which is the product default, and is there a
default expiry (e.g. 7 days)?]

From navigation spec §1 (open questions):

[NEEDS CLARIFICATION: Universal-link domain — what domain do we own for
`https://` links (gogo.travel? gogotravel.app?)? Needed for AASA /
assetlinks and the link formats below. Custom scheme `gogo://` is assumed
as the fallback either way.]

[NEEDS CLARIFICATION: Where does the user's own profile/app-settings
surface live? The component map has no home for it ((trips) is
list/create/join; more/* is per-trip). Proposal: avatar button in the
trip-list header → pushed profile screen (profile edit, payment handles,
appearance/theme, sign-out). Confirm or redirect.]

### 2.3 Create trip (`(trips)/new.tsx`, form modal per nav §2.6)

Single-screen form (nav §2.4: "name, destination, dates"):

1. **Name** — required, text input.
2. **Destination** — structured search-as-you-type; selecting a result
   fills `destination_name` + `destination_lat/lng`. Free-text fallback
   exists only if the destination marker (§2.2) resolves that way.
   [NEEDS CLARIFICATION: destination search data source — trips need
   city/region-level destinations ("Tokyo, Japan"), but the S-2 provider
   table locks only a POI spine (Overture/FSQ → our Postgres, schema
   §3.3.7) and the `places` trgm search is POI-grade, not a city gazetteer.
   Candidates: (a) city/region subset of the Overture spine imported into
   `places` (no new dependency; import-task scope grows), (b) Mapbox
   Geocoding API (same vendor account, but a new metered product —
   Autonomy Contract trigger #3), (c) free-text only (rejected unless the
   destination marker resolves that way — kills guaranteed weather/AI
   grounding). Blocks the create-trip flow's search field.]
3. **Dates** — optional range picker (pends the dates marker; if resolved
   required, the field gains required validation and "No dates yet" states
   across this spec drop out).

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
   (ConfirmDialog — R-tripui-17, PROVISIONAL).
2. **Invite** — primary Button "Invite to trip" (owner/editor per matrix):
   creates the invite (`POST /trips/:tripId/invites`; role + expiry
   defaults pend the §2.2 invite marker — until resolved the UI offers a
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
| Base currency | owner | Push → currency picker; change semantics pend API §3.6 marker — until resolved the row is read-only after the first expense/budget exists |
| Trip visibility | — | NOT RENDERED — no schema support; pends API §3.6 trip-visibility marker |
| Offline pack | all | Status pill + download/refresh (offline spec owns content) |
| Members | all | Shortcut → members screen |
| Leave trip | editor, viewer | ConfirmDialog → `DELETE /trips/:tripId/members/:me` → trip list |
| Leave trip (owner) | owner | Disabled row + "Transfer ownership first" hint → members screen [PROVISIONAL — ownership marker] |
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
| | `trip-list-button-profile` | header avatar (pends profile marker) |
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
| | `members-button-transfer-{userId}` | make-owner action [PROVISIONAL] |
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
- Profile screen itself (pends nav profile marker; only the entry point is
  noted here).
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
| CT-2 | Create-trip modal: form, destination structured search (pends §2.3 marker), submit/land, dirty-dismiss guard. | R-tripui-6..8, 22 |
| CT-3 | Invite-join screen: preview, accept/decline, all dead-token states, already-member path (cold/warm via nav registry). | R-tripui-9..12, 22 |
| CT-4 | Members screen: list + role badges, role-gated actions (role change, remove, transfer PROVISIONAL), invite create + share sheet, active-invite list + revoke. | R-tripui-13..17, 21, 22 |
| CT-5 | Trip settings screen: role-gated rows, details form with `expect_updated_at` conflict UX, leave/delete flows. | R-tripui-14, 18..20, 21, 22 |
| CT-6 | Collab client layer: push-event → query-key invalidation map, optimistic mutation helpers with rollback, forced-exit handling (trip deleted / self removed). | R-tripui-3, 4, 21 |

**Tests required (minimum):**

- [ ] Sections group/sort by status correctly incl. date-less trips (CT-1)
- [ ] Empty state renders with both CTAs; error state has retry (CT-1)
- [ ] Create: validation, pending-disable, success lands itinerary tab, failure preserves input, dirty dismiss confirms (CT-2)
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

*Trace: every R-tripui-N cites its §2 section inline. Markers: 1 new
(§2.3 destination search data source), 6 repeated verbatim (§2.2) from
schema spec §3.3.4/§3.3.5/§3.3.6 and navigation spec §1; the API spec's 3
new markers (§3.2 viewer participation, §3.6 base currency, §3.6 trip
visibility) are cited, not repeated. Zero markers = approvable.*
