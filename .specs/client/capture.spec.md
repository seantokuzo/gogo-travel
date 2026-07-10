# Client — Booking Capture (share intent · review queue · onboarding)

> **Task:** T-2.3 · **Status:** DRAFT — pending Sean approval (P-2 gates).
> Not approvable until zero `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `.specs/api/capture.spec.md` (companion — endpoints, pipeline,
> statuses), `.specs/client/navigation.spec.md` (R-nav-14/18/19, deep-link
> registry §2.3, modal/push conventions §2.6, testID grammar §2.7),
> `.specs/database/schema.spec.md` §3.2/§3.4.2 (`parse_status`,
> `ProposedBooking`), `.specs/shared/contracts.spec.md` (`CaptureItem`,
> error codes), `.specs/research/booking-integrations.md` (expo-share-intent
> v8, Apple Mail 3-tap PDF share, Gmail-iOS-can't-share-bodies reality),
> `docs/PLANNING.md § Cross-cutting patterns` (failures visible, never
> silent).
>
> **Consumes:** design-system `Sheet`, `ConfirmDialog`, `ListItem`,
> `ErrorBanner` (tokens spec).

---

## 1. Requirements (EARS)

### Where the queue lives

Resolved at `.specs/client/navigation.spec.md`:§1 (Gate 2, 2026-07-09):
**trips-level inbox** reachable from the trip-list header with a badge
(captures can precede trip assignment), **plus a per-trip filtered view**.
The routes below anchor at the trips-level inbox home the navigation
spec's registry defines; the per-trip view is the same queue filtered by
assigned/guessed trip.

### Share-intent ingestion

- **R-capc-1:** WHEN content arrives via the iOS share sheet
  (`expo-share-intent` v8 — SDK 57, config plugin, dev client required; no
  Expo Go) THE SYSTEM SHALL route into the capture flow with the shared
  payload on both warm and cold start, after auth gating with stash-and-resume
  (this is navigation spec R-nav-19 + R-nav-14; the registry §2.3 owns the
  mechanics — this spec owns what happens on arrival).
- **R-capc-2:** WHEN a shared payload arrives THE SYSTEM SHALL classify it
  (PDF / image / text / URL), upload it via `POST /capture/share`, and land
  the user on the capture queue with the new item visible in its `pending`
  (processing) state.
- **R-capc-3:** WHEN a share upload is rejected (413 oversize, 400
  unsupported, 429 rate-limited) or fails in transit THE SYSTEM SHALL show
  the error inline with the payload summary and a retry affordance — the
  shared payload SHALL never be silently dropped (navigation registry row:
  "parse failure → capture entry with raw payload visible (never dropped)").
- **R-capc-4:** WHEN a share upload cannot be retried to success THE SYSTEM
  SHALL keep the payload available locally until the user explicitly
  discards it (ConfirmDialog) or it uploads.

### Review queue

- **R-capc-5:** WHEN the queue renders THE SYSTEM SHALL list the user's
  captures (`GET /capture?filter=open` by default) newest-first, each row
  showing source (email/share), a one-line summary (parsed title or raw
  hint), and its state: processing (`pending`), ready to file (`parsed`,
  unlanded), needs review (`needs_review`), or failed (`failed`); a segment
  control switches to landed history (`filter=landed`).
- **R-capc-6:** WHILE any visible capture is `pending` THE SYSTEM SHALL poll
  the list every 3 seconds (up to 90 s, then fall back to refetch-on-focus —
  PLANNING collab-sync pattern: REST + refetch, no sockets) and update rows
  in place when parsing completes.
- **R-capc-7:** WHEN the queue is empty THE SYSTEM SHALL render the empty
  state as capture onboarding entry ("Forward bookings to your GoGo address
  or share them from any app") with a button into the onboarding screen.
- **R-capc-8:** WHERE the queue surfaces with a badge (trip-list header
  inbox entry — resolved Gate 2) THE badge count SHALL equal the number of
  actionable rows — `needs_review` + `failed` + unlanded `parsed` (derived
  client-side from the `open` list; no dedicated count endpoint).

### Proposed-booking review card

- **R-capc-9:** WHEN a capture row is opened THE SYSTEM SHALL push the
  review screen showing the proposed booking card: category (editable
  picker), title, dates/times, price + currency, confirmation code, parser
  provenance ("Read automatically" for `jsonld` / "Read by AI" +
  confidence for `llm`), and the trip assignment control (pre-selected with
  `trip_guess` when present).
- **R-capc-10:** WHEN the user edits fields THE SYSTEM SHALL validate with
  the shared Zod schemas locally (same `BookingDetails` union the server
  enforces) and submit edits as `overrides` on
  `POST /capture/:id/confirm` — edits ride the confirm call; there is no
  separate draft-save (companion spec §3.1 confirm).
- **R-capc-11:** WHEN the user taps confirm with a trip selected THE SYSTEM
  SHALL call confirm, and on 201 navigate to the created booking (itinerary
  item detail path) with a success toast; on 409 (already landed — e.g.
  another device) refresh the row into its landed state; on 400 surface the
  field errors inline.
- **R-capc-12:** WHEN the trip picker opens THE SYSTEM SHALL present the
  user's trips (owner/editor roles only — viewer trips are not offered,
  mirroring server authz R-cap-20) in a Sheet, date-overlapping trips first.
- **R-capc-13:** WHEN the user rejects a capture THE SYSTEM SHALL require a
  ConfirmDialog warning that the original email/file is deleted
  (companion R-cap-21: reject = hard delete of the capture and raw payload),
  then `DELETE /capture/:id` and remove the row.
- **R-capc-14:** WHEN a capture is `failed` THE SYSTEM SHALL show the
  user-visible `error`, the raw-payload preview, and three actions: retry
  (`POST /capture/:id/reparse` → row returns to processing), add manually
  (deep-link to the manual booking form, prefilled category when known),
  and reject (R-capc-13). Failures are visible, never silent (R-db-7's UX
  half).
- **R-capc-15:** WHEN the user requests the original THE SYSTEM SHALL fetch
  `GET /capture/:id` and open `raw_url` in an in-app viewer (PDF/image/HTML);
  an expired signed URL is refetched transparently once before surfacing an
  error.
- **R-capc-16 (auto-file visibility):** WHEN a capture was auto-filed THE
  SYSTEM SHALL render it in landed history as "Filed to *<trip>*" linking
  to the booking — auto-filing is never invisible in-app. Auto-file is
  decided behavior — Resolved at `.specs/api/capture.spec.md`:§R-cap-13
  (Gate 2, 2026-07-09): high-confidence parses auto-file + push
  notification with one-tap undo; medium/low-confidence parses route to
  this review queue.
- **R-capc-23 (auto-file undo):** WHEN the auto-file push's one-tap Undo
  action fires (or the Undo action on an auto-filed landed row's overflow
  is tapped) THE SYSTEM SHALL call `POST /capture/:id/undo`; on success
  the capture returns to the queue as `needs_review` for normal review
  (R-capc-9 flow), and the booking disappears from the trip; on 409 (the
  booking was since edited/deleted, or the capture was manually confirmed)
  THE SYSTEM SHALL show an explanatory toast and refresh the row.
  (Resolved 2026-07-09, Gate 2)

### Capture onboarding

- **R-capc-17:** WHEN the onboarding screen opens for the first time THE
  SYSTEM SHALL provision the forward address (`POST /capture/address`),
  showing a loading state, and on failure an ErrorBanner with retry —
  onboarding never renders a fake address.
- **R-capc-18:** WHEN the forward address renders THE SYSTEM SHALL show it
  with a one-tap copy button (copied toast) and teach both paths:
  - **Forward path:** "Forward booking emails to this address" + mail-app
    reality tips from research: Apple Mail shares PDFs in 3 taps; the Gmail
    iOS app can't share email bodies at all — Gmail users must *forward*
    instead of share.
  - **Share path:** "Or share PDFs, screenshots and links straight from any
    app" with the share-sheet walkthrough.
- **R-capc-19:** WHEN the "How to forward" action fires from the
  deeplink-return prompt ("Did you book it?" Sheet — navigation spec
  R-nav-18 owns that prompt) THE SYSTEM SHALL open this onboarding screen —
  one teaching surface, referenced from both entry points.
- **R-capc-20:** WHEN onboarding has been completed once THE SYSTEM SHALL
  remain reachable (queue header help action) — the address is something
  users come back to copy.

### Cross-cutting

- **R-capc-21:** WHEN any capture screen renders THE SYSTEM SHALL carry a
  `testID` on its root view and every interactive element per navigation
  spec §2.7 grammar (R-nav-22; inventory in §2.4 below).
- **R-capc-22:** WHEN capture content renders anywhere THE SYSTEM SHALL
  treat parsed and raw content as private to the owner — capture rows,
  proposals, and raw previews never appear in any shared/trip-visible
  surface (Law #3 posture; server twin R-cap-17/23).

---

## 2. Design

### 2.1 Screens & presentation (navigation §2.6 conventions)

| Screen | Route (anchored at the trips-level inbox home — nav registry, resolved Gate 2) | Presentation |
|---|---|---|
| `capture-queue` | `capture/index` | trips-level inbox (trip-list header entry + badge) with a per-trip filtered view |
| `capture-review` | `capture/[captureId]` | **PUSH** (drill into an on-screen entity) |
| `capture-onboarding` | `capture/onboarding` | **MODAL — form** (self-contained teach flow, explicit done) |
| raw viewer | within `capture-review` | **PUSH** (full-bleed viewer) |
| trip picker | within `capture-review` | **Sheet** (single-decision, context visible) |
| reject / discard confirmations | — | **ConfirmDialog** |

Share-intent arrival (R-capc-1/2) targets `capture-queue` via the deep-link
registry's share-sheet row (navigation §2.3), after upload kickoff.

### 2.2 Queue row states (one component, four render modes)

| `parse_status` + landed | Row treatment | Tap target |
|---|---|---|
| `pending` | spinner + "Reading…" + source icon | review screen (read-only, processing) |
| `parsed`, unlanded | proposal summary + "Pick a trip" chip (or trip_guess name) | review screen |
| `needs_review` | proposal summary + "Needs review" badge | review screen |
| `failed` | error line + "Failed" badge | review screen (failure mode, R-capc-14) |
| landed (any, `booking_id` set) | "Filed to *<trip>*" + checkmark (history segment) | booking detail |

### 2.3 State & data

- TanStack Query: `['capture','list',filter]` (list), `['capture',id]`
  (detail). Confirm/reject/reparse are mutations invalidating both; confirm
  additionally invalidates the target trip's bookings/itinerary queries.
- Poll loop (R-capc-6) implemented as query `refetchInterval` active only
  while the visible page contains a `pending` row; capped at 90 s.
- Pending-upload store (R-capc-3/4): Zustand slice holding not-yet-accepted
  share payloads `{ localId, kind, uri/text, error? }`; rendered as
  synthetic rows at the top of the queue until the server row exists.
- Offline behavior beyond "surface the failure + retry" is the offline
  spec's (navigation §2.8 precedent); the pending-upload store is the seam
  it will extend.

### 2.4 testID inventory (grammar: navigation spec §2.7)

Screen roots: `capture-queue-screen`, `capture-review-screen`,
`capture-onboarding-screen`.

| Element | testID |
|---|---|
| Queue list / row | `capture-queue-list`, `capture-queue-list-item-{captureId}` |
| Queue segment (open/history) | `capture-queue-segment-open`, `capture-queue-segment-landed` |
| Queue help/onboarding entry | `capture-queue-button-onboarding` |
| Pending-upload synthetic row + retry/discard | `capture-queue-list-item-{localId}`, `{testID}-retry`, `{testID}-discard` (+ ConfirmDialog derives `-confirm`/`-cancel`) |
| Review: field inputs | `capture-review-input-title`, `capture-review-input-price`, `capture-review-input-currency`, `capture-review-input-confirmation` |
| Review: category picker | `capture-review-picker-category` |
| Review: trip assign + sheet rows | `capture-review-button-assign-trip`, `capture-review-sheet-trip`, `capture-review-list-item-trip-{tripId}` |
| Review: primary actions | `capture-review-button-confirm`, `capture-review-button-reject` (ConfirmDialog derives `-confirm`/`-cancel`), `capture-review-button-retry`, `capture-review-button-add-manually`, `capture-review-button-view-original` |
| Auto-filed row undo (landed history overflow) | `capture-queue-button-undo-{captureId}` |
| Onboarding | `capture-onboarding-button-copy-address`, `capture-onboarding-button-done`, `capture-onboarding-button-retry` (address provisioning failure) |

Dynamic qualifiers are stable entity ids, never render indexes (§2.7 rule).

### 2.5 Failure-state matrix

| Failure | Surface | Recovery |
|---|---|---|
| Share while signed out | auth flow, payload stashed | resume into R-capc-2 after sign-in (R-nav-14 machinery) |
| Upload network failure | synthetic row + ErrorBanner | retry (R-capc-3); discard via ConfirmDialog (R-capc-4) |
| Upload 413 / 400 / 429 | synthetic row with reason ("Too large — max 10 MB" / "Can't read this type" / "Slow down a moment") | 429: retry; 413/400: discard or share something else |
| Parse `failed` | review screen failure mode | retry / add-manually / reject (R-capc-14) |
| Parse `needs_review` — `ai_unavailable` | needs-review card + notice "AI parsing unavailable — review manually" (server R-cap-16; capture is cap-exempt with its own 20/day ceiling — resolved Gate 2) | edit + confirm manually, or retry later |
| Confirm 400 | inline field errors | fix + resubmit (R-capc-11) |
| Confirm 409 (landed elsewhere) | row refreshes to landed | none needed |
| Raw URL expired | transparent single refetch | error toast if refetch fails (R-capc-15) |
| Address provisioning failure | onboarding ErrorBanner | retry (R-capc-17) |

### 2.6 Out of scope (explicit)

- The "Did you book it?" deeplink-return prompt itself — navigation spec
  R-nav-18 (this spec only receives its "how to forward" action, R-capc-19).
- Manual booking form — itinerary/bookings client spec (R-capc-14 deep-links
  into it).
- Push notification on parse completion + its tap-routing — notifications
  spec (will route through the deep-link registry).
- Siri/Calendar reservation donation — future enhancement (research item 4),
  not v1.
- Android share-target verification — Android pass, pre-launch (navigation
  §2.8 precedent).
- Offline mutation queueing for uploads — offline spec (§2.3 seam).
- Email-side behavior (webhook, parse, reply email) — companion API spec.

---

## 3. Tasks

Traceable to requirement IDs; each sized to one agent session; become `T-N.M`
rows when the phase is cut. **Depends on:** NAV-6 (share-intent routing),
capture API (CAP-1..4), design-system Sheet/ConfirmDialog/ListItem.

| ID | Task | Covers |
|---|---|---|
| CAPC-1 | Share-intent ingestion: expo-share-intent v8 wiring (config plugin, dev client), payload classification, upload call, pending-upload store + synthetic rows, stash/resume path. | R-capc-1..4 |
| CAPC-2 | Queue screen: list + segments + row states + poll loop + badge derivation + empty state. | R-capc-5..8 |
| CAPC-3 | Review screen: proposal card, edit fields with shared-schema validation, trip picker sheet, confirm/reject/retry/add-manually/view-original flows, landed history rendering, auto-file undo (push action + landed-row overflow). | R-capc-9..16, R-capc-23 |
| CAPC-4 | Onboarding screen: address provisioning, copy affordance, forward + share teaching content, R-nav-18 entry hook, persistent reachability. | R-capc-17..20 |

testIDs (R-capc-21) land with each screen's task; NAV-7 lint enforces them.

**Tests required (minimum):**
- [ ] Share intent (each payload kind) on cold + warm start → upload fired, queue shows processing row (CAPC-1)
- [ ] Share while signed out → stash, auth, resume to upload (CAPC-1)
- [ ] Upload 413/400/429/network failure → visible synthetic row, retry works, discard requires ConfirmDialog, payload never silently dropped (CAPC-1)
- [ ] Queue renders all five row states; poll updates a pending row in place; badge equals actionable count (CAPC-2)
- [ ] Confirm happy path: edited fields sent as overrides, 201 → navigate to booking; 400 → inline errors; 409 → row flips to landed (CAPC-3)
- [ ] Trip picker excludes viewer-role trips; trip_guess preselected (CAPC-3)
- [ ] Reject shows deletion warning, deletes, removes row (CAPC-3)
- [ ] Failed capture shows error + all three recovery actions; retry returns row to processing (CAPC-3)
- [ ] Auto-filed row shows "Filed to <trip>"; undo returns it to needs_review and removes the booking; 409 undo shows toast + refresh (CAPC-3)
- [ ] Onboarding provisions address once, copy button copies, provisioning failure shows retry (CAPC-4)
- [ ] Every interactive element carries its §2.4 testID (NAV-7 lint green)

---

*Trace: R-capc-N ↔ §2 sections inline. Both repeated markers resolved at
their canonical homes at Gate 2 (2026-07-09): queue surface → trips-level
inbox + per-trip filtered view (navigation spec §1); auto-file →
high-confidence auto-file + push with one-tap undo, medium/low → review
queue (capture API R-cap-13/28 — client undo flow added as R-capc-23).
Zero markers remain.*
