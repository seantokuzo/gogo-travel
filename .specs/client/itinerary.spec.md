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
  that pair plus a "Directions" handoff to Google/Apple Maps (never replace
  the nav app — competitors § feature-matrix).
- **R-itin-5**: WHEN choosing the chip's displayed mode THE SYSTEM SHALL
  show walking when the walking leg is ≤ 15 minutes, else driving; transit
  and cycling appear in the mode Sheet when their legs exist (transit rows
  may be absent — degradation is silent, API R-ib-21).
- **R-itin-6**: WHEN a pair's legs are absent (still computing, provider
  down, an endpoint unlocated) THE SYSTEM SHALL render no chip or a subtle
  placeholder — never a spinner row, never an inline error.
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
- **R-itin-11**: WHEN "Add to day" is tapped on a bucket card THE SYSTEM
  SHALL present a day/time picker Sheet and schedule via the schedule
  endpoint (API R-ib-8), optimistically moving the card into its day section
  with the status badge advancing `idea → planned`.
- **R-itin-12**: WHEN a `planned`/`booked` booking is timeless (in the
  bucket) THE SYSTEM SHALL flag it "needs a day" — visually distinct from
  `idea` cards; WHEN `cancelled` bookings exist THE SYSTEM SHALL hide them
  from the bucket by default behind a "Show cancelled" toggle (their only
  surface — they are off-calendar by invariant).

### Calendar-grid view (the differentiator)

- **R-itin-13**: WHEN grid mode is active THE SYSTEM SHALL render trip days
  as horizontally-paged columns against a shared vertical hour axis (1-hour
  rows, scrollable 00–24), with each timed item drawn as a block positioned
  and sized by `start_time`/`end_time`; tapping a block opens its detail.
- **R-itin-14**: WHEN a time range on a day has no items THE SYSTEM SHALL
  leave it visibly empty, and tapping an empty slot SHALL open the add flow
  prefilled with that day and the slot's time rounded to 30 min (gap →
  action, the pattern HN users explicitly ask for — competitors § call #4).
- **R-itin-15**: WHEN two or more blocks overlap in time THE SYSTEM SHALL
  render them side-by-side (never occluded) with an overlap Badge on each —
  overlaps are surfaced, never hidden or rejected (API R-ib-17).
- **R-itin-16**: WHEN a day has untimed items THE SYSTEM SHALL render them
  as compact chips in an all-day lane pinned above that day's column.
- **R-itin-17**: WHEN grid mode opens THE SYSTEM SHALL land on the trip's
  first day (or today's column when the trip is active and today is in
  range) with the 08:00–20:00 band initially visible.

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
  the trip's saved places first, then spine search (places search endpoint —
  maps/places spec seam); place ideas without a day are saved places by
  design (navigation spec place-detail "add to day"), not day-less items —
  the schema requires every item to have a `day`.

### Booking detail (per category)

- **R-itin-24**: WHEN a booking is opened (from a day item, the bucket, or
  the grid) THE SYSTEM SHALL push the `booking-detail` screen rendering:
  title + status Badge with status actions (§3.2 machine via API), the
  category's `details` fields as a labeled grid, confirmation code with a
  copy affordance (`mono` type role), price, source label
  (manual/email/share/deeplink return), linked place row → map tab, linked
  expenses row (money-spec seam), and scheduled day/time row → jumps to the
  itinerary position.
- **R-itin-25**: WHEN the booking's category has partner deeplinks (§2.7)
  THE SYSTEM SHALL render deeplink-out buttons on the detail screen with the
  same construction + recording rules as R-itin-21/22.
- **R-itin-26**: WHEN Cancel is invoked THE SYSTEM SHALL require a
  ConfirmDialog (R-ds-18), then set status `cancelled` (items disappear from
  the calendar per API R-ib-7); WHEN Delete is invoked THE SYSTEM SHALL
  ConfirmDialog with copy noting linked expenses are kept (they detach —
  schema §3.6).
- **R-itin-27**: WHEN a `place_visit`/`custom` item is opened THE SYSTEM
  SHALL push the `itinerary-item` screen (navigation spec §2.4): title/place
  link, day + times, notes, edit (reopens the form modal) and delete
  (ConfirmDialog); tapping a `booking`-kind item routes to `booking-detail`
  instead — booking content is never duplicated across two screens.

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
- **R-itin-30**: WHEN any screen in this spec renders THE SYSTEM SHALL carry
  testIDs per the navigation-spec §2.7 grammar on its root and every
  interactive element, per the §2.9 inventory.

### Open questions (blocking approval)

- Repeated verbatim from `.specs/database/schema.spec.md` §3.3.10 — it
  decides how lodging renders in both list and grid (§2.5/§2.6 map the
  branches):
  [NEEDS CLARIFICATION: multi-day bookings (lodging check-in→check-out) on the calendar — one spanning item (`end_day` used, rendered across days) or two point items (check-in item + check-out item)? Affects whether `end_day` stays; user-visible calendar rendering.]
- Repeated verbatim from `.specs/database/schema.spec.md` §3.3.4 — a
  date-less trip has no day range to section or grid until items exist:
  [NEEDS CLARIFICATION: are trip dates required at creation, or are date-less trips allowed (dates added later)? Columns are nullable to keep both options open; the create-trip UX decides.]
- [NEEDS CLARIFICATION: party size for deeplink-out URLs — Skyscanner
  `adultsv2`, Airbnb `adults`, Booking `group_adults`, Expedia/Vrbo `adults`
  all take a traveler count, but no traveler-count field exists anywhere
  (`trip_members` counts collaborators, not travelers — a solo planner books
  for a family of four). Options: (a) default to member count, editable
  inline in the add flow; (b) a per-trip `travelers` column — an entity
  change needing Sean's nod per the schema spec; (c) always ask inline and
  remember the last answer per trip locally. User-visible in every lodging
  and flight handoff.]
- [NEEDS CLARIFICATION: persistent map in plan mode — competitor evidence
  crowns "map-beside-itinerary with travel times" the category's
  most-praised pattern (competitors.md § loves #3, call #4), but our IA
  gives maps a dedicated tab (navigation spec §2.1). Should the plan-mode
  list embed a collapsible mini-map strip (day-scoped pins, tap → map tab),
  or does the map tab alone carry the pattern? Affects itinerary screen
  layout and adds a Mapbox surface to this tab.]

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
  offers jump-to-day for long trips.
- **Item card** (Card, pressable): leading category icon (booking) or
  place/custom glyph; title; `start–end` times (`caption`, or "No time");
  status Badge per R-itin-8; overlap warning chip per R-itin-7. Press →
  detail (R-itin-24/27). Long-press → drag (R-itin-2/3).
- **Travel-time chip** (between cards): mode icon + "18 min" (`caption`),
  default mode per R-itin-5. Tap → mode Sheet: one row per computed leg
  (walk/drive/cycle/transit — absent modes simply missing) + "Directions"
  external handoff row. Data: legs from the composite itinerary read (API
  R-ib-13), keyed by `(from_item_id, to_item_id)`.
- **Drag-drop**: reorder commits as a single day-order PUT for the target
  day (API §3.4); optimistic with rollback (R-itin-2). Midpoint math is not
  the client's problem — the PUT reassigns the day.

### 2.3 Ideas bucket

Collapsible section pinned above day one. Header: "Ideas" + count Badge +
chevron. Cards grouped by category; each shows title, category icon, status
Badge (`idea`, or "needs a day" flag per R-itin-12), price if known, and an
"Add to day" button (R-itin-11 — the guaranteed scheduling path; drag from
bucket into a day is an enhancement, not the contract). "Show cancelled"
toggle at the section foot (R-itin-12). Card press → `booking-detail`.

### 2.4 Add flows per category

FAB → add Sheet (10 options: 8 categories + place visit + custom) →
`item/new` modal. The modal renders per type:

| Type | Form fields (mirror schema §3.4.1) | Deeplink-out buttons (§2.7) |
|---|---|---|
| `flight` | airline, flight number, origin/destination IATA, departs/arrives (+tz via place pickers), cabin class, seat | Kayak, Skyscanner |
| `lodging` | property name, address/place, check-in/check-out, guests, room type, provider | Airbnb, Booking.com, Expedia, Vrbo |
| `train` | carrier, train number, origin/destination stations, departs/arrives, coach, seat | Trainline (URN flow), Omio, Amtrak (plain) |
| `car_rental` | company, pickup/dropoff locations + times, vehicle class | Kayak Cars, Turo |
| `moped_rental` | company, pickup/dropoff locations + times, vehicle description, helmets | — (manual entry v1; BikesBooking is v2 — research § verdict) |
| `activity` | provider, venue/place, starts/ends, ticket count/type, external URL | Open external URL; Eventbrite browse (US-slug cities only) |
| `restaurant` | place/address, reserved at, party size, provider | — (no verified format in research; manual v1) |
| `other` | description, starts/ends, external URL | Open external URL |
| `place_visit` | place picker (saved places → spine search, R-itin-23), day, times, notes | — |
| `custom` | title, day, times, notes | — |

Common to booking types: status selector (idea/planned/booked), price +
currency, confirmation code. Save routes: timeless → bucket; timed →
auto-scheduled (API I-2); day-picked timeless → schedule endpoint. Editing
opens the same modal prefilled (`?bookingId=` / `?itemId=`).

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

### 2.6 Multi-day rendering (blocked on the §1 marker)

- **Branch A (spanning item):** lodging renders in list mode as a banner
  row pinned under each covered day's header ("Park Hyatt Tokyo · night 2
  of 4"); in grid mode as a slim full-height background band behind the
  day's column (never occluding timed blocks), labeled at check-in/check-out
  edges. Cross-midnight flights render one block clipped at midnight with a
  "+1" tail on the arrival day.
- **Branch B (two point items):** check-in and check-out render as ordinary
  point items on their days; nights between show nothing (acceptable —
  lodging is ambient); cross-midnight flights render on the departure day
  with a "+1" chip.

No implementation of lodging rendering starts until the marker resolves.

### 2.7 Deeplink-out URL construction (exact — every row cites research)

All templates come from `.specs/research/booking-integrations.md` § Key
deeplink formats; **only research-verified formats ship** — anything
unverified degrades to the partner's plain domain link. Builders are pure
functions in `apps/mobile` feature code (no server involvement; nothing for
`@gogo/shared`). Every interpolation is URL-encoded; date formats are
per-partner as shown. `{adults}` pends the party-size marker (§1). Builders
accept an optional affiliate-params config, dormant until Sean's affiliate
signups (research § Escalations — Viator `?pid={P00X}&mcid={id}&medium=link`
is the documented shape when it activates).

| Partner | Category | Constructed URL | Field mapping / caveats |
|---|---|---|---|
| Kayak Flights | flight | `https://www.kayak.com/flights/{ORIG}-{DEST}/{YYYY-MM-DD}[/{YYYY-MM-DD}]` + optional `?fs=stops=0` | ORIG/DEST = form origin/destination IATA; second date only for round trips; `fs=stops=0` when a "non-stop only" form toggle is set. Enabled when both IATAs + depart date present (R-itin-21). |
| Skyscanner | flight | `https://www.skyscanner.net/transport/flights/{orig}/{dest}/{yymmdd}/[{yymmdd}/]?adultsv2={adults}&cabinclass={cabin}&preferDirects={bool}` | Lowercase IATA; **`yymmdd`** dates (not ISO); `cabin` mapped from cabin-class field (economy/premiumeconomy/business/first); params are the officially documented set. |
| Airbnb | lodging | `https://www.airbnb.com/s/{location}/homes?checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&adults={adults}` | `location` = place/address field, else `trips.destination_name`. Research caveat repeated: app honoring params after universal-link is **UNTESTED — device-verify** before this button ships enabled. |
| Booking.com | lodging | `https://www.booking.com/searchresults.html?ss={q}&checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}&group_adults={adults}` | `ss` = location query as Airbnb. |
| Expedia | lodging | `https://www.expedia.com/Hotel-Search?destination={q}&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}&adults={adults}` | Officially documented format. |
| Vrbo | lodging | `https://www.vrbo.com/search?destination={q}&startDate={YYYY-MM-DD}&endDate={YYYY-MM-DD}&adults={adults}` | |
| Trainline | train | Lookup: `https://www.thetrainline.com/api/locations-search/v2/search?searchTerm={q}` → pick URN → `https://www.thetrainline.com/book/results?origin={urn}&destination={urn}&outwardDate={ISO}` | Two-step: station fields drive debounced client-direct URN lookup (open API, verified live); on lookup failure degrade to plain `thetrainline.com`. |
| Omio | train | `https://www.omio.com/` (plain) | No parameterized format in research — plain link only. |
| Amtrak | train | `https://www.amtrak.com/` (plain) | Research: no API, SPA, no prefill. |
| Kayak Cars | car_rental | `https://www.kayak.com/cars/{location}/{YYYY-MM-DD}/{YYYY-MM-DD}` | Pickup location + pickup/dropoff dates. |
| Turo | car_rental | `https://turo.com/us/en/search?location={q}&startDate={MM/DD/YYYY}` | **`MM/DD/YYYY`** date format; research shows further params exist but unverified (`&…`) — ship location+startDate only, device-verify before adding more. |
| Eventbrite | activity | `https://www.eventbrite.com/d/{state--city}/events/` | Browse-only (discovery API dead since 2020). Constructible only when the destination maps to a US `state--city` slug; otherwise omit the button. |
| External URL | activity, other | `details.external_url` verbatim | Shown as "Open {host}". |

Not deeplinked in v1 (buttons absent, manual entry only): `moped_rental`
(BikesBooking is a v2 affiliate — research § verdict table), `restaurant`
(no verified format exists in research). Google Flights is deliberately
excluded (research: unofficial param only — "can break; don't depend").

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

| Element | testID |
|---|---|
| View toggle (header) | `itinerary-view-toggle` |
| FAB | `itinerary-fab-add` |
| Add-sheet option | `itinerary-add-option-{category\|place-visit\|custom}` |
| Day add row (empty day) | `itinerary-day-add-{date}` |
| Day jump strip item | `itinerary-day-jump-{date}` |
| Item card | `itinerary-list-item-{itemId}` (nav §2.7 example) |
| Travel-time chip | `itinerary-leg-{fromItemId}` (leg ids are rebuilt — from-item id is the stable key) |
| Mode sheet row | `itinerary-leg-{fromItemId}-mode-{mode}` |
| Directions handoff | `itinerary-leg-{fromItemId}-directions` |
| Sort-by-time affordance | `itinerary-sort-by-time-{date}` |
| Ideas section toggle | `itinerary-ideas-toggle` |
| Ideas card | `itinerary-ideas-item-{bookingId}` |
| Ideas "Add to day" | `itinerary-ideas-schedule-{bookingId}` |
| Show-cancelled toggle | `itinerary-ideas-show-cancelled` |
| Grid item block | `itinerary-grid-item-{itemId}` |
| Grid empty slot | `itinerary-grid-slot-{date}-{HH}` |
| Grid all-day chip | `itinerary-grid-allday-{itemId}` |
| Form inputs | `itinerary-item-new-input-{field}` (kebab field: `title`, `day`, `start-time`, `price`, `confirmation`, …) |
| Form status segment | `itinerary-item-new-segment-status-{status}` |
| Form place attach | `itinerary-item-new-button-place` |
| Form save | `itinerary-item-new-button-save` |
| Partner search (form) | `itinerary-item-new-button-search-{partner}` (`kayak`, `skyscanner`, `airbnb`, `booking`, `expedia`, `vrbo`, `trainline`, `omio`, `amtrak`, `kayak-cars`, `turo`, `eventbrite`, `external`) |
| Booking detail actions | `booking-detail-button-{edit\|cancel\|delete}` |
| Confirmation copy | `booking-detail-button-copy-confirmation` |
| Detail deeplink buttons | `booking-detail-button-deeplink-{partner}` |
| Detail rows | `booking-detail-row-{place\|expenses\|schedule}` |
| Item detail actions | `itinerary-item-button-{edit\|delete}` |
| Return prompt sheet | `booking-return-sheet`, `booking-return-button-{forward\|share\|manual\|dismiss}` (complements R-nav-18, which owns the prompt's behavior) |

ConfirmDialogs derive `{testID}-confirm`/`-cancel` per design-system
convention (tokens §2.9).

### 2.10 Out of scope (explicit)

- **Today tab** — separate bundle (leave-by, next-event, day-of leg
  refresh).
- **Map tab screens** and place-detail — maps/places spec (this spec only
  links into them); the mini-map question is a §1 marker, not silent scope.
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

---

## 3. Tasks

Each sized to one agent session; they become `T-N.M` rows when the phase is
cut. **Depends on:** IB-1..IB-3 (API), NAV-1..NAV-6, DS-7..DS-9.

| ID | Task | Covers |
|---|---|---|
| IT-1 | Plan-mode day list: sections, item cards, empty-day rows, day-jump strip, view-toggle shell + per-trip persistence. | R-itin-1, R-itin-8, R-itin-9, R-itin-28 |
| IT-2 | Drag-drop reorder: optimistic day-order PUT, booking-item day locks, haptics, rollback. | R-itin-2, R-itin-3 |
| IT-3 | Travel-time chips + mode sheet + directions handoff + absent-leg states. | R-itin-4..R-itin-6 |
| IT-4 | Conflict surfacing: overlap chips, sort-by-time affordance, form conflict notice. | R-itin-7, R-itin-20 |
| IT-5 | Ideas bucket: section, grouping, add-to-day scheduling flow, needs-a-day + cancelled visibility. | R-itin-10..R-itin-12 |
| IT-6 | Calendar grid: hour axis, day paging, timed blocks, overlap split, all-day lane, gap-tap prefill. | R-itin-13..R-itin-17 |
| IT-7 | Add/edit flows: add sheet, per-type forms (10 types), save routing (bucket vs scheduled), place picker. | R-itin-18, R-itin-19, R-itin-23 |
| IT-8 | Deeplink-out: URL builders per §2.7 (+ device-verify pass for Airbnb/Turo caveats), button enablement, tap recording, return-prompt "add manually" landing. | R-itin-21, R-itin-22 |
| IT-9 | Booking detail screen: per-category layouts, status actions, copy affordance, seams (place/expenses/schedule rows), cancel/delete confirms. | R-itin-24..R-itin-26 |
| IT-10 | Item detail (place_visit/custom) + booking-item routing + offline degradation of this tab. | R-itin-27, R-itin-29 |

**Tests required (minimum, E2E on testIDs of §2.9):**
- [ ] Reorder round-trip: drag persists order; failure rolls back visibly (IT-2)
- [ ] Timed-booking item refuses cross-day drop with hint (IT-2)
- [ ] Leg chip shows correct default mode; absent transit shows no error (IT-3)
- [ ] Overlap: both list chips and grid side-by-side render for the same data (IT-4, IT-6)
- [ ] Idea → "Add to day" → appears in day with `planned` badge (IT-5)
- [ ] Grid gap tap opens prefilled add form (day + rounded time) (IT-6)
- [ ] Each deeplink button builds its exact §2.7 URL (snapshot per partner) and disables on missing fields (IT-8)
- [ ] Deeplink tap records return-prompt state; "add manually" creates with `source: 'deeplink_return'` (IT-8)
- [ ] Cancel flow: confirm → booking off calendar, visible under show-cancelled (IT-9)
- [ ] Every screen root + interactive element exposes its §2.9 testID (all)

---

*Trace: every R-itin-N cites its design section inline; §2.7 rows each trace
to `.specs/research/booking-integrations.md` § Key deeplink formats. Markers:
four — two repeated verbatim from the schema spec, two native (party size,
persistent map).*
