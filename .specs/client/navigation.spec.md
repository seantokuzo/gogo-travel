# Client — Navigation IA (expo-router)

> Route topology, auth gating, deep links, tab defaults, modal conventions,
> and the testID grammar for `apps/mobile`. Route groups follow
> `docs/PLANNING.md § Component map` exactly. UX patterns trace to
> `.specs/research/competitors.md` (plan-mode day list + persistent map +
> inline travel times; today-mode chronological timeline; calendar-grid gap
> view).
>
> **Status:** draft — not approvable until zero `[NEEDS CLARIFICATION]` markers.
> **Depends on:** ADR-004; `.specs/design-system/tokens.spec.md` (TabNav,
> PageHeader, Sheet). **Consumed by:** every screen spec.

---

## 1. Requirements (EARS)

### Auth gating

- **R-nav-1**: WHEN an unauthenticated user navigates to any route outside
  `(auth)` THE SYSTEM SHALL redirect to sign-in, preserving the intended
  destination.
- **R-nav-2**: WHEN sign-in completes with a stashed destination THE SYSTEM
  SHALL navigate to it (after onboarding, on first-ever sign-in); otherwise
  to the default landing route.
- **R-nav-3**: WHEN the session store has not finished hydrating from secure
  storage THE SYSTEM SHALL hold on the splash surface — never flash sign-in
  at an authenticated user or vice versa.
- **R-nav-4**: WHEN the user signs out THE SYSTEM SHALL reset the entire
  navigation state, clear any stashed destinations, and land on sign-in.

### Landing & today-tab defaults

- **R-nav-5**: WHEN an authenticated user launches the app and no trip is
  currently active THE SYSTEM SHALL land on the trip list.
- **R-nav-6**: WHEN an authenticated user cold-launches the app and exactly
  one trip is active (status `active`: today within its dates) THE SYSTEM
  SHALL land directly on that trip's **today** tab.
- **R-nav-7**: WHEN the user opens a trip that is currently active THE SYSTEM
  SHALL default to the **today** tab.
- **R-nav-8**: WHEN the user opens a trip that is not active (planning or
  past) THE SYSTEM SHALL default to the **itinerary** tab.
- **R-nav-9**: WHEN the user manually selects a tab within a trip THE SYSTEM
  SHALL respect that selection for the rest of the session — no snap-back to
  today. Cold launch re-applies the default rules.
- **R-nav-10**: WHEN the user switches tabs and returns THE SYSTEM SHALL
  preserve each tab's own navigation stack and scroll position (per-tab
  stacks).
- **R-nav-23**: WHEN an authenticated user cold-launches the app and two or
  more trips are active THE SYSTEM SHALL land on the **most-recently-viewed**
  active trip's today tab (falling back to the trip list when none of them
  has ever been viewed), and the trip header SHALL offer a trip-switcher
  affordance for moving between active trips without returning to the list.
  (Resolved 2026-07-09, Gate 2)

### Deep links (gogo universal links + custom scheme)

- **R-nav-11**: WHEN the app opens via an invite link THE SYSTEM SHALL route
  to the invite-accept screen for that token; WHEN the token is invalid or
  expired THE SYSTEM SHALL show an error state with a path back to the trip
  list.
- **R-nav-12**: WHEN an invite is accepted THE SYSTEM SHALL land the user
  inside that trip (default-tab rules R-nav-7/8 apply).
- **R-nav-13**: WHEN the app opens via a settle-up request link THE SYSTEM
  SHALL route to that request's detail (share owed + payment handle options +
  "mark as settled"), inside the trip's money context.
- **R-nav-14**: WHEN a deep link arrives while unauthenticated THE SYSTEM
  SHALL stash it, run the auth flow, and resume the link after sign-in
  (R-nav-1/2 machinery).
- **R-nav-15**: WHEN a deep link references a trip the user is not a member
  of THE SYSTEM SHALL show a generic not-found/no-access state revealing no
  trip data (IDOR posture — PLANNING § Security).
- **R-nav-16**: WHEN a deep link arrives on cold start (app killed) THE
  SYSTEM SHALL route identically to the warm-start (foregrounded) case.
- **R-nav-17**: WHEN an unknown or malformed link opens the app THE SYSTEM
  SHALL land on the default landing route with a non-blocking notice — never
  a crash or blank screen.

### Capture entry points

- **R-nav-18**: WHEN the app returns to foreground within 30 minutes of a
  booking deeplink-out (Kayak, Airbnb, etc.) THE SYSTEM SHALL present the
  "Did you book it?" prompt (Sheet) offering forward-email instructions /
  share-screenshot / add-manually / dismiss (research call #6: deeplink
  round-trip capture).
- **R-nav-19**: WHEN content arrives via the iOS share sheet
  (`expo-share-intent`) THE SYSTEM SHALL route into the capture review flow
  with the shared payload, on both warm and cold start, after auth gating.
- **R-nav-24**: WHEN captures exist needing review THE SYSTEM SHALL surface
  them in a **trips-level capture inbox** (`(trips)/capture`) reachable from
  the trip-list header with a needs-review count badge — captures can
  precede trip assignment, so the inbox lives outside trip context — AND in
  a per-trip filtered view of the same queue reached from that trip's More
  tab. (Resolved 2026-07-09, Gate 2)

### Membership & structure

- **R-nav-20**: WHEN any `[tripId]/*` route mounts THE SYSTEM SHALL verify
  the user's membership of that trip before rendering trip data; failures
  render the R-nav-15 no-access state.
- **R-nav-21**: WHEN a screen presents a create/edit form or a
  self-contained flow THE SYSTEM SHALL present it modally; WHEN it drills
  into detail of an on-screen entity THE SYSTEM SHALL push it (conventions
  § 2.6) — no mixed presentation for the same screen type.
- **R-nav-22**: WHEN any screen renders THE SYSTEM SHALL carry a `testID` on
  its root view and on every interactive element, per the § 2.7 grammar
  (mobile-engineer landmine: a screen without testIDs can never be E2E
  covered).

### Resolved questions (Gate 2)

- **Universal-link domain** — spec against the placeholder
  `links.gogotravel.example`; the real domain is Sean's pre-launch pick. All
  link formats, AASA/assetlinks references, and the §2.3 registry consume a
  single shared config constant (`LINK_DOMAIN` in `@gogo/shared` config), so
  the swap is a one-config change with zero spec/code churn. Custom scheme
  `gogo://` remains the fallback either way.
  (Resolved 2026-07-09, Gate 2 — domain pick itself outstanding.)
- **Onboarding contents** — `(auth)/onboarding` collects, in order: display
  name/avatar → home currency → payment handles (Venmo/CashApp/PayPal/Zelle
  — the settle-up spine; skippable) → notification permission priming, plus
  an optional `travel_style` prompt (skippable). Everything after name is
  skippable and editable later via the profile screen.
  (Resolved 2026-07-09, Gate 2)
- **Profile/app-settings home** — avatar button in the trip-list header
  (outside trip context) → pushed `(trips)/profile` screen: profile edit,
  payment handles, appearance/accent theme, session list/revoke, sign-out.
  (Resolved 2026-07-09, Gate 2)
- **Capture needs-review queue** — both surfaces (R-nav-24): a trips-level
  inbox at `(trips)/capture`, reachable from the trip-list header with a
  badge (captures can precede trip assignment), plus a per-trip filtered
  view of the same queue from the More tab.
  (Resolved 2026-07-09, Gate 2)
- **Multiple concurrently-active trips on launch** — land on the
  most-recently-viewed active trip's today tab; header trip switcher between
  active trips (R-nav-23). (Resolved 2026-07-09, Gate 2)
- **Settle-up request links for non-members** — require app install +
  account in v1; membership required, so R-nav-15 applies unchanged and
  R-nav-13 has **no** unauthenticated branch (no web surface exists to fall
  back to). Revisit with any future web phase.
  (Resolved 2026-07-09, Gate 2)

---

## 2. Design

### 2.1 Route tree (expo-router file map)

Route groups exactly per PLANNING § Component map: `(auth)`, `(trips)`,
`[tripId]/` with `today · itinerary · map · money · more` tabs.

```
apps/mobile/app/
├── _layout.tsx                     # root Stack: providers (Theme, Query, session),
│                                   #   auth gate, deep-link bootstrap, modal group config
├── index.tsx                       # entry redirect: R-nav-3/5/6 resolution
├── (auth)/
│   ├── _layout.tsx                 # redirects authed users out
│   ├── sign-in.tsx                 # Apple + Google (AuthSession)
│   └── onboarding.tsx              # first-run profile setup (contents: § Resolved questions)
├── (trips)/
│   ├── _layout.tsx                 # Stack
│   ├── index.tsx                   # trip list (header: profile avatar + capture-inbox badge)
│   ├── new.tsx                     # create trip — MODAL
│   ├── join/[token].tsx            # invite accept — deep-link target
│   ├── profile.tsx                 # PUSH — profile & app settings (Gate-2 E6)
│   └── capture/
│       ├── index.tsx               # capture inbox — trips-level queue (R-nav-24)
│       ├── [captureId].tsx         # PUSH — capture review (client capture spec)
│       └── onboarding.tsx          # MODAL — forward-address teach flow
└── [tripId]/
    ├── _layout.tsx                 # Tabs (design-system TabNav) + trip context
    │                               #   provider + membership guard (R-nav-20)
    │                               #   + default-tab resolution (R-nav-7/8)
    ├── today/
    │   └── index.tsx
    ├── itinerary/
    │   ├── _layout.tsx             # tab-local Stack (pattern repeats per tab)
    │   ├── index.tsx
    │   ├── item/[itemId].tsx       # PUSH
    │   ├── item/new.tsx            # MODAL (also handles edit via ?itemId= / ?bookingId=)
    │   └── booking/[bookingId].tsx # PUSH — booking detail per category (added
    │                               #   2026-07-09, Gate 2 sync — client itinerary
    │                               #   spec §2.1: ideas have no itemId to route by)
    ├── map/
    │   ├── index.tsx
    │   └── place/[placeId].tsx     # Sheet over map (small) / PUSH (full detail)
    ├── money/
    │   ├── index.tsx               # segmented: budget · expenses · balances
    │   ├── expense/[expenseId].tsx # PUSH
    │   ├── expense/new.tsx         # MODAL
    │   ├── settle/[memberId].tsx   # PUSH → payment-handle handoff Sheet
    │   └── request/[requestId].tsx # settle-up request — deep-link target
    └── more/
        ├── index.tsx               # hub list (ListItem rows)
        ├── photos/
        │   ├── index.tsx           # album grid
        │   └── [photoId].tsx       # PUSH — viewer + visibility control (Law #3)
        ├── packing.tsx
        ├── documents.tsx           # vault
        ├── members.tsx             # roles + invite entry
        └── settings.tsx            # trip settings: dates, theme, offline pack,
                                    #   leave/delete (ConfirmDialog)
```

Layout responsibilities:
- **Root `_layout`** owns providers, splash-hold until session hydration
  (R-nav-3), the redirect gate (R-nav-1), and registers the modal
  presentation group.
- **`[tripId]/_layout`** owns the Tabs navigator, fetches/validates
  membership before rendering children (R-nav-20), resolves the initial tab
  (R-nav-7/8) from trip status, provides trip context (id, role, dates,
  theme) to all tabs, and hosts the header trip-switcher affordance when 2+
  trips are active (R-nav-23).
- **Each tab directory** is its own Stack → per-tab history (R-nav-10).

### 2.2 Auth gate & session flow

State: Zustand session store (tokens in expo-secure-store, hydrated at
boot). Pseudocode for the root gate:

```
if (!session.hydrated)        → render splash            (R-nav-3)
if (!session.user)            → stash intended path; redirect /(auth)/sign-in  (R-nav-1)
if (session.user.firstRun)    → redirect /(auth)/onboarding                    (R-nav-2)
else                          → pop stash ?? entry-redirect logic              (R-nav-2/5/6)
```

Entry redirect (`app/index.tsx`):

```
activeTrips = trips where status == 'active'
if (activeTrips.length == 1) → /[tripId]/today                     (R-nav-6)
if (activeTrips.length >= 2) → most-recently-viewed active trip's
                               today tab; none viewed → /(trips)    (R-nav-23)
else                         → /(trips)                             (R-nav-5)
```

Most-recently-viewed tracking: `[tripId]/_layout` mount stamps the trip id +
timestamp into MMKV (`gogo.lastViewedTrip`); the entry redirect reads it
synchronously at boot (same no-flash posture as R-nav-3).

Sign-out: clear session store + query cache + stashes, `router.replace` to
sign-in with reset state (R-nav-4).

### 2.3 Deep-link registry

Transport: universal links on `links.gogotravel.example` (placeholder — the
real domain swaps in via the single `LINK_DOMAIN` config constant, see
§ Resolved questions) + `gogo://` scheme mirroring the same paths. All links
flow through one registry (single source of truth for parse → target →
guard):

| Link | Target route | Auth | Guard / failure |
|---|---|---|---|
| `/invite/[token]` | `/(trips)/join/[token]` | required (stash+resume) | invalid/expired token → in-screen error + "Back to trips" (R-nav-11) |
| `/t/[tripId]` | `/[tripId]` (default tab) | required | non-member → no-access (R-nav-15) |
| `/t/[tripId]/request/[requestId]` | `/[tripId]/money/request/[requestId]` | required — membership too (app + account v1; non-member → R-nav-15, no unauthenticated branch) | missing/settled request → request screen's resolved/empty state |
| share-sheet intent (`expo-share-intent`) | `/(trips)/capture` inbox → review (R-nav-24) | required | parse failure → capture entry with raw payload visible (never dropped) |
| anything else | `/(trips)` + toast | — | R-nav-17 |

Mechanics: expo-router linking config handles warm links; cold start resolves
`getInitialURL()`/initial share intent through the same registry (R-nav-16).
Stash-and-resume (R-nav-14) stores the parsed target, not the raw URL, so
expiry/authz is re-checked at resume time.

**Capture return (R-nav-18):** when a booking deeplink-out fires, record
`{ partner, category, tripId, timestamp }` in the client store. On next
`AppState → active` within 30 min, present the "Did you book it?" Sheet once
(then clear the record). Actions: how-to-forward instructions / open share
tips / add booking manually (`/[tripId]/itinerary/item/new` prefilled
category) / dismiss.

### 2.4 Screen inventory (name · purpose · key interactions)

**(auth)**
- `sign-in` — Apple/Google sign-in; legal links; error banner on failure.
- `onboarding` — first-run setup: name/avatar → home currency → payment
  handles (skippable) → notification priming; optional travel_style prompt
  (§ Resolved questions); skippable steps → trip list.

**(trips)**
- `trip-list` — trips grouped active/upcoming/past; tap → trip; create + join
  entries; header: profile avatar → `profile`, capture-inbox icon with
  needs-review badge → `capture-queue` (R-nav-24).
- `trip-new` (modal) — name, destination, dates; create → land in new trip
  (itinerary tab per R-nav-8).
- `invite-join` — trip preview + inviter + role; accept/decline; error state
  for dead tokens.
- `profile` (push) — profile edit (name/avatar), payment handles,
  appearance/accent theme, session list/revoke, sign-out. (Added 2026-07-09,
  Gate 2.)
- `capture-queue` — trips-level capture inbox: all captures across trips
  with status rows; content owned by the client capture spec. (Added
  2026-07-09, Gate 2.)
- `capture-review` (push) — proposal review/edit, trip picker Sheet, confirm
  → booking lands; content owned by the client capture spec.

**[tripId]/today** (live-trip surface — TripIt-style what's-next timeline)
- `today` — chronological timeline of today's items; next-event card with
  countdown/leave-by (from precomputed `travel_legs`); weather strip; quick
  actions (add expense, add photo, open map); tap item → itinerary item
  detail (cross-tab push into itinerary stack).

**[tripId]/itinerary** (plan surface — Wanderlog day list + our calendar grid)
- `itinerary` — day-sectioned list, drag-to-reorder, inline travel times
  between consecutive items; view toggle → calendar-grid (gaps/overlaps
  exposed — the differentiator nobody has); day tap → jump; FAB → add item.
- `itinerary-item` (push) — detail for place-visit/custom items: times,
  place link → map, expenses link, edit/delete; `booking`-kind items replace
  themselves with `booking-detail`.
- `itinerary-item-new` (modal) — add/edit item; category picker; place search;
  time set; conflicts surfaced inline (`?itemId=` / `?bookingId=` edit).
- `booking-detail` (push) — per-category booking detail: details + confirmation
  code, schedule/"add to day", linked expenses, edit/delete. Routes ideas too —
  they have no itinerary item to route by (client itinerary spec §2.1). (Added
  2026-07-09, Gate 2 sync.)

**[tripId]/map**
- `map` — persistent trip map: saved places, itinerary pins (day-colored),
  photo pins; **spine-backed place search bar** (Gate 2, F4 — see map spec
  R-map-25; `map-search` testID); day filter; offline-pack status pill; pin
  tap → place sheet; one-tap external nav handoff (Google/Apple Maps — never
  replace the nav app).
- `place-detail` — place info (our POI spine + FSQ fresh details), visit
  notes, linked itinerary items/photos; save/unsave; "add to day".

**[tripId]/money**
- `money` — segmented budget (caps + AI estimate vs actual) · expenses
  (list, filter by member/category) · balances (who-owes-who, simplified);
  FAB → add expense.
- `expense-new` (modal) — amount (integer cents, Law #2), currency, payer,
  split among members, optional booking link.
- `expense-detail` (push) — shares breakdown, edit/delete (Confirm), source
  booking link.
- `settle` (push) — "You owe X $NN.NN" → one button per payment handle
  (Venmo/CashApp/PayPal deeplink, Zelle copy) + unconditional "Mark as
  settled"; on return from payment app → "Did you complete it?" confirm.
- `settle-request` — recipient view of a settle-up request link: share owed,
  pay options, mark-settled (deep-link target; membership required — app +
  account v1, § Resolved questions).

**[tripId]/more**
- `more` — hub of ListItem rows: Photos, Packing, Documents, Members,
  Capture inbox (opens the trips-level queue filtered to this trip —
  R-nav-24), Trip settings; offline-pack status.
- `photos` — album grid; visibility badges; upload; tap → viewer.
- `photo-viewer` (push) — full-bleed photo, place/itinerary pin links,
  visibility control (private/trip/public — explicit check, Law #3), delete.
- `packing` — AI-generated + manual checklist; check off; regenerate.
- `documents` — vault list with expiry badges; add doc; reminder toggle.
- `members` — member list with roles; invite (share sheet with invite link);
  role change / remove (owner only, Confirm).
- `trip-settings` — name/dates/destination edit, trip theme picker, offline
  pack download/refresh, leave trip / delete trip (destructive Confirms).

### 2.5 Today-tab default logic

```
tripIsActive(trip) = trip.status == 'active'
                     && today ∈ [trip.startDate, trip.endDate]   (user's tz)

initialTab(trip)   = tripIsActive(trip) ? 'today' : 'itinerary'   (R-nav-7/8)
```

- Evaluated when `[tripId]/_layout` mounts. In-session manual tab choice is
  held in a per-trip, in-memory store slot — never persisted (R-nav-9), so
  every cold launch re-applies `initialTab`.
- A trip crossing into active while the app is open does NOT yank the user;
  the change applies from the next trip open (no surprise navigation).

### 2.6 Modal vs push conventions (R-nav-21)

| Presentation | Use for | Examples |
|---|---|---|
| **Push** (tab-local Stack) | Drill-down into an entity already on screen | itinerary item, expense detail, place detail (full), photo viewer, settle |
| **Modal — sheet** (design-system `Sheet`, in-screen) | Quick, single-decision interactions that keep context visible | map place preview, "Did you book it?", settle handoff options, filters |
| **Modal — form** (router `presentation: 'modal'`) | Create/edit forms; self-contained flows with explicit save/cancel | trip-new, itinerary-item-new, expense-new, doc add |
| **Dialog** (design-system `ConfirmDialog`) | Destructive confirmation only | delete trip/item/expense/photo, remove member, leave trip |

Rules: modals never stack on modals (dismiss first); ConfirmDialog may sit
over anything; back/swipe-back pops pushes, swipe-down dismisses modals —
forms with dirty state intercept dismissal with a discard Confirm.

### 2.7 testID convention (R-nav-22)

Grammar — kebab-case, screen-prefixed:

```
<screen>-<element>[-<qualifier>]
```

- `<screen>` — route basename in kebab: `sign-in`, `trip-list`, `trip-new`,
  `invite-join`, `profile`, `capture-queue`, `capture-review`, `today`,
  `itinerary`, `itinerary-item`, `booking-detail`, `map`, `place-detail`,
  `money`, `expense-new`, `settle`, `more`, `photos`, `packing`,
  `documents`, `members`, `trip-settings`.
- `<element>` — role noun: `button`, `input`, `list`, `list-item`, `tab`,
  `fab`, `toggle`, `segment`, `sheet`, `back`, `retry`.
- `<qualifier>` — static discriminator (`-apple`, `-confirm`) or, for
  dynamic collections, the **stable entity id** (`-{expenseId}`) — never a
  render index.

Fixed rules:
1. **Every interactive element** (Pressable/Touchable, Input, Switch, tab,
   FAB, swipe action) carries one. Design-system components make it a
   required prop, so omission is a type error.
2. Every screen's root view: `<screen>-screen`.
3. Tab bar items: `tab-bar-today`, `tab-bar-itinerary`, `tab-bar-map`,
   `tab-bar-money`, `tab-bar-more` (trip-agnostic — E2E flows shouldn't need
   the tripId to switch tabs).
4. Compound components derive children from their base:
   `{testID}-confirm` / `{testID}-cancel` (ConfirmDialog), `{testID}-retry`
   (ErrorBanner).
5. IDs are stable across renders and refactors — E2E flows match on them
   (landmine: flows point at the REAL UI).

Examples: `sign-in-button-apple`, `trip-list-fab-create`,
`trip-list-list-item-{tripId}`, `itinerary-view-toggle`,
`itinerary-list-item-{itemId}`, `expense-new-input-amount`,
`settle-button-venmo`, `photo-viewer-toggle-visibility`,
`trip-settings-button-delete`.

### 2.8 Out of scope (explicit)

- Screen-level content specs (each tab's feature spec owns its screens; this
  spec owns where they live and how they present).
- Photo/recap public share links and booking-partner callback URLs (future
  deep-link registry entries; the registry design accommodates them).
- Push-notification tap-routing (notifications spec; it will route through
  the same deep-link registry).
- Android back-button edge cases beyond stack-pop parity (Android
  verification pass, pre-launch).
- Offline navigation behavior (offline spec; note: all `[tripId]` tabs must
  still mount from cache for the active trip).
- Web support for expo-router routes.

---

## 3. Tasks

Traceable to requirement IDs; each sized to one agent session. These become
`T-N.M` rows in `docs/QUEUE.md` when the phase is cut.

| ID | Task | Covers |
|---|---|---|
| NAV-1 | Route skeleton: full file tree with placeholder screens, tab-local Stacks, TabNav wiring, root modal group. | R-nav-10, R-nav-21 |
| NAV-2 | Session store + root auth gate: hydration splash, redirect, stash/resume, first-run onboarding branch, sign-out reset. | R-nav-1..4 |
| NAV-3 | Entry redirect + trip default-tab resolution + in-session tab memory + most-recently-viewed multi-active landing (MMKV stamp) + header trip switcher. | R-nav-5..9, R-nav-23 |
| NAV-4 | `[tripId]` membership guard + trip context provider + no-access state. | R-nav-15, R-nav-20 |
| NAV-5 | Deep-link registry: scheme + universal-link config (AASA/assetlinks against the `LINK_DOMAIN` placeholder), invite + trip + settle-request routes, cold/warm parity, malformed fallback. | R-nav-11..17 |
| NAV-6 | Capture entries: share-intent routing + deeplink-out return prompt + inbox surfaces (trips-level queue + badge + per-trip filtered view). | R-nav-18, R-nav-19, R-nav-24 |
| NAV-7 | testID audit tooling: convention doc in `.claude/rules/mobile.md` + lint/check that flags interactive elements missing testIDs. | R-nav-22 |

**Tests required (minimum):**
- [ ] Unauthed access to `(trips)` and `[tripId]/*` redirects to sign-in; destination resumes post-auth (NAV-2)
- [ ] Active trip → today default; planning/past trip → itinerary; manual choice sticky in session, reset on relaunch (NAV-3)
- [ ] 2+ active trips → most-recently-viewed active trip's today tab; never-viewed fallback → trip list (NAV-3)
- [ ] Non-member tripId deep link renders no-access with zero trip data fetched into UI (NAV-4, NAV-5)
- [ ] Invite link: valid (cold + warm), expired, and unauthenticated-then-resumed paths (NAV-5)
- [ ] Malformed link lands on trip list without crash (NAV-5)
- [ ] Share intent routes to capture on cold and warm start (NAV-6)
- [ ] Deeplink-out + foreground within window shows prompt exactly once (NAV-6)
