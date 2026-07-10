# Client — Today Surface, Offline Sync & Notification Routing — `.specs/client/today.spec.md`

> **Task:** T-2.3 · **Status:** DRAFT — pending Sean approval (P-2 gate 3:
> per-feature specs). Not approvable until zero `[NEEDS CLARIFICATION]`
> markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (cross-cutting offline
> pattern, component map `[tripId]/today`) + `§ Overview` (live-trip "today"
> view bundle) · `.specs/client/navigation.spec.md` — **CANONICAL** for
> landing/default-tab behavior (R-nav-5..9), deep-link registry (§2.3),
> modal/push conventions (§2.6), testID grammar (§2.7) ·
> `.specs/database/schema.spec.md` (`travel_legs` §3.3.11, `bookings`
> `(trip_id, starts_at)` index "today-view next event", `itinerary_items`
> §3.3.10, `weather_cache` §3.3.23) · `.specs/api/notifications-utilities.spec.md`
> — **companion**: catalog (§3.4), payload schema (§3.3), leave-by
> scheduling (R-notif-3) · `.specs/research/competitors.md` (TripIt
> today-mode benchmark: chronological what's-next + leave-by prompts; "no
> planning-first app does day-of well") · `.specs/research/maps-places.md`
> (precompute leg times at sync — directions online-only) ·
> `.specs/research/ai-architecture.md` (tour bundles → expo-sqlite over
> wifi) · `.specs/shared/contracts.spec.md` §3.8 (offline mutation-queue
> handoff: "will define its queue-entry schema IN shared when specced" —
> specced here, §2.7).

---

## 1. Requirements (EARS)

### 1.1 Today surface

- **R-today-1 (chronological timeline):** WHEN the today tab renders for a
  trip whose current day is within the trip dates THE SYSTEM SHALL show a
  chronological timeline of that day's itinerary items (all kinds: booking /
  place_visit / custom), ordered by `(start_time, sort_order)`, with travel
  legs interleaved between consecutive items (mode, duration from
  `travel_legs` — TripIt what's-next benchmark).
- **R-today-2 (next-item hero):** WHEN at least one of today's items has a
  start time in the future THE SYSTEM SHALL render the earliest such item as
  a hero card with a live countdown ("in 1 h 20 m"), refreshed at least
  every minute while the screen is focused.
- **R-today-3 (leave-by):** WHEN the hero item has a preceding `travel_legs`
  row THE SYSTEM SHALL show a leave-by line
  (`leave_by = start − leg.duration_seconds − buffer`, buffer default 10 min
  shared config — same formula as the companion spec's R-notif-3, one shared
  computation) and the leg's mode + duration.
- **R-today-4 ("Now" state):** WHEN an item's time span contains now THE
  SYSTEM SHALL render it as in-progress ("Now"), above upcoming items and
  below no one; past items collapse to a dimmed done section.
- **R-today-5 (day complete):** WHEN all of today's timed items are past THE
  SYSTEM SHALL show a day-complete state with a preview of tomorrow's first
  item (and its leave-by, when legs exist).
- **R-today-6 (empty day):** WHEN today has no itinerary items THE SYSTEM
  SHALL show an empty state with an add-item action and tomorrow's preview —
  never a blank screen.
- **R-today-7 (weather strip):** WHEN the today tab renders THE SYSTEM SHALL
  show a weather strip for the trip destination from the cached forecast
  (companion spec `GET /trips/:tripId/weather` snapshot; §2.4), including a
  staleness treatment per R-sync-2 when the data is old or offline; WHEN no
  forecast exists (coordless trip / never fetched) THE SYSTEM SHALL hide the
  strip — never block the timeline.
- **R-today-8 (quick actions):** WHEN the today tab renders THE SYSTEM SHALL
  show quick actions — open map (map tab), add expense (`money/expense/new`
  modal), add photo (photo capture/upload into `more/photos`) — matching the
  navigation spec's screen inventory ("quick actions (add expense, add
  photo, open map)").
- **R-today-9 (item tap):** WHEN a timeline item is tapped THE SYSTEM SHALL
  cross-tab push to the itinerary item detail
  (`itinerary/item/[itemId]`) per navigation §2.4 today entry.
- **R-today-10 (pre-trip state):** WHEN the today tab is opened for a trip
  that has not started THE SYSTEM SHALL show a countdown-to-start state
  ("Trip starts in N days") with readiness nudges (packing list, document
  expiry within trip dates, offline pack status) — the tab is reachable
  before the trip even though the default tab is itinerary (R-nav-8).
- **R-today-11 (post-trip state):** WHEN the today tab is opened for a past
  trip THE SYSTEM SHALL show a trip-ended state pointing to photos/memories —
  never today's (empty) timeline.
- **R-today-12 (collaborator-activity ticker):** WHEN recent collaborator
  activity exists THE SYSTEM SHALL show a compact activity ticker (e.g.
  "Alex added Dinner at Ichiran · 2 h ago") — data source has an open
  marker (§1.4).
- **R-today-13 (spanning stays):** WHEN a lodging booking spans today
  (checked in, not yet checked out) THE SYSTEM SHALL represent it on the
  today surface without treating it as a timed event (e.g. a passive
  "Staying at Park Hyatt" context row, not a hero/countdown candidate) —
  exact rendering pends the multi-day marker (§1.4).

### 1.2 Offline behavior & sync orchestration

- **R-sync-1 (offline-complete render):** WHEN the device is offline and the
  trip's offline bundle exists THE SYSTEM SHALL render the today tab fully
  from the device SQLite trip bundle — timeline, hero, leave-by (precomputed
  legs), weather snapshot, quick actions — with zero network dependency
  (PLANNING: active trip bundle in SQLite; navigation §2.8: "all `[tripId]`
  tabs must still mount from cache for the active trip").
- **R-sync-2 (staleness honesty):** WHEN rendering from cache THE SYSTEM
  SHALL show an unobtrusive offline/stale indicator carrying the bundle's
  last-sync time, and volatile surfaces (weather, transit legs) SHALL show
  their own fetched-at age when older than their TTL — stale data is shown,
  never silently passed off as fresh (degrade gracefully, PLANNING
  cross-cutting).
- **R-sync-3 (bundle contents):** THE active-trip offline bundle SHALL
  contain: itinerary items, bookings (with details), saved places + their
  `places` rows, travel legs, tour-guide bundles (`status='ready'` content),
  trip member profiles (display names/avatars for attribution), the latest
  weather snapshot (best-effort), and the trip row itself — matching
  PLANNING ("itinerary + bookings + saved places + tour content + leg ETAs
  in SQLite") plus display dependencies. The Mapbox tile pack downloads
  alongside via `offlineManager` (maps spec owns tile-pack mechanics).
- **R-sync-4 (bundle download triggers):** THE SYSTEM SHALL download/refresh
  the bundle: (a) automatically on wifi when a trip approaches activation
  (default: within 3 days of `start_date`, config) — the wifi
  trip-activation download per the maps/AI research pattern (tour bundles
  "downloads bundle … into expo-sqlite over wifi"); (b) manually from trip
  settings ("offline pack download/refresh", navigation §2.4); (c)
  incrementally after itinerary-change invalidations while online. Automatic
  full downloads SHALL NOT run on cellular (tile packs + tour bundles are
  heavy); manual download on cellular is allowed with a size warning.
- **R-sync-5 (mutation queue):** WHEN a write occurs while offline (packing
  check-off, expense add, itinerary edit, photo caption …) THE SYSTEM SHALL
  enqueue it in a persisted mutation queue and apply it optimistically to
  the local cache; WHEN connectivity returns THE SYSTEM SHALL drain the
  queue in FIFO order per trip; conflicts resolve last-write-wins (PLANNING
  collab sync v1).
- **R-sync-6 (visible failures):** WHEN a queued mutation is rejected by the
  server on drain (validation, authz, entity deleted) THE SYSTEM SHALL
  surface it in a visible failed-changes state with the payload retained and
  retry/discard actions — never silently dropped (capture-queue pattern:
  failures visible).
- **R-sync-7 (push invalidation):** WHEN an `itinerary_change` push arrives
  while online THE SYSTEM SHALL map its `invalidate` scopes to TanStack
  Query key invalidations (refetch), and, when the trip's bundle exists,
  schedule an incremental bundle refresh (R-sync-4c); pushes arriving for
  the actor's own device (matching `actor_id`) SHALL NOT trigger user-visible
  notification handling, only cache refresh.
- **R-sync-8 (volatile data online-only):** Live place details (hours),
  transit re-routing, and fresh weather SHALL remain online-only surfaces
  that degrade to their cached-or-hidden states offline — never spinners
  that block the timeline (PLANNING: volatile data online-only, degrade
  gracefully).

### 1.3 Notification tap-routing

- **R-route-1 (registry only):** WHEN any notification (server push or
  local) is tapped THE SYSTEM SHALL resolve its payload `route` through the
  navigation deep-link registry (§2.3) — cold start and warm start SHALL
  route identically (R-nav-16 machinery); no notification handler navigates
  outside the registry. (Navigation spec §2.8 explicitly delegates
  push-notification tap-routing to this spec, "through the same deep-link
  registry".)
- **R-route-2 (guards apply):** WHEN a notification routes into a trip THE
  SYSTEM SHALL apply the same auth + membership guards as any deep link
  (stash-and-resume when signed out, R-nav-14; membership check R-nav-20;
  no-access state R-nav-15 — e.g. tapping a stale notification for a trip
  the user has left).
- **R-route-3 (per-category targets):** notification categories SHALL route
  per the table in §2.8 — one registry mapping, covered by tests per
  category.
- **R-route-4 (leave-by focus):** WHEN a leave-by local notification is
  tapped THE SYSTEM SHALL land on the today tab with the hero focused on the
  notification's `item_id` (scroll/highlight), falling back to the plain
  today tab when the item no longer exists.

### 1.4 Markers repeated from canonical specs (verbatim + cite)

From `.specs/client/navigation.spec.md` §1 Open questions — the landing
behavior this surface participates in (navigation spec is CANONICAL for
landing; repeated here because the 2+-active case decides which trip's
today tab wins):

> [NEEDS CLARIFICATION: Multiple concurrently-active trips on launch —
> R-nav-6 covers exactly one. With 2+ active (rare but possible), land on
> the trip list, or on the most-recently-viewed active trip's today tab?]

From `.specs/database/schema.spec.md` §3.3.4 (`trips`) — decides what
"active" means for R-today-1/10/11 and the bundle trigger R-sync-4:

> [NEEDS CLARIFICATION: `status` transitions — PLANNING implies automatic
> (`today` view "auto-default while trip active"). Is status purely derived
> from dates by a daily job/on-read (planning→active on start_date,
> active→past after end_date), or can users manually override (e.g. mark a
> trip past early)? Manual override is user-visible.]

From `.specs/database/schema.spec.md` §3.3.10 (`itinerary_items`) — decides
R-today-13's rendering:

> [NEEDS CLARIFICATION: multi-day bookings (lodging check-in→check-out) on
> the calendar — one spanning item (`end_day` used, rendered across days) or
> two point items (check-in item + check-out item)? Affects whether
> `end_day` stays; user-visible calendar rendering.]

### 1.5 New markers owned by this spec

- [NEEDS CLARIFICATION: collaborator-activity ticker data source — the v1
  data model has no activity/event-log entity (PLANNING keeps the event-log
  seam for later; collab sync v1 is REST + refetch + push invalidation).
  Options: (a) derive a best-effort ticker from `created_at`/`created_by`
  (+ `updated_at`) on recent trip-scoped rows — cheap, no schema change,
  can't attribute edits/deletes precisely; (b) add a `trip_activity` table —
  proper feed, but an entity-list addition needing Sean's nod (same class as
  the schema spec's recaps marker); (c) drop the ticker from the v1 today
  view and lean on itinerary-change pushes alone. User-visible; R-today-12
  is unbuildable until answered.]

---

## 2. Design

### 2.1 Screen layout (zones, top to bottom)

```
[tripId]/today/index.tsx
┌──────────────────────────────────────────┐
│ header: trip name · day x/y · offline/   │  ← stale indicator (R-sync-2)
│         stale pill when applicable       │
├──────────────────────────────────────────┤
│ weather strip (compact, horizontal)      │  ← hidden when no data (R-today-7)
├──────────────────────────────────────────┤
│ HERO — next item                         │  ← countdown + leave-by (R-today-2/3)
│  · staying-at context row when a         │
│    spanning stay exists (R-today-13)     │
├──────────────────────────────────────────┤
│ quick actions: map · add expense ·       │  (R-today-8)
│                add photo                 │
├──────────────────────────────────────────┤
│ activity ticker (single row, tappable)   │  (R-today-12 — pends marker)
├──────────────────────────────────────────┤
│ timeline (FlashList/FlatList —           │  (R-today-1/4; mobile landmine:
│  virtualized):                           │   long lists virtualize)
│   done items (collapsed, dimmed)         │
│   ▸ NOW item                             │
│   ▸ leg row (walk 12 min)                │
│   ▸ upcoming items + interleaved legs    │
└──────────────────────────────────────────┘
```

Alternate full-screen states replace hero + timeline: pre-trip countdown
(R-today-10), day-complete (R-today-5), empty day (R-today-6), trip-ended
(R-today-11). All states keep the header; design-system components per
`.specs/design-system/tokens.spec.md`.

### 2.2 Timeline composition

Inputs (all cache/bundle-served, R-sync-1): today's `itinerary_items`
(`(trip_id, day, sort_order)` read), their `bookings`, `travel_legs` keyed
by `(from_item_id, to_item_id)`, member profiles for attribution.

Algorithm (pure function — unit-testable without UI):

```
compose(day items, legs, now):
  timed   = items with start_time, sorted (start_time, sort_order)
  untimed = items without start_time, sorted (sort_order)   → "anytime" section
  for consecutive timed pairs (a, b):
      leg = legs[(a.id, b.id)] preferring the user's last-used mode,
            else fastest available mode          → interleave leg row
  classify each timed item: done | now | upcoming   (R-today-4)
  hero = first upcoming                              (R-today-2)
  hero.leave_by = hero.start − leg.duration − buffer (R-today-3, shared fn
                                                      with companion R-notif-3)
```

Time semantics: booking-backed items use the booking's UTC instants
(`bookings.starts_at`) when present — exact across timezones; place-visit/
custom items use `day` + `start_time` wall-time interpreted in the device's
current timezone (schema §3.3.10: itineraries are planned in destination
local time; the traveler's device is in destination tz during the trip).
Same rule as companion R-notif-3 scheduling — one shared time-resolution
helper, one behavior.

### 2.3 Hero & countdown mechanics

- Countdown ticks on a 1-minute interval while focused; suspends on blur
  (R-today-2). Crossing `leave_by` escalates the leave-by line's emphasis
  (token-level styling, not a new state machine).
- Hero promotes to the next item when the current one starts (becomes
  "Now") — recomputed from `compose()` on each tick; no push/pull needed.

### 2.4 Weather strip

Renders the trip forecast snapshot: today (+ small next-days rail) —
`temp_min/max`, condition icon from `condition_code`, precip probability.
Data: TanStack Query over `GET /trips/:tripId/weather` (companion §3.5)
with the last response persisted into the bundle snapshot (R-sync-3);
offline renders the snapshot + fetched-at age (R-sync-2). Units per
`UserPrefs.units` — conversion is presentation (schema §3.4.5).

### 2.5 Quick actions & ticker

- Quick actions are navigation calls only — no logic: map tab switch,
  `money/expense/new` modal, photo add flow (photos spec owns capture
  mechanics). All function offline: expense/photo writes enqueue per
  R-sync-5.
- Ticker (pending §1.5 marker): single compact row, newest event, tap →
  fuller activity view or the touched entity — unresolved until the data
  source is picked.

### 2.6 Offline bundle contract (device SQLite)

Storage: expo-sqlite database per PLANNING/AI research ("bundle keyed by
`place_id` into expo-sqlite"); TanStack Query persist + MMKV covers warm
query cache, the SQLite bundle is the durable offline source for active
trips. One bundle per trip; schema mirrors the server rows it caches
(same `@gogo/shared` shapes — no bespoke local types).

| Bundle section | Source | Refresh |
|---|---|---|
| trip row, members (profiles) | `GET /trips/:tripId` + members | every sync |
| itinerary items + bookings | itinerary/bookings endpoints | every sync + incremental on push invalidation |
| saved places + `places` rows | places endpoints | every sync |
| travel legs | legs endpoint (leg-ETA refresh job keeps them fresh server-side) | every sync |
| tour-guide bundles (`ready`) | tour bundle manifest (`(trip_id, place_id)` unique read) | wifi sync only (heavy) |
| weather snapshot | `GET /trips/:tripId/weather` | every sync, best-effort |
| Mapbox tile pack | `offlineManager` (maps spec) | wifi sync only |

Sync orchestration ("what syncs when", R-sync-4):

```
trigger                        scope
────────                       ─────
wifi + trip within 3d of start full bundle + tile pack + tour bundles (auto)
trip settings manual action    full bundle (+ size warning on cellular)
itinerary_change push (online) incremental: invalidated scopes only
app foreground (online)        TQ refetch-on-focus (PLANNING) + leave-by
                               reschedule (companion R-notif-3)
connectivity restored          mutation-queue drain (R-sync-5) THEN
                               incremental refresh (server truth wins after
                               drain)
```

Staleness display (R-sync-2): bundle stores `synced_at`; header pill shows
"Offline — updated 2 h ago" when disconnected, or "Updated 3 d ago" online
when a sync hasn't succeeded recently (threshold 24 h, config).

### 2.7 Mutation queue contract

Fulfills contracts spec §3.8's handoff (the offline/sync spec "will define
its queue-entry schema IN shared when specced"). Field-exact Zod schema
lands in `@gogo/shared` (`domains/offline.ts`) with this shape:

```
OfflineMutation = {
  id: Uuid,                      // client-generated (IdGenerator port)
  trip_id: Uuid,
  descriptor_key: string,        // EndpointDescriptor identity (method+path)
  params: object,                // path params
  payload: object,               // request body (already Zod-valid locally)
  queued_at: ISODateTime,
  attempts: int,
  status: 'pending' | 'failed'   // failed = server-rejected, awaiting user
}
```

Semantics:

- **Enqueue:** offline (or request-failed-network) writes append; optimistic
  cache update applies immediately (TanStack Query mutation defaults).
- **Drain:** FIFO per trip on connectivity restore; each entry replays
  through the standard `ApiClient` (descriptor-addressed — same validation
  path as live calls, R-shared-3). Success → dequeue. Network failure →
  halt drain, retry with backoff (order preserved).
- **Server rejection** (4xx): mark `failed`, keep payload, surface in the
  failed-changes UI (R-sync-6) with retry (re-queues) / discard (removes +
  rolls back the optimistic patch by invalidating affected queries).
- **Conflicts:** last-write-wins per PLANNING collab v1 — no vector clocks,
  no merge UI; the post-drain incremental refresh reconciles the cache to
  server truth.
- **Queue is per-device, persisted** (survives app kill), capped with
  oldest-first eviction warning at 500 entries (config; hitting the cap in
  practice means days offline with heavy edits — warn, don't drop silently).
- Photo binary uploads do NOT ride this queue (upload-url flows need
  liveness); photo *metadata* edits do. Capture-inbox actions are
  online-only (review requires server parse state).

### 2.8 Notification tap-routing table (R-route-3)

All routes resolve through the navigation deep-link registry (§2.3); this
table is the registry's notification-category extension (navigation §2.8
reserved the seam). Guards: R-route-2.

| Category (companion §3.4) | Route target | Fallback when entity missing |
|---|---|---|
| `itinerary_change` (single item) | `/[tripId]/itinerary/item/[itemId]` | trip default tab (R-nav-7/8) |
| `itinerary_change` (coalesced) | `/[tripId]` default tab | — |
| `daily_digest` | `/[tripId]/today` | trip list if no longer a member (R-nav-15) |
| `leave_by` (local) | `/[tripId]/today` + hero focus on `item_id` (R-route-4) | plain today tab |
| `document_expiry` | `/[tripId]/more/documents` when trip-associated, else documents surface via profile home [depends on navigation's profile-surface marker — vault entry for tripless docs follows that resolution] | documents list |
| `settle_up` | `/[tripId]/money/request/[requestId]` (navigation registry row) | money tab, request-resolved empty state |
| `flight_status` | reserved (companion R-notif-6 marker) | — |

Foreground arrivals: `itinerary_change` applies invalidation silently
(R-sync-7) and shows no banner for the actor's own echo; other categories
show the in-app banner (design-system toast/banner) instead of an OS
notification while foregrounded.

### 2.9 testIDs (grammar per navigation §2.7 — screen prefix `today`)

Root: `today-screen`. Interactive/asserted elements:

| Element | testID |
|---|---|
| Offline/stale pill | `today-offline-pill` |
| Weather strip | `today-weather-strip` |
| Hero card (tap → detail) | `today-hero-card` |
| Hero leave-by line | `today-hero-leave-by` |
| Quick action: map | `today-button-map` |
| Quick action: add expense | `today-button-add-expense` |
| Quick action: add photo | `today-button-add-photo` |
| Activity ticker row | `today-ticker` |
| Timeline list | `today-list` |
| Timeline item (dynamic) | `today-list-item-{itemId}` |
| Leg row (dynamic) | `today-leg-{fromItemId}-{toItemId}` |
| Done-section toggle | `today-toggle-done` |
| Empty-state add action | `today-button-add-item` |
| Pre-trip packing nudge | `today-button-packing` |
| Pre-trip documents nudge | `today-button-documents` |
| Pre-trip offline-pack nudge | `today-button-offline-pack` |
| Failed-changes banner | `today-banner-failed-changes` |
| Failed-changes retry / discard | `today-banner-failed-changes-retry` / `-discard` |

Static IDs stable across renders; dynamic qualifiers are entity ids, never
render indexes (navigation §2.7 rule 5).

### 2.10 Out of scope (explicit)

- **Landing/default-tab logic** — navigation spec is CANONICAL (R-nav-5..9,
  §2.5); this spec only builds the surface those rules land on.
- **Tile-pack download mechanics + map rendering** — maps spec
  (`offlineManager`/TileStore per maps research); R-sync-3 only requires the
  pack rides the same wifi trigger.
- **Tour-guide content UX** — AI spec (bundle *storage* is R-sync-3's
  concern; playback isn't).
- **Leave-by local notification scheduling** — companion spec R-notif-3/
  NTF-4 (this spec consumes the same leave-by computation for display).
- **Server push sending, prefs, catalog** — companion spec.
- **Expense/photo/packing screen internals** — their domain specs; quick
  actions only navigate.
- **Realtime presence/live cursors** — PLANNING: no sockets v1; event-log
  seam later.
- **Recap surface for past trips** — recaps have an open persistence marker
  (schema §3.7); R-today-11 links to photos only until that resolves.

---

## 3. Tasks

Each traceable to requirement IDs; one agent session each; become `T-N.M`
rows at build time. TDY-2/3 are cross-cutting infrastructure other during-
trip surfaces (packing, money) will consume — they land before or with
TDY-1.

| ID | Task | Covers |
|---|---|---|
| TDY-1 | Today screen: layout zones, timeline composition (pure `compose()` + UI), hero/countdown/leave-by display, weather strip, quick actions, pre/post/empty/complete states, testIDs. | R-today-1..11, R-today-13 |
| TDY-2 | Offline bundle infra: SQLite schema mirroring shared shapes, bundle download/refresh orchestrator (wifi trigger, manual trigger, incremental refresh), `synced_at` staleness plumbing, weather snapshot persistence. | R-sync-1..4, R-sync-8 |
| TDY-3 | Mutation queue: shared `OfflineMutation` schema (`domains/offline.ts` — coordinated contracts-spec addition), persisted queue + optimistic updates, FIFO drain + backoff, failed-changes UI with retry/discard. | R-sync-5, R-sync-6 |
| TDY-4 | Notification tap-routing: registry extension per §2.8 table, cold/warm parity, foreground banner behavior, `itinerary_change` → TQ invalidation mapping, hero focus for leave-by taps. | R-route-1..4, R-sync-7 |
| TDY-5 | Ticker (blocked on §1.5 marker) — placeholder task, unschedulable until the data source is decided. | R-today-12 |

**Tests required (minimum):**

- [ ] `compose()` unit suite: ordering, leg interleave, done/now/upcoming
      classification, hero selection, leave-by math (incl. no-leg and
      untimed items), booking-UTC vs wall-time resolution (TDY-1)
- [ ] Each full-screen state renders on its condition: pre-trip, empty day,
      day complete, trip ended (TDY-1)
- [ ] Airplane-mode E2E: bundle present → today renders complete with
      offline pill + stale ages; no spinner, no blank (TDY-2, R-sync-1/2)
- [ ] Bundle triggers: wifi+T−3d auto-download fires once; cellular
      auto-download never fires; manual download works (TDY-2)
- [ ] Queue: offline expense add + packing check-off apply optimistically,
      drain FIFO on reconnect, server truth reconciles after (TDY-3)
- [ ] Rejected queued mutation surfaces in failed-changes with working
      retry and discard; nothing silently dropped (TDY-3, R-sync-6)
- [ ] Tap-routing per category table, cold AND warm start; stale
      notification for a left trip → no-access state (TDY-4, R-route-1..3)
- [ ] `itinerary_change` foreground arrival invalidates mapped queries
      without a banner for the actor (TDY-4, R-sync-7)
- [ ] testID audit: every §2.9 element present and stable (TDY-1;
      navigation R-nav-22)

---

*Trace: R-today/R-sync/R-route cite design sections inline. §1.4 markers
resolve in their canonical homes (navigation, schema); §1.5's ticker marker
is this spec's P-2 interview question for Sean. Zero markers = approvable.*
