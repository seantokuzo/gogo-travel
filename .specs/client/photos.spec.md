# Client — Photos (`.specs/client/photos.spec.md`)

> **Task:** T-2.3 (PHOTOS + MEMORIES bundle) · **Status:** DRAFT — pending
> Sean approval (P-2 gate 3). Not approvable until zero
> `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `CLAUDE.md` Law #3, `docs/PLANNING.md § Overview` (photos
> bullet) + `§ Cross-cutting patterns` (offline mutation queue),
> `.specs/api/photos.spec.md` (**companion** — endpoints, limits, consent
> posture), `.specs/client/navigation.spec.md` (**CANONICAL** — routes
> `more/photos/*`, modal/push conventions §2.6, testID grammar §2.7),
> `.specs/design-system/tokens.spec.md` (Sheet, ConfirmDialog, Badge,
> EmptyState, ErrorBanner, Skeleton), `.specs/shared/contracts.spec.md`
> (`canViewPhoto` — UI and server share one Law #3 implementation),
> `.specs/research/competitors.md` (Polarsteps: effortless memory capture,
> journaling merged INTO the planner).
>
> **Cross-spec:** map photo pins render in the map tab — owned by the
> maps/places bundle's client spec (sibling T-2.3); §3.7 defines this
> spec's side of that contract.

---

## 1. Scope

Screen-level UX for photos in `apps/mobile`: capture/upload (camera +
library, multi-select), the offline-tolerant upload queue, gallery views
(trip album by day; place-grouped), the photo viewer (pin editing,
visibility control, delete), and permission priming. Routes are fixed by
the navigation spec (`[tripId]/more/photos/index.tsx` album grid,
`[tripId]/more/photos/[photoId].tsx` viewer — push) — this spec fills those
screens and adds no new routes; in-screen flows use Sheets per navigation
spec §2.6.

Design rationale (the MEMORIES half of the bundle): Polarsteps grew
5M→20M travelers on effortless photo journaling, but "journaling lives in
SEPARATE apps from planning today — merging them is an opening"
(`.specs/research/competitors.md`). So the trip album is not a camera roll —
it is the trip's journal: grouped by itinerary day, pinned to places, fed
by frictionless capture during the trip (today-tab quick action), and the
future recap's raw material.

---

## 2. Requirements (EARS)

### Permission priming

- **R-cphoto-1:** WHEN the user first enters any capture/upload flow THE
  SYSTEM SHALL show an in-app priming screen explaining what will be
  requested and why (camera for capture; photo access for library picks;
  location metadata for pin-to-place) BEFORE any OS permission dialog — the
  OS prompt fires only after the user proceeds from priming.
- **R-cphoto-2:** WHEN camera permission is denied THE SYSTEM SHALL keep
  library upload fully functional and render the camera entry with a
  settings deep-link explainer — never a dead button; and vice versa for
  library-only denial.
- **R-cphoto-3:** WHEN the user has not granted location-metadata consent
  per the API spec's consent posture THE SYSTEM SHALL send
  `extract_location: false` on every finalize and SHALL NOT read or
  transmit photo GPS metadata (Law #3 — the boundary is respected
  client-side too, not just at the server).
- **R-cphoto-4:** WHEN location consent is off THE SYSTEM SHALL still allow
  manual pin-to-place/item (auto-suggestion is the only capability lost,
  and the priming copy says so).

### Capture & upload

- **R-cphoto-5:** WHEN the user taps the album FAB (or the today-tab "add
  photo" quick action) THE SYSTEM SHALL offer camera capture and library
  selection; library selection SHALL support multi-select.
- **R-cphoto-6:** WHEN photos are chosen THE SYSTEM SHALL enqueue them and
  return the user to their context immediately — enqueueing never blocks on
  network; slot-minting, PUT, and finalize (API spec §3.2) run from the
  queue in the background, batched at most `MAX_UPLOAD_SLOTS_PER_REQUEST`
  per mint call.
- **R-cphoto-7:** WHEN a photo exceeds `MAX_PHOTO_BYTES` or has an
  unaccepted type (shared constants, API spec §3.9) THE SYSTEM SHALL reject
  it at selection time with a per-item message — never a silent drop, and
  never a doomed round-trip.

### Upload queue (offline tolerance)

- **R-cphoto-8:** WHEN the device is offline or a transfer fails THE SYSTEM
  SHALL retain queue entries (local asset reference + metadata + state) and
  retry with backoff on connectivity/foreground; the queue SHALL survive
  app restarts (PLANNING § Cross-cutting: persisted mutation-queue
  pattern — entries reference local asset URIs, bytes are never copied into
  the queue store).
- **R-cphoto-9:** WHEN uploads are pending or failed THE SYSTEM SHALL show
  them in the album grid as placeholder tiles with per-item progress,
  retry, and cancel — failures are visible, never silent (capture-pipeline
  ethos, R-db-7's spirit).
- **R-cphoto-10:** WHEN a queued item's local asset no longer exists at
  send time THE SYSTEM SHALL mark that item failed with an explanatory
  message (not crash, not skip silently).
- **R-cphoto-11:** WHEN a finalize response returns suggestions (API spec
  §3.5) THE SYSTEM SHALL surface a one-tap confirm affordance ("Pin to
  <place>?") on the uploaded tile/viewer; confirming issues the PATCH —
  the client never auto-pins (mirror of R-photo-5).

### Gallery

- **R-cphoto-12:** WHEN the album grid renders THE SYSTEM SHALL group
  photos into day sections by `taken_at` (fallback `created_at`) in the
  trip's day terms, matching itinerary day headers — the album reads as the
  trip's journal.
- **R-cphoto-13:** WHEN the user switches the album segment to "by place"
  THE SYSTEM SHALL group photos under their pinned place (unpinned photos
  under an "Unpinned" section that doubles as the pin-suggestion entry
  point).
- **R-cphoto-14:** WHEN any photo tile renders THE SYSTEM SHALL show its
  blurhash placeholder until the thumb loads, and a visibility badge for
  any non-default level (`trip`, `public`) — `private` is the unmarked
  default state (Law #3: default private).
- **R-cphoto-15:** WHEN the gallery is empty THE SYSTEM SHALL render an
  EmptyState with an upload CTA (design-system R-ds rules; never a blank
  region).
- **R-cphoto-16:** WHEN the trip is the active offline-bundled trip THE
  SYSTEM SHALL render the gallery from cached metadata + cached thumbs
  offline; full-size loads degrade gracefully (spinner → ErrorBanner with
  retry).

### Viewer, pins, visibility

- **R-cphoto-17:** WHEN a photo the caller owns is open in the viewer THE
  SYSTEM SHALL expose pin controls (place + itinerary item; suggestions
  preselected when available), caption edit, visibility control, and
  delete; WHEN the viewer is not the owner THE SYSTEM SHALL show pins,
  caption, and uploader attribution read-only — owner-only controls are
  absent, not disabled (shared `canViewPhoto`/ownership logic, so UI and
  server can't drift — contracts spec §3.4).
- **R-cphoto-18:** WHEN the user changes visibility THE SYSTEM SHALL
  present the three levels with distinct iconography and plain-language
  scope copy (§3.6); WHEN the change widens to `public` THE SYSTEM SHALL
  require an explicit confirmation step that states who will see the photo
  and that already-seen content can't be recalled after later retraction —
  no default-selected confirm (Law #3: crossing the boundary is always an
  explicit check).
- **R-cphoto-19:** WHEN visibility is narrowed THE SYSTEM SHALL apply it
  with no extra friction (retraction is a privacy control — API spec
  R-photo-8) and update badges/lists immediately (optimistic, rollback on
  error).
- **R-cphoto-20:** WHEN delete is tapped THE SYSTEM SHALL present a
  ConfirmDialog (destructive convention, design-system R-ds-18) and on
  confirm remove the photo optimistically with rollback on failure.

### Map integration & testIDs

- **R-cphoto-21:** WHEN the map tab renders photo pins (owned by the map
  spec) THE SYSTEM SHALL supply it only photos the viewer may see — the
  data source is the server-filtered gallery query, and pin tap SHALL open
  this bundle's place-filtered gallery (§3.7 contract).
- **R-cphoto-22:** WHEN any photos screen renders THE SYSTEM SHALL carry
  testIDs per the navigation spec §2.7 grammar on its root and every
  interactive element (§3.8 inventory) — R-nav-22 applies.

### Open questions (blocking approval)

Repeated verbatim from the canonical schema spec
(`.specs/database/schema.spec.md §3.3.17`) — they gate this spec's caption
UI and any non-member surface:

- [NEEDS CLARIFICATION: PLANNING says public photos let others "see
  experiences/reviews" — is a photo + caption the whole v1 review surface,
  or are ratings/review text a separate concept? Determines whether
  `caption` suffices or a review entity must be specced (none exists in
  PLANNING's entity list).]
- [NEEDS CLARIFICATION: where do public photos surface for non-members —
  browsing a place's detail view, a destination gallery, both? Affects API
  authz spec and whether the partial index above needs `taken_at` for
  ordering. Schema keeps the minimal partial index until the surface is
  defined.]

Repeated verbatim from the companion API spec (`.specs/api/photos.spec.md`
§2) — it decides what the priming flow (§3.5) actually asks:

- [NEEDS CLARIFICATION: location-consent posture — is EXIF GPS extraction
  (R-photo-3) per-upload opt-in via the priming flow (privacy-max, Law #3
  aligned — recommended), a one-time global opt-in stored in `users.prefs`,
  or default-on with priming? Auto-association (the headline pin-to-place
  feature) only works when location is extracted, so the default materially
  shapes the product.]

---

## 3. Design

### 3.1 Screen & flow inventory

Routes per navigation spec §2.1 (no additions):

| Surface | Route / presentation | Contents |
|---|---|---|
| `photos` (album grid) | `[tripId]/more/photos/index.tsx` | Day/place segmented grid, upload FAB, queue tiles, visibility badges |
| `photo-viewer` | `[tripId]/more/photos/[photoId].tsx` — PUSH | Full-bleed image, metadata, pin links, owner controls |
| Source picker | Sheet over `photos` (or today tab) | Camera / library entries + priming branch |
| Pin editor | Sheet over `photo-viewer` | Place search (trip's saved places) + same-day itinerary items, suggestion preselected |
| Visibility control | Sheet over `photo-viewer` | Three levels w/ icons + scope copy; public path → ConfirmDialog |
| Priming screens | In-flow (pre-OS-prompt) | Camera / photos / location-metadata explainers |

Entry points: album FAB; today-tab quick action "add photo" (navigation
spec §2.4 today screen); map photo-pin tap → place-filtered album (§3.7).

### 3.2 Capture & upload UX

1. FAB / quick action → **source Sheet**: "Take photo" (camera) · "Choose
   from library" (multi-select picker). First use of either branch runs its
   priming screen (§3.5) before the OS prompt (R-cphoto-1).
2. Library pick: system picker with multi-select (no artificial client cap;
   batching to the 20-slot server limit is the queue's job). Camera:
   capture → confirm/retake → enqueue; optionally "save to library" per OS
   convention.
3. Selection-time validation against shared `ACCEPTED_PHOTO_MIME` /
   `MAX_PHOTO_BYTES` (R-cphoto-7): rejected items listed with reasons; the
   rest proceed.
4. Enqueue + immediate return to context (R-cphoto-6). New tiles appear at
   the top of the grid in `uploading` state.
5. Picker/camera library choice (expo-image-picker vs alternatives, EXIF
   handling) is a build-time decision via Context7 + `npm view` — this spec
   fixes behavior, not packages (CLAUDE.md § Before you code).

### 3.3 Upload queue mechanics

- **Entry shape (client store, persisted — MMKV/SQLite per PLANNING
  cross-cutting):** `{ local_id, trip_id, asset_ref, content_type,
  byte_size, state: 'queued' | 'uploading' | 'processing' | 'done' |
  'failed', photo_id?, ticket?, put_url?, error?, attempts,
  extract_location }`. Bytes stay in the OS photo store; only references
  persist (R-cphoto-8).
- **Pipeline per batch (≤ 20):** mint slots → parallel PUTs (bounded
  concurrency, e.g. 3) → finalize each → replace queue tile with the real
  `Photo` (and its suggestions chip, R-cphoto-11). Ticket/PUT-URL expiry
  (30 min, API spec §3.9) → re-mint transparently on retry.
- **Retry policy:** exponential backoff; triggers on connectivity regained
  and app foreground; manual per-item retry always available (R-cphoto-9).
  Terminal failures (asset missing R-cphoto-10, server rejection) stay
  visible until dismissed — never auto-cleared.
- **Cancel:** removes the queue entry; if PUT already happened but finalize
  didn't, the object is an orphan and server GC reclaims it (API spec
  R-photo-13) — the client does nothing special.
- Uploads are allowed for any trip status (pre-trip inspiration shots are
  legitimate); the queue is per-trip and rendered only in that trip's album.

### 3.4 Gallery views

- **By day (default):** sections keyed by `taken_at`-derived trip-local day
  (client converts using the trip's destination tz context; fallback
  `created_at` — R-cphoto-12), newest day first, photos within a day in
  `taken_at` order. Server queries use `taken_after`/`taken_before` windows
  (API spec §3.7.3); infinite scroll via `Paginated` cursors; TanStack
  Query with persisted cache for offline (R-cphoto-16).
- **By place:** segmented control switches grouping; sections per pinned
  place (server `place_id` filter per section or client-side regroup of the
  same dataset — implementer's choice; correctness contract is grouping,
  not query shape). "Unpinned" section rows carry a "suggest pins" action →
  runs §3.7.6 suggestions per photo and surfaces confirm chips.
- **Tiles:** blurhash → thumb (R-cphoto-14); visibility Badge overlays
  (§3.6 icons) for `trip`/`public`; queue tiles show progress ring +
  retry/cancel on failure. Skeleton grid on first load; EmptyState with
  upload CTA when empty (R-cphoto-15).
- What members see is the server-filtered set (API R-photo-10) — the client
  adds no filtering but ALSO never renders a photo the shared
  `canViewPhoto` would deny, as drift defense (contracts spec §3.4
  rationale).

### 3.5 Permission priming (R-cphoto-1..4)

One reusable priming pattern (illustration + one-paragraph why + proceed /
not-now), three instances:

| Prime | Fires before | Copy commitment | On deny/not-now |
|---|---|---|---|
| Camera | first camera use | capture straight into the trip album | camera entry shows settings-link explainer; library unaffected (R-cphoto-2) |
| Photo library | first library pick (where the OS/picker requires an app-level grant; out-of-process pickers may need none — build-time verification via Context7) | pick trip photos; app never scans the whole library | library entry explains + settings link; camera unaffected |
| Location metadata | first upload (posture pends the §2 marker) | photo GPS is used only to suggest place/itinerary pins; photos' location never leaves the visibility the user sets (Law #3) | uploads proceed with `extract_location: false`; manual pinning intact (R-cphoto-3/4) |

Priming screens are app UI (skippable, re-triggerable from the blocked
entry), never a replacement for OS dialogs.

### 3.6 Visibility control UX (Law #3 surface)

- **Iconography (fixed):** `private` = lock · `trip` = people · `public` =
  globe. Same icons everywhere a level appears (badges, control sheet,
  viewer header).
- **Control Sheet:** three options with scope copy — private: "Only you";
  trip: "Everyone on this trip"; public: "Anyone using GoGo who browses
  this place". Current level checked; tapping a narrower level applies
  immediately (R-cphoto-19).
- **Widening to public:** selecting `public` opens a ConfirmDialog:
  title "Make this photo public?", body states who can see it (per the
  place-surface wording — final copy pends the §2 where-public-surfaces
  marker), that the photo's caption is included, and that retracting later
  can't recall what others already saw (R-cphoto-18). Confirm is never the
  default-focused action.
- **Trip-level widening** (`private → trip`) applies from the sheet without
  a dialog — members-only exposure, still an explicit user act.
- Optimistic update + rollback with ErrorBanner on failure. Visibility
  control renders ONLY for the owner (R-cphoto-17; API R-photo-7 is the
  backstop).

### 3.7 Map photo-pins contract (with the maps/places client spec)

This spec's side of the boundary — the map spec owns rendering, clustering,
and pin visuals:

- **Data:** photo pins derive from `GET /trips/:tripId/photos` (server
  visibility-filtered, R-photo-10) restricted to rows with `lat`/`lng`;
  the map never receives coordinates for photos the viewer can't see
  (R-cphoto-21 — Law #3 holds on the map surface).
- **Interaction:** photo-pin (or cluster) tap → navigate to
  `[tripId]/more/photos` with a place/location filter applied (place-pinned
  photos → place filter; unpinned-but-located photos → the day section
  containing them). Cross-tab navigation per navigation spec conventions.
- Offline: cached gallery metadata feeds pins for the active trip
  (R-cphoto-16).

### 3.8 testID inventory (R-cphoto-22 — grammar per navigation spec §2.7)

Screen names `photos`, `photo-viewer` (already reserved in the navigation
spec's screen list and examples).

| Element | testID |
|---|---|
| Album root / grid | `photos-screen` · `photos-list` |
| Grid tile | `photos-list-item-{photoId}` |
| Grouping segment | `photos-segment-by-day` · `photos-segment-by-place` |
| Upload FAB | `photos-fab-upload` |
| Source sheet + entries | `photos-sheet-source` · `photos-button-camera` · `photos-button-library` |
| Queue tile / retry / cancel | `photos-upload-item-{localId}` (+ `-retry`, `-cancel`) |
| Suggestion chip confirm/dismiss | `photos-button-pin-suggestion-{photoId}` (+ `-confirm`, `-dismiss`) |
| Priming proceed / not-now | `photos-button-prime-proceed` · `photos-button-prime-later` |
| Viewer root | `photo-viewer-screen` |
| Visibility control | `photo-viewer-toggle-visibility` (navigation spec's own example) |
| Visibility sheet + options | `photo-viewer-sheet-visibility` · `photo-viewer-button-visibility-private/-trip/-public` |
| Public ConfirmDialog | `photo-viewer-dialog-public` (+ `-confirm`, `-cancel` per compound rule) |
| Pin editor | `photo-viewer-button-pin` · `photo-viewer-sheet-pin` · `photo-viewer-list-item-place-{placeId}` · `photo-viewer-list-item-item-{itemId}` |
| Caption input | `photo-viewer-input-caption` |
| Delete + dialog | `photo-viewer-button-delete` (+ `-confirm`, `-cancel`) |
| Back | `photo-viewer-back` |

### 3.9 Out of scope (explicit)

- **Non-member public gallery UI** — pends both public-surface markers
  (§2); when resolved it lands in the maps/places (place detail) or a new
  spec, not by widening this one silently (scope-change rule,
  `.specs/README.md`).
- **Caption-as-review semantics** — pends the reviews-surface marker; the
  caption input ships as a plain caption until then.
- **Map pin rendering/clustering** — maps/places client spec (§3.7 is the
  contract).
- **Post-trip recap UI (MEMORIES beyond the album)** — recap persistence
  has an open marker (API spec §3.10 repeats it from schema spec §3.7);
  recap UX is unspeccable until it resolves.
- **Photo export/share-out, save-to-library of others' photos, print** —
  future scope change.
- **Video capture/playback** — out of scope v1 (API spec §3.10).
- **Today-tab quick-action placement details** — today screen's own spec
  (navigation spec §2.4 already lists "add photo" among its quick actions;
  it simply opens §3.2's source Sheet with this trip's context).

---

## 4. Tasks

Sized to one agent session each; become `T-N.M` rows at build time.
Depends on PH-1..3 (API), NAV-1 route skeleton, DS-7..9 components.

| ID | Task | Covers |
|---|---|---|
| PHC-1 | Album grid: day/place grouping, segmented control, tiles (blurhash, badges), EmptyState/Skeleton, cursor pagination, offline cache read. | R-cphoto-12..16 |
| PHC-2 | Capture + upload: source Sheet, camera/library flows, selection validation, persisted upload queue with batch pipeline, progress/retry/cancel tiles, suggestion chips. | R-cphoto-5..11 |
| PHC-3 | Viewer: full-bleed image, owner vs non-owner control sets, pin editor Sheet w/ suggestions, caption edit, delete w/ ConfirmDialog. | R-cphoto-17, R-cphoto-20 |
| PHC-4 | Visibility control: iconography, control Sheet, public ConfirmDialog, optimistic transitions w/ rollback. **Sensitive path — photo visibility auto-escalates review (PLANNING § Review Pipeline).** | R-cphoto-18, R-cphoto-19 |
| PHC-5 | Permission priming trio + consent plumbing (`extract_location` flag, denial degradations). **Gated on the consent-posture marker.** | R-cphoto-1..4 |
| PHC-6 | Map-pin data contract: visibility-safe pin feed + pin-tap → filtered album navigation (joint task with the map spec's owner). | R-cphoto-21 |

**Tests required (minimum):**
- [ ] Priming precedes every OS prompt; each denial path leaves the other
      capture route functional (PHC-5)
- [ ] Consent off ⇒ `extract_location: false` on the wire and no GPS read
      client-side (PHC-5, Law #3)
- [ ] Enqueue offline → kill app → relaunch → uploads complete on
      connectivity; missing local asset → visible per-item failure (PHC-2)
- [ ] Oversize/unaccepted file rejected at selection with per-item message
      (PHC-2)
- [ ] Suggestion chip: confirm PATCHes the pin; dismiss never writes (PHC-2)
- [ ] Day grouping matches itinerary day headers incl. `taken_at`-null
      fallback; place grouping + Unpinned section (PHC-1)
- [ ] Another member's private photo never renders anywhere: grid, viewer
      deep link (404 state), map pin feed (PHC-1/PHC-6, Law #3 — blocking
      review criterion)
- [ ] Owner-only controls absent for non-owners (PHC-3)
- [ ] Public widen requires the ConfirmDialog; cancel leaves visibility
      unchanged; narrow applies instantly and badge/list update (PHC-4)
- [ ] Delete confirm → tile removed optimistically, restored on server
      error (PHC-3)
- [ ] Every element in §3.8 resolves by testID in an E2E run (R-cphoto-22)

---

*Requirements → design trace inline. Three markers in this file — two
repeated verbatim from schema spec §3.3.17, one repeated verbatim from the
companion API spec (consent posture) — all P-2 interview questions for
Sean. Zero markers = approvable.*
