# Client — Map Screen & Offline Packs — `.specs/client/map.spec.md`

> **Task:** T-2.3 (maps/places bundle) · **Status:** DRAFT — pending Sean
> approval (P-2 gate 3). Not approvable until zero `[NEEDS CLARIFICATION]`
> markers remain.
>
> **Sources:** `.specs/research/maps-places.md` (Mapbox SDK facts: offline
> StylePacks/TileRegions, 750-pack ceiling, clustering, attribution
> requirement, MarkerView budget), `.specs/client/navigation.spec.md`
> (map tab routes `map/index` + `map/place/[placeId]`, testID grammar §2.7,
> modal/sheet conventions §2.6), `.specs/design-system/tokens.spec.md`
> (Sheet, Badge, EmptyState, ErrorBanner, theme; §2.10 delegates Mapbox
> theme/pin colors HERE), `.specs/database/schema.spec.md` (places,
> saved_places, photos Law #3 indexes, tour_guide_bundles),
> `docs/PLANNING.md § Architecture` (foreground-only location lock; offline
> pattern), ADR-005.
>
> **Companion spec:** `.specs/api/places.spec.md` — server half of
> fetch-fresh/display-then-discard (R-map-9 ↔ R-places-11) and the shared
> region grid (§2.5 here ↔ §3.5 there).

---

## 1. Requirements (EARS)

Screen-level; every requirement names its testIDs (grammar: navigation spec
§2.7; full inventory §2.8).

### Map screen (`map/index`, root `map-screen`)

- **R-map-1 (pin layers):** WHEN the map tab mounts for a trip THE SYSTEM
  SHALL render, over the trip-region camera (§2.1): saved-place pins
  (`map-pin-saved-{placeId}`), itinerary-item pins day-color coded
  (`map-pin-itinerary-{itemId}`), and photo pins
  (`map-pin-photo-{photoId}`) — all from cached trip data so the render
  also works offline (PLANNING offline pattern).
  **AMENDED (B-7 part 3):** a place with no coordinates (a coordinate-less
  custom place) renders NO pin — never a malformed feature at `[null,
null]`; it still appears in list surfaces by name. See R-map-26.
- **R-map-2 (clustering):** WHEN pins overlap at the current zoom THE
  SYSTEM SHALL cluster them (`map-cluster-{clusterId}`) with a count badge;
  WHEN a cluster is tapped THE SYSTEM SHALL zoom/expand to reveal its
  members — never open a sheet for a cluster.
- **R-map-3 (day filter):** WHEN the user selects a day in the day filter
  (`map-day-filter`, chips `map-day-filter-chip-{dayIndex}` + `-all`) THE
  SYSTEM SHALL show only that day's itinerary pins (saved-place and photo
  pins remain, dimmed) and recenter the camera to fit them; default is All
  days.
  **AMENDED (round-2, T-8.2 — each ruled 2026-09-19):**
  - **Span-aware days (Q2-219):** a multi-day itinerary item (an `end_day`
    span, e.g. lodging) stays pinned on EVERY day it covers under the day
    filter (`dayIndex ≤ filter ≤ endDayIndex`), wearing its check-in day's
    color and glyph throughout, so "only that day's itinerary pins" reads
    as "items covering that day". This is a deliberate SUPERSET of the
    itinerary's check-in/check-out-only point-row treatment (R-itin-31:
    nights between render nothing in list mode); the map/itinerary
    divergence is ruled intentional.
  - **"All" and empty subsets (Q2-207):** WHEN "All" is re-selected THE
    SYSTEM SHALL refit the camera to all pins; WHEN the selected day has no
    pins THE SYSTEM SHALL move the camera nowhere.
  - **Chip range (Q2-208):** the chips span only the trip's own date range
    (`dayIndex` 0..N-1); items outside it (R-itin-1) still pin under "All"
    but get no chip — a negative-index chip id would fork the §2.7
    kebab-case testID grammar.
- **R-map-4 (pin tap → sheet):** WHEN a saved-place or itinerary pin is
  tapped THE SYSTEM SHALL present the place sheet (`map-sheet-place`,
  design-system Sheet — navigation spec: "Sheet over map (small) / PUSH
  (full detail)"); WHEN a photo pin is tapped THE SYSTEM SHALL open the
  photo viewer (cross-tab push, navigation spec `photo-viewer`).
  **AMENDED (round-2, Q2-217, ruled 2026-09-19):** the photo-pin family is
  empty in production until P-12 feeds it with located photos, but the
  press is wired now — it cross-tab pushes the viewer (tab jump first),
  never the place sheet and never a silent no-op (the T-8.2 shell's no-op
  was a placeholder, retired by the T-8.7 integration rider); the viewer
  screen itself is a placeholder until P-12.
- **R-map-5 (photo-pin privacy):** WHEN photo pins are rendered THE SYSTEM
  SHALL include only photos the viewer may see per the shared
  `canViewPhoto` helper (own photos + `trip`/`public` visibility) — a
  member's `private` photo never appears on another member's map (Law #3;
  contracts spec §3.4 `photo.ts`).
- **R-map-6 (attribution):** WHILE the map is visible THE SYSTEM SHALL
  display the Mapbox wordmark and attribution control unobscured by our
  overlays (pills, FABs, sheet at rest) — required by Mapbox terms
  (research: "attribution/wordmark required"); spine attribution strings
  come from the shared registry (places spec §3.2.4) via the attribution
  info sheet (`map-button-attribution`).
  **AMENDED (round-2, T-8.2 — each ruled 2026-09-19):**
  - **SDK ornaments (Q2-216):** the Mapbox logo sits bottom-left at token
    spacing and the SDK attribution control is offset 96 pt right of it.
    The exact fit is a phase-QA visual check (ornaments need a live
    style), not a spec-pinned pixel value.
  - **Attribution (i) button (Q2-222):** the tappable info opener
    (`map-button-attribution`) sits bottom-RIGHT — the SDK ornaments own
    bottom-left — and every later bottom-corner control (locate-me, R-map-16)
    composes around it, never on top of it.
- **R-map-7 (theming):** WHEN the app theme scheme is light/dark THE
  SYSTEM SHALL load the matching custom map style (§2.2) and derive all
  pin/route colors from `Theme` — no literal colors (tokens spec R-ds-7;
  §2.10 delegates map colors here).
- **R-map-8 (external nav handoff):** WHEN the user taps navigate
  (`map-sheet-place-button-navigate` / `place-detail-button-navigate`) THE
  SYSTEM SHALL hand off to Apple/Google Maps via URL scheme with the
  place's coordinates — never in-app turn-by-turn (competitor research:
  never replace the nav app).
  **AMENDED (B-7 part 3):** WHEN the place has no coordinates (a
  coordinate-less custom place) THE SYSTEM SHALL NOT render the navigate
  control at all — never a URL built from `null` coordinates, never merely
  a `disabled` affordance.
  **AMENDED (round-2, T-8.3 — Q2-232, as shipped):** the handoff goes
  through the Google Maps URLs API, with the place's coordinates as
  `destination` and no `travelmode` parameter — the T-7.5 `directions.ts`
  handoff applied verbatim. The Apple Maps variant is pending the Q2-125
  pick (client itinerary spec §2.7); Q2-232 and Q2-125 are one question, so
  this rule follows whatever that pick lands and is not re-litigated here.
  **AMENDED (round-2, T-8.7 — ruled 2026-09-19):** navigate is ENABLED
  offline on BOTH surfaces — the place sheet and the detail screen (Q2-258,
  superseding the detail-screen-only offline disable, Q2-254). Google Maps'
  own offline navigation exists, offline-inside-a-downloaded-pack is the
  headline P-8 use case, and R-map-22's degrade-with-notice applies only to
  entry points that cannot work at all (search, fresh details); an
  external-nav launch can.

### Place sheet & detail (`map/place/[placeId]`, root `place-detail-screen`)

- **R-map-9 (fetch-fresh, display-then-discard):** WHEN fresh premium
  details are shown (sheet or detail screen) THE SYSTEM SHALL fetch them
  via `GET /places/:id?fresh=true` per view, hold them in memory only, and
  SHALL NOT write them to the TanStack Query persister, SQLite, MMKV, or
  any log — the fresh query is excluded from persistence and configured
  non-cacheable (§2.4). Client mirror of places spec R-places-11
  (Foursquare zero-caching licensing).
- **R-map-10 (fresh degrade):** WHEN the fresh block is absent (offline,
  upstream error, no FSQ id, not entitled, MVP-deferred) THE SYSTEM SHALL
  render the full spine view with no error surface — premium fields
  appear when available, their absence is silent.
- **R-map-11 (save/unsave):** WHEN save is tapped (`place-detail-button-
save`, `map-sheet-place-button-save`) THE SYSTEM SHALL apply the change
  optimistically and reconcile; a 409 duplicate-save is treated as success
  (places spec R-places-16). Viewers see state, not the control (role from
  trip context).
  **AMENDED (round-2, T-8.4 — each ruled 2026-09-19):**
  - **409 seam (Q2-249):** WHEN the save POST answers 409 THE SYSTEM SHALL
    keep the optimistic row and invalidate the list so the server's truth
    lands; only non-409 errors reach the error handler.
  - **Unsave (Q2-250):** unsave has no success-equivalent error status —
    any failure rolls the optimistic removal back and invalidates the list.
  - **Note edit (Q2-251):** the saved-place note PATCH is NOT optimistic —
    "optimistically" above covers save/unsave only; every other mutation
    follows the house non-optimistic precedent (trip-settings,
    booking-update).
- **R-map-12 (add to itinerary):** WHEN "Add to day" is tapped
  (`place-detail-button-add-to-day` / `map-sheet-place-button-add-to-day`)
  THE SYSTEM SHALL open the itinerary add-item modal
  (`/[tripId]/itinerary/item/new`) prefilled `kind='place_visit'` +
  `place_id` (navigation spec route; itinerary spec owns the form).
  **AMENDED (round-2, T-8.4 — ruled 2026-09-19):** the prefill rides route
  params (Q2-253): `item/new` accepts `?placeId=` (a UUID) and
  `?placeName=` (display only, trimmed and capped at 100 chars — the write
  path stays id-truth). WHEN `placeId` is malformed or repeated THE SYSTEM
  SHALL degrade to the empty place picker; WHEN `placeId` is valid but
  `placeName` is missing, empty, or repeated THE SYSTEM SHALL still
  preselect the place, under the generic label "Selected place" — never an
  error either way.
  **AMENDED (round-2, T-8.7 — ruled 2026-09-19):** Add-to-day is hidden
  from viewers on both surfaces (Q2-268) — viewers cannot write the
  itinerary (R-ib-24), so they see state, not the control (the R-map-11
  posture, mirrored from place detail).
- **R-map-13 (tour-guide hook):** WHEN the trip has a `ready` tour-guide
  bundle for the place THE SYSTEM SHALL show the tour-guide entry point
  (`place-detail-button-tour-guide`) opening the bundle content surface
  (AI spec owns content + its screen); WHEN no bundle is `ready` the entry
  point is absent — never a broken tap.
  **AMENDED (round-2, Q2-245, ruled 2026-09-19):** until P-10 supplies the
  bundle read the entry point is not rendered at all (absent, not a broken
  tap); it lands with P-10.
- **R-map-14 (linked content):** WHEN the detail screen renders THE SYSTEM
  SHALL list the place's itinerary items and this-trip photos
  (viewer-visible only, R-map-5 rule) with taps cross-navigating to them;
  the saved-place note is editable inline for owner/editor
  (`place-detail-input-note`).
  **AMENDED (round-2, T-8.4 — ruled 2026-09-19):** linked rows land on the
  item's OWN detail, per kind (Q2-256): an item-kind row pushes
  `item/[itemId]`; a booking-kind row pushes `booking/[bookingId]` DIRECTLY
  — routed through `item/[itemId]` it would only replace itself (R-itin-27)
  and leave a back-stack bounce.

### Location (foreground-only — PLANNING lock)

- **R-map-15 (blue dot, foreground only):** WHEN when-in-use location
  permission is granted THE SYSTEM SHALL show the user puck on the map;
  THE SYSTEM SHALL NOT request always/background authorization, define
  background location capabilities, or track location while backgrounded —
  anywhere in the app (locked: foreground-only v1).
  **AMENDED (round-2, T-8.7 — each ruled 2026-09-19):**
  - **Re-sync is transition-only (Q2-261):** so a Settings grant or revoke
    is observed, the permission is re-read on every background→active
    transition — and NOT at mount: a permission granted in a previous
    session shows no puck until the first locate tap or the first
    background→active cycle (the revoke side shares the window: a revoke
    that round-trips while the screen is unmounted leaves stale distance
    rows until that cycle). A one-line mount-time `get` closes both gaps —
    it is a read, not a request, so it would not violate R-map-16 — and is
    the fix if phase QA finds the window annoying.
  - **Revoke clears position (Q2-262):** WHEN the re-sync observes a revoke
    THE SYSTEM SHALL clear the last-known position, keeping
    `position !== null ⟹ granted`, so every "distance when puck active"
    label (sheet and detail) keys on `position` alone and can never render
    from a revoked grant's stale fix.
- **R-map-16 (permission flow):** WHEN the user first taps locate-me
  (`map-button-locate`) THE SYSTEM SHALL request when-in-use permission
  (no request on mount); WHEN permission is denied THE SYSTEM SHALL keep
  the map fully functional without the puck, and locate-me SHALL show a
  one-tap path to Settings — never a repeated prompt loop.
  **AMENDED (round-2, T-8.3/T-8.7 — Q2-234 and Q2-266 ruled 2026-09-19;
  Q2-239 as shipped at T-8.3, superseded by Q2-266):**
  - **Rationale first (Q2-234):** WHEN locate-me is tapped before any grant
    THE SYSTEM SHALL front the one system prompt with a ConfirmDialog
    carrying the rationale copy (§2.6) — declining changes nothing. WHEN
    the system prompt is then denied THE SYSTEM SHALL record the denial and
    STOP: the Settings dialog waits for the user's NEXT locate tap — no
    repeated prompt loop, and never surfaced unprompted. Every tap in the
    denied state raises the Settings dialog (user-initiated and dismissible
    each time, hence non-blocking).
  - **Granted but the read fails (Q2-239 — as shipped at T-8.3, superseded
    by Q2-266 below):** the T-8.3 build raised the denial's "Location is
    off" dialog here; Q2-239's flagged alternative — distinct failure-arm
    copy — is what the T-8.7 rider shipped and Q2-266 keeps. End state: WHEN
    permission is granted but the position read rejects (Location Services
    off, or a transient GPS fault) THE SYSTEM SHALL raise the
    Settings-hop dialog with its own copy, distinct from the denial's
    (Q2-266, below) — Settings is the actionable path for the services-off
    cause — and keep the map fully functional without the puck.
  - **Unavailable-dialog copy (Q2-266):** title "Couldn't get your
    location"; body "Your location didn't come through — Location Services
    may be off, or the signal dropped. Check Settings, or try again in a
    moment." Settings remains the confirm hop (the actionable path for the
    persistent cause); "try again" names the transient one. The denial
    dialog keeps its own "Location is off" copy.
- **R-map-17 (locate-me):** WHEN locate-me is tapped with permission
  granted THE SYSTEM SHALL animate the camera to the user with the trip
  pins still loaded (no layer reset).
  **AMENDED (round-2, T-8.3 — each ruled 2026-09-19):**
  - **Single shot (Q2-235):** each locate tap performs ONE position read
    (`getCurrentPositionAsync`) — never a continuous `watchPositionAsync`;
    the fly-to and the distance labels need a single fix, and live updates
    are the SDK puck's own concern. The fly-to zoom is the fixed single-pin
    zoom, 14.
  - **Distance labels (Q2-235):** metric ("850 m", "1.2 km", "23 km"),
    haversine on-device, never sent to the server. The unit cut branches on
    the ROUNDED value so a label never misstates magnitude: 999.6 m renders
    "1.0 km", never "1000 m"; the 10 km cut is a precision switch inside
    the unit, so 9999.6 m renders "10.0 km".
  - **Camera-intent store (Q2-236):** the locate fly-to hands the camera
    its target through a consume-once intent store that is NOT trip-scoped —
    an intent carries only the user's own location, so the worst case is a
    misplaced viewport (contrast the trip-scoped pending-focus, §2.7).

### Offline tile packs (StylePack + TileRegion)

- **R-map-18 (auto-download at activation):** WHEN a trip becomes active
  AND the device is on unmetered wifi AND no `ready`/current pack exists
  for the trip THE SYSTEM SHALL automatically download the style pack and
  the trip-region tile pack (§2.5), surfacing progress in the map status
  pill (`map-pill-offline`); WHEN not on wifi THE SYSTEM SHALL defer and
  retry on the next wifi + app-active window (download billing is $0 —
  research — the wifi gate is for the user's data plan, not cost).
  **AMENDED (B-7 part 3):** WHILE the trip's destination has no
  coordinates THE SYSTEM SHALL stand the WHOLE pack machine down (state
  pinned `none`, no fingerprint, no network listener, no SDK touch) rather
  than attempt a download the region grid cannot compute — see R-map-26.
  **AMENDED (Q2-186, ruled 2026-10-06, Sean) — activation mount:** THE
  SYSTEM SHALL mount the offline-pack controller (`useOfflinePackController`)
  at the trip-scoped root layout, so that WHEN a trip's effective status
  flips to `active` the wifi-gated auto-download triggers regardless of which
  surface is mounted — map tab, trip settings, or any other. The stand-down
  rules (the coordinate-less stand-down above and the unusable-destination
  stand-down in the round-2 block below) and the arms-only-from-`none` rule
  are unchanged. Consequence
  of the root mount: the flip is observed for as long as that layout is
  mounted, so no particular surface has to be showing — which closes the
  one-visit-late gap (a trip that flipped `active` before the map tab or
  settings mounted used to download only on the NEXT visit).
  **AMENDED (round-2, T-8.5 — each ruled 2026-09-19):**
  - **Arms only from `none` (Q2-272):** auto-download starts only WHEN the
    pack state is `none`. A `stale` pack (style or region drift) requires a
    manual refresh — packs never auto-refresh (§2.5 trigger 3 outranks a
    loose reading of "no `ready`/current pack"); a `failed` pack requires
    the user's retry (R-map-21), never a silent loop.
  - **`failed` is session-scoped (Q2-274):** a failed state lives in the
    store only (not annotated); after a restart an incomplete download reads
    `none`, so the next wifi window re-attempts it, while in-session the
    retry affordances own it.
  - **Unusable destination (Q2-280):** WHEN the destination coordinates are
    unusable (NaN — the region grid throws on them) THE SYSTEM SHALL stand
    the WHOLE pack machine down: no fingerprint, no effects, state pinned
    `none` — the same posture as the coordinate-less stand-down above.
  - **"Unmetered wifi" (Q2-284):** defined in §2.5 (Connectivity
    detection).
- **R-map-19 (manual management UI):** WHEN the user opens trip settings →
  Offline map (`trip-settings-list-item-offline` → section testIDs
  `offline-pack-*`) THE SYSTEM SHALL show pack state (`none / downloading
(progress) / ready (size, date) / stale / failed`) with actions:
  download (`offline-pack-button-download` — allowed on cellular after a
  size-estimate ConfirmDialog), refresh (`offline-pack-button-refresh` —
  packs don't auto-update; research), delete (`offline-pack-button-delete`,
  ConfirmDialog).
  **AMENDED (round-2, T-8.5 — ruled 2026-09-19):** the cellular-data
  ConfirmDialog fronts refresh and retry downloads too, not only a first
  download (Q2-283) — they cost the same data; each dialog is keyed by its
  triggering button (navigation spec §2.7 rule 4). The management surface
  is the trip-settings Offline-map sheet (`trip-settings-sheet-offline`).
- **R-map-20 (pack hygiene / 750 ceiling):** WHEN a trip is deleted or the
  user leaves it THE SYSTEM SHALL delete its packs; WHEN a trip
  transitions to `past` THE SYSTEM SHALL offer pack deletion
  (non-blocking prompt, also available in management UI); WHEN a new
  download would approach the device tile-region ceiling (750 cumulative —
  research) THE SYSTEM SHALL first purge packs of `past` trips
  (oldest-first) — the ceiling is never user-visible as a failure.
  **AMENDED (round-2, T-8.5 — each ruled 2026-09-19):**
  - **Past-trip offer (Q2-276):** "offer pack deletion on `active → past`"
    ships as a non-blocking OFFER LINE (`offline-pack-past-offer`) on the
    pack-management surfaces — there is no background status-transition
    observer to hang a modal off — so it renders wherever pack management
    is visible: a past trip with a saved pack shows it, an active trip never
    does. The ceiling purge backstops a user who never opens a management
    surface.
  - **Delete/leave hygiene (Q2-278):** pack deletion rides `exitToTripList`
    — the only exit surface for both the delete and leave flows, including
    leave's converged-404 arm — and is fire-and-forget, so cleanup never
    blocks navigation.
  - **Orphan sweep (Q2-273):** the sweep targets only UNACCOUNTED packs
    (`trip-*` with no local MMKV annotation); a paginated trip list can
    never safely be the sweep's source of truth, since sweeping against a
    cached first page would delete page-2 trips' live packs. Documented
    gap: a pack for a trip deleted remotely on another device persists
    locally until the delete/leave hook or sweep conditions catch it.
- **R-map-21 (download failure):** WHEN a pack download fails THE SYSTEM
  SHALL mark the pack `failed` with a retry action in the pill and
  management UI (`offline-pack-button-retry`) and keep the map fully
  usable online — pack state never blocks map interaction.
  **AMENDED (B-7 part 3):** a coordinate-less trip can never REACH `failed`
  — R-map-18's stand-down (below) keeps it pinned to `none` with the
  R-map-26 explanation instead.
- **R-map-22 (offline behavior):** WHEN the device is offline within a
  downloaded region THE SYSTEM SHALL render tiles from the pack and pins
  from cached trip data; search and fresh details are unavailable offline
  and their entry points degrade with an offline notice (no spinners that
  never resolve). Outside pack coverage the basemap may be blank — pins
  and the sheet still function.

### Map ↔ itinerary linking

- **R-map-23 (map → itinerary):** WHEN "View in itinerary" is tapped on an
  itinerary pin's sheet (`map-sheet-place-button-view-itinerary`) THE
  SYSTEM SHALL cross-tab navigate to that item's detail in the itinerary
  stack (navigation spec cross-tab push pattern, R-nav-10 preserved).
  **AMENDED (round-2, T-8.7 — each ruled 2026-09-19):**
  - **Right item, itinerary-pin origin only (Q2-260):** itinerary pins are
    per-ITEM, so the pressed pin's `selectedItemId` rides the map-sheet seam
    and "View in itinerary" lands on the RIGHT item for a place visited
    twice. The action renders ONLY for a selection that originates from a
    resolvable itinerary pin — saved-pin, search, and focus selections never
    show it ("itinerary pins only", read strictly).
  - **One cache for kind (Q2-267):** the sheet resolves the linked item's
    kind (item vs booking, per the R-map-14 landing rule) from the same
    cache the map's own pin builder reads, so the map and the sheet can
    never disagree about it.
- **R-map-24 (itinerary → map):** WHEN an itinerary item's place link is
  tapped (itinerary spec surface) THE SYSTEM SHALL switch to the map tab,
  select that pin, center the camera on it, and open its sheet — the map
  tab's own stack state is otherwise preserved.

### Resolved questions (Gate 2, 2026-07-09)

- R-map-18's "becomes active" trigger — Resolved at
  `.specs/database/schema.spec.md`:§3.3.4 `trips.status` (Gate 2,
  2026-07-09): status is date-derived with manual owner override (override
  wins until cleared); the auto-download trigger follows the effective
  status. **Mount point (Q2-186, ruled 2026-10-06, Sean):** the controller
  that observes the flip is mounted at the trip-scoped root layout, not on
  a particular surface — see R-map-18.
- Destination coordinates — Resolved at
  `.specs/database/schema.spec.md`:§3.3.4 `trips` (Gate 2, 2026-07-09):
  destination input is structured (Overture-backed search), so
  `destination_lat/lng` are always present — the tile region and default
  camera are always derivable.
  **AMENDED (B-7 part 3, `B-7/nullable-custom-coords`, Sean ruling
  2026-09-13):** no longer true. A trip's destination may be a `source=
'custom'` place with NO coordinates (created via the destination search's
  empty-results fallback, R-tripui-23/24 in the trips client spec) —
  `destination_lat/lng` are now `number | null` on the wire
  (`.specs/database/schema.spec.md` §3.3.4/§3.3.7 updated). See R-map-26.
- **Place discovery on the map — decided: option (a), a search bar on the
  map tab** querying `GET /places/search` (spine-backed) with results as
  temporary pins; no basemap-POI tap-through in v1 (option b composes
  later). The navigation spec's map inventory gains the search bar
  (companion scope note — that spec's owner is syncing). See R-map-25.
  (Resolved 2026-07-09, Gate 2)

- **R-map-25 (map search):** WHEN the map search bar (`map-search-input`)
  receives ≥ 2 characters THE SYSTEM SHALL query `GET /places/search`
  (debounced, geo-biased to the current viewport) and render results as
  temporary pins (`map-pin-search-{placeId}`) + a result list; tapping a
  result opens the standard place sheet (save/add-to-day work as on any
  pin); clearing the search removes temporary pins. Offline, the search
  entry degrades with an offline notice (R-map-22 rule). (Resolved
  2026-07-09, Gate 2)
  **AMENDED (B-7 part 3):** the ≥ 2 character floor applies only WHEN the
  trip has destination coordinates to bias the query with (a `bbox` bound).
  WHILE the trip has none, see R-map-26 — the floor widens and the bound
  drops entirely, never a fixed 2-char request against no geo bound (a live
  server 400).
  **AMENDED (round-2, T-8.3 — each ruled 2026-09-19):**
  - **Geo bound (Q2-223):** the bound is the destination-region envelope —
    the envelope of `regionCellsForDestination`, i.e. the exact spine-ingest
    coverage (places spec §3.5) — NOT the live viewport. The viewport bias
    named above applies once camera state is exposed to the search call
    site, a one-call-site swap.
  - **Antimeridian (Q2-224):** WHEN the destination sits within one cell of
    ±180° THE SYSTEM SHALL search a clipped box — wrapped neighbor cells
    are dropped — rather than issue two calls or error.
  - **Request shape (Q2-226):** `trip_id` rides every map search (custom
    places saved to this trip stay findable, R-places-8; membership is
    server-checked); the client pins the page limit at 20.
  - **Query key (Q2-225):** map search is its own query-key family, disjoint
    from destination search — results are global spine rows, and the key is
    suffixed with the tripId so per-trip custom-place visibility never
    bleeds across trips.
  - **Offline (Q2-231):** the proactive arm (device known offline) disables
    the query outright — no spinner that never resolves — and the reactive
    arm keys off the status-0 transport marker; both arms render the same
    offline notice (`map-search-offline`), while real server errors keep the
    retryable banner (`map-search-error`).
  - **Result selection (Q2-229):** a result tap selects the FULL `Place`
    row (the result may be unsaved) and first closes any open place sheet
    before the sheet re-opens on the result; dismissing the sheet clears
    every selection source, search included.
  - **Selection lives at the screen (Q2-259, T-8.7):** the search selection
    is held at SCREEN level, lifted out of the sheet slot — only the screen
    can observe a search-PIN tap, and two homes for one selection would
    re-create a precedence bug — so a search-pin tap and a result-list tap
    land on one selection state.

- **R-map-26 (coordinate-less destination degrade), NEW — B-7 part 3
  (`B-7/nullable-custom-coords`, Sean ruling 2026-09-13):** WHILE a trip's
  destination has no coordinates (a `source='custom'` place created via the
  empty-results fallback, R-tripui-23, that was never given a location) THE
  SYSTEM SHALL:
  - open the map tab at a WORLD camera (never a Null-Island / `(0, 0)`
    center) with an honest empty state (`map-empty-state`): title "No map
    area for this trip yet", body "Set a destination with a location in
    trip settings.";
  - run map search (R-map-25) UNBOUNDED — no `bbox` — at the shared
    text-only floor (`PLACES_SEARCH_TEXT_ONLY_MIN_CHARS`, 4 chars; places
    spec R-places-27) instead of the geo-biased 2-char floor, with a
    standing caption (`map-search-notice-no-destination`) naming the wider
    floor's reason; a search under the floor fires NO request (would be a
    live server 400 with no bbox to widen it);
  - render NO pin (saved, search-result, or otherwise) for any place that
    itself has no coordinates — never a malformed `[null, null]` GeoJSON
    feature; such places still appear in list surfaces (search results,
    saved-places list) by name;
  - replace the offline-pack download/refresh/retry controls
    (`offline-pack-button-*`) with a one-line explanation
    (`offline-pack-notice-no-location`) — the whole pack machine stands
    down (R-map-18/21 amendment below), never crashing on the region grid;
  - hide (not merely disable) `map-sheet-place-button-navigate` /
    `place-detail-button-navigate` for a coordinate-less place — R-map-8
    amendment.

  The remediation path is trip settings, not this screen: R-tripui-24
  (trips client spec) — picking a real-coordinate destination and saving
  heals the trip in one PATCH, which is a cache MISS for the map search key
  (the bbox slot flips from the literal `"no-bbox"` marker to a real bbox
  string) and un-stands the offline-pack machine on the next mount.

Related: the schema spec's public-photos surface question resolved Gate 2
(place detail sheet only v1) — the place detail surface here gains a
public-photos strip fed by the photos API's public-by-place endpoint
(redacted `PublicPlacePhoto` shape; a small additive block on
`place-detail`); R-map-5/14 still cover only this-trip, viewer-visible
photos.

---

## 2. Design

### 2.1 Map composition (@rnmapbox/maps v10+, dev build — no Expo Go)

- **MapView** with `styleURL` per theme (§2.2), attribution + logo enabled
  and positioned bottom-left above the tab bar (R-map-6); compass on;
  scale bar off.
- **Camera:** initial = fit all visible pins (padded); fallback when no
  pins = destination point at z12; fallback when no coordinates = world
  view + EmptyState overlay ("Add places to see them here",
  `map-empty-state`). Day-filter changes animate camera to fit the subset
  (R-map-3).
  - **Zero-span fit — RULED (Q2-206, ruled 2026-09-19):** a fit whose
    envelope has zero span (a single pin, or N pins at one coordinate — the
    common first-use state of a saved place that is also scheduled) centers
    on that coordinate at fixed zoom 14 rather than fitting a degenerate
    envelope.
  - **World arm — RULED (Q2-214, ruled 2026-09-19):** the world-empty
    EmptyState (`map-empty-state`) renders only when there are no pins AND
    no usable destination coordinates; the coordinate-less-destination copy
    is R-map-26's.
- **Pin rendering:** one GeoJSON `ShapeSource` per layer family
  (saved / itinerary / photo) with `cluster=true` (SDK-native clustering —
  research) + `SymbolLayer`/`CircleLayer` styling. `MarkerView` (RN views,
  ~100 on-screen budget — research) is reserved for the selected pin and
  photo thumbnails at high zoom; everything else is style-layer rendered
  so 500-pin trips stay cheap.
  - **Double pin — RULED (Q2-221, ruled 2026-09-19):** a place that is both
    saved AND scheduled renders in BOTH families — the itinerary pin sits
    exactly atop its saved twin and, zoomed out, each family clusters
    independently (per-family counts). There is no dedup or merge across
    families; merging them stays a design alternative to revisit only if
    double pins read as clutter in QA.
  - **Search family — RULED (Q2-228, ruled 2026-09-19):** the `search` pin
    family (R-map-25 temporary pins) is NOT a member of the saved /
    itinerary / photo `PinFamily` union — it has its own structural types
    (and its own press classifier), so the three-family shell contract stays
    closed.
- **Overlay composition — RULED (Q2-230, ruled 2026-09-19):** the search bar
  sits in the top overlay UNDER the day-filter strip (48 pt clearance); the
  locate button (`map-button-locate`) sits bottom-right, stacked ABOVE the
  attribution (i) button (R-map-6).
- **Z-order (top→bottom):** selected pin → itinerary pins → saved pins →
  photo pins → clusters.
  **Honored per family — RULED (Q2-215, ruled 2026-09-19):** families stack
  photo → saved → itinerary bottom-up, and within a family the cluster
  bubble and count sit below that family's unclustered pins. A strict
  global "clusters below every pin" ordering is unreachable with
  per-family clustered sources and is not required.
  **Search temp pins render topmost — RULED (Q2-257, ruled 2026-09-19):**
  the R-map-25 temporary pins are the last `ShapeSource` child, above every
  other family — a transient highlight outranks the pins it points at. They
  are non-clustered by construction (bounded by the 20-row page, R-map-25
  amendment).
- **Data:** pins derive from the TQ-cached trip bundle (saved places list,
  itinerary items with place coords, photos list) — no map-specific
  endpoint; offline renders from the persisted cache (R-map-1/22).
  - **Saved-places pagination — RULED (Q2-220, ruled 2026-09-19):** the
    client follows `nextCursor` to exhaustion, bounded at 10 pages (1000
    pins — twice the 500-pin sizing above), so a runaway cursor terminates
    and a trip with more than 100 saved places never silently truncates.
  - **Loading and errors — RULED (Q2-213, ruled 2026-09-19):** the map has
    no blocking loading UI — the basemap itself is the loading surface and
    pins hydrate in. WHEN a trip-data query errors THE SYSTEM SHALL show a
    retry banner (`map-error`, ErrorBanner `-retry`) while the screen stays
    interactive.

### 2.2 Map style & colors (delegated here by tokens spec §2.10)

- Two Mapbox Studio custom styles (light/dark), muted basemap tuned to the
  app's neutral ramps; style URLs are config. Custom styles work offline
  via StylePacks (research). Style creation needs the Mapbox account
  (existing P-3+ escalation; no new marker).
- `mapColors(theme)` in `packages/tokens` (consumes `Theme`, exports map
  concerns — honoring tokens spec ownership): pin fills, selected ring,
  cluster bubble, route-line color (future), dim opacity.
- **Day-color coding:** `mapDayColors(theme): string[8]` — ordered,
  scheme-tuned 8-hue categorical sequence built from the token ramps;
  itinerary pin day index = `(day - trip.start_date)`, color =
  `dayColors[dayIndex % 8]`, and the pin glyph carries the day number so
  color is never the only signal (R-ds-8 spirit, colorblind-safe). The
  same mapping colors the day-filter chips. Saved-but-unscheduled pins =
  accent; photo pins = neutral ring with thumbnail.
- **Day-color sourcing — RULED (Q2-187, ruled 2026-09-19):** the eight day
  hues draw ONLY from the four shared status ramps (info / success /
  warning / danger), two scheme-tuned stops per ramp, hue-interleaved so
  adjacent days — including the day-8 → day-1 wrap — never share a hue
  family. The accent, primary, and neutral families are reserved for other
  pin families (accent = saved-but-unscheduled pins; primary = cluster
  bubble and selected ring; neutral = photo-pin ring) and SHALL NOT serve
  as day colors, so a day pin can never impersonate a reserved family.
- **Pin color roles — RULED (`mapColors`, the one token home in
  `packages/tokens`):**
  - `pinPhotoRing` is a neutral-ramp ring; `routeLine` is an info-ramp line
    (future-reserved); `dimOpacity` is 0.35 (Q2-188, ruled 2026-09-19).
    These are values, not contract: phase QA may retune them inside the
    token home without a spec change; the contract is "theme-derived, one
    home, no literal colors" (R-map-7).
  - `clusterFill` / `clusterText` are `primary.solid` / `primary.onSolid` —
    the AA-validated on-solid pairing; no dedicated cluster color exists
    (Q2-190, ruled 2026-09-19).
  - `pinSelectedRing` is `border.focus` — the theme's existing "this is
    selected" affordance; no dedicated color exists (Q2-191, ruled
    2026-09-19).
  - Pin-glyph and cluster-count ink use `mapColors.clusterText` — no
    dedicated pin-ink token exists (Q2-212, ruled 2026-09-19).
  - The search (R-map-25) temporary pin uses `mapColors.pinSelectedRing` —
    the closest existing "transient highlight" token; no dedicated
    search-pin color exists and no new token field is added (Q2-227, ruled
    2026-09-19).
- **Glyph day numbers — RULED (Q2-209, ruled 2026-09-19):** the pin glyph
  shows the 1-based day number for an in-range day; an out-of-range item
  (R-itin-1) shows its raw arithmetic number (0, -1, …), honest about
  sitting outside the trip window. Its color wraps by Euclidean modulo
  (`dayColors[((dayIndex % 8) + 8) % 8]`) so a negative index never
  yields an undefined lookup.

### 2.3 Place sheet vs detail screen

- **Sheet** (`map-sheet-place`, design-system Sheet, snap `content`): name,
  coarse-category icon + category, distance from user (when puck active),
  save toggle, actions row — Add to day · Navigate · View in itinerary
  (itinerary pins only) · Details. One pin selected at a time; tapping the
  map dismisses (Sheet R-ds-19 mechanics).
  **Always-mounted — RULED (Q2-237, ruled 2026-09-19):** the place sheet is
  mounted for the life of the map screen with a NULLABLE place (closed =
  `null`); exit-frame content retention is not used (it is a
  `react-hooks/refs` lint violation).
  **Sheet layout and errors — RULED (T-8.7, each ruled 2026-09-19):**
  - **Action row (Q2-263):** the actions row wraps 2-up (up to four
    actions, in the order above); the exact layout is a phase-QA visual
    check.
  - **Save errors (Q2-264):** a failed save/unsave surfaces in its own
    banner (`map-sheet-place-action-error`), distinct from the
    Navigate-failure banner (`map-sheet-place-error`), which stays
    Navigate-only.
- **Detail screen** (push, `place-detail-screen`): everything above plus
  saved note editor (R-map-14), fresh premium fields block (hours/rating/
  photos/tips when present, with the Foursquare attribution row —
  R-map-9/10), linked itinerary items, this-trip photos strip, tour-guide
  entry (R-map-13), spine attribution footer (`place-detail-attribution`).
  **Detail-screen rulings (T-8.4 — each ruled 2026-09-19):**
  - **Module home (Q2-243):** the place-detail client lives in
    `features/places/`, not `features/map/` — a disjoint file set from the
    map shell and sheet, by construction.
  - **Distance (Q2-244):** distance-from-user is part of the detail
    composition (`place-detail-distance`, the R-map-17 label format): shown
    WHEN the location seam holds a position (puck active), absent
    otherwise (the T-8.4 "currently unreachable" interim was closed by the
    T-8.7 rider).
  - **Public-photos strip (Q2-246):** the PUBLIC photos-by-place strip (the
    Gate-2 companion in the Related note under R-map-26) is a SEPARATE
    surface from the this-trip photos strip, deferred WITH P-12 and unwired
    until then. P-12 must land the public-by-place strip itself, not merely
    feed the this-trip strip.
  - **Premium imagery (Q2-247):** Foursquare premium photo URLs are not
    rendered until the deferred integration's licensing/display pass
    (R-map-9/10 — the fresh block's photos are absent, silently).
  - **Attribution footer (Q2-248):** only spine places render the
    attribution footer; a custom place renders none (the shared registry
    keys spine sources only — places spec §3.2.4).
- Sheet fetches spine data only (cheap, offline-capable); the detail
  screen requests `?fresh=true` (§2.4) — **in v1 it never does** (Q2-205,
  ruled 2026-09-19): the places spec's Gate-2 resolution ("`fresh` never
  requested in v1") outranks this section's literal wording, so the
  fetch-fresh client contract (§2.4) ships built and tested behind a
  structural dormancy flag (a bare call issues no request), flipped post-MVP
  with the ADR-005 entitlement seam.

### 2.4 Fetch-fresh client contract (R-map-9)

- Dedicated query, key `['place-fresh', placeId]`, `staleTime: 0`,
  `gcTime: 0`, `retry: false`; the TQ persister's `shouldDehydrateQuery`
  allowlist excludes the `place-fresh` prefix — belt (gcTime) and
  suspenders (persister filter).
  **Two queries, keyed outside the trips subtree — RULED (Q2-241 and
  Q2-242, ruled 2026-09-19):** "dedicated query" is read literally — place
  detail issues TWO queries: `usePlace` (the cacheable spine read,
  offline-capable per R-map-22) and `usePlaceFresh` (this section's
  non-cacheable query; its response's spine half is discarded). The
  `placeDetail` and `placeFresh` keys live OUTSIDE the trips query subtree:
  they are global, auth-only reads, so losing trip access never evicts
  them. Spine places are readable behind auth alone; a custom place's
  privacy is the server's indistinguishable 404 (R-places-8), which every
  reader of a retained `placeDetail` entry SHALL let outrank the cached
  row (the `placeDetail` key doc in `query-client.ts`; the OFFLINE + STATES
  note in `map/place/[placeId].tsx` — "`is404` OUTRANKS retained cache").
- Fresh payload never enters Zustand, SQLite, MMKV, analytics, or console
  logging; render-only props. Enforced by review + a lint-level grep in
  CI (mirror of places spec PL-3 guard test).
  **Guard scope — RULED (Q2-255, ruled 2026-09-19):** the CI grep guard
  covers tracked `apps/mobile` RUNTIME source — test and test-utils files
  are exempt (they don't ship and legitimately name both sides) — and
  includes `package.json`, because a persister dependency is a violation
  before its first import. No TanStack persister exists in the app today
  (the P-8 offline posture is warm-session), so the guard fails the moment
  one appears; that change must land the exclusion above AND deliberately
  re-scope the guard's no-persister rule to assert it.
- Offline/error/absent ⇒ block simply not rendered (R-map-10).

### 2.5 Offline pack lifecycle

- **Region = shared grid cells:** TileRegion bounds = envelope of
  `regionCellsForDestination(destination_lat, destination_lng)` from
  `@gogo/shared` — the exact cells the POI ingestion used (places spec
  §3.5). One definition of "the destination area" everywhere.
  **Envelope at the antimeridian and poles — RULED (Q2-270, ruled
  2026-09-19):** neighbor cells that wrap are shifted ±360° back beside the
  center cell so the box stays contiguous (longitude may then exceed ±180 —
  the standard GeoJSON cross-antimeridian box); neighbors a pole drops
  (8 → 5 cells) simply do not extend the envelope. (Contrast map search,
  which CLIPS a wrapped box — R-map-25, Q2-224.) Native acceptance of a
  longitude past ±180 is a phase-QA check; a rejection degrades that
  destination to `failed` + retry per R-map-21.
- **Naming/versioning:** TileRegion id `trip-{tripId}`; StylePack keyed by
  style URL + version. Zoom range z6–z15 (config; size estimated via the
  SDK's estimate API before download and shown in the ConfirmDialog /
  management UI; bounds verified at implementation — never guessed).
  **Size estimate — RULED (Q2-271, ruled 2026-09-19):** the Mapbox SDK
  (10.3.5) exposes NO size-estimate API, so the size shown before download
  is a deterministic slippy-tile-count × 12 KB approximation
  (`ESTIMATED_TILE_BYTES`, config), labeled `~` everywhere it appears; phase
  QA calibrates the constant against a real download.
  **`setTileCountLimit` is never called — RULED (Q2-277, ruled
  2026-09-19):** Mapbox's terms forbid it, so the limit is not touched —
  enforced structurally: the jest mock omits the method, so any code path
  that reaches it faults loudly under test.
- **State machine (client store, per trip):**
  `none → downloading(progress) → ready(size, completed_at)`;
  `ready → stale` when style version or destination/region changed;
  `any → failed(error)` with retry (R-map-21). State derives from
  `offlineManager` queries + a small MMKV record — the SDK is the source
  of truth, MMKV is the annotation (trip ↔ pack mapping, completed_at).
  **State-machine rulings (T-8.5 — each ruled 2026-09-19):**
  - **Completion (Q2-279):** a pack is complete when the SDK reports
    `percentage >= 100` — the SDK's own example contract; the numeric
    `state` enum values are native constants a full module mock cannot
    carry.
  - **Style URL and theme (Q2-275):** a pack downloads the CURRENT theme's
    style URL; a theme flip marks it `stale` ("style changed") in the
    management UI ONLY — the pill never nags and refresh stays manual.
    Offline in the other scheme still renders the downloaded style's tiles.
  - **Ready display (Q2-285):** the ready state's size/date derive from the
    MMKV annotation FIRST (synchronous first frame — the no-flash posture)
    and are verified against the SDK asynchronously; drift self-corrects.
  - **Reconcile (Q2-282):** WHEN the SDK holds a pack for the current trip
    with no annotation THE SYSTEM SHALL remove it (the same unaccounted-pack
    policy as the sweep — the SDK is the source of truth for existence);
    an annotation whose pack has vanished is cleared.
  - **Pill visibility (Q2-281):** the offline pill (`map-pill-offline`)
    hides for the online settled states (`none` / `ready` / `stale`) — it is
    informational-plus-retry only; stale nudges live in the management UI.
- **Triggers:** (1) auto at activation on wifi (R-map-18; "activation" =
  effective status flips to `active` — derived + override, resolved
  Gate 2 — observed by the controller mounted at the trip-scoped root
  layout, whichever surface is showing, Q2-186); (2) manual from management
  UI (R-map-19); (3) refresh action
  re-downloads with the same id (replaces — packs never auto-refresh;
  research).
- **Hygiene (R-map-20):** delete pack on trip delete/leave (hooked to
  those mutations); prompt on `active → past`; before any new download,
  enumerate regions and purge past-trip packs oldest-first if count nears
  the ceiling (threshold config, e.g. 700). Orphan sweep on app start:
  packs whose `trip-{id}` no longer matches a local trip are removed —
  read as UNACCOUNTED packs (no MMKV annotation), per the R-map-20
  amendment (Q2-273); the past-trip "prompt" is the non-blocking offer line
  (Q2-276), and delete/leave hygiene is fire-and-forget on `exitToTripList`
  (Q2-278).
- **Connectivity detection:** wifi check via the network state API at
  trigger time + listener while deferred (R-map-18); implementation pinned
  at P-3 (`expo-network` expected, verified then).
  **"Unmetered wifi" — RULED (Q2-284, ruled 2026-09-19):** the wifi gate is
  `NetworkStateType.WIFI` with `isConnected` — iOS exposes no metered-ness
  signal, and the wifi/cellular split satisfies the data-plan rationale of
  R-map-18.

### 2.6 Location (foreground-only)

- `LocationPuck` enabled only after when-in-use grant; permission
  requested lazily on first locate-me tap (R-map-16), rationale copy
  first ("show where you are on the trip map").
- `Info.plist` carries ONLY `NSLocationWhenInUseUsageDescription` — no
  always keys, no background modes (R-map-15; App-Store-friction rationale
  in PLANNING provider table). **The purpose string is RULED (Q2-189,
  ruled 2026-09-19):** "Allow $(PRODUCT_NAME) to use your location to show
  where you are on the trip map while the app is open." — it states the
  foreground-only purpose in the user-visible permission prompt.
- Locate-me states: off (no permission) → prompt; denied → Settings
  deeplink hint (once per session, non-blocking); granted → camera fly-to
  (R-map-17). Puck position is never sent to the server by this screen
  (distance labels computed on-device). Per the R-map-16 amendment (Q2-234,
  ruled 2026-09-19), "once per session, non-blocking" is realized as
  "never unprompted": the Settings dialog appears only behind the user's own
  locate tap and is dismissible each time.

### 2.7 Map ↔ itinerary linking mechanics

- Map → itinerary (R-map-23): `router.push` into the itinerary tab's
  stack for `item/[itemId]` (per-tab stacks preserved, navigation spec
  R-nav-10).
  **Two-step cross-tab jump — RULED (Q2-252, ruled 2026-09-19):**
  navigation from a place into another tab is two steps — the tab switch
  first (the tab-bar-equivalent jump), then the navigate/push inside the
  now-active stack; a single cross-tab push is not relied on. The per-kind
  landing rule for linked rows is the R-map-14 amendment (Q2-256).
- Itinerary → map (R-map-24): navigate to map tab with
  `{ focusPlaceId }` param; map screen effect selects pin + opens sheet +
  centers camera; param consumed once (no re-trigger on tab revisit).
  **Pending-focus semantics — RULED (Q2-218, ruled 2026-09-19):** the
  pending map-focus is last-set-wins (a rapid double-send collapses to the
  newest) and trip-scoped — it carries `{ tripId, placeId }`, and a consume
  for a different trip discards AND clears it, so an interrupted jump can
  never surface trip A's place on trip B's map.
  **Unresolvable focus — RULED (Q2-238, ruled 2026-09-19):** WHEN a pending
  focus names a `placeId` the map has no pin for (it resolves to no
  coordinate) THE SYSTEM SHALL present nothing — no improvised fallback row
  or coordinate source.
- Today screen's "open map" quick action reuses the same param contract
  (today spec consumes it).

### 2.8 testID inventory (grammar: navigation spec §2.7)

| Surface            | testIDs                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map root           | `map-screen`, `map-button-locate`, `map-button-attribution`, `map-pill-offline`, `map-empty-state`, `map-error`                                                                                                                             |
| Map view / style   | `map-view`, `map-source-{saved,itinerary,photo,search}`, `map-layer-{saved,itinerary,photo}-{pin,cluster,cluster-count}`, `map-layer-itinerary-pin-label`, `map-layer-search-pin`                                                           |
| Attribution sheet  | `map-sheet-attribution`                                                                                                                                                                                                                     |
| Locate dialogs     | `map-dialog-locate-rationale`, `map-dialog-locate-settings`, `map-dialog-locate-unavailable` (+ derived `-confirm` / `-cancel`)                                                                                                             |
| Search (R-map-25)  | `map-search-input`, `map-search-list-item-{placeId}`, `map-pin-search-{placeId}`, `map-search-clear`, `map-search-notice-no-destination` (B-7 part 3, R-map-26), `map-search-offline`, `map-search-error`                                   |
| Day filter         | `map-day-filter`, `map-day-filter-chip-all`, `map-day-filter-chip-{dayIndex}`                                                                                                                                                               |
| Pins/clusters      | `map-pin-saved-{placeId}`, `map-pin-itinerary-{itemId}`, `map-pin-photo-{photoId}`, `map-cluster-{clusterId}` (stable entity ids, never render index)                                                                                       |
| Place sheet        | `map-sheet-place`, `map-sheet-place-button-save`, `-button-add-to-day`, `-button-navigate`, `-button-view-itinerary`, `-button-details`                                                                                                     |
| Place sheet status | `map-sheet-place-distance`, `map-sheet-place-badge-saved`, `map-sheet-place-error`, `map-sheet-place-action-error`                                                                                                                          |
| Detail screen      | `place-detail-screen`, `place-detail-button-save`, `-button-add-to-day`, `-button-navigate`, `-button-tour-guide`, `place-detail-input-note`, `place-detail-list-item-{itemId}`, `place-detail-photo-{photoId}`, `place-detail-attribution` |
| Detail status      | `place-detail-distance`, `place-detail-badge-saved`                                                                                                                                                                                         |
| Offline management | `offline-pack-button-download`, `-button-refresh`, `-button-delete`, `-button-retry` (+ ConfirmDialog children derive `-confirm`/`-cancel` per tokens spec); `offline-pack-notice-no-location` (B-7 part 3, R-map-26)                       |
| Offline status     | `trip-settings-sheet-offline`, `offline-pack-status`, `offline-pack-past-offer`, `offline-pack-offline-notice`                                                                                                                              |

**Round-2 testID notes (ids ruled 2026-09-19, except the Q2-240 naming pick,
which is pending Sean)** — the ids above are the single inventory; these
notes explain the entries the original inventory did not anticipate:

- **`map-pin-*` / `map-cluster-*` live in the GeoJSON feature's
  `properties.testID`, not in RN `testID` props (Q2-210):** style-layer pins
  are not React views, so the inventory ids are the stable feature handles;
  cluster ids are SDK-synthesized and not RN-assertable.
- **`map-sheet-attribution` (Q2-211):** grammar-derived for the R-map-6 info
  sheet — the original inventory named only its opener,
  `map-button-attribution`.
- **`map-error` (Q2-213):** the retry banner for an errored trip-data query;
  ErrorBanner derives `-retry` / `-dismiss` (§2.7 rule 4 of the navigation
  spec).
- **Six ids beyond the original inventory (Q2-240 — as shipped; the dialog
  naming below is pending Sean):** `map-sheet-place-distance`
  (the sheet's distance label, R-map-17), `map-sheet-place-error` (the
  Navigate-failure banner), `map-search-offline` (the offline notice) and
  `map-search-error` (the retryable error banner), and the two locate-me
  dialogs `map-dialog-locate-rationale` / `map-dialog-locate-settings`.
- **Ids added by the T-8.7 rider (Q2-265):** the sheet's
  `-button-save` / `-button-add-to-day` / `-button-view-itinerary` (already
  inventoried, now real), the Saved badges (`map-sheet-place-badge-saved`,
  `place-detail-badge-saved`), `map-sheet-place-action-error` (Q2-264),
  `map-dialog-locate-unavailable` (Q2-266), `place-detail-distance`
  (Q2-244), and the search source / layer ids. `map-view` is the MapView's
  own testID; the `map-source-*` and `map-layer-*` ids are Mapbox style ids
  following the shell convention, not RN `testID` props.
- **Offline-pack status ids (T-8.5, PR #27 spec-sync inputs):**
  `trip-settings-sheet-offline` (the management sheet, house
  `trip-settings-sheet-*` grammar — opened by
  `trip-settings-list-item-offline`), `offline-pack-status` (the state
  line), `offline-pack-past-offer` (the R-map-20 offer line, Q2-276) and
  `offline-pack-offline-notice` (the R-map-22 degrade notice). The
  ConfirmDialog children of download / refresh / retry / delete derive from
  the triggering button's id (`offline-pack-button-download-confirm` /
  `-cancel`, and so on — Q2-283).
- **Dialog naming — the `map-dialog-locate-*` fork (Q2-240 — as shipped;
  Sean pick pending: (a) element-position `<screen>-dialog-<qualifier>` /
  (b) trailing `<qualifier>-dialog`):** as shipped, the map's locate-me
  ConfirmDialog base ids take `dialog` in ELEMENT position
  (`map-dialog-locate-rationale` / `-settings` / `-unavailable`), and
  children derive `-confirm` / `-cancel` (navigation spec §2.7 rule 4). The
  profile screen's three `profile-*-dialog` ids use the trailing form, and
  the photos spec's `photo-viewer-dialog-public` uses the element-position
  form — two live conventions; the repo-wide pick is Sean's. Dialogs keyed
  by their triggering control (e.g. `offline-pack-button-delete-confirm`)
  derive from that control's id and are not dialog-named, so the fork does
  not touch them. [NEEDS CLARIFICATION: Q2-240 — pick the ConfirmDialog
  testID naming convention to apply repo-wide: (a) element-position
  `<screen>-dialog-<qualifier>` (keeps `map-dialog-locate-*`; renames the
  three `profile-*-dialog` ids) or (b) trailing `<qualifier>-dialog`
  (renames the three `map-dialog-locate-*` ids and the photos spec's
  `photo-viewer-dialog-public`)]

### 2.9 Out of scope (explicit)

- **Route polylines / turn-by-turn** — `travel_legs` carry no geometry in
  v1 (schema §3.3.11); external nav handoff only (R-map-8).
- **Public-photos strip content rules** — the photos specs own visibility
  law and the redacted shape; this spec only renders the strip on place
  detail (surface resolved Gate 2: place detail sheet only v1, schema
  §3.3.17).
- **Tour-guide content rendering & audio** — AI spec; this spec ships the
  entry-point hook only (R-map-13).
- **Basemap-POI tap-through discovery** — not v1 (discovery resolved
  Gate 2 as the R-map-25 search bar; tap-through composes later).
- **Trip-bundle offline data sync** (SQLite/mutation queue) — offline/sync
  spec; this spec consumes the cached bundle and owns only tile packs.
- **Android map behaviors** — Android verification pass, pre-launch
  (CLAUDE.md); spec is written iOS-first but SDK-portable.
- **Mapbox account setup + SPM/CocoaPods migration watch** — P-3 infra
  (research watch item #1).

---

## 3. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on: NAV-1 (routes), DS-9 (Sheet), PL-2/PL-4 (endpoints), and the
`@rnmapbox/maps` dev-build scaffold (P-3; versions pinned then via
`npm view` + Context7 — never training data).

| ID    | Task                                                                                                                                                               | Covers                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| MAP-1 | Map screen shell: MapView + themed styles, camera logic, attribution placement, ShapeSource layers + clustering for the three pin families, day filter.            | R-map-1..3, R-map-6, R-map-7        |
| MAP-2 | Pin selection + place sheet + photo-pin routing + external nav handoff + photo-visibility filtering + map search bar with temporary result pins.                   | R-map-4, R-map-5, R-map-8, R-map-25 |
| MAP-3 | Place detail screen: spine view, fresh block w/ non-persistence contract, save/unsave, add-to-day, note editor, linked content, tour-guide hook, attribution.      | R-map-9..14                         |
| MAP-4 | Foreground location: puck, lazy permission flow, locate-me, plist audit.                                                                                           | R-map-15..17                        |
| MAP-5 | Offline packs: state machine, activation auto-download (wifi-gated), management UI in trip settings, hygiene/ceiling purge, failure/retry, offline degrade states. | R-map-18..22                        |
| MAP-6 | Map↔itinerary linking params + cross-tab flows (+ today quick-action contract).                                                                                    | R-map-23, R-map-24                  |

**Tests required (minimum — component/E2E per testIDs above):**

- [ ] Pins render per family from fixture trip data; cluster tap expands, never sheets (MAP-1/2)
- [ ] Search: ≥ 2 chars queries spine, temporary pins + list render, result tap opens sheet, clear removes pins; offline shows notice (MAP-2)
- [ ] Day filter shows only that day's itinerary pins; chips match `mapDayColors` (MAP-1)
- [ ] Another member's private photo absent from map + detail strip (`canViewPhoto` truth table drives fixtures) (MAP-2/3)
- [ ] Fresh details render when stubbed, vanish silently when stub errors; TQ persister snapshot contains no `place-fresh` entry after use (R-map-9/10) (MAP-3)
- [ ] Save on already-saved place (409 stub) lands in saved state, no error UI (MAP-3)
- [ ] Locate-me before grant prompts once; denied path shows Settings hint, no re-prompt; no background location keys in the built plist (MAP-4)
- [ ] Activation on wifi starts download exactly once; cellular defers then resumes on wifi event; failure → retry works; delete-trip removes pack; past-trip purge frees count before new download (MAP-5)
- [ ] Activation observed with only a non-map, non-settings trip surface mounted (e.g. Today) starts the wifi-gated download, and later mounting the map tab or settings starts no second one — the in-flight latch keeps it to one download per trip however many surfaces read pack state (root-layout mount, R-map-18 / Q2-186) (MAP-5)
- [ ] Airplane-mode E2E inside a downloaded region: tiles + pins + sheet work; search/fresh entry points show offline notice (MAP-5)
- [ ] Itinerary → map focuses pin + opens sheet once, param not re-consumed; map → itinerary lands on item detail with tab stacks intact (MAP-6)

---

_Trace: every R-map-N cites its design section inline. All 3 markers
resolved at Gate 2 (2026-07-09): 2 at the schema spec (status derived +
override; destination structured with guaranteed coords), 1 owned here
(map discovery → spine-backed search bar, R-map-25); the public-photos
surface resolved at the schema spec (place detail sheet only, photos spec
renders it). Zero markers remain._
