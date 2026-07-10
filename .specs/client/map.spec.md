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
- **R-map-2 (clustering):** WHEN pins overlap at the current zoom THE
  SYSTEM SHALL cluster them (`map-cluster-{clusterId}`) with a count badge;
  WHEN a cluster is tapped THE SYSTEM SHALL zoom/expand to reveal its
  members — never open a sheet for a cluster.
- **R-map-3 (day filter):** WHEN the user selects a day in the day filter
  (`map-day-filter`, chips `map-day-filter-chip-{dayIndex}` + `-all`) THE
  SYSTEM SHALL show only that day's itinerary pins (saved-place and photo
  pins remain, dimmed) and recenter the camera to fit them; default is All
  days.
- **R-map-4 (pin tap → sheet):** WHEN a saved-place or itinerary pin is
  tapped THE SYSTEM SHALL present the place sheet (`map-sheet-place`,
  design-system Sheet — navigation spec: "Sheet over map (small) / PUSH
  (full detail)"); WHEN a photo pin is tapped THE SYSTEM SHALL open the
  photo viewer (cross-tab push, navigation spec `photo-viewer`).
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
- **R-map-7 (theming):** WHEN the app theme scheme is light/dark THE
  SYSTEM SHALL load the matching custom map style (§2.2) and derive all
  pin/route colors from `Theme` — no literal colors (tokens spec R-ds-7;
  §2.10 delegates map colors here).
- **R-map-8 (external nav handoff):** WHEN the user taps navigate
  (`map-sheet-place-button-navigate` / `place-detail-button-navigate`) THE
  SYSTEM SHALL hand off to Apple/Google Maps via URL scheme with the
  place's coordinates — never in-app turn-by-turn (competitor research:
  never replace the nav app).

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
- **R-map-12 (add to itinerary):** WHEN "Add to day" is tapped
  (`place-detail-button-add-to-day` / `map-sheet-place-button-add-to-day`)
  THE SYSTEM SHALL open the itinerary add-item modal
  (`/[tripId]/itinerary/item/new`) prefilled `kind='place_visit'` +
  `place_id` (navigation spec route; itinerary spec owns the form).
- **R-map-13 (tour-guide hook):** WHEN the trip has a `ready` tour-guide
  bundle for the place THE SYSTEM SHALL show the tour-guide entry point
  (`place-detail-button-tour-guide`) opening the bundle content surface
  (AI spec owns content + its screen); WHEN no bundle is `ready` the entry
  point is absent — never a broken tap.
- **R-map-14 (linked content):** WHEN the detail screen renders THE SYSTEM
  SHALL list the place's itinerary items and this-trip photos
  (viewer-visible only, R-map-5 rule) with taps cross-navigating to them;
  the saved-place note is editable inline for owner/editor
  (`place-detail-input-note`).

### Location (foreground-only — PLANNING lock)

- **R-map-15 (blue dot, foreground only):** WHEN when-in-use location
  permission is granted THE SYSTEM SHALL show the user puck on the map;
  THE SYSTEM SHALL NOT request always/background authorization, define
  background location capabilities, or track location while backgrounded —
  anywhere in the app (locked: foreground-only v1).
- **R-map-16 (permission flow):** WHEN the user first taps locate-me
  (`map-button-locate`) THE SYSTEM SHALL request when-in-use permission
  (no request on mount); WHEN permission is denied THE SYSTEM SHALL keep
  the map fully functional without the puck, and locate-me SHALL show a
  one-tap path to Settings — never a repeated prompt loop.
- **R-map-17 (locate-me):** WHEN locate-me is tapped with permission
  granted THE SYSTEM SHALL animate the camera to the user with the trip
  pins still loaded (no layer reset).

### Offline tile packs (StylePack + TileRegion)

- **R-map-18 (auto-download at activation):** WHEN a trip becomes active
  AND the device is on unmetered wifi AND no `ready`/current pack exists
  for the trip THE SYSTEM SHALL automatically download the style pack and
  the trip-region tile pack (§2.5), surfacing progress in the map status
  pill (`map-pill-offline`); WHEN not on wifi THE SYSTEM SHALL defer and
  retry on the next wifi + app-active window (download billing is $0 —
  research — the wifi gate is for the user's data plan, not cost).
- **R-map-19 (manual management UI):** WHEN the user opens trip settings →
  Offline map (`trip-settings-list-item-offline` → section testIDs
  `offline-pack-*`) THE SYSTEM SHALL show pack state (`none / downloading
  (progress) / ready (size, date) / stale / failed`) with actions:
  download (`offline-pack-button-download` — allowed on cellular after a
  size-estimate ConfirmDialog), refresh (`offline-pack-button-refresh` —
  packs don't auto-update; research), delete (`offline-pack-button-delete`,
  ConfirmDialog).
- **R-map-20 (pack hygiene / 750 ceiling):** WHEN a trip is deleted or the
  user leaves it THE SYSTEM SHALL delete its packs; WHEN a trip
  transitions to `past` THE SYSTEM SHALL offer pack deletion
  (non-blocking prompt, also available in management UI); WHEN a new
  download would approach the device tile-region ceiling (750 cumulative —
  research) THE SYSTEM SHALL first purge packs of `past` trips
  (oldest-first) — the ceiling is never user-visible as a failure.
- **R-map-21 (download failure):** WHEN a pack download fails THE SYSTEM
  SHALL mark the pack `failed` with a retry action in the pill and
  management UI (`offline-pack-button-retry`) and keep the map fully
  usable online — pack state never blocks map interaction.
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
- **R-map-24 (itinerary → map):** WHEN an itinerary item's place link is
  tapped (itinerary spec surface) THE SYSTEM SHALL switch to the map tab,
  select that pin, center the camera on it, and open its sheet — the map
  tab's own stack state is otherwise preserved.

### Resolved questions (Gate 2, 2026-07-09)

- R-map-18's "becomes active" trigger — Resolved at
  `.specs/database/schema.spec.md`:§3.3.4 `trips.status` (Gate 2,
  2026-07-09): status is date-derived with manual owner override (override
  wins until cleared); the auto-download trigger follows the effective
  status.
- Destination coordinates — Resolved at
  `.specs/database/schema.spec.md`:§3.3.4 `trips` (Gate 2, 2026-07-09):
  destination input is structured (Overture-backed search), so
  `destination_lat/lng` are always present — the tile region and default
  camera are always derivable.
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
- **Pin rendering:** one GeoJSON `ShapeSource` per layer family
  (saved / itinerary / photo) with `cluster=true` (SDK-native clustering —
  research) + `SymbolLayer`/`CircleLayer` styling. `MarkerView` (RN views,
  ~100 on-screen budget — research) is reserved for the selected pin and
  photo thumbnails at high zoom; everything else is style-layer rendered
  so 500-pin trips stay cheap.
- **Z-order (top→bottom):** selected pin → itinerary pins → saved pins →
  photo pins → clusters.
- **Data:** pins derive from the TQ-cached trip bundle (saved places list,
  itinerary items with place coords, photos list) — no map-specific
  endpoint; offline renders from the persisted cache (R-map-1/22).

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

### 2.3 Place sheet vs detail screen

- **Sheet** (`map-sheet-place`, design-system Sheet, snap `content`): name,
  coarse-category icon + category, distance from user (when puck active),
  save toggle, actions row — Add to day · Navigate · View in itinerary
  (itinerary pins only) · Details. One pin selected at a time; tapping the
  map dismisses (Sheet R-ds-19 mechanics).
- **Detail screen** (push, `place-detail-screen`): everything above plus
  saved note editor (R-map-14), fresh premium fields block (hours/rating/
  photos/tips when present, with the Foursquare attribution row —
  R-map-9/10), linked itinerary items, this-trip photos strip, tour-guide
  entry (R-map-13), spine attribution footer (`place-detail-attribution`).
- Sheet fetches spine data only (cheap, offline-capable); the detail
  screen requests `?fresh=true` (§2.4).

### 2.4 Fetch-fresh client contract (R-map-9)

- Dedicated query, key `['place-fresh', placeId]`, `staleTime: 0`,
  `gcTime: 0`, `retry: false`; the TQ persister's `shouldDehydrateQuery`
  allowlist excludes the `place-fresh` prefix — belt (gcTime) and
  suspenders (persister filter).
- Fresh payload never enters Zustand, SQLite, MMKV, analytics, or console
  logging; render-only props. Enforced by review + a lint-level grep in
  CI (mirror of places spec PL-3 guard test).
- Offline/error/absent ⇒ block simply not rendered (R-map-10).

### 2.5 Offline pack lifecycle

- **Region = shared grid cells:** TileRegion bounds = envelope of
  `regionCellsForDestination(destination_lat, destination_lng)` from
  `@gogo/shared` — the exact cells the POI ingestion used (places spec
  §3.5). One definition of "the destination area" everywhere.
- **Naming/versioning:** TileRegion id `trip-{tripId}`; StylePack keyed by
  style URL + version. Zoom range z6–z15 (config; size estimated via the
  SDK's estimate API before download and shown in the ConfirmDialog /
  management UI; bounds verified at implementation — never guessed).
- **State machine (client store, per trip):**
  `none → downloading(progress) → ready(size, completed_at)`;
  `ready → stale` when style version or destination/region changed;
  `any → failed(error)` with retry (R-map-21). State derives from
  `offlineManager` queries + a small MMKV record — the SDK is the source
  of truth, MMKV is the annotation (trip ↔ pack mapping, completed_at).
- **Triggers:** (1) auto at activation on wifi (R-map-18; "activation" =
  effective status flips to `active` — derived + override, resolved
  Gate 2); (2) manual from management UI (R-map-19); (3) refresh action
  re-downloads with the same id (replaces — packs never auto-refresh;
  research).
- **Hygiene (R-map-20):** delete pack on trip delete/leave (hooked to
  those mutations); prompt on `active → past`; before any new download,
  enumerate regions and purge past-trip packs oldest-first if count nears
  the ceiling (threshold config, e.g. 700). Orphan sweep on app start:
  packs whose `trip-{id}` no longer matches a local trip are removed.
- **Connectivity detection:** wifi check via the network state API at
  trigger time + listener while deferred (R-map-18); implementation pinned
  at P-3 (`expo-network` expected, verified then).

### 2.6 Location (foreground-only)

- `LocationPuck` enabled only after when-in-use grant; permission
  requested lazily on first locate-me tap (R-map-16), rationale copy
  first ("show where you are on the trip map").
- `Info.plist` carries ONLY `NSLocationWhenInUseUsageDescription` — no
  always keys, no background modes (R-map-15; App-Store-friction rationale
  in PLANNING provider table).
- Locate-me states: off (no permission) → prompt; denied → Settings
  deeplink hint (once per session, non-blocking); granted → camera fly-to
  (R-map-17). Puck position is never sent to the server by this screen
  (distance labels computed on-device).

### 2.7 Map ↔ itinerary linking mechanics

- Map → itinerary (R-map-23): `router.push` into the itinerary tab's
  stack for `item/[itemId]` (per-tab stacks preserved, navigation spec
  R-nav-10).
- Itinerary → map (R-map-24): navigate to map tab with
  `{ focusPlaceId }` param; map screen effect selects pin + opens sheet +
  centers camera; param consumed once (no re-trigger on tab revisit).
- Today screen's "open map" quick action reuses the same param contract
  (today spec consumes it).

### 2.8 testID inventory (grammar: navigation spec §2.7)

| Surface | testIDs |
|---|---|
| Map root | `map-screen`, `map-button-locate`, `map-button-attribution`, `map-pill-offline`, `map-empty-state` |
| Search (R-map-25) | `map-search-input`, `map-search-list-item-{placeId}`, `map-pin-search-{placeId}`, `map-search-clear` |
| Day filter | `map-day-filter`, `map-day-filter-chip-all`, `map-day-filter-chip-{dayIndex}` |
| Pins/clusters | `map-pin-saved-{placeId}`, `map-pin-itinerary-{itemId}`, `map-pin-photo-{photoId}`, `map-cluster-{clusterId}` (stable entity ids, never render index) |
| Place sheet | `map-sheet-place`, `map-sheet-place-button-save`, `-button-add-to-day`, `-button-navigate`, `-button-view-itinerary`, `-button-details` |
| Detail screen | `place-detail-screen`, `place-detail-button-save`, `-button-add-to-day`, `-button-navigate`, `-button-tour-guide`, `place-detail-input-note`, `place-detail-list-item-{itemId}`, `place-detail-photo-{photoId}`, `place-detail-attribution` |
| Offline management | `offline-pack-button-download`, `-button-refresh`, `-button-delete`, `-button-retry` (+ ConfirmDialog children derive `-confirm`/`-cancel` per tokens spec) |

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

| ID | Task | Covers |
|---|---|---|
| MAP-1 | Map screen shell: MapView + themed styles, camera logic, attribution placement, ShapeSource layers + clustering for the three pin families, day filter. | R-map-1..3, R-map-6, R-map-7 |
| MAP-2 | Pin selection + place sheet + photo-pin routing + external nav handoff + photo-visibility filtering + map search bar with temporary result pins. | R-map-4, R-map-5, R-map-8, R-map-25 |
| MAP-3 | Place detail screen: spine view, fresh block w/ non-persistence contract, save/unsave, add-to-day, note editor, linked content, tour-guide hook, attribution. | R-map-9..14 |
| MAP-4 | Foreground location: puck, lazy permission flow, locate-me, plist audit. | R-map-15..17 |
| MAP-5 | Offline packs: state machine, activation auto-download (wifi-gated), management UI in trip settings, hygiene/ceiling purge, failure/retry, offline degrade states. | R-map-18..22 |
| MAP-6 | Map↔itinerary linking params + cross-tab flows (+ today quick-action contract). | R-map-23, R-map-24 |

**Tests required (minimum — component/E2E per testIDs above):**

- [ ] Pins render per family from fixture trip data; cluster tap expands, never sheets (MAP-1/2)
- [ ] Search: ≥ 2 chars queries spine, temporary pins + list render, result tap opens sheet, clear removes pins; offline shows notice (MAP-2)
- [ ] Day filter shows only that day's itinerary pins; chips match `mapDayColors` (MAP-1)
- [ ] Another member's private photo absent from map + detail strip (`canViewPhoto` truth table drives fixtures) (MAP-2/3)
- [ ] Fresh details render when stubbed, vanish silently when stub errors; TQ persister snapshot contains no `place-fresh` entry after use (R-map-9/10) (MAP-3)
- [ ] Save on already-saved place (409 stub) lands in saved state, no error UI (MAP-3)
- [ ] Locate-me before grant prompts once; denied path shows Settings hint, no re-prompt; no background location keys in the built plist (MAP-4)
- [ ] Activation on wifi starts download exactly once; cellular defers then resumes on wifi event; failure → retry works; delete-trip removes pack; past-trip purge frees count before new download (MAP-5)
- [ ] Airplane-mode E2E inside a downloaded region: tiles + pins + sheet work; search/fresh entry points show offline notice (MAP-5)
- [ ] Itinerary → map focuses pin + opens sheet once, param not re-consumed; map → itinerary lands on item detail with tab stacks intact (MAP-6)

---

*Trace: every R-map-N cites its design section inline. All 3 markers
resolved at Gate 2 (2026-07-09): 2 at the schema spec (status derived +
override; destination structured with guaranteed coords), 1 owned here
(map discovery → spine-backed search bar, R-map-25); the public-photos
surface resolved at the schema spec (place detail sheet only, photos spec
renders it). Zero markers remain.*
