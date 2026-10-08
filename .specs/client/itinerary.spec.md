# Client — Itinerary Tab (plan mode, calendar grid, bookings, deeplink-out)

> **Task:** T-2.3 (ITINERARY + BOOKINGS + DEEPLINK-OUT bundle) · **Status:**
> DRAFT — pending Sean approval. Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `.specs/client/navigation.spec.md` (route topology, modal
> conventions, testID grammar, R-nav-18 return prompt — CANONICAL for IA),
> `.specs/design-system/tokens.spec.md` (components, haptics, states —
> CANONICAL for visuals), `.specs/api/itinerary-bookings.spec.md` (companion
> API — endpoints, invariants, status machine), `.specs/database/schema.spec.md`
> §3.3.9–§3.3.11/§3.4.1 (shapes), `.specs/research/competitors.md`
> (§ top-line call #4: plan-mode day list + inline travel times + the
> calendar-grid gap view "NOBODY has"), `.specs/research/booking-integrations.md`
> (§ Key deeplink formats — every URL in §2.7 traces there).
>
> **Scope note:** today mode is a SEPARATE bundle — nothing here specs the
> today tab. This spec owns `[tripId]/itinerary/*` screens only.

---

## 1. Requirements (EARS)

### Plan-mode day list

- **R-itin-1**: WHEN the itinerary tab opens in list mode THE SYSTEM SHALL
  render a day-sectioned list over the trip's date range (unioned with any
  item days outside it), each day's items ordered by `sort_order`; an empty
  day SHALL render a slim tappable "Add to this day" row — never a blank
  section (R-ds-16 spirit at day granularity).
- **R-itin-2**: WHEN the user long-presses an item and drags THE SYSTEM
  SHALL reorder optimistically within/across days, fire `dragLift`/`dragDrop`
  haptics (tokens §2.8), and persist via the day-order endpoint (API
  R-ib-15); on failure it SHALL roll back and show an ErrorBanner (R-ds-17).
- **R-itin-3**: WHEN the dragged item is a `booking`-kind item whose parent
  booking has fixed times THE SYSTEM SHALL block cross-day drop with an
  inline hint ("Times come from the booking — edit the booking to move it",
  API R-ib-16); same-day reorder remains allowed.
- **R-itin-4**: WHEN two consecutive items in a day are both located THE
  SYSTEM SHALL render a travel-time chip between them (duration + mode
  icon); tapping the chip SHALL open a Sheet listing every computed mode for
  that pair plus a "Directions" handoff to Google Maps — as shipped (Q2-125;
  Sean pick pending on an Apple Maps variant, see R-itin-67) — never
  replacing the nav app (competitors § feature-matrix).
- **R-itin-5**: WHEN choosing the chip's displayed mode THE SYSTEM SHALL
  show walking when the walking leg is ≤ 15 minutes, else driving; transit
  and cycling appear in the mode Sheet when their legs exist (transit rows
  may be absent — degradation is silent, API R-ib-21). WHEN driving is also
  absent THE SYSTEM SHALL continue down transit → cycling →
  walking-over-15-minutes (first rung present wins) so a computed leg is
  never hidden behind an absent one — Mapbox modes routinely are absent, and
  a pair can arrive transit-only (Q2-117, ruled 2026-09-19).
- **R-itin-6**: WHEN a pair's legs are absent (still computing, provider
  down, an endpoint unlocated) THE SYSTEM SHALL render no chip (the "subtle
  placeholder" arm is NOT used — whitespace is the honest render for "nothing
  computed", matching §2.5's gap semantics; Q2-118, ruled 2026-09-19) —
  never a spinner row, never an inline error.
- **R-itin-7**: WHEN timed items on a day overlap THE SYSTEM SHALL show a
  warning chip on the involved items (overlaps are legal — API R-ib-17);
  WHEN a day's times are non-monotonic relative to its `sort_order` THE
  SYSTEM SHALL offer a one-tap "Sort day by time" affordance (issues a
  day-order PUT) and SHALL never auto-resort.
- **R-itin-8**: WHEN a `booking`-kind item renders THE SYSTEM SHALL show its
  category icon and a status Badge (`planned` = accent, `booked` = success);
  `idea` bookings never appear in day sections (they live in the bucket,
  R-itin-10) and `cancelled` bookings have no items at all (API R-ib-7).
- **R-itin-9**: WHEN the user toggles list ↔ grid THE SYSTEM SHALL switch
  views and persist the choice locally per trip, restoring it on next open
  (`itinerary-view-toggle`, the navigation-spec §2.7 example testID).

### Ideas / unscheduled bucket

- **R-itin-10**: WHEN unscheduled bookings exist (zero itinerary items — API
  R-ib-10) THE SYSTEM SHALL show a pinned, collapsible "Ideas" entry above
  the day list with a count Badge; expanded, it lists idea cards grouped by
  category, ordered `updated_at DESC`.
- **R-itin-11**: WHEN "Planned" or "Booked" is tapped on a bucket card
  (replacing the single "Add to day" action — Sean QA feature batch
  2026-09-06 feature ④, R-itin-40/41) THE SYSTEM SHALL present a
  status-action Sheet and, on confirm, transition the booking's status to
  the tapped target and ensure its calendar presence exists in the same
  operation (routing detail: R-itin-41), optimistically moving the card
  into its day section with the status badge advancing to the tapped
  status.
- **R-itin-12**: WHEN a `planned`/`booked` booking is timeless (in the
  bucket) THE SYSTEM SHALL flag it "needs a day" — visually distinct from
  `idea` cards; WHEN `cancelled` bookings exist THE SYSTEM SHALL render a
  collapsible "Cancelled" bin as a PEER of the Ideas bin — same shape,
  count Badge, collapsed by default — whose expansion is the show-cancelled
  affordance (their only surface — they are off-calendar by invariant): a
  cancelled booking stays reachable there, keeping its row and expense
  links (ledger F-043 criterion 3). Each bin SHALL render ONLY when it has
  contents — an empty bin hides entirely, never an empty box. (Amended per
  QUEUE B-13, Sean's ruling 2026-08-29 — replaces the earlier "Show
  cancelled" foot toggle inside the Ideas container.)

### Calendar-grid view (the differentiator)

- **R-itin-13**: WHEN grid mode is active THE SYSTEM SHALL render trip days
  as horizontally-paged columns against a shared vertical hour axis (1-hour
  rows, scrollable 00–24), with each timed item drawn as a block positioned
  and sized by `start_time`/`end_time`; tapping a block opens its detail.
  While the timezone switcher is visible the block is positioned by its
  CONVERTED time in the active zone (R-itin-80), and a tap on a grid
  element follows R-itin-81 (NC-3); bucket opens and routing are unchanged
  (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **R-itin-14**: WHEN a time range on a day has no items THE SYSTEM SHALL
  leave it visibly empty, and tapping an empty slot SHALL open the add flow
  prefilled with that day and the slot's time rounded to 30 min (gap →
  action, the pattern HN users explicitly ask for — competitors § call #4).
  While the timezone switcher is visible and the slot's location zone
  differs from the active zone, the prefill follows R-itin-80 (NC-6)
  (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **R-itin-15**: WHEN two or more blocks overlap in time THE SYSTEM SHALL
  render them side-by-side (never occluded) with an overlap Badge on each —
  overlaps are surfaced, never hidden or rejected (API R-ib-17). The Badge
  is an item-vs-item signal: derived checkpoint indicators (R-itin-31,
  §2.6) join the side-by-side split but SHALL neither carry nor cause it —
  ephemeral render-only UI collides with nothing (QUEUE B-12,
  Sean-specified 2026-08-29).
- **R-itin-16**: WHEN a day has untimed items THE SYSTEM SHALL render them
  as compact chips in an all-day lane pinned above that day's column.
- **R-itin-17**: WHEN grid mode opens THE SYSTEM SHALL land on the trip's
  first day (or today's column when the trip is active and today is in
  range) with the 08:00–20:00 band initially visible. ("First day" is the
  first column of the grid's day set — an earlier out-of-range item day wins
  over the trip's first day; R-itin-51.) While the timezone switcher is
  visible "today" is `todayInZone(now, activeZone)`, not the device-local
  day (R-itin-80) (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).

### Calendar view density (3-day / month / trip-span)

Sean QA feature batch 2026-09-06, feature ③. Orthogonal to R-itin-9
(list ↔ grid): density applies **only** inside grid mode — list mode is
unaffected and keeps its existing day-sectioned form.

- **R-itin-33**: WHEN grid mode is active THE SYSTEM SHALL offer a density
  selector with four options — **Day** (existing R-itin-13..17 behavior,
  the default), **3-day**, **Month**, **Trip-span** — persisting the choice
  locally per trip (independent MMKV key from the R-itin-9 list/grid
  choice, same `view-mode.ts` pattern) and restoring it on next open.
- **R-itin-34 (Day / 3-day / Trip-span — shared mechanism)**: WHEN density
  is **Day**, **3-day**, or **Trip-span** THE SYSTEM SHALL render the SAME
  hour-timeline `GridSurface` (R-itin-13..17 apply unchanged), varying only
  the simultaneous day-column count: Day = 1 column (current
  `COLUMN_FRACTION` peek); 3-day = 3 columns, no snap-peek; Trip-span = every
  trip day simultaneously, columns sized to fit down to a floor width, then
  continuous horizontal scroll (no page-snap) once the trip is long enough
  to exceed it — no trip-length cap in v1. Paging/scroll position is
  independent per density (switching density does not attempt to preserve
  scroll offset beyond re-landing on the R-itin-17 rule).
- **R-itin-35 (Month)** (Ruled 2026-09-13, Sean — PR #71 Question #2:
  option (a), true month-overview grid, confirmed): WHEN density is
  **Month** THE SYSTEM SHALL render a true month-overview grid (weeks × 7 day cells,
  no hour axis) for the month containing the current landing day
  (R-itin-17's rule); each cell SHALL show up to 3 compact item-count dots
  plus a "+N" overflow marker, and multi-day bookings (lodging spans,
  R-itin-31; overnight flights, R-itin-36) SHALL render as a thin
  connecting bar across their covered cells within a week row (the month
  analogue of the grid's all-day spanning lane, R-itin-16/31). Tapping a
  day cell SHALL switch density to **Day**, landing on that date. Days
  outside the trip's range render dimmed and inert (no add affordance).

### Add-item flows

- **R-itin-18**: WHEN the FAB is tapped THE SYSTEM SHALL open an add Sheet
  offering the 8 booking categories plus "Place visit" and "Custom block";
  selecting one SHALL open the `itinerary-item-new` modal (navigation spec
  R-nav-21 form-modal convention) with that type preset.
- **R-itin-19**: WHEN a booking category is being added or edited THE SYSTEM
  SHALL present that category's fields mirroring its `details` shape (schema
  §3.4.1) plus status (default `idea`), price + currency (paired),
  confirmation code, and optional place attach; saving without times/day
  SHALL land it in the Ideas bucket, saving with times SHALL schedule it
  automatically (API R-ib-5/R-ib-8).
- **R-itin-20**: WHEN the chosen day/times overlap existing items THE SYSTEM
  SHALL show a non-blocking inline conflict notice in the form (navigation
  spec §2.4 "conflicts surfaced inline"); save remains allowed.
- **R-itin-21**: WHEN a deeplink-capable category's form has the fields its
  partner URLs require (§2.7) THE SYSTEM SHALL enable "Search on {partner}"
  buttons that open the exact constructed URL; with insufficient fields the
  buttons SHALL be visible but disabled, hinting the missing field(s).
- **R-itin-22**: WHEN any deeplink-out button (form or booking detail) is
  tapped THE SYSTEM SHALL record `{ partner, category, tripId, timestamp }`
  for the return prompt before opening the URL externally (navigation spec
  §2.3 capture-return contract; the prompt itself is R-nav-18 — not
  re-specified here), and the prompt's "add manually" action SHALL reopen
  this add flow prefilled with the category and `source: 'deeplink_return'`
  (API R-ib-11).
- **R-itin-23**: WHEN "Place visit" is being added THE SYSTEM SHALL offer
  spine search (places search endpoint — maps/places spec seam). Listing the
  trip's saved places FIRST is the target, NOT yet wired in v1: the
  saved-places list exists (T-8.1, `GET /trips/:tripId/saved-places`) but the
  item picker does not call it (Q2-103, R-itin-59). Place ideas without a day
  are saved places by design (navigation spec place-detail "add to day"), not
  day-less items — the schema requires every item to have a `day`.

### Booking detail (per category)

- **R-itin-24**: WHEN a booking is opened (from a day item, the bucket, or
  the grid) THE SYSTEM SHALL push the `booking-detail` screen rendering:
  title + status Badge with status actions (§3.2 machine via API), the
  category's `details` fields as a labeled grid, confirmation code with a
  copy affordance (`mono` type role), price, source label
  (manual/email/share/deeplink return), linked place row → map tab, linked
  expenses row (money-spec seam), and scheduled day/time row → jumps to the
  itinerary position. While the timezone switcher is visible, a tap on a
  list row / grid element follows R-itin-81 (NC-3); bucket opens and
  routing are unchanged (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **R-itin-25**: WHEN the booking's category has partner deeplinks (§2.7)
  THE SYSTEM SHALL render deeplink-out buttons on the detail screen with the
  same construction + recording rules as R-itin-21/22.
- **R-itin-26**: WHEN Cancel is invoked THE SYSTEM SHALL require a
  ConfirmDialog (R-ds-18), then set status `cancelled` (items disappear from
  the calendar per API R-ib-7); WHEN Delete is invoked THE SYSTEM SHALL
  ConfirmDialog with copy noting linked expenses are kept (they detach —
  schema §3.6). Cancel's VISIBILITY is gated `status === 'booked'` only —
  see R-itin-39 (B-17, amends this line).
- **R-itin-27**: WHEN a `place_visit`/`custom` item is opened THE SYSTEM
  SHALL push the `itinerary-item` screen (navigation spec §2.4): title/place
  link, day + times, notes, edit (reopens the form modal) and delete
  (ConfirmDialog); tapping a `booking`-kind item routes to `booking-detail`
  instead — booking content is never duplicated across two screens. While
  the timezone switcher is visible, a tap on a list row / grid element
  follows R-itin-81 (NC-3); bucket opens and routing are unchanged
  (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).

### States, offline, testIDs

- **R-itin-28**: WHEN the itinerary is loading initially THE SYSTEM SHALL
  render Skeleton day sections (R-ds-15); WHEN the trip has zero items and
  zero unscheduled bookings THE SYSTEM SHALL render an EmptyState with an
  "Add your first plan" CTA (R-ds-16); WHEN a fetch fails THE SYSTEM SHALL
  render an ErrorBanner with retry (R-ds-17).
- **R-itin-29**: WHEN the active trip is offline THE SYSTEM SHALL render the
  itinerary (items, bookings, last-computed legs) from cache (offline-spec
  seam; PLANNING § Cross-cutting) and SHALL disable deeplink-out buttons
  with an offline hint; mutation queuing is the offline spec's contract.
  Derivation + precedence rules: R-itin-72.
- **R-itin-30**: WHEN any screen in this spec renders THE SYSTEM SHALL carry
  testIDs per the navigation-spec §2.7 grammar on its root and every
  interactive element, per the §2.9 inventory.

### Resolved questions (Gate 2, 2026-07-09)

- Multi-day bookings — Resolved at
  `.specs/database/schema.spec.md`:§3.3.10 `itinerary_items` (Gate 2,
  2026-07-09): ONE spanning item (`end_day` stays), rendered as a
  **spanning all-day lane on the grid** and **check-in/check-out point
  rows on the day list** — §2.6 holds the decided rendering; see
  R-itin-31.
- Trip dates — Resolved at `.specs/database/schema.spec.md`:§3.3.4 `trips`
  (Gate 2, 2026-07-09): dates are required at creation v1 — every trip has
  a day range to section and grid from birth.
- **Party size for deeplink-out URLs — decided:** default `adults` = the
  trip's member count, editable inline in the add flow per search (no
  schema change; a solo planner booking for four just edits the field).
  See R-itin-32. (Resolved 2026-07-09, Gate 2)
- **Persistent mini-map in plan mode — decided: deferred to the polish
  phase.** The map tab alone carries the map-beside-itinerary pattern in
  v1, with strong linkage from itinerary surfaces (place rows → map tab);
  a collapsible mini-map strip is a polish-phase enhancement, not v1
  layout. (Resolved 2026-07-09, Gate 2)

- **R-itin-31 (multi-day rendering):** WHEN a lodging (or other spanning)
  booking covers multiple days THE SYSTEM SHALL render it in grid mode as
  a spanning lane in the all-day lane across its covered day columns, and
  in list mode as synthesized check-in and check-out point rows on their
  respective days (derived from the single spanning item — no extra data
  rows); nights between render nothing in the list. (Resolved 2026-07-09,
  Gate 2) Grid mode SHALL additionally draw two small derived checkpoint
  indicator blocks (~15-minute size) on the timed grid at the real
  check-in/check-out times when set — ephemeral render-only projections of
  the SAME single row, never persisted and never itinerary rows (ledger
  F-051 criterion 2: exactly one DB row per multi-night stay), exempt from
  the R-itin-15 overlap Badge, routing to the same `booking-detail` as the
  lane. (Amended per QUEUE B-12, Sean-specified 2026-08-29) **Category
  scope note:** despite the generic "or other spanning" wording, list-mode
  point-row synthesis shipped LODGING-ONLY (`model.ts` `projectItem` gated
  `base.category === "lodging"`); every other spanning item rendered as one
  row + a `plusOne` "+1" chip instead (§2.6). R-itin-36 brings `flight` into
  the point-row treatment (Sean QA feature batch 2026-09-06, feature ①);
  the `plusOne` chip stays live for every category R-itin-36 does not name.
- **R-itin-32 (deeplink party size):** WHEN a deeplink-out URL takes a
  traveler count THE SYSTEM SHALL default it to the trip's current member
  count and offer an inline, per-search editable adults field in the add
  flow; the edited value applies to that search's constructed URL.
  (Resolved 2026-07-09, Gate 2)

### Overnight/multi-day flights — list view (Sean QA feature batch 2026-09-06, feature ①)

- **R-itin-36**: WHEN a `flight` booking's derived auto-item spans two wall
  dates (`end_day` set — API §3.3 "everything else" branch, already
  computed server/shared-side, no derivation change) THE SYSTEM SHALL, in
  **list mode only**, extend the R-itin-31 point-row mechanism to `flight`:
  synthesize a "Departs" row on `day` and an "Arrives" row on `end_day`
  from the SAME single spanning item (F-051-class single-row invariant —
  zero extra `itinerary_items` rows, mirroring the lodging mechanism
  exactly, not the car_rental/moped_rental two-DB-row mechanism); the
  "Arrives" row is render-only (not draggable — reassigning its day would
  misfile the item, R-itin-31 check-out precedent) and both rows route to
  the same `booking-detail`. Grid mode is explicitly UNCHANGED by this
  requirement — it keeps the existing clipped-block-with-"+1"-tail
  rendering (§2.6); Sean's direction was scoped to list view. A same-day
  flight (`end_day` null or equal to `day`) renders as today: one row, no
  "+1" chip, no Departs/Arrives split. Scope is `flight` only per the QUEUE
  row's literal wording — `train` shares the identical mechanical shape
  (same `end_day` derivation branch) but is deliberately NOT included this
  batch (see PR body "what we deliberately did not spec"). The "Arrives" row,
  like a lodging check-out row (R-itin-46), has no `sort_order` on its day, so
  THE SYSTEM SHALL render it FIRST in its `end_day` section ahead of that
  day's own items, and SHALL NOT carry the R-itin-7 "Overlap" chip on it — the
  R-itin-7 overlap analysis runs on the departure day only (clipped at
  midnight); arrival-day collisions are not analysed in either mode (T-7.11).

### Calendar timezone switcher (Sean QA feature batch 2026-09-06, feature ②; effect superseded by T-7.17 — Sean UX story 2026-09-19)

- **R-itin-37 (zone set, labels, control)** (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06): WHEN the itinerary
  tab renders THE SYSTEM SHALL derive the trip's ZONE SET as the distinct union of (a) the
  trip's effective `destination_tz` (B-30 — never null on the wire) and (b) every
  `departs_tz`/`arrives_tz` on the trip's `flight` and `train` bookings whose status is
  `planned` or `booked` (idea and cancelled bookings put nothing on the calendar, R-itin-8),
  keeping only ids that pass the shared shape-and-engine gate (`isValidTimeZone`,
  `@gogo/shared` `time.ts`) AND resolve on the device's engine (`isKnownTimeZone`, B-9) —
  exact-id de-duplication, no alias folding. `lodging` and every other category contribute
  no zone of their own (no schema change); their times convert through R-itin-78's location
  timeline. Each zone SHALL be city-labeled through `describeTimeZone`
  (`add-edit/zoned-time.ts`) — "Tokyo — GMT+9", never a bare offset — with the offset taken
  at the reference date (the R-itin-17/51 landing day); offset-identical zones (Tokyo/Seoul)
  stay distinct rows. Order: the destination zone first; then the remaining zones by first
  use in departure order (a leg's departure zone before its arrival zone); then zones carried
  only by bookings without times, alphabetically by city. WHEN the zone set has fewer than 2
  zones THE SYSTEM SHALL hide the switcher entirely and every itinerary time SHALL render
  exactly as it did before T-7.17 (a tap opens detail, R-itin-81). Otherwise THE SYSTEM SHALL
  render the switcher in BOTH list and grid mode as ONE compact pressable chip — clock icon
  (`time-outline`), the active zone's label, a chevron — in a toolbar row directly under the
  PageHeader (§2.6b), at least `touchTarget` tall, accessibilityRole `button`,
  accessibilityLabel "Time zone: {city}, {GMT±X}", hint "Shows this trip's time zones".
  Tapping it SHALL open a DS Sheet listing every zone in the set as one row ("{city} —
  GMT±X"; subtitle the IANA id; the destination row additionally captioned "Trip
  destination", or "Trip destination (from your bookings)" WHEN `Trip.destination_tz_source`
  (B-30) is `booking` — that rung picks among the non-cancelled flight/train bookings (booked
  before planned before idea, then earliest) and can be a connecting leg
  (`.specs/api/trips.spec.md` §3.4 limit; a user zone, R-tripui-29, is the override)), the
  active row check-marked with `accessibilityState.selected`. Selecting a
  different row SHALL close the Sheet and make that zone active (R-itin-38); selecting the
  active row SHALL close the Sheet with no change. ("Railway accessible" in the T-7.17 story
  is read as "readily accessible": one tap from either view mode, never behind a menu,
  VoiceOver-complete per R-itin-30.)
- **R-itin-38 (effect, default, persistence)** (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06)
  (replaces the 2026-09-13 "display-only, no math" ruling, PR #71 Q1): WHILE the switcher is visible THE
  SYSTEM SHALL render every itinerary time shown in the list (R-itin-79) and the grid
  (R-itin-80) in exactly ONE active zone, converting each time from its source zone
  (R-itin-78); the chip SHALL always name the active zone. [NEEDS CLARIFICATION: NC-1 — is
  there a no-conversion "Local times" mode, and what does the tab show on open? (a) No such
  mode: one active zone always, default the trip's `destination_tz` — on a Tokyo trip an
  LAX→NRT flight's Departs row reads "03:35 (+1)" instead of the ticket's "11:35"; tapping it
  (R-itin-81) shows it in LA time. (b) "Local times" is the default and a Sheet row: each
  item in its own zone (today's airport-local rendering, schema §3.4.1); picking a zone,
  focusing an item or following days converts. (c) As (a), plus every converted flight/train
  time keeps its ticket-local time as a secondary caption ("03:35 (+1) · 11:35 LAX"). Rec
  (a) — literal to "show all times for the trip in each time zone", and the focus/follow
  mechanics assume one zone is always active; (c) if the non-ticket default reads as a
  B-8-class regression.] Default active zone when the tab opens: the trip's `destination_tz`
  when it is in the zone set, else the set's first zone. WHEN the active zone leaves the zone
  set (its booking was deleted, cancelled or re-zoned) THE SYSTEM SHALL fall back to the
  default. One active zone per trip, shared by list and grid. [NEEDS CLARIFICATION: NC-5 —
  does the active zone survive a cold start? (a) Session-only: an in-memory per-trip slot
  (R-nav-9's tab-memory precedent, `navigation/tab-memory.ts`), reset on sign-out; a cold
  launch re-applies the default. (b) MMKV per trip (`gogo.itineraryTimeZone.{tripId}`, the
  R-itin-9/33 pattern the 2026-09-13 text specified). Rec (a) — focus and follow now change
  the zone as a side effect of ordinary taps and paging, so persisting it reopens a trip in
  whatever zone the last tap left behind.] Conversion is display arithmetic in the client
  only: it SHALL NOT change any stored value, request or wire shape, and it works offline
  over cached data (R-itin-29). Booking detail (R-itin-71), item detail, add/edit forms, the
  Ideas/Cancelled bins, the Month view (R-itin-35 renders no times), travel-time chips and
  the Today tab are unaffected and keep native wall times.
- **R-itin-78 (source zone of each time)** (NEW 2026-10-06 — T-7.17): WHEN a displayed
  itinerary time is converted THE SYSTEM SHALL read its stored wall value (`day`/`end_day` +
  `start_time`/`end_time`, API §3.3 — unchanged) in its SOURCE zone:
  - `flight`/`train` booking item — start in the booking's `departs_tz`, end in its
    `arrives_tz`, only while that edge's wall still equals the booking's `departs_at` /
    `arrives_at` wall (an item-owned edit, I-3, falls to the next rule — the
    `rentalCheckpointSubtext` precedent). A booking zone the device cannot resolve SHALL NOT
    be re-attributed: that item renders native.
  - every other item (lodging, rentals, activity, restaurant, other, place visit, custom) —
    the LOCATION-TIMELINE zone at that wall time: the zone the traveller is in, derived from
    the trip's planned/booked flight/train legs that carry both times and both zones — the
    first leg's departure zone before it departs, each leg's arrival zone from its arrival
    until the next leg departs. Where two segments both contain the wall time (an eastbound
    date-line replay) the EARLIER segment wins; where none does (westbound date-line / in
    flight) the last segment that started at or before it wins. A trip with no such leg uses
    its `destination_tz`.
  - A source zone equal to the active zone SHALL show the stored wall verbatim (no engine
    round trip — a DST-gap wall such as 02:30 never re-renders as 03:30).
  - Wall + zone are authoritative; a stored offset is ignored (B-9's composition is
    deterministic, so every B-9-written row round-trips; a legacy `Z`-stamped row converts
    from its wall + attributed zone).
  - IF any timed edge of an item cannot be converted (unresolvable zone; an engine
    `isIntlFaithful` rejects) THEN the WHOLE item SHALL render native — never half-converted,
    never a guessed instant (B-9 R1 posture). An untimed item (`start_time` null) keeps its
    stored day and renders native.
- **R-itin-79 (list under conversion)** (NEW — T-7.17): [NEEDS CLARIFICATION: NC-2 — where
  does a converted item sit in the list? (a) In its STORED day section and `sort_order`
  position; each converted time carries a relative-day suffix when its converted date differs
  from the section day. (b) Re-bucketed into its converted day, ordered by converted time,
  with drag-reorder and "Sort day by time" disabled while any item is converted. Rec (a) —
  the list stays the editing surface (R-itin-2/3/7/48 unchanged; a day-order PUT can never
  carry a converted day), a focus tap never reflows the list, and under NC-1 (a) option (b)
  would be live on every multi-zone trip.] Under (a): THE SYSTEM SHALL keep stored day
  sections, `sort_order`, drag (R-itin-2/3), overlap chips and "Sort day by time" (R-itin-7,
  evaluated on stored walls) exactly as today, and render each converted time as `HH:MM`
  followed — when its converted date differs from the row's section day — by " (+N)" /
  " (-N)", spoken to VoiceOver as "next day" / "previous day" / "N days later|earlier". Point
  rows convert their own edge: Departs/check-in the start, Arrives/check-out the end
  (R-itin-31/36). A row with any converted edge SHALL NOT also carry the §2.6 "+1" chip (the
  suffixes say it); a row with no converted edge renders byte-identically to today.
- **R-itin-80 (grid under conversion)** (NEW — T-7.17): WHILE the switcher is visible THE
  SYSTEM SHALL lay out every timed block, checkpoint indicator (R-itin-31) and spanning lane
  segment (R-itin-52) by its CONVERTED day and time — an item whose converted start falls on
  another date renders in that date's column; a converted span that crosses midnight takes
  R-itin-52's clipped block + "+1" tail; a converted date outside the trip range adds a
  sparse column (R-itin-45). Block metadata — title, icon, status, rental "Pickup"/"Drop off"
  subtext (B-18), day lock — SHALL still derive from the NATIVE item. Overlap split and badges
  (R-itin-15/53) are computed on converted positions. The R-itin-17/51 landing "today" SHALL
  be `todayInZone(now, activeZone)` (`@gogo/shared` `time.ts`, B-30), replacing the
  device-local day the navigation spec's B-30 note leaves to T-7.17. WHEN an empty slot is
  tapped (R-itin-14/50) whose location zone (R-itin-78, at the slot's instant) differs from
  the active zone THE SYSTEM SHALL [NEEDS CLARIFICATION: NC-6 — (a) prefill the add form with
  the slot converted into that location zone, so the saved item lands exactly under the
  tapped slot (tapping 14:00 on a Tokyo day while viewing LA time prefills the next day,
  06:00); (b) prefill the tapped day and time verbatim (the form reads 14:00; the saved item
  then renders at a different slot); (c) render those slots inert, like a viewer's
  (R-itin-50). Rec (a) — the gap → action promise is positional, and the form always edits
  the local time the traveller will live.]
- **R-itin-81 (focusable items)** (NEW — T-7.17): WHILE the switcher is visible, WHEN the user
  taps a list row or a grid block, all-day chip, lane segment or checkpoint indicator THE
  SYSTEM SHALL highlight it (2pt `border.focus` outline; `accessibilityState.selected`) and
  make ITS zone active: a flight/train row or "Departs" row → its start edge's source zone
  (R-itin-78); an "Arrives" row → its end edge's; a lodging check-in row, lane segment or
  check-in indicator → the start edge's, check-out → the end edge's; any other item → its
  start edge's (untimed → the timeline zone at 00:00 of its day). An item whose zone is
  unresolvable is highlighted and the zone stays unchanged. One focus at a time; it clears
  when another item is focused, the active zone changes any other way, the view mode toggles,
  or the screen unmounts. An automatic zone change (this requirement or R-itin-82) SHALL be
  announced to VoiceOver ("Times now shown in {city} time"). [NEEDS CLARIFICATION: NC-3 — how
  does a user OPEN an item now that one tap focuses? (a) Tapping the already-focused item
  opens its detail (R-itin-24/27); VoiceOver double-tap follows the same two steps, plus a
  custom action "Open details" that opens in one. (b) One tap focuses AND opens the detail;
  the highlight and new zone are waiting on return. (c) Focus lives on a separate affordance
  (the card's time text / a small zone tag); a card tap opens detail as today. Rec (a) — the
  story's literal "one tap highlights it"; the cost is a second tap to open, on multi-zone
  trips only.] WHEN the switcher is hidden (fewer than 2 zones) a tap SHALL open detail
  directly, exactly as today.
- **R-itin-82 (calendar follows the days)** (NEW — T-7.17): WHILE grid mode is active and the
  switcher is visible, WHEN a horizontal page or scroll settles (momentum end — never per
  frame), the density changes (R-itin-33), or a Month cell tap lands on Day (R-itin-35), THE
  SYSTEM SHALL compute the FIRST visible column's location zone — the R-itin-78 timeline zone
  at 00:00 of that date ("first day priority if changes") — and [NEEDS CLARIFICATION: NC-4 —
  (a) switch to it only when it DIFFERS from the first-visible-day zone at the previous settle
  (edge-triggered: paging through Tokyo days after picking LA keeps LA; paging into Seoul days
  switches); the grid's first render is a baseline, not a follow event; (b) set it on every
  settle (a manual pick lasts until the next page); (c) follow only while a "Follow the days"
  row is selected in the Sheet; a manual pick or focus turns following off. Rec (a) — it is
  "when we switch view to days at a specific location"; (b) fights every manual pick; (c)
  adds a mode to explain.] List scrolling and the list's day-jump strip never switch zones.

### Ideas flow rework (Sean QA feature batch 2026-09-06, feature ④)

- **R-itin-39**: WHEN a `booked` booking's status is being displayed on
  the `booking-detail` screen THE SYSTEM SHALL offer a Cancel action only
  for that status (B-17, Sean's device-QA ruling 2026-09-06, PR #47) —
  `idea`/`planned` bookings expose NO Cancel affordance in this UI, even
  though the API's §3.2 transition table still permits `idea → cancelled`
  and `planned → cancelled` at the wire layer (unchanged; reachable only
  through a direct API caller, never this UI). Amends R-itin-26.
- **R-itin-40**: WHEN an idea card in the Ideas bin is acted on THE SYSTEM
  SHALL offer two actions, "Planned" and "Booked" — replacing the single
  "Add to day" action (R-itin-11, amended) — each opening a status-action
  Sheet; ideas without a day stay legal and untouched (no action required),
  but every transition OUT of `idea` through this bucket flow SHALL
  require a valid day before it commits, per R-itin-41's routing.
- **R-itin-41 (validation + routing)**: WHEN the status-action Sheet
  (R-itin-40) opens for a booking with NO known primary times THE SYSTEM
  SHALL require a valid day (times stay optional) before the confirm
  button enables, with inline errors for an empty day or an end time
  before its start time (mirroring today's schedule-picker validation); on
  confirm THE SYSTEM SHALL call the schedule endpoint with the entered
  day/times AND the tapped target status, transitioning `idea → planned`
  or `idea → booked` and scheduling the item in one transaction (API
  R-ib-8, extended — see itinerary-bookings.spec.md §3.4). WHEN the Sheet
  opens for a booking that ALREADY carries known primary times (the
  pre-existing gap the schedule endpoint's R-ib-8 always rejected —
  `ScheduleSheet`'s module doc records it) THE SYSTEM SHALL render them
  read-only with a "change the date on the booking itself" hint (R-ib-16
  parity) and, on confirm, apply ONLY the status PATCH (API §3.2) — the
  booking service's existing I-2 auto-item behavior supplies the calendar
  row, no schedule call. Neither path can produce a `planned`/`booked`
  booking with no day through this flow; the R-itin-12 "needs a day" flag
  stays reachable only via other write paths (the booking-detail screen's
  plain status buttons, R-itin-39; capture; direct API).

### Round-2 spec-pass rulings (ruled 2026-09-19)

Sean approved the round-2 spec-pass batch wholesale on 2026-09-19
(`.specs/OPEN-QUESTIONS.md` § Round 2; the `Q2-NNN` rows stay as the decision
record). Each rule stamped "ruled 2026-09-19" is the as-shipped
interpretation made normative (ruled as shipped) and cites its id. Four items
whose Rec named a real alternative — which approve-all did NOT decide
(Q2-056, Q2-064, Q2-125, Q2-181) — are written as shipped, labelled "as
shipped; Sean pick pending", and carry a `[NEEDS CLARIFICATION]` marker. This
file's 2 open markers are Q2-125 (R-itin-67) and Q2-181 (R-itin-76); the
other two live in `.specs/api/itinerary-bookings.spec.md`; the 2026-10-06
T-7.17 amendment adds NC-1..NC-6 (R-itin-38, R-itin-79..82), so 8 in
total — see the trace paragraph. The spec is
approvable once all are ruled. Grouped by source task. R-itin-33..41 above
are the separately signed-off P-7 extension; this batch does not touch them.

#### Deeplink-out builders (T-7.8)

- **R-itin-42 (party size surface; Q2-065, ruled 2026-09-19):** the editable
  `adults` field exists on the FORM surface only (R-itin-32 scopes the inline
  edit to the add flow); the booking-detail deeplink panel (R-itin-25) builds
  with the member-count default and no editor. `adults` reaches a partner URL
  only where that partner's §2.7 format carries a traveler count (Skyscanner,
  Airbnb, Booking.com, Expedia, Vrbo); every other partner link carries no
  party-size param.
- **R-itin-43 (builder degradation; Q2-066, Q2-067, Q2-070, ruled
  2026-09-19):** WHEN the Trainline station lookup fails OR succeeds with zero
  URNs THE SYSTEM SHALL fall back to the plain `https://www.thetrainline.com/`
  link — never a broken deep link, never an error surface. WHEN
  `details.external_url` has a scheme other than http(s) THE SYSTEM SHALL
  treat it as a MISSING field (button disabled with its hint) and never hand
  it to `Linking.openURL` (stored data must not reach `javascript:`/`tel:`
  handoffs). WHEN the Skyscanner cabin class is absent or unrecognized THE
  SYSTEM SHALL emit `cabinclass=economy` (the documented param set is always
  emitted).
- **R-itin-44 (manual-add fallback; Q2-068, ruled 2026-09-19):** the return
  host's built-in "add manually" landing (`ManualAddBookingSheet`: one title
  field → `POST …/bookings` with the recorded category and
  `source: 'deeplink_return'`, status defaulting to `idea`) is the HOST'S
  FALLBACK only — the itinerary stack passes `onAddManually`, which routes to
  `item/new?category=…` per R-itin-22, so the fallback never mounts there.
  Its five testIDs — `booking-manual-add-sheet`, `-error`, `-input-title`,
  `-button-save`, `-button-cancel` — are listed in §2.9 (fallback-only).

#### Plan-mode day list (T-7.4)

- **R-itin-45 (section set + jump strip; Q2-071, Q2-075, ruled 2026-09-19):**
  WHEN the day list builds its sections THE SYSTEM SHALL render EVERY day of
  the trip's date range — in-range empty days included, each with its R-itin-1
  "Add to this day" row — and add exactly one section per distinct
  out-of-range day that has content. Out-of-range item days are SPARSE: an
  item three weeks past the trip adds one section, never weeks of empty
  filler. The horizontal day-jump strip (§2.2) renders at every trip length —
  §2.2's "for long trips" is motivation, not a threshold.
- **R-itin-46 (check-out row; Q2-073, ruled 2026-09-19):** WHEN a lodging
  check-out point row (R-itin-31) renders THE SYSTEM SHALL place it FIRST in
  its end-day section (it has no `sort_order` on that day; check-out-is-morning
  makes first the deterministic position) and SHALL NOT make it draggable —
  listing its id in the end-day day-order PUT would REASSIGN the spanning
  item's `day` and misfile the stay (API R-ib-15/16). The scope of the
  point-row mechanism (lodging; `flight` per R-itin-36; every other spanning
  category one row plus a `+1` chip) is as R-itin-31's category scope note
  states (Q2-072, ruled 2026-09-19).
- **R-itin-47 (nameless place visit; Q2-074, ruled 2026-09-19):** WHEN a
  `place_visit` item renders and no place name is available to the client
  (v1: the composite itinerary read carries `place_id` only — API R-ib-30)
  THE SYSTEM SHALL show the generic title "Place visit" on its list and grid
  card — never a blank title — until a place-name source exists (the
  maps-spine join).
- **R-itin-48 (refused reorder; Q2-076, ruled 2026-09-19):** WHEN the server
  refuses a day-order PUT that the client did not itself prevent (e.g. stale
  lock knowledge — the wire 400 carries no discriminating reason in v1) THE
  SYSTEM SHALL roll back and show the ONE generic reorder ErrorBanner
  (R-itin-2); the crafted day-lock hint of R-itin-3 is reserved for drops the
  client itself prevents.

#### Calendar grid (T-7.7)

- **R-itin-49 (block geometry; Q2-077, Q2-091, ruled 2026-09-19):** WHEN a
  timed item has no `end_time` THE SYSTEM SHALL draw it as a 60-minute block
  (the list shows a bare start time). WHEN an event is shorter than a
  tappable block THE SYSTEM SHALL keep `top` duration-true and floor the
  block's `height` at `MIN_BLOCK_HEIGHT = 22pt` — a documented deviation from
  strict R-itin-13 duration sizing: a 5-minute espresso stop renders 22pt
  tall, not 5pt, so tiny blocks stay readable and tappable (R-ds-9 spirit).
- **R-itin-50 (gap-tap; Q2-078, Q2-084, ruled 2026-09-19):** "rounded to 30
  min" (R-itin-14) means FLOOR to the half-hour containing the tap — the
  tap's `locationY` within its hour row (24 pressable hour slots per day sit
  behind the blocks); a press event carrying no location prefills `HH:00` (a
  defensive default — native always supplies the event; the bare case is a
  test-renderer artifact). WHEN the member's role is
  `viewer` (R-ib-24) THE SYSTEM SHALL render the slots as inert grid lines —
  no slot Pressables, no slot testIDs; read affordances (blocks, chips,
  lanes) stay pressable. While the timezone switcher is visible and the
  slot's location zone differs from the active zone, the prefilled day and
  time follow R-itin-80 (NC-6) (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **R-itin-51 (landing band + column; Q2-079, Q2-080, ruled 2026-09-19):**
  the "08:00–20:00 band initially visible" of R-itin-17 is realized as
  `hourHeight = viewportHeight / 12`, clamped to 44–96pt — exact inside the
  clamp, approximate on extreme screens — with the initial vertical offset at
  08:00. The landing column is today's whenever today is in the grid's
  day-column set (the trip range plus any sparse out-of-range item days,
  R-itin-45) — so a trip that has ended but has an item dated today lands on
  today — else the FIRST column of that set: the trip's first day, or an
  earlier out-of-range item day when one exists (`initialDayIndex` returns
  the earliest column). While the timezone switcher is visible "today" is
  `todayInZone(now, activeZone)`, not the device-local day (R-itin-80)
  (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **R-itin-52 (spanning lane segments; Q2-081, Q2-083, Q2-088, ruled
  2026-09-19):** WHEN a spanning booking renders in the grid's all-day lane
  (R-itin-31, §2.6) THE SYSTEM SHALL draw it as abutting per-column segments
  — rounded and labeled at the check-in/check-out edges, squared between,
  every segment carrying the same `bookingId` so all route to one detail —
  because a literal single element cannot span a virtualized pager.
  Non-lodging spanning items generalize §2.6's flight treatment in the GRID:
  a timed one renders as a block clipped at 24:00 with a "+1" tail on the
  arrival day; an untimed one renders as an all-day chip with a "+1" badge
  (list mode keeps §2.6's per-category rules and R-itin-36). Spanning-lodging
  detection reuses `projectItem`'s two-entry signature, so the list and the
  grid share one source of truth — no duplicated category logic.
- **R-itin-53 (overlap badge scope; Q2-085, ruled 2026-09-19):** WHEN blocks
  are clustered for the side-by-side split (R-itin-15) THE SYSTEM SHALL badge
  only blocks that DIRECTLY share a time range with another block;
  transitively-chained cluster members split the width but carry no badge.
  Touching edges (one block ending at 10:00, another starting at 10:00) do
  not overlap; identical zero-length point events do (they split
  side-by-side).
- **R-itin-54 (column geometry; Q2-086, Q2-087, ruled 2026-09-19):** in Day
  density the day-peek column is 92% of (window width − 48pt gutter), paged
  by `snapToInterval` (§2.5 names the behavior; this pins the ratio — the
  R-itin-34 `COLUMN_FRACTION` peek). All-day chips render in ONE fixed-height
  row per column — flex-squeezed, no wrap — so the pinned header strip keeps
  a uniform, virtualization-stable height.

#### Ideas bucket + add/edit flows (T-7.6)

- **R-itin-55 (datetime composition; Q2-092, ruled 2026-09-19):** WHEN a
  booking-detail datetime is composed for a field whose wire shape carries no
  `*_tz` zone THE SYSTEM SHALL write it as `YYYY-MM-DDTHH:MM:00Z` — the client
  has no destination-timezone database, so the wall values ride a `Z`
  offset. Calendar placement is derived by SLICING the wall date/time
  components (shared `wallDate`/`wallTime`, API §3.3), so placement is exact;
  only the denormalized UTC instant (`starts_at`/`ends_at`) is approximate —
  trip-internal sort, self-consistent. A datetime field with only one half
  set is a field-level validation error ("Set both date and time, or clear
  both."), never a silent drop. Zoned fields (flight/train `*_tz`, B-9)
  compose with their real offset and require the zone — they never take the
  `Z` path.
- **R-itin-56 (bins; Q2-093, Q2-094, Q2-095, Q2-096, ruled 2026-09-19):** each
  bin of §2.3 (Ideas, Cancelled — B-13's shared shape) SHALL default
  collapsed and, expanded, cap its content at 45% of the window height with
  internal scroll. The cancelled list is fetched EAGERLY — one bounded extra
  `status=cancelled` read per itinerary mount — so a cancelled-only trip's bin
  still appears (R-itin-12 makes the bin their only surface; a lazy fetch
  would strand them invisible). Both bins render in BOTH view modes, grid
  included — unscheduled and cancelled bookings have no other surface. A
  cancelled card carries a neutral "Cancelled" badge, routes to
  `booking-detail`, and is never schedulable (§3.2: cancelled is terminal).
- **R-itin-57 (add-option ids; Q2-098, Q2-099, ruled 2026-09-19):** add-option
  slugs are the kebab-case of the category — `car-rental`, `moped-rental`,
  `place-visit` (plus `custom`) — matching §2.9's other kebab ids. The
  in-form category step (the path for category-less prefills) reuses the
  `itinerary-add-option-*` ids: the add Sheet and that step never co-mount.
- **R-itin-58 (create prefill + chain failure; Q2-100, Q2-101, ruled
  2026-09-19):** WHEN `item/new` opens with `?day=` alone THE SYSTEM SHALL NOT
  write that day into the booking's details — it stays the create→schedule
  target (R-ib-8); only day + time (a gap-tap) seeds the primary-start field,
  which prevents phantom "00:00" times. WHEN a create→schedule chain fails
  after the booking was created THE SYSTEM SHALL never fail silently: the
  booking exists in Ideas, a warning banner ("Saved to your Ideas — adding it
  to the day failed") shows, and Save swaps for Done — no duplicate-create
  risk.
- **R-itin-59 (place attach; Q2-102, Q2-103, Q2-114, ruled 2026-09-19):** the
  place picker searches the places spine only (Q2-103, as shipped): the
  saved-places list endpoint exists (T-8.1, `GET /trips/:tripId/saved-places`;
  mobile `useSavedPlaces`) but the item picker is NOT wired to it, so
  R-itin-23's "saved places first" leg is a flagged seam, not a silent skip.
  WHEN an edit form opens on a record whose attached place has no name
  on the wire (API R-ib-30) THE SYSTEM SHALL show a generic placeholder chip:
  "Attached place" on a booking edit, "Selected place" on `ItemForm` edit —
  two strings for one state, pending the maps-spine join; unify them into one
  at the next touch of either (non-blocking).
- **R-itin-60 (viewer gating; Q2-104, ruled 2026-09-19):** WHEN the member's
  role is `viewer` THE SYSTEM SHALL hide the FAB, the empty-day add rows, and
  the EmptyState CTA (R-ib-24 — no guaranteed-403 affordances); day headers
  remain, and `item/new`, if reached by URL, renders a view-only notice
  instead of the form.
- **R-itin-61 (form fields; Q2-106, Q2-107, Q2-109, Q2-113, ruled
  2026-09-19):** booking forms show exactly the §2.4 table's fields, plus
  `activity.address` — the activity row's "venue/place" reads as covering the
  venue name AND its address. `notes`, flight `segments` and `passenger_names`
  exist in the detail shapes but stay off-form (capture and detail surfaces
  own them). Kayak's "non-stop only" toggle (§2.7 caveat) is not exposed — it
  is not in the §2.4 field table. Item forms (`place_visit`/`custom`) expose
  no `end_day`; `title` is custom-only and the place is place_visit-only,
  per API R-ib-26.
- **R-itin-62 (edit semantics; Q2-105, Q2-108, ruled 2026-09-19):** the status
  control honors §3.2 exactly: edit offers only legal targets (`booked` hides
  `idea` — the deliberate two-step; `cancelled` renders as a static badge;
  cancel/delete live on the detail screen, R-itin-26/39), and a status PATCH
  fires only when status CHANGED — the matrix has no self-loops. Booking edit
  sends whole-form LWW: `details` as one whole value, and price / currency /
  confirmation / place as nullable fields that clear on each save when
  emptied.
- **R-itin-63 (deeplink integration; Q2-110, Q2-111, ruled 2026-09-19):** the
  return host (`DeeplinkReturnHost`) mounts ONCE in the itinerary stack
  layout — every deeplink-out surface (form, booking detail) lives in that
  stack, and the recorded `{ partner, category, tripId, timestamp }` carries
  its own `tripId`, so a cross-trip return still routes; lifting the mount to
  trip/root chrome later needs no API change. The lodging deeplink `location`
  falls back address → `property_name` → `trips.destination_name` (§2.7; the
  property name is the better query when the address is empty).
- **R-itin-64 (field widgets; Q2-115, Q2-116, ruled 2026-09-19):** WHEN the
  SELECTED option chip of an enum detail field is tapped THE SYSTEM SHALL
  clear the field (every detail field is optional and no "none" option
  exists). WHEN a `TimeField` has no value THE SYSTEM SHALL open its picker
  at 12:00 (noon) — a midnight default would hit the DST edges.

#### Travel-time legs + conflict surfacing (T-7.5)

- **R-itin-65 (chip placement + endpoints; Q2-119, Q2-120, Q2-132, Q2-150,
  Q2-151, ruled 2026-09-19):** WHEN a located pair has computed legs THE
  SYSTEM SHALL render its chip directly after its FROM row — the leg's anchor
  is the item you are leaving — even when the pair is not adjacent because
  the chain crosses unlocated items (API R-ib-20; both endpoint titles ride
  the accessibility label). The forward scan for the TO endpoint SHALL STOP at
  the first LOCATED entry: transparency is for unlocated items only, so a
  stale leg after a reorder (legs are directional and recompute is async,
  API R-ib-19) degrades to absent (R-itin-6), never drawn against the wrong
  neighbour. Check-out rows ARE leg endpoints — a spanning item chains into
  both its `day` and `end_day` (API R-ib-20) — so hotel → first-stop on a
  check-out morning gets a chip; where the client's row order and the
  server's chain order disagree on a check-out day, the directional pair key
  degrades to absent and can never invent a chip. A same-place pair
  (`provider: 'same_place'` — zero duration and distance for every mode, API
  §3.5) renders NO chip: there is no travel to time. An entry whose parent
  booking is unknown to the client (an enrichment gap) counts as LOCATED —
  located-ness only STOPS the scan, so the gap fails safe to absent instead
  of skipping a real item; a KNOWN parent with a null `place_id` stays
  genuinely unlocated and transparent.
- **R-itin-66 (leg Sheet; Q2-121, Q2-122, Q2-123, Q2-124, Q2-130, Q2-131,
  Q2-133, ruled 2026-09-19):** the leg Sheet (R-itin-4) SHALL be titled "To
  {toTitle}" and list every computed mode as INFORMATIONAL rows, not
  selectors — only Directions and close are interactive, so the chip can
  never contradict R-itin-5 (the row matching the chip carries a "Shown"
  badge). Distance (metric only — no locale/units preference exists yet) and
  the provider (e.g. "3.4 km · transitous", for legibility) ride the Sheet
  rows, never the chip, which stays duration + mode icon (§2.2). Duration
  copy rounds to the nearest minute, floors a sub-minute leg to "1 min", and
  splits hours above 60 minutes. The Sheet does NOT use `dismissDisabled` (it
  wraps no mutation to gate) and mounts EAGERLY like every other Sheet on the
  screen — a lazy mount put mounting and `visible → true` in one commit and
  gave Reduce Motion users a spring slide-up then a teleport (R-ds-11).
- **R-itin-67 (Directions handoff; Q2-126, Q2-127, Q2-128, Q2-129, ruled
  2026-09-19; Q2-125 — as shipped, Sean pick pending, below):** WHEN the
  Directions row is tapped THE SYSTEM SHALL open Google Maps via the §2.7
  "Directions handoff" URL (Q2-125 — as shipped; Sean pick pending: (a) bless
  Google-only for v1 / (b) spend a device-verify pass on an Apple Maps
  variant (`maps.apple.com` `saddr`/`daddr`/`dirflg`). Rec: "Bless Google-only
  for v1, or spend a device-verify pass on an Apple Maps variant — real
  alternative, deliberately not shipped." T-8.3's nav handoff (Q2-232) rides
  the same pick.) [NEEDS CLARIFICATION: Q2-125 — Google-only Directions for
  v1, or device-verify an Apple Maps variant?] Directions taps SHALL NOT be
  recorded for the return prompt (R-itin-22) — a
  navigation handoff books nothing. WHEN an endpoint has no usable free-text
  label (an unnamed `place_visit`; API R-ib-30) THE SYSTEM SHALL render
  Directions disabled with a "Needs …" hint — never a junk-text query for the
  literal "Place visit". The endpoint label is a two-way branch on
  `item.kind`: a `booking`-kind item resolves `details.address` → the
  booking's title → none and NEVER falls back to `item.title` (null for
  booking rows by schema); any other kind uses `item.title` directly (null
  for an unnamed `place_visit`, which is what disables Directions — adding a
  fallback would reintroduce the junk query). The trip destination is
  appended as query context ("Walk Shibuya, Tokyo"), suppressed when the
  label already contains it.
- **R-itin-68 (overlap vs sort; "Sort by time"; Q2-134, Q2-135, Q2-136,
  Q2-137, Q2-138, Q2-139, Q2-140, Q2-149, ruled 2026-09-19):** the OVERLAP
  span and the SORT key are deliberately different notions: the overlap span
  is null for untimed items AND for spanning lodging (the grid draws those in
  the all-day lane — a hotel stay is ambient, not a conflict with dinner),
  while the sort key includes any item with a `start_time`, spanning lodging
  included, because the list renders its check-in row inline (R-itin-31).
  "Sort day by time" (R-itin-7) leaves untimed items exactly in their
  existing slot — only timed items are permuted among the slots timed items
  already occupy — and sorting is stable: items sharing a start minute never
  mark a day "unsorted", and non-monotonicity checks ignore untimed rows
  entirely. The affordance lives in the day header, labelled "Sort by time",
  shown only when that day is unsorted; it is a WRITE, so it is viewer- and
  pending-gated, while overlap chips are read-only and not gated. Its PUT
  reuses `useDayOrder`'s rollback / invalidation / ErrorBanner plumbing (a
  failed sort restores the original order and re-offers the affordance), and
  its tap fires the `actionLight` haptic (tokens §2.8 tap-vocabulary rule).
- **R-itin-69 (form conflict notice; Q2-141, Q2-142, Q2-143, Q2-144, Q2-145,
  Q2-146, ruled 2026-09-19):** the add/edit form's conflict notice (R-itin-20)
  SHALL be DERIVED live from the current fields, never latched — no dismiss
  affordance, so it cannot desync. Its copy names up to three overlapping
  items, then "and N more", and states that overlaps are allowed ("Overlaps
  {title} ({times}) — that's allowed, just so you know."). The booking form
  derives it from the shared server derivation (`deriveAutoItems`, API
  R-ib-5/§3.3), never a client re-derivation, so it describes exactly the
  placement a save would create. A half-filled datetime yields NO notice (no
  placement, nothing to warn about); a spanning-lodging candidate warns about
  nothing (ambient, as in R-itin-68) while a same-day lodging (check-in =
  check-out) warns normally. `useFormConflicts` reads the two plan queries
  from cache rather than taking props — a cold deep link fetches them and the
  notice appears when the data lands, never blocking the form.

#### Booking/item detail + offline degrade (T-7.9)

- **R-itin-70 (status + destructive actions; Q2-152, Q2-153, Q2-154, Q2-157,
  ruled 2026-09-19):** WHEN Cancel succeeds THE SYSTEM SHALL leave the user ON
  the `booking-detail` screen — the Cancelled badge and the now-empty
  transition set ARE the confirmation; WHEN Delete succeeds THE SYSTEM SHALL
  pop (the row is gone and the next refetch would 404). `cancelled` is
  terminal in the UI as on the wire (API §3.2): no status buttons and no
  Cancel button — but Delete still works (API §3.4 DELETE has no status
  precondition). Status actions render as plain buttons, not a segmented
  control (the form already owns the status segment): the list is API §3.2's
  legal targets minus the current status and `cancelled` — so `booked → idea`
  is absent too (§3.2's deliberate two-step: demote to `planned` first).
  ConfirmDialog ids derive `-confirm` /
  `-cancel` from the TRIGGERING button's id (§2.9), the trip-settings
  precedent.
- **R-itin-71 (detail rendering; Q2-158, Q2-159, Q2-160, Q2-161, Q2-162,
  Q2-163, Q2-175, ruled 2026-09-19):** empty detail fields are OMITTED from the
  render, not shown dashed (an email-captured booking fills 3 of 8 fields —
  five "—" rows would bury the three that matter). Detail datetimes render as
  destination WALL time — sliced via `wallDate`/`wallTime`, never through
  `Date`, so a Tokyo 10:00 departure never shifts to the phone's zone. The
  schedule row collapses plurality into one line — `car_rental`/`moped_rental`
  have two items and lodging spans days — naming the earliest day plus
  "through {day}" / "N calendar entries"; the jump targets the earliest item's
  day. A zero-item booking gets a non-pressable "Not on the calendar" row
  (copy differs for an idea vs a cancelled booking) rather than a hidden one —
  the absence is information. The place and expenses rows jump to the TAB
  (map / money), not to a screen inside it: place-detail and expense creation
  belong to the maps and money specs (§2.10) and no place names are on the
  wire yet (API R-ib-30); the expenses row always renders, even with zero
  linked expenses (it is the money-spec seam, and its subtitle says where it
  goes rather than claiming a count). An untimed item reads "No time set"
  (`itemWhenLabel`), never an empty row.
- **R-itin-72 (offline degrade; Q2-166, Q2-167, Q2-168, Q2-169, Q2-170, and
  Q2-069 — T-7.8's deferred R-itin-29 posture, resolved here; ruled
  2026-09-19):** refines R-itin-29. Offline is DERIVED from transport
  failures (`ApiRequestError` status 0 is the only source of status 0 in the
  app), not independently measured — so a surface whose data is still fresh
  (5-minute `staleTime`) can be offline without knowing it, and the
  deeplink-disable arm engages one request late; R-itin-29's cache-render
  arm needs no signal at all. A true connectivity signal is offline-spec
  scope, not this surface's. Offline OUTRANKS a refresh error and shows no
  retry over retained data (the no-cache branch keeps its retry — it is the
  only way forward there). The offline banner fires TRIP-WIDE, including when
  this tab's own reads are cached and happy but the `[tripId]` guard's read
  failed — "the active trip is offline" is a trip property, not a per-query
  one. Offline disables deeplink-out buttons but never materializes an
  OMITTED URL (e.g. Eventbrite outside a covered US city has no URL to build
  online either), and the offline hint outranks the "Needs …" field hint when
  both are true.
- **R-itin-73 (detail deeplink panel; Q2-171, Q2-172, ruled 2026-09-19):** the
  deeplink panel stays VISIBLE for viewers on `booking-detail` — a partner
  search is not an API write, so R-ib-24 does not reach it; every actual
  write affordance stays hidden, and (as shipped) a viewer's tap writes no
  return-prompt record, so the prompt cannot dead-end them into a form they
  may not use. The detail surface builds its panel input through the FORM's
  `stateFromDetails` → `deeplinkInputFor` mapping, never a second
  detail→panel mapping, so the two surfaces cannot build different URLs from
  the same booking.
- **R-itin-74 (navigation seams; Q2-164, Q2-165, Q2-173, Q2-174, Q2-178,
  Q2-179, Q2-180, ruled 2026-09-19):** the `?day=` return jump retargets LIST
  mode only — never the grid's own column state (the grid's landing is
  R-itin-51's); in grid mode the param is consumed without dispatching, which
  beats yanking the user's persisted view mode, and it is consumed after
  handling so a later grid→list toggle cannot jump to a stale day. The param is
  narrowed by `typeof` at the boundary; membership in the trip's day set is
  the real guard. A `booking`-kind item opened at `item/[itemId]` hands off
  with `router.replace`, never `push` (a push leaves a bounce-back stack
  entry), rendering a neutral hold for the frame before it lands. Item detail
  resolves from the composite read — the API has no per-item GET (API
  R-ib-31) — and a missing id renders "Item not found", never an error.
  Cross-tab navigation (place / expenses rows) goes through the
  `jumpToTripTab` helper, which walks up to the navigator that declares the
  tab and DEGRADES to a no-op (reporting the miss) instead of throwing; it
  records the manual tab selection (`rememberTab`) exactly as a tab-bar press
  does (R-nav-9). The booking-detail missing state is TERMINAL — a blank,
  mangled or 404 id renders "Booking not found" with no retry — while other
  pre-data errors get a retry banner; item detail mirrors it (a fresh 404
  outranks retained cache).
- **R-itin-75 (copy affordance; Q2-176, Q2-177, ruled 2026-09-19):** the
  confirmation-code copy affordance flips to "Copied" and STAYS for the life of
  the screen — no timed revert (a timer whose only job is to un-say something
  true); it resets only when the code itself changes. The clipboard engine is
  RN core `Clipboard` behind a one-file seam (`theme/clipboard.ts`);
  `expo-clipboard` / `@react-native-clipboard/clipboard` would be a NEW
  dependency — an Autonomy Contract #3 escalation, reported and not taken.

#### Booking-form validation UX (PR #67)

- **R-itin-76 (required floor + indicator; Q2-182 ruled 2026-09-19; Q2-181
  — as shipped, Sean pick pending, below):** the booking form's required
  fields are DERIVED from the shared Zod schemas, never hand-listed (the form
  probes `BookingCreateSchema.shape` and the category's `BookingDetails`
  member with `undefined` — Zod's own answer cannot disagree with the parse a
  save runs).
  Today only `title` is required (`category` is route-supplied); every other
  field stays optional BY DESIGN — a flight with no departure time is savable
  (API R-ib-32; Q2-181 — as shipped; Sean pick pending: (a) keep as shipped /
  (b) a real floor such as flight ⇒ departure date+time, a shared-schema
  change everyone inherits) [NEEDS CLARIFICATION: Q2-181 — keep `title` as
  the only required field, or add a floor (e.g. flight ⇒ departure
  date+time)?]. What the schema cannot express is not marked: conditional
  pairs (price requires currency, API R-ib-12) and client composition rules
  (R-itin-55's both-halves rule, the zone requirement) surface as field-level
  errors at save. The indicator is a danger-colored `*` beside the label, a
  "* Required" legend rendered only when the derived set is non-empty, and
  `", required"` appended to the field's accessibility name (DS `Input`
  `required` prop, tokens §2.9).
- **R-itin-77 (error surfacing; Q2-183, Q2-184, ruled 2026-09-19):** WHEN a
  save is refused and every reason maps onto a field THE SYSTEM SHALL name
  those fields in the banner ONCE — "These fields need attention: Name,
  Currency." / "Name needs attention — see the message under it." — rather
  than repeating each message in the banner and under the field; a reason no
  control owns appears in the banner verbatim. Raw Zod / server validation
  text is shown AS-IS (it can read developer-ish, e.g. "Too small: expected
  string to have >=1 characters"; a server message is the envelope's
  human-readable `error.message`, clamped to 300 characters) until a per-rule
  copy table is written — that table is a spec artefact, not something the
  client invents.

---

## 2. Design

### 2.1 Route additions (extends navigation spec §2.1)

One new route under the itinerary tab's Stack; everything else already
exists in the canonical tree. **Flag for navigation-spec sync at approval**
(its §2.8 delegates screen content here, but the tree is its inventory):

```
[tripId]/itinerary/
├── index.tsx                 # plan list + grid (view toggle) + ideas bucket
├── item/[itemId].tsx         # PUSH — place_visit/custom detail (existing)
├── item/new.tsx              # MODAL — unified add/edit form (existing;
│                             #   ?itemId= edit, ?bookingId= booking edit,
│                             #   ?category=&day=&time= prefills)
└── booking/[bookingId].tsx   # PUSH — booking detail per category (NEW —
                              #   R-nav-21 drill-down convention; needed
                              #   because ideas have no itemId to route by)
```

`item/[itemId]` receiving a `booking`-kind item replaces itself with
`booking/[bookingId]` (R-itin-27). The Ideas bucket is a section of
`index`, not a route — drag-to-day and the count badge live on one surface.

### 2.2 Plan-mode list anatomy

Top-to-bottom: PageHeader (trip name; trailing: view toggle) · Ideas entry
(R-itin-10; hidden when empty) · day sections · FAB. Components are the
design-system's (Card for items, Badge for status, ListItem for bucket
rows, Sheet for pickers/modes) — zero new primitives.

- **Day header**: weekday + date (`subheading`), item count (`caption`).
  Reserves a trailing slot for the weather bundle (out of scope). Tapping a
  day header in list mode scrolls; a horizontal day strip under the header
  offers jump-to-day (rendered at every trip length — no threshold,
  R-itin-45).
- **Item card** (Card, pressable): leading category icon (booking) or
  place/custom glyph; title; `start–end` times (`caption`, or "No time");
  status Badge per R-itin-8; overlap warning chip per R-itin-7. Press →
  detail (R-itin-24/27); while the timezone switcher is visible, a tap on a
  list row follows R-itin-81 (NC-3); bucket opens and routing are unchanged
  (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06). Long-press → drag (R-itin-2/3).
- **Travel-time chip** (between cards): mode icon + "18 min" (`caption`),
  default mode per R-itin-5. Tap → mode Sheet: one row per computed leg
  (walk/drive/cycle/transit — absent modes simply missing) + "Directions"
  external handoff row. Data: legs from the composite itinerary read (API
  R-ib-13), keyed by `(from_item_id, to_item_id)`. Round-2 rulings:
  R-itin-65..R-itin-69.
- **Drag-drop**: reorder commits as a single day-order PUT for the target
  day (API §3.4); optimistic with rollback (R-itin-2). Midpoint math is not
  the client's problem — the PUT reassigns the day.

### 2.3 Ideas / Cancelled bins

Two PEER collapsible bins pinned above day one, each rendered ONLY when it
has contents — an empty bin hides entirely (QUEUE B-13, Sean's ruling
2026-08-29). Ideas bin header: "Ideas" + unscheduled-count Badge + chevron.
Cards grouped by category; each shows title, category icon, status
Badge (`idea`, or "needs a day" flag per R-itin-12), price if known, and two
buttons, "Planned" / "Booked" (R-itin-11/40 — replaces the single "Add to
day" action; the guaranteed scheduling path; drag from bucket into a day is
an enhancement, not the contract). Cancelled bin
header: "Cancelled" + count Badge + chevron; expanding it is the
show-cancelled affordance (R-itin-12) — flat cancelled cards (no group
labels; the bin header names them), never schedulable. Card press →
`booking-detail` in both bins. Both bins default collapsed; expanded, each
caps at 45% of window height with internal scroll, and both render in list
AND grid modes (R-itin-56).

### 2.4 Add flows per category

FAB → add Sheet (10 options: 8 categories + place visit + custom) →
`item/new` modal. The modal renders per type:

| Type           | Form fields (mirror schema §3.4.1)                                                                          | Deeplink-out buttons (§2.7)                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `flight`       | airline, flight number, origin/destination IATA, departs/arrives (+tz via place pickers), cabin class, seat | Kayak, Skyscanner                                            |
| `lodging`      | property name, address/place, check-in/check-out, guests, room type, provider                               | Airbnb, Booking.com, Expedia, Vrbo                           |
| `train`        | carrier, train number, origin/destination stations, departs/arrives, coach, seat                            | Trainline (URN flow), Omio, Amtrak (plain)                   |
| `car_rental`   | company, pickup/dropoff locations + times, vehicle class                                                    | Kayak Cars, Turo                                             |
| `moped_rental` | company, pickup/dropoff locations + times, vehicle description, helmets                                     | — (manual entry v1; BikesBooking is v2 — research § verdict) |
| `activity`     | provider, venue/place (+ `address`, R-itin-61), starts/ends, ticket count/type, external URL                | Open external URL; Eventbrite browse (US-slug cities only)   |
| `restaurant`   | place/address, reserved at, party size, provider                                                            | — (no verified format in research; manual v1)                |
| `other`        | description, starts/ends, external URL                                                                      | Open external URL                                            |
| `place_visit`  | place picker (saved places → spine search, R-itin-23), day, times, notes                                    | —                                                            |
| `custom`       | title, day, times, notes                                                                                    | —                                                            |

Common to booking types: status selector (idea/planned/booked), price +
currency, confirmation code. Save routes: timeless → bucket; timed →
auto-scheduled (API I-2); day-picked timeless → schedule endpoint. Editing
opens the same modal prefilled (`?bookingId=` / `?itemId=`). Round-2 rulings
on these flows: R-itin-55, R-itin-57..R-itin-64, R-itin-76..R-itin-77.

**Flight-number lookup gating (B-9 client half, QA-wave sync):** the
flight-number field's in-form airline inference fires no request the
SHARED `FlightNumberInputSchema` (+ `parseFlightNumber`) would reject —
both gates live in one canonical key derivation
(`flightLookupKeyOf`), so every spelling of one flight number collapses
onto one cache entry and one request; the match is offered as a one-tap
fill, never auto-applied (it would arm the dirty-guard discard-confirm on
a booking the user only looked at).

**`iata` field kind (B-20, QA-wave sync):** origin/destination IATA
inputs (`flight` From/To) are their own field kind — auto-uppercase
as-you-type, `characters` keyboard, autocorrect off, `maxLength` 3 —
with a save-time gate `^[A-Z]{3}$` and a field-level error ("3-letter
airport code, like NRT."). The gate is DIRTY-ONLY: an untouched prefill
(e.g. a legacy stored value like "Narita") rides verbatim through an
unrelated edit rather than blocking it; a stored lowercase code
self-heals to uppercase on its own next edit. Wire narrowing is
deliberately NOT part of this (B-20 decision item Q2, recommendation c)
— it rides B-9's airport-picker work instead, which makes the field
structurally valid by construction.

### 2.5 Calendar grid

Layout per R-itin-13..17: shared hour gutter, day columns paged
horizontally (one full day per page on phones; peek of neighbors), all-day
lane on top. Blocks use category icon + title, status-tinted edge
(accent/success), overlap Badge when sharing a time range (side-by-side
split, R-itin-15). Empty-slot tap → add flow prefilled (R-itin-14, 30-min
snap). Pinch/zoom of the hour scale is out of scope v1.

Gap semantics: whitespace IS the feature — no artificial "free time" fills.
The differentiator claim (competitors § call #4: "the calendar-grid view
NOBODY has — HN users explicitly ask for gap/overlap exposure") is honored
by rendering, not by nagging.

### 2.5b Calendar view density (R-itin-33..35, feature ③)

A segmented control sits beside the R-itin-9 list/grid toggle in the
PageHeader trailing slot, visible only in grid mode: **Day · 3-day ·
Month · Trip-span**. Day/3-day/Trip-span share ONE `GridSurface`
component — the density prop changes `COLUMN_FRACTION`/simultaneous
column count only (`grid/constants.ts`), everything else (hour gutter,
block layout, all-day lane, gap-tap) is untouched. Month is a SEPARATE
component (`MonthSurface`, new) — a 7-column week grid with no hour
axis; each cell reuses the day-list's item-count/dot summary (not the
timed block layout) plus a spanning bar for multi-day bookings (the
month analogue of the all-day lane). Persistence: `gogo.itineraryGridDensity.{tripId}`
MMKV key, independent of the `gogo.itineraryView.{tripId}` key —
switching list↔grid never resets density, and vice versa.

### 2.6 Multi-day rendering (resolved — Gate 2, 2026-07-09)

Decided (R-itin-31; data model = one spanning item, `end_day` stays —
schema §3.3.10):

- **Grid mode:** the spanning booking renders as a lane in the all-day
  lane (R-itin-16's strip), spanning across its covered day columns and
  labeled at the check-in/check-out edges ("Park Hyatt Tokyo") — never a
  full-height band, never occluding timed blocks.
- **Grid checkpoint indicators (QUEUE B-12, Sean-specified 2026-08-29):**
  in addition to the lane, two small derived indicator blocks (~15-minute
  size; dashed, captioned "Check-in"/"Check-out") render on the timed grid
  at the real check-in/check-out times when set. Ephemeral render-only
  projections of the same single row — never persisted, never itinerary
  rows (ledger F-051 criterion 2 holds: exactly one DB row). They join the
  R-itin-15 side-by-side split but are exempt from its overlap Badge, and
  route to the same `booking-detail` as the lane.
- **List mode:** the client synthesizes **check-in and check-out point
  rows** from the spanning item — a check-in row on the `day` date and a
  check-out row on the `end_day` date, each with time and category icon;
  nights between show nothing (lodging is ambient). Both rows route to the
  same `booking-detail`.
- **Cross-midnight flights** (`end_day` = arrival wall-date, R-itin-36,
  Sean QA feature batch 2026-09-06 feature ①): grid mode is UNCHANGED —
  one block clipped at midnight with a "+1" tail on the arrival day. List
  mode CHANGED — it no longer renders a single departure-day row with a
  "+1" chip; instead it synthesizes "Departs"/"Arrives" point rows on
  their respective days, the same mechanism as lodging's check-in/
  check-out rows above (one spanning DB row, zero extra rows). Every
  OTHER category whose auto-item spans days (`train`, `activity`,
  `car_rental`/`moped_rental` two-point spans, `other`) keeps the
  original one-row-plus-"+1"-chip treatment in both modes — R-itin-36
  names `flight` only. While the timezone switcher is visible the grid's
  clipping and "+1" tail are evaluated in the active zone (R-itin-80), and a
  list row with a converted edge drops the "+1" chip for R-itin-79's
  (+N)/(-N) suffixes (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).

### 2.6b Calendar timezone switcher (R-itin-37/38, R-itin-78..82 — feature ②, T-7.17)

(superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06) — placement, the Sheet
contents and the effect below replace the 2026-09-13 PageHeader-button / "Trip default" /
header-label-only design.

**Placement.** A compact chip — clock icon, "{city} — GMT±X", chevron — in a toolbar row
directly under the PageHeader, in both view modes (it may share the row with the §2.5b
density control in grid mode — T-7.16's layout call). Not a PageHeader trailing action:
`PageHeaderAction` is icon-only and `trailing` renders at most two
(`components/PageHeader.tsx:24-31,119-121`), so it cannot carry the label. Hidden when the
zone set has < 2 zones.

**Sheet.** DS `Sheet`, title "Time zone", one `ListItem` row per zone in R-itin-37 order,
title "{city} — GMT±X", subtitle the IANA id (+ " · Trip destination", the source-aware caption of R-itin-37), trailing checkmark
on the active row; rows in a `FlatList` (the Sheet is not inside a ScrollView). Dismiss via
the Sheet's close button.

**Effect.** One active zone per trip feeds a pure placement map
(`features/itinerary/timezone/`): list rows read converted labels (R-itin-79), the grid
reads converted geometry (R-itin-80), and native items still supply every non-time field.
Focus (R-itin-81) and follow (R-itin-82) change the active zone through the same state as a
Sheet pick.

**Modules.** `features/itinerary/timezone/` — `convert.ts` (zone math on B-9's
`zoned-time.ts`, never `Intl` directly), `timeline.ts` (location timeline, source-zone
attribution, placements, focus zones), `timezone-switcher-model.ts` (zone set, labels,
default), `TimezoneSwitcher.tsx`, `zone-selection.ts` (active-zone state), `index.ts`.

### 2.7 Deeplink-out URL construction (exact — every row cites research)

All templates come from `.specs/research/booking-integrations.md` § Key
deeplink formats; **only research-verified formats ship** — anything
unverified degrades to the partner's plain domain link. Builders are pure
functions in `apps/mobile` feature code (no server involvement; nothing for
`@gogo/shared`). Every interpolation is URL-encoded; date formats are
per-partner as shown. `{adults}` defaults to the trip's member count,
editable inline per search (R-itin-32, resolved Gate 2). Builders accept
an optional affiliate-params config, dormant until Sean's affiliate
signups (research § Escalations — Viator `?pid={P00X}&mcid={id}&medium=link`
is the documented shape when it activates).

| Partner       | Category        | Constructed URL                                                                                                                                                                                | Field mapping / caveats                                                                                                                                                                               |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kayak Flights | flight          | `https://www.kayak.com/flights/{ORIG}-{DEST}/{YYYY-MM-DD}[/{YYYY-MM-DD}]` + optional `?fs=stops=0`                                                                                             | ORIG/DEST = form origin/destination IATA; second date only for round trips; `fs=stops=0` only if a non-stop toggle exists (not in v1). Enabled when both IATAs + depart date present (R-itin-21).     |
| Skyscanner    | flight          | `https://www.skyscanner.net/transport/flights/{orig}/{dest}/{yymmdd}/[{yymmdd}/]?adultsv2={adults}&cabinclass={cabin}&preferDirects={bool}`                                                    | Lowercase IATA; **`yymmdd`** dates (not ISO); `cabin` mapped from cabin-class field (economy/premiumeconomy/business/first; absent → economy, Q2-070); params are the officially documented set.      |
| Airbnb        | lodging         | `https://www.airbnb.com/s/{location}/homes?checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&adults={adults}`                                                                                         | `location` = address → property name → `trips.destination_name`. Research caveat repeated: app honoring params after universal-link is **UNTESTED — device-verify** before this button ships enabled. |
| Booking.com   | lodging         | `https://www.booking.com/searchresults.html?ss={q}&checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&group_adults={adults}`                                                                           | `ss` = location query as Airbnb.                                                                                                                                                                      |
| Expedia       | lodging         | `https://www.expedia.com/Hotel-Search?destination={q}&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}&adults={adults}`                                                                             | Officially documented format.                                                                                                                                                                         |
| Vrbo          | lodging         | `https://www.vrbo.com/search?destination={q}&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}&adults={adults}`                                                                                      |                                                                                                                                                                                                       |
| Trainline     | train           | Lookup: `https://www.thetrainline.com/api/locations-search/v2/search?searchTerm={q}` → pick URN → `https://www.thetrainline.com/book/results?origin={urn}&destination={urn}&outwardDate={ISO}` | Two-step: station fields drive debounced client-direct URN lookup (open API, verified live); on lookup failure OR zero URNs degrade to plain `thetrainline.com` (Q2-066).                             |
| Omio          | train           | `https://www.omio.com/` (plain)                                                                                                                                                                | No parameterized format in research — plain link only.                                                                                                                                                |
| Amtrak        | train           | `https://www.amtrak.com/` (plain)                                                                                                                                                              | Research: no API, SPA, no prefill.                                                                                                                                                                    |
| Kayak Cars    | car_rental      | `https://www.kayak.com/cars/{location}/{YYYY-MM-DD}/{YYYY-MM-DD}`                                                                                                                              | Pickup location + pickup/dropoff dates.                                                                                                                                                               |
| Turo          | car_rental      | `https://turo.com/us/en/search?location={q}&startDate={MM/DD/YYYY}`                                                                                                                            | **`MM/DD/YYYY`** date format; research shows further params exist but unverified (`&…`) — ship location+startDate only, device-verify before adding more.                                             |
| Eventbrite    | activity        | `https://www.eventbrite.com/d/{state--city}/events/`                                                                                                                                           | Browse-only (discovery API dead since 2020). Constructible only when the destination maps to a US `state--city` slug; otherwise omit the button.                                                      |
| External URL  | activity, other | `details.external_url` verbatim                                                                                                                                                                | Shown as "Open {host}"; a non-http(s) URL is a missing field, never opened (Q2-067).                                                                                                                  |

Not deeplinked in v1 (buttons absent, manual entry only): `moped_rental`
(BikesBooking is a v2 affiliate — research § verdict table), `restaurant`
(no verified format exists in research). Google Flights is deliberately
excluded (research: unofficial param only — "can break; don't depend").

**Directions handoff (not a partner link — R-itin-4/67; as shipped — Q2-125
Sean pick pending, see R-itin-67).** The leg Sheet's "Directions" row opens the Google Maps URLs API:
`https://www.google.com/maps/dir/?api=1&origin={origin}&destination={destination}&travelmode={mode}`.
Every interpolation is URL-encoded; `{origin}`/`{destination}` are the
free-text endpoint labels of R-itin-67 (trip destination appended as context),
`{mode}` is `driving | walking | bicycling | transit` (the app's `cycling` leg
maps to `bicycling`). No API key is needed. **Citation:** Google's Maps URLs
documentation, § Directions
(`developers.google.com/maps/documentation/urls/get-started`, fetched
2026-10-06) — `api=1` is mandatory; `travelmode` ∈ driving, walking,
bicycling, two-wheeler, transit; "You don't need a Google API key to use Maps
URLs". `.specs/research/` covers Mapbox/Transitous leg COMPUTATION only, never
an outbound maps URL, so this paragraph is the spec's citation of record for
the format. **Apple Maps is not shipped** (as shipped; whether to bless
Google-only for v1 or device-verify a `maps.apple.com`
`saddr`/`daddr`/`dirflg` variant is Sean's pick — Q2-125, R-itin-67), and the
builder never records a return-prompt tap (R-itin-67). T-7.5's and T-8.3's
(Q2-232) directions handoffs share that pick.

**Coordinate-only Navigate variant (T-8.3, Q2-232).** The map place sheet and
place detail "Navigate" (map spec R-map-8) open the same Maps URLs endpoint
with a coordinate destination only —
`https://www.google.com/maps/dir/?api=1&destination={lat},{lng}` (the comma
URL-encoded as `%2C`), origin omitted so Maps starts from the current
location, no `travelmode`. The builder returns null for a coordinate-less
place (B-7 part 3; the control is hidden) and records no return-prompt tap. It
lives in `features/map/nav-handoff.ts` and `features/places/place-links.ts`
(`placeNavigateUrl`); a future fold into `directions.ts` MUST keep this
coordinate-only shape alongside the label-based one above.

### 2.8 Deeplink-out → return prompt loop

Owned by the navigation spec (R-nav-18, §2.3 capture-return): this spec's
only obligations are (a) record `{ partner, category, tripId, timestamp }`
at button tap, before `Linking.openURL` (R-itin-22), and (b) implement the
prompt's "add manually" landing: `item/new?category={category}` with
`source: 'deeplink_return'` on the eventual create (API R-ib-11). The
"forward email" and "share screenshot" prompt actions route to the capture
spec's surfaces. This closes research call #6 — deeplink out, capture back,
the loop nobody else runs.

### 2.9 testID inventory (grammar: navigation spec §2.7)

Screens: `itinerary` (index, both view modes), `itinerary-item`,
`itinerary-item-new`, `booking-detail`. Roots carry `<screen>-screen`.

| Element                                                                                                                                                                                        | testID                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View toggle (header)                                                                                                                                                                           | `itinerary-view-toggle`                                                                                                                                                                                                                |
| FAB                                                                                                                                                                                            | `itinerary-fab-add`                                                                                                                                                                                                                    |
| Add-sheet option — kebab slugs (`car-rental`, `moped-rental`, `place-visit`); the in-form category step reuses these ids (Q2-098, Q2-099)                                                      | `itinerary-add-option-{category\|place-visit\|custom}`                                                                                                                                                                                 |
| Day add row (empty day)                                                                                                                                                                        | `itinerary-day-add-{date}`                                                                                                                                                                                                             |
| Day-header add button (every day, editors — B-11)                                                                                                                                              | `itinerary-day-header-add-{date}`                                                                                                                                                                                                      |
| Day section header (PR #15 spec-sync)                                                                                                                                                          | `itinerary-day-header-{date}`                                                                                                                                                                                                          |
| Day list root / header (T-7.4, PR #15 spec-sync)                                                                                                                                               | `itinerary-day-list` / `itinerary-header`                                                                                                                                                                                              |
| Lodging check-in / check-out point row (R-itin-31, R-itin-46)                                                                                                                                  | `itinerary-list-item-{itemId}-check-in` / `-check-out`                                                                                                                                                                                 |
| List-screen states (R-itin-28; PR #15 spec-sync)                                                                                                                                               | `itinerary-loading` (Skeleton) · `itinerary-empty` + CTA `itinerary-empty-add` · `itinerary-error` (no-cache ErrorBanner + retry) · `itinerary-refresh-error` (refetch failed over retained data)                                      |
| Reorder notices (R-itin-3, R-itin-48)                                                                                                                                                          | `itinerary-reorder-hint` (client-prevented day-lock drop) / `itinerary-reorder-error` (generic refused/failed reorder)                                                                                                                 |
| Day jump strip item                                                                                                                                                                            | `itinerary-day-jump-{date}`                                                                                                                                                                                                            |
| Item card                                                                                                                                                                                      | `itinerary-list-item-{itemId}` (nav §2.7 example)                                                                                                                                                                                      |
| Item card rental subtext (B-18, QA-wave sync)                                                                                                                                                  | `itinerary-list-item-{itemId}-subtext` (list); `itinerary-grid-item-{key}-subtext` (grid — `key` = `itemId` or `itemId-checkpoint`)                                                                                                    |
| Flight Departs/Arrives point row (R-itin-36, feature ①)                                                                                                                                        | `itinerary-list-item-{itemId}-departs` / `-arrives` (rule-4 derived shape, same family as `-check-in`/`-check-out`)                                                                                                                    |
| Travel-time chip                                                                                                                                                                               | `itinerary-leg-{date}-{fromItemId}` — day-scoped (Q2-148): a pair is co-chained on two days when a spanning lodging is a FROM on both, so `{fromItemId}` alone is not unique; `{date}` = the render day                                |
| Leg Sheet root / close / error (T-7.5, Q2-147)                                                                                                                                                 | `itinerary-leg-sheet` · `itinerary-leg-sheet-close` (DS-derived) · `itinerary-leg-error`                                                                                                                                               |
| Mode sheet row                                                                                                                                                                                 | `itinerary-leg-{fromItemId}-mode-{mode}`                                                                                                                                                                                               |
| Directions handoff                                                                                                                                                                             | `itinerary-leg-{fromItemId}-directions`                                                                                                                                                                                                |
| Directions hint (disabled-row "Needs …", R-itin-67; Q2-147)                                                                                                                                    | `itinerary-leg-{fromItemId}-directions-hint`                                                                                                                                                                                           |
| List overlap chip (R-itin-7; Q2-147)                                                                                                                                                           | `itinerary-list-item-{itemId}-overlap`                                                                                                                                                                                                 |
| Form conflict notice (R-itin-69; Q2-147)                                                                                                                                                       | `itinerary-item-new-conflict`                                                                                                                                                                                                          |
| Sort-by-time affordance                                                                                                                                                                        | `itinerary-sort-by-time-{date}`                                                                                                                                                                                                        |
| Add sheet root (T-7.6, Q2-097)                                                                                                                                                                 | `itinerary-add-sheet`                                                                                                                                                                                                                  |
| Ideas / Cancelled bin roots + Ideas list (T-7.6, Q2-097)                                                                                                                                       | `itinerary-ideas`, `itinerary-ideas-list`, `itinerary-cancelled`                                                                                                                                                                       |
| Ideas section toggle                                                                                                                                                                           | `itinerary-ideas-toggle`                                                                                                                                                                                                               |
| Ideas card                                                                                                                                                                                     | `itinerary-ideas-item-{bookingId}`                                                                                                                                                                                                     |
| Ideas "Planned" / "Booked" (R-itin-11/40 — replaces "Add to day")                                                                                                                              | `itinerary-ideas-planned-{bookingId}` / `itinerary-ideas-booked-{bookingId}`                                                                                                                                                           |
| Status-action Sheet (R-itin-41; internals extend the pre-existing `itinerary-ideas-schedule-sheet` family — `-input-day`, `-input-start-time`, `-input-end-time`, `-button-confirm`, `-error`) | `itinerary-ideas-schedule-sheet`                                                                                                                                                                                                       |
| Ideas schedule-sheet internals (Q2-097 — the prefix is `itinerary-ideas-schedule-`, no `-sheet-`; root is the row above)                                                                       | `itinerary-ideas-schedule-input-day`, `-input-start-time`, `-input-end-time`, `-button-confirm`, `-error`                                                                                                                              |
| Cancelled bin toggle (B-13 — replaces `itinerary-ideas-show-cancelled`)                                                                                                                        | `itinerary-cancelled-toggle`                                                                                                                                                                                                           |
| Cancelled bin list                                                                                                                                                                             | `itinerary-cancelled-list`                                                                                                                                                                                                             |
| Cancelled card                                                                                                                                                                                 | `itinerary-cancelled-item-{bookingId}`                                                                                                                                                                                                 |
| Grid item block                                                                                                                                                                                | `itinerary-grid-item-{itemId}`                                                                                                                                                                                                         |
| Grid checkpoint indicator (B-12, derived)                                                                                                                                                      | `itinerary-grid-item-{itemId}-check-in` / `-check-out`                                                                                                                                                                                 |
| Grid empty slot (hour rows; editors only — absent for viewers, R-itin-50)                                                                                                                      | `itinerary-grid-slot-{date}-{HH}`                                                                                                                                                                                                      |
| Grid all-day chip                                                                                                                                                                              | `itinerary-grid-allday-{itemId}`                                                                                                                                                                                                       |
| Grid root (T-7.7, Q2-082)                                                                                                                                                                      | `itinerary-grid-surface` (frozen contract)                                                                                                                                                                                             |
| Grid internals (T-7.7, Q2-082)                                                                                                                                                                 | `itinerary-grid-hours` (hour gutter), `itinerary-grid-pager` (day pager), `itinerary-grid-allday-lane` (pinned all-day lane), `itinerary-grid-scroll` (the one vertical scroller)                                                      |
| Grid day label (pinned header cell)                                                                                                                                                            | `itinerary-grid-day-{date}`                                                                                                                                                                                                            |
| Grid spanning-lane segment (R-itin-52 — the chip id would collide across columns)                                                                                                              | `itinerary-grid-span-{itemId}-{date}`                                                                                                                                                                                                  |
| Grid density segment (R-itin-33, feature ③)                                                                                                                                                    | `itinerary-density-segment-{day\|3-day\|month\|trip-span}`                                                                                                                                                                             |
| Month view day cell (R-itin-35)                                                                                                                                                                | `itinerary-month-day-{date}`                                                                                                                                                                                                           |
| Month view spanning bar (derived, same booking-detail routing)                                                                                                                                 | `itinerary-month-span-{bookingId}-{date}`                                                                                                                                                                                              |
| Timezone switcher chip (R-itin-37; absent when hidden)                                                                                                                                         | `itinerary-timezone-switcher`; label text `itinerary-timezone-switcher-label`                                                                                                                                                          |
| Timezone switcher sheet + row                                                                                                                                                                  | `itinerary-timezone-switcher-sheet` (close `-close`), `itinerary-timezone-switcher-sheet-item-{tz}` (tz = `timeZoneSlug`, B-9 precedent)                                                                                               |
| Focused item (R-itin-81)                                                                                                                                                                       | no new id — `accessibilityState.selected` on the existing `itinerary-list-item-*`, `itinerary-grid-item-*`, `itinerary-grid-allday-*`, `itinerary-grid-span-*` ids                                                                     |
| Form inputs                                                                                                                                                                                    | `itinerary-item-new-input-{field}` (kebab field: `title`, `day`, `start-time`, `price`, `confirmation`, …)                                                                                                                             |
| Date/time field derivations (every DateField/TimeField, B-10)                                                                                                                                  | `{fieldTestID}-picker`, `-error`, `-clear` (time); shared `PickerCard` modal card `{fieldTestID}-sheet` with `-sheet-done` / `-sheet-close` / `-sheet-scrim` (QA-wave sync — `-sheet-done` added post-B-15, was missing from this row) |
| Item-form surface states (T-7.6, Q2-097)                                                                                                                                                       | `itinerary-item-new-error` (both forms' ErrorBanner), `-error-load`, `-loading`, `-viewer` (view-only notice, R-itin-60), `-uneditable`                                                                                                |
| Create-chain notices (R-itin-58, Q2-097)                                                                                                                                                       | `itinerary-item-new-saved-to-ideas` (warning banner), `itinerary-item-new-button-done` (replaces Save)                                                                                                                                 |
| Booking-form datetime field (Q2-097)                                                                                                                                                           | `itinerary-item-new-input-{field}-date` / `-time`; `-tz` (zoned fields only); `-error` (a caption on a raw AppText — NOT the DS Input's `{testID}-error` derivation)                                                                   |
| Place picker (Q2-097)                                                                                                                                                                          | `itinerary-item-new-input-place` (query input) plus suffixes `-result-{placeId}`, `-clear`, `-error-search` (novel — no DS component derives it)                                                                                       |
| Enum option chips (R-itin-64, Q2-115)                                                                                                                                                          | `itinerary-item-new-input-{field}-{option}`                                                                                                                                                                                            |
| Required-field legend + markers (PR #67, Q2-182)                                                                                                                                               | `itinerary-item-new-required-legend` · `{inputTestID}-required` (DS Input marker, derived)                                                                                                                                             |
| Form status segment                                                                                                                                                                            | `itinerary-item-new-segment-status-{status}`                                                                                                                                                                                           |
| Form place attach                                                                                                                                                                              | `itinerary-item-new-button-place`                                                                                                                                                                                                      |
| Form save                                                                                                                                                                                      | `itinerary-item-new-button-save`                                                                                                                                                                                                       |
| Deeplink adults field + panel error banners (PR #14 spec-sync, R-itin-42)                                                                                                                      | `itinerary-item-new-input-adults` (form only) · `itinerary-item-new-error-deeplink` / `booking-detail-error-deeplink`                                                                                                                  |
| Return-host fallback sheet (R-itin-44)                                                                                                                                                         | `booking-manual-add-sheet`, `-error`, `-input-title`, `-button-save`, `-button-cancel`                                                                                                                                                 |
| Partner search (form)                                                                                                                                                                          | `itinerary-item-new-button-search-{partner}` (`kayak`, `skyscanner`, `airbnb`, `booking`, `expedia`, `vrbo`, `trainline`, `omio`, `amtrak`, `kayak-cars`, `turo`, `eventbrite`, `external`)                                            |
| Booking detail status actions (T-7.9, Q2-155)                                                                                                                                                  | `booking-detail-button-status-{status}`                                                                                                                                                                                                |
| Booking detail read surface (Q2-156)                                                                                                                                                           | `booking-detail-status`, `-price`, `-source`, `-confirmation`, `-field-{key}` (key kebab-cased: `-field-flight-number`)                                                                                                                |
| Booking detail states (Q2-156)                                                                                                                                                                 | `booking-detail-loading`, `-error`, `-missing` (terminal, R-itin-74), `-banner-{offline\|refresh\|action}`                                                                                                                             |
| Item detail read surface + states (T-7.9, Q2-156)                                                                                                                                              | `itinerary-item-when`, `-notes`, `-row-place`, `-loading`, `-error`, `-missing`, `-banner-{offline\|refresh\|action}`                                                                                                                  |
| Index offline banner (R-itin-72; Q2-156)                                                                                                                                                       | `itinerary-banner-offline`                                                                                                                                                                                                             |
| Detail ConfirmDialogs (Q2-157 — derived from the TRIGGERING button)                                                                                                                            | `booking-detail-button-{cancel\|delete}-confirm` / `-cancel`; `itinerary-item-button-delete-confirm` / `-cancel`                                                                                                                       |
| Booking detail actions                                                                                                                                                                         | `booking-detail-button-{edit\|cancel\|delete}`                                                                                                                                                                                         |
| Confirmation copy                                                                                                                                                                              | `booking-detail-button-copy-confirmation`                                                                                                                                                                                              |
| Detail deeplink buttons                                                                                                                                                                        | `booking-detail-button-deeplink-{partner}`                                                                                                                                                                                             |
| Detail rows                                                                                                                                                                                    | `booking-detail-row-{place\|expenses\|schedule}`                                                                                                                                                                                       |
| Item detail actions                                                                                                                                                                            | `itinerary-item-button-{edit\|delete}`                                                                                                                                                                                                 |
| Return prompt sheet                                                                                                                                                                            | `booking-return-sheet`, `booking-return-button-{forward\|share\|manual\|dismiss}` (complements R-nav-18, which owns the prompt's behavior)                                                                                             |

ConfirmDialogs derive `{testID}-confirm`/`-cancel` per design-system
convention (tokens §2.9).

### 2.10 Out of scope (explicit)

- **Today tab** — separate bundle (leave-by, next-event, day-of leg
  refresh).
- **Map tab screens** and place-detail — maps/places spec (this spec only
  links into them); the plan-mode mini-map is deferred to the polish phase
  (§1, resolved Gate 2), not silent scope.
- **Weather strip in day headers** — weather bundle (slot reserved, §2.2).
- **Capture review queue + landing UX** — capture spec (R-itin-22's prompt
  actions route there).
- **Expense creation from bookings** — money spec (`booking-detail-row-expenses`
  is the seam).
- **Offline cache/mutation-queue mechanics** — offline spec (R-itin-29
  defines this tab's degraded behavior only).
- **In-app activity discovery (Viator/Ticketmaster APIs)** — activities/AI
  bundle; its results land through the same add flow.
- **Photo pins on itinerary items** — photos spec.
- **Drag-drop library selection** — P-3/P-4 implementation choice via
  Context7 + `npm view` (CLAUDE.md § Before you code); this spec pins
  behavior, not the library.
- **`train` Departs/Arrives point rows** — R-itin-36 names `flight` only
  (the QUEUE row's literal scope); `train` shares the identical `end_day`
  mechanism and is a natural follow-up (sleeper trains genuinely cross
  midnight) but is deliberately not built this batch — a queued `T-N`/`B-N`
  row if wanted, not silent scope.
- **Lodging/ferry contribution to the timezone switcher** — R-itin-37's
  zone set is flight/train `departs_tz`/`arrives_tz` plus the trip's
  `destination_tz` (B-30) (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
  `lodging` details carry a UTC-offset instant with no named IANA zone
  (schema §3.4.1), and there is no `ferry` booking category — either gap
  would need a schema change (a new `places.tz`-style column, or a new
  category enum value + migration), which this spec deliberately does not
  propose (Autonomy Contract #6 — scope/schema changes are Sean's call,
  not an improvisation this batch). Lodging TIMES do convert, through
  R-itin-78's location timeline, without a zone of their own.
- **Conversion outside the itinerary list/grid** — booking/item detail
  (R-itin-71), forms, Ideas/Cancelled bins, Month (R-itin-35), Today and
  notifications keep native wall times (R-itin-38) (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06).
- **Device/home zone in the zone set** — T-7.17 says 'destination time
  zones'; not populated.
- **Alias canonicalisation** — exact-id de-dup only (the
  `time-zone-catalog.ts` 'deliberately NOT widened' posture).
- **Month-view day re-bucketing** — Month counts items on stored days.

---

## 3. Tasks

Each sized to one agent session; they become `T-N.M` rows when the phase is
cut. **Depends on:** IB-1..IB-3 (API), NAV-1..NAV-6, DS-7..DS-9.

| ID    | Task                                                                                                                                                                                      | Covers                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| IT-1  | Plan-mode day list: sections, item cards, empty-day rows, day-jump strip, view-toggle shell + per-trip persistence.                                                                       | R-itin-1, R-itin-8, R-itin-9, R-itin-28 |
| IT-2  | Drag-drop reorder: optimistic day-order PUT, booking-item day locks, haptics, rollback.                                                                                                   | R-itin-2, R-itin-3                      |
| IT-3  | Travel-time chips + mode sheet + directions handoff + absent-leg states.                                                                                                                  | R-itin-4..R-itin-6                      |
| IT-4  | Conflict surfacing: overlap chips, sort-by-time affordance, form conflict notice.                                                                                                         | R-itin-7, R-itin-20                     |
| IT-5  | Ideas bucket: section, grouping, add-to-day scheduling flow, needs-a-day + cancelled visibility.                                                                                          | R-itin-10..R-itin-12                    |
| IT-6  | Calendar grid: hour axis, day paging, timed blocks, overlap split, all-day lane incl. spanning-lodging lane, gap-tap prefill; list-mode check-in/check-out synthesis.                     | R-itin-13..R-itin-17, R-itin-31         |
| IT-7  | Add/edit flows: add sheet, per-type forms (10 types), save routing (bucket vs scheduled), place picker.                                                                                   | R-itin-18, R-itin-19, R-itin-23         |
| IT-8  | Deeplink-out: URL builders per §2.7 (+ device-verify pass for Airbnb/Turo caveats), adults default + inline edit, button enablement, tap recording, return-prompt "add manually" landing. | R-itin-21, R-itin-22, R-itin-32         |
| IT-9  | Booking detail screen: per-category layouts, status actions, copy affordance, seams (place/expenses/schedule rows), cancel/delete confirms.                                               | R-itin-24..R-itin-26                    |
| IT-10 | Item detail (place_visit/custom) + booking-item routing + offline degradation of this tab.                                                                                                | R-itin-27, R-itin-29                    |

**Tests required (minimum, E2E on testIDs of §2.9):**

- [ ] Reorder round-trip: drag persists order; failure rolls back visibly (IT-2)
- [ ] Timed-booking item refuses cross-day drop with hint (IT-2)
- [ ] Leg chip shows correct default mode; absent transit shows no error (IT-3)
- [ ] Overlap: both list chips and grid side-by-side render for the same data (IT-4, IT-6)
- [ ] Idea → "Add to day" → appears in day with `planned` badge (IT-5)
- [ ] Grid gap tap opens prefilled add form (day + rounded time) (IT-6)
- [ ] Multi-day lodging: grid all-day spanning lane across covered columns; list shows check-in + check-out rows only, both routing to the same detail (IT-6)
- [ ] Each deeplink button builds its exact §2.7 URL (snapshot per partner) and disables on missing fields; adults defaults to member count and inline edit flows into the URL (IT-8)
- [ ] Deeplink tap records return-prompt state; "add manually" creates with `source: 'deeplink_return'` (IT-8)
- [ ] Cancel flow: confirm → booking off calendar, visible under show-cancelled (IT-9)
- [ ] Every screen root + interactive element exposes its §2.9 testID (all)

**Test-infra rulings (no product surface; ruled 2026-09-19):**

- The Sheet exit-window "rider unmount" pin is a NET assertion, not a
  discriminator — React 19's post-unmount `setState` is a silent no-op — kept
  as a regression net; the guard itself (an unmounted ref plus
  `pointerEvents: "none"` while exiting) is the deliverable (Q2-089).
- The members-screen two-in-flight overlap pin is driven by same-frame
  multi-touch (both presses inside ONE `act` scope, before the sheet-closing
  state commits), because the exit-window tap route is closed by that Sheet
  guard; the pin's per-call-vs-hook-level discrimination is unchanged
  (Q2-090).
- The R-nav-21 modal audit tolerates a Fragment-wrapped `Stack` in the
  itinerary layout (the return host is non-route chrome; exactly one Stack
  is still asserted), and the renderRouter return-host suite deliberately
  skips the exit-timer drain — fake timers HOLD the exit callback, so
  waiting for the unmount under fake timers is a hang, not hygiene
  (documented in-file; Q2-112).

---

_Trace: every R-itin-N cites its design section inline; §2.7 rows each trace
to `.specs/research/booking-integrations.md` § Key deeplink formats. The
original four Gate 2 (2026-07-09) markers resolved: two at the schema spec
(multi-day → spanning item with lane/point-row rendering → R-itin-31;
dates required), two owned here (party size → member-count default,
inline-editable → R-itin-32; plan-mode mini-map → deferred to polish).
Two markers opened by the Sean QA feature batch 2026-09-06 amendment —
R-itin-35 (month view's exact shape) and R-itin-38 (timezone-switcher
selection effect) — both **Ruled 2026-09-13, Sean** (PR #71 Questions
#1/#2, both confirmed the recommended default). Gate-2 and feature-batch
markers are all resolved; round 2 (2026-09-19) leaves 2 open — Q2-125, Q2-181,
Sean picks pending (R-itin-67, R-itin-76) — approvable once ruled. R-itin-38's 2026-09-13 ruling is superseded by T-7.17 (Sean UX story
2026-09-19, QUEUE T-7.17). The 2026-10-06 amendment opens NC-1..NC-6 here and NC-7
in `.specs/client/trips.spec.md` R-tripui-29; the "all resolved" line above is
amended accordingly (superseded by T-7.17, Sean 2026-09-19; amended 2026-10-06) and this file now
carries 8 open markers (Q2-125, Q2-181, NC-1..NC-6)._
