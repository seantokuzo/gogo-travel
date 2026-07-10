# Places API Spec — `.specs/api/places.spec.md`

> **Task:** T-2.3 (maps/places bundle) · **Status:** DRAFT — pending Sean
> approval (P-2 gate 3). Not approvable until zero `[NEEDS CLARIFICATION]`
> markers remain.
>
> **Sources:** `.specs/research/maps-places.md` (THE evidence layer — Overture/
> FSQ-OS licensing, Foursquare zero-caching rule, Google ToS wall),
> `.specs/database/schema.spec.md` §3.3.7/§3.3.8 (CANONICAL — `places`,
> `saved_places`; R-db-6), `.specs/shared/contracts.spec.md` (envelope,
> descriptors, `domains/place.ts`), `docs/PLANNING.md § Architecture`
> (provider table: places spine = Overture/FSQ OS → our Postgres), ADR-005
> (premium-place-details entitlement seam).
>
> **Companion spec:** `.specs/client/map.spec.md` — the client half of the
> fetch-fresh/display-then-discard contract (R-places-8 ↔ R-map-9).

---

## 1. Scope

The `places` router in `apps/server` (PLANNING § Component map lists it) plus
the POI-spine ingestion pipeline that feeds it:

1. **Spine ingestion** — Overture / FSQ OS GeoParquet → our Postgres,
   region-scoped on demand (strategy §3.1).
2. **Place search** — our DB first: text (pg_trgm) + geo (bbox) queries;
   user-custom place creation.
3. **Place details** — spine data + optional Foursquare hosted-API premium
   fields, fetch-fresh → display → discard, **never persisted** (licensing).
4. **`saved_places` CRUD** — trip-scoped pins.
5. **Attribution requirements** surfaced to the client.

Out of scope: §3.6.

---

## 2. Requirements (EARS)

### Spine ingestion

- **R-places-1 (region-scoped ingestion on demand):** WHEN a trip is created
  or its destination changes, AND destination coordinates are present, THE
  SYSTEM SHALL enqueue an asynchronous ingestion job for the destination
  region (§3.1 region definition) unless that region is already ingested and
  fresh (`ingested_at` within the refresh window). Trip creation SHALL NOT
  block on, or fail because of, ingestion.
- **R-places-2 (idempotent upsert, no deletes):** WHEN the pipeline ingests
  or re-ingests a region THE SYSTEM SHALL upsert rows on `(source,
  source_id)` (schema R-db-6) and SHALL NOT delete any `places` row as part
  of refresh (spine rows are referenced with `ON DELETE RESTRICT`; upstream
  disappearance is not row removal).
- **R-places-3 (cross-source dedup):** WHEN a record from a lower-priority
  source resolves as a duplicate of an existing place from a higher-priority
  source (distance + name-similarity thresholds, §3.1.4) THE SYSTEM SHALL
  skip inserting it, so one physical venue yields one `places` row.
- **R-places-4 (ingestion failure is visible, not fatal):** WHEN a region
  ingestion job fails THE SYSTEM SHALL record the failure on the region row
  (status + error), retry with backoff, and leave all previously ingested
  data intact; search over a failed/partial region degrades to whatever the
  spine holds (R-places-6).
- **R-places-5 (refresh cadence):** WHEN an ingestion trigger fires for a
  region whose last successful ingest is older than the refresh window
  (default 90 days, config) THE SYSTEM SHALL re-run ingestion for it;
  regions are never refreshed on a standing schedule (no cron sweep — demand-
  driven only, keeps Neon/egress cost proportional to actual trips).

### Search

- **R-places-6 (our DB first):** WHEN a user searches places THE SYSTEM
  SHALL answer from our Postgres spine only — text match (pg_trgm GIN on
  `name`) and/or geo filter (bbox over the `(lat, lng)` index) — and SHALL
  NOT call any external search/autocomplete API in v1 (Mapbox Search Box is
  an explicit non-goal: intro-pricing watch item, research §Places).
- **R-places-7 (coverage miss degrades + backfills):** WHEN a geo-scoped
  search targets an area with no ingested region THE SYSTEM SHALL return
  whatever the spine holds for it AND enqueue a throttled background ingest
  for that area (secondary trigger, §3.1.3) — never an error, never a block.
- **R-places-8 (custom-place privacy):** WHEN search results are assembled
  THE SYSTEM SHALL include `custom`-source places only if the caller created
  them or they are referenced (saved/itinerary/booking) in a trip the caller
  is a member of. Custom places SHALL NOT surface globally (Law #3 posture:
  "Mom's house" never appears in strangers' searches).

### Custom places

- **R-places-9 (creation):** WHEN a user creates a custom place THE SYSTEM
  SHALL persist it with `source = 'custom'`, `source_id = NULL`,
  `created_by = caller` (schema §3.3.7 checks), validated coordinates and
  non-empty name.
- **R-places-10 (creator-only mutation):** WHEN a custom place is updated or
  deleted THE SYSTEM SHALL require `created_by = caller` (403 otherwise);
  spine-source places (`overture`/`fsq_os`) SHALL reject mutation for
  everyone. WHEN deletion is blocked by references (RESTRICT from
  `saved_places`/`itinerary_items`/`tour_guide_bundles`) THE SYSTEM SHALL
  return 409 `CONFLICT` naming the reason, not a 500.

### Place details & Foursquare fetch-fresh

- **R-places-11 (fetch-fresh, zero persistence):** WHEN premium details are
  requested THE SYSTEM SHALL fetch them from the Foursquare hosted API at
  request time, return them with `Cache-Control: no-store`, and SHALL NOT
  write any part of the response to Postgres, server cache, or logs (only
  the FSQ place id may be stored — it already is, as `places.source_id`).
  Fetch-fresh → display → discard is the licensing contract (research:
  "Zero content caching for PAYG"; mirror: `.specs/client/map.spec.md`
  R-map-9).
- **R-places-12 (entitlement seam):** WHEN a request asks for premium
  details THE SYSTEM SHALL check
  `resolveEntitlements(user).premium_place_details` before any Foursquare
  call (ADR-005 seam; premium details are deferred from MVP — resolved
  Gate 2, §2 Resolved questions — so this seam is dormant in v1).
- **R-places-13 (fresh degrade):** WHEN the Foursquare call fails, times
  out (budget: 3s), or the place has no FSQ id THE SYSTEM SHALL still return
  200 with full spine data and the `fresh` block omitted — the premium fetch
  never fails the details view.
- **R-places-14 (fresh cost hygiene):** WHEN premium-detail calls execute
  THE SYSTEM SHALL count them per user per day (config cap, default 50/day →
  429 `RATE_LIMITED` beyond it) and against a global monthly budget guard
  (config; trip → alert → disable `fresh`, spine-only responses continue) —
  FSQ spend is metered per call and sits outside the AI kill-switch, so it
  gets its own guard in the same spirit.

### Saved places

- **R-places-15 (trip-scoped CRUD + roles):** WHEN saved-place endpoints are
  called THE SYSTEM SHALL require trip membership for reads and role
  `owner`/`editor` for mutations (`viewer` is read-only); non-members get
  the indistinguishable 404 posture (contracts spec `ErrorCode` table).
- **R-places-16 (save-once semantics):** WHEN a place is saved to a trip it
  is already saved to THE SYSTEM SHALL return 409 `CONFLICT` (unique
  `(trip_id, place_id)`, schema §3.3.8) — clients may treat it as
  idempotent success (map spec R-map-11).

### Attribution

- **R-places-17 (attribution surfaced):** THE SYSTEM SHALL include `source`
  on every place payload, and every `fresh` block SHALL carry the
  Foursquare-required attribution field; the per-source attribution registry
  (display strings + link URLs for Overture, FSQ OS, Foursquare API) SHALL
  live in `@gogo/shared` config so client surfaces render it consistently
  (map spec R-map-6 renders the Mapbox side). Exact wording/logo rules are
  verified against each provider's current policy at implementation — never
  from training data.

### Resolved questions (Gate 2, 2026-07-09)

- Destination input — Resolved at `.specs/database/schema.spec.md`:§3.3.4
  `trips` (Gate 2, 2026-07-09): structured search against the Overture
  city/locality subset; lat/lng always present — R-places-1's trigger fires
  for every trip (the coordinates-present guard stays as robustness only).
- **v1 ingestion source set — decided: BOTH Overture + FSQ OS, with
  cross-source dedup (R-places-3); Overture wins dedup priority**
  (`overture > fsq_os`). Both attribution strings ship. (Resolved
  2026-07-09, Gate 2)
- **`place_ingest_regions` table (§3.1.2) + the `places-ingest` job —
  APPROVED** as entity-list additions: the table folds into schema.spec.md
  + migration (Law #6; schema spec is picking it up) and the job joins
  PLANNING § Component map. (Resolved 2026-07-09, Gate 2)
- **Foursquare premium fresh details — DEFERRED from MVP** (revisit
  post-launch): MVP is spine-data-only ($0) — no Foursquare developer
  account, no metered billing. R-places-11..14 land as a dormant seam
  (`fresh` never requested in v1; endpoint shape unchanged) and detail
  views are spine-only. (Resolved 2026-07-09, Gate 2)

- **R-places-18 (source set):** WHEN a region is ingested THE SYSTEM SHALL
  ingest both the Overture and FSQ OS snapshots for it, applying
  cross-source dedup (R-places-3) with deterministic priority
  `overture > fsq_os`. (Resolved 2026-07-09, Gate 2)

---

## 3. Design

### 3.1 Ingestion pipeline (GeoParquet → Postgres)

#### 3.1.1 Strategy: region-scoped on demand — **decided**, global preload rejected

| Option | Verdict | Why |
|---|---|---|
| **Region-scoped, on demand (trip-driven)** | **CHOSEN** | Storage/ingest cost proportional to real trips (a few metros ≈ 10⁴–10⁵ rows each); first ingest per destination runs async in minutes; Neon stays small; no standing jobs. |
| Global preload (75–100M+ POIs) | Rejected | Tens of GB in Neon before the first user; hours-long import; ~all rows never queried; violates the keep-spend-proportional posture for zero user-visible gain (search still works per region either way). |

Never marked `[NEEDS CLARIFICATION]`: given Neon + the no-idle-spend
posture there is one sane answer; the formerly open parts (source set,
region table approval, trigger inputs) are resolved in §2.

#### 3.1.2 Region tracking — `place_ingest_regions` (approved table — Gate 2, 2026-07-09)

| Column | Type | Notes |
|---|---|---|
| `region_key` | `text` PK | Canonical key from the region grid (§3.1.3) |
| `min_lat` / `min_lng` / `max_lat` / `max_lng` | `numeric(9,6)` | The ingested bbox |
| `source` | `place_source` | One row per (region, source); PK is `(region_key, source)` |
| `status` | `text` | `pending` / `running` / `ready` / `failed` |
| `error` | `text` NULL | Last failure, visible in ops queries (R-places-4) |
| `ingested_at` | `timestamptz` NULL | Last success — drives the 90-day refresh window (R-places-5) |
| `row_count` | `integer` NULL | Observability |

Follows every schema-spec convention (§1 there); approved Gate 2 — the
schema spec is folding it in verbatim with its migration.

#### 3.1.3 Triggers & region definition

- **Region grid:** regions are cells of a fixed grid (0.5° × 0.5°, ~55 km —
  `region_key = "r:{floor(lat/0.5)}:{floor(lng/0.5)}"`). A destination
  ingests the cell containing it **plus the 8 neighbors** (~165 km square —
  covers a metro + day trips). Grid cells (not per-trip radii) make region
  work shareable across trips and idempotent by key.
- **Primary trigger:** trip create / destination change with coordinates
  (R-places-1) — server-side enqueue in the same request, job runs async.
- **Secondary trigger:** geo-scoped search over cells with no
  `ready`/fresh row (R-places-7) — enqueue those cells, throttled (one
  enqueue per cell per hour) so scan-the-globe panning can't stampede jobs.
- **Refresh:** both triggers re-enqueue when `ingested_at` is older than the
  window (R-places-5). Upsert-only; closed venues persist until a future
  staleness pass (additive later; RESTRICT makes deletion moot anyway).

#### 3.1.4 Job steps (contract, not code)

1. Resolve release: latest published Overture places / FSQ OS Places
   GeoParquet snapshot (release discovery pinned at implementation via
   Context7/docs — never guessed).
2. Bbox-filter read of the remote GeoParquet for the region cell (DuckDB
   with httpfs/spatial is the assumed reader; exact tooling pinned at
   implementation).
3. Normalize per record: `name` (trim/NFC), `lat`/`lng` (validate range),
   `category` (raw source-taxonomy string stored as-is; coarse-category
   mapping is read-side, §3.2.3), `wiki_ref` (mapped when the source carries
   a Wikidata ref; else NULL), `source_id` (Overture GERS id / FSQ id).
4. Batch upsert (500–1,000 rows/statement) on `(source, source_id)`
   (R-places-2; schema R-db-6 is the contract).
5. Cross-source dedup (R-places-3), only when ingesting a lower-priority
   source: candidate is a duplicate when an existing higher-priority-source
   place lies within **50 m** AND normalized-name trigram similarity ≥
   **0.6** (both config in `@gogo/shared`; thresholds tunable on real
   regions) → skip insert. Deterministic priority order:
   `overture > fsq_os` (R-places-18, resolved Gate 2).
6. Mark region row `ready` + `ingested_at = now()` + `row_count`; on error
   mark `failed` + `error`, retry with backoff (max 3), leave data intact
   (R-places-4).

### 3.2 Wire shapes (defined in `@gogo/shared` `domains/place.ts`)

Per contracts spec §3.1: snake_case, mirrors of schema §3.3.7/§3.3.8.

- **`Place`** — `{ id, source, source_id, name, lat, lng, category,
  coarse_category, wiki_ref, created_by, created_at, updated_at }`
  (`coarse_category` is derived, §3.2.3, not a DB column).
- **`PlaceCreate`** — `{ name, lat, lng, category? }` (server sets
  `source='custom'`, `created_by`).
- **`SavedPlace`** — `{ id, trip_id, place_id, note, created_by,
  created_at, updated_at }`; list/read endpoints return
  **`SavedPlaceWithPlace`** = `SavedPlace & { place: Place }` (one round
  trip renders the map pins + list).
- **`FreshPlaceDetails`** (never persisted anywhere — R-places-11):
  `{ fetched_at, attribution: { text, logo_required: boolean, url },
  fields: { hours?, open_now?, rating?, price_level?, photos?: string[],
  tips?: Array<{ text, created_at }>, website?, phone? } }`. Field-exact
  mapping from FSQ responses pinned at implementation against current FSQ
  docs (fields are Premium-tier: hours/rating/photos/tips — research).
- **§3.2.3 Coarse categories** — shared pure mapping
  `coarseCategory(source, category)` → `'food' | 'drink' | 'lodging' |
  'attraction' | 'culture' | 'outdoors' | 'shopping' | 'nightlife' |
  'transport' | 'other'` (append-only tuple in `enums.ts`). Consumed by
  search filters and map-pin icons (map spec §2.2). Source-taxonomy →
  coarse tables live in shared config; schema stays raw (schema §3.3.7:
  normalization is a places-domain concern).
- **§3.2.4 Attribution registry** (R-places-17) — shared config:
  `ATTRIBUTION: Record<'overture' | 'fsq_os' | 'foursquare_api' | 'mapbox',
  { text, url, logo_required }>`; strings verified at implementation.

### 3.3 Endpoints

All routes require auth (bearer JWT; auth spec owns the mechanics); all
inputs validated via shared descriptors + `@hono/zod-validator`
(R-shared-3); errors use the shared `ApiError` envelope.

---

### GET /places/search

Search our spine: text and/or geo. **Auth**: Required

**Request** (query): `q?` (string, ≥ 2 chars) · `bbox?`
(`minLng,minLat,maxLng,maxLat`) · `near?` (`lat,lng`) + `radius_m?`
(default 2,000, max 50,000) · `coarse_category?` · `trip_id?` (uuid —
widens custom-place visibility to that trip per R-places-8; membership
checked) · `cursor?` · `limit?` (default 20, max 50). At least one of
`q` / `bbox` / `near` required.

**Response 200**: `Paginated<Place>` — ranked by trigram similarity when
`q` present, distance when geo-only, blended when both (exact ranking
expression is implementation detail; determinism required for cursor
stability).

**Errors**: 400 `VALIDATION_FAILED` — no criteria / malformed bbox; 404
`NOT_FOUND` — `trip_id` given but caller not a member (posture).

**Requirements covered**: R-places-6, R-places-7, R-places-8

**Tests required**:
- [ ] Happy path: text hit, geo hit, text+geo blend, pagination cursor
- [ ] Coverage miss returns partial results AND enqueues throttled ingest (R-places-7)
- [ ] Error cases: no criteria, bad bbox, oversized radius
- [ ] Authz: stranger's custom place absent from results; own + trip-referenced custom present (R-places-8); non-member `trip_id` → 404

---

### POST /places

Create a user-custom place. **Auth**: Required

**Request**: `PlaceCreate`

**Response 201**: `Place` (`source: 'custom'`)

**Errors**: 400 `VALIDATION_FAILED` — empty name, out-of-range lat/lng

**Requirements covered**: R-places-9

**Tests required**:
- [ ] Happy path: created with `source='custom'`, `source_id NULL`, `created_by=caller`
- [ ] Error cases: invalid coords, blank name
- [ ] Authz: unauthenticated → 401

---

### GET /places/:placeId

Place details: spine row + optional fetch-fresh premium fields.
**Auth**: Required

**Request** (query): `fresh?` (boolean, default false)

**Response 200**: `{ place: Place, fresh?: FreshPlaceDetails,
fresh_unavailable_reason?: 'no_fsq_id' | 'not_entitled' | 'upstream_error' |
'disabled' }` — `fresh` present only when requested AND `source='fsq_os'`
AND entitled AND the FSQ call succeeded within budget. Response served with
`Cache-Control: no-store` whenever `fresh` was requested (R-places-11).

**Errors**: 404 `NOT_FOUND` — unknown id, or a custom place invisible to
the caller (R-places-8 posture); 429 `RATE_LIMITED` — per-user daily fresh
cap (R-places-14)

**Requirements covered**: R-places-11, R-places-12, R-places-13,
R-places-14, R-places-17

**Tests required**:
- [ ] Happy path: spine-only; fresh happy path (FSQ stubbed) with attribution present
- [ ] Fresh degrade: FSQ timeout/500 → 200 with `fresh` omitted + reason (R-places-13)
- [ ] Zero persistence: after a fresh request, no FSQ content exists in DB or logs (assert on stub payload sentinel string) (R-places-11)
- [ ] Entitlement off → `not_entitled`, no FSQ call made (R-places-12); daily cap → 429 (R-places-14)
- [ ] Authz: invisible custom place → 404 indistinguishable from absent

---

### PATCH /places/:placeId

Edit a custom place (creator only). **Auth**: Required

**Request**: partial `PlaceCreate` (any of `name`, `lat`, `lng`, `category`)

**Response 200**: `Place`

**Errors**: 403 `FORBIDDEN` — non-creator or spine-source place; 404 —
unknown/invisible; 400 — validation

**Requirements covered**: R-places-10

**Tests required**:
- [ ] Happy path: creator edits name/coords
- [ ] Error cases: spine place rejected; invalid coords
- [ ] Authz: non-creator → 403

---

### DELETE /places/:placeId

Delete a custom place (creator only, unreferenced only). **Auth**: Required

**Response 204**

**Errors**: 403 — non-creator or spine place; 409 `CONFLICT` — referenced
by saved places / itinerary items / bundles (RESTRICT surfaced cleanly);
404 — unknown/invisible

**Requirements covered**: R-places-10

**Tests required**:
- [ ] Happy path: unreferenced custom place deleted
- [ ] Error cases: referenced → 409 with reason (not 500)
- [ ] Authz: non-creator → 403

---

### GET /trips/:tripId/saved-places

List a trip's saved places. **Auth**: Required (member)

**Request** (query): `cursor?`, `limit?` (default 100 — map wants the full
pin set in one page for typical trips)

**Response 200**: `Paginated<SavedPlaceWithPlace>`

**Errors**: 404 — non-member posture

**Requirements covered**: R-places-15

**Tests required**:
- [ ] Happy path: member lists; embedded `place` present
- [ ] Authz: non-member → 404; viewer can read

---

### POST /trips/:tripId/saved-places

Save a place to a trip. **Auth**: Required (owner/editor)

**Request**: `{ place_id: Uuid, note?: string }`

**Response 201**: `SavedPlaceWithPlace`

**Errors**: 409 `CONFLICT` — already saved (R-places-16); 404 — non-member
posture, or `place_id` unknown/invisible; 403 — viewer role

**Requirements covered**: R-places-15, R-places-16

**Tests required**:
- [ ] Happy path: save with/without note; `created_by = caller`
- [ ] Error cases: duplicate → 409; unknown place → 404
- [ ] Authz: viewer → 403; non-member → 404

---

### PATCH /trips/:tripId/saved-places/:savedPlaceId

Edit the note. **Auth**: Required (owner/editor)

**Request**: `{ note: string | null }`

**Response 200**: `SavedPlaceWithPlace`

**Errors**: 404 — non-member posture / unknown id; 403 — viewer

**Requirements covered**: R-places-15

**Tests required**:
- [ ] Happy path: note set + cleared
- [ ] Authz: viewer → 403; non-member → 404 (wrong trip in path → 404)

---

### DELETE /trips/:tripId/saved-places/:savedPlaceId

Unsave. **Auth**: Required (owner/editor)

**Response 204**

**Errors**: 404 — non-member posture / unknown id; 403 — viewer

**Requirements covered**: R-places-15

**Tests required**:
- [ ] Happy path: unsave; re-save afterwards succeeds (no tombstone)
- [ ] Authz: viewer → 403; non-member → 404

---

### 3.4 Foursquare integration notes

- **MVP posture (resolved Gate 2, 2026-07-09): premium fresh details are
  deferred** — no FSQ developer account in MVP; the contract below is the
  dormant seam, implemented when the feature is revisited post-launch.
- Server-side only — the FSQ API key never ships in the client bundle.
- Only `fsq_os`-sourced places have an FSQ id (`source_id`) to query;
  Overture/custom places return `fresh_unavailable_reason: 'no_fsq_id'`.
  (FSQ "match" lookup for Overture rows is a future seam, not v1.)
- Timeout budget 3 s; no retries (cost); failures are degrade-not-error
  (R-places-13).
- Per-user daily counter + global monthly budget guard (R-places-14) are
  plain Postgres counters/config — deliberately NOT `ai_usage` (that table
  is the AI-cap seam; FSQ is a different meter).

### 3.5 Ingestion ↔ tile-region alignment

The region grid (§3.1.3) is exported from `@gogo/shared`
(`regionCellsForDestination(lat, lng)`), and `.specs/client/map.spec.md`
§2.5 uses the same cells for the offline TileRegion bounds — one region
definition, two consumers (POI coverage and tile coverage never disagree
about what "the destination area" means).

### 3.6 Out of scope (explicit)

- **Destination geocoding at trip creation** — trips spec (structured
  Overture-backed destination search, resolved Gate 2).
- **Travel legs / directions** — itinerary spec (Mapbox Directions +
  Transitous; `travel_legs` contract in schema §3.3.11).
- **Tour-guide content generation/serving** — AI spec (grounds in this
  spine via `places.id` + `wiki_ref`).
- **Mapbox Search Box autocomplete** — explicitly not v1 (R-places-6);
  revisit only with the pricing watch item in hand.
- **Wikipedia/Wikivoyage enrichment jobs** — AI spec concern; this spec
  only carries `wiki_ref` through.
- **Photos-at-place surfaces** — photos spec (public-surface marker lives
  in schema §3.3.17).
- **Ops/admin UI for ingest regions** — server logs + SQL are the v1 ops
  surface.

---

## 4. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
Depends on DB-1 (schema) + SH-1 (shared) having landed.

| ID | Task | Covers |
|---|---|---|
| PL-1 | `place_ingest_regions` migration (approved Gate 2) + region grid in shared + ingest job for both sources, `overture > fsq_os` dedup (GeoParquet read → normalize → batch upsert → dedup → region bookkeeping) + trip-create/search-miss triggers with throttle. | R-places-1..5, R-places-7 (enqueue half), R-places-18 |
| PL-2 | Search endpoint (text/geo/blend, custom-place visibility, pagination) + custom place create/patch/delete + coarse-category mapping in shared. | R-places-6..10 |
| PL-3 | Details endpoint: spine read + attribution registry in shared. FSQ fetch-fresh client (no-store, degrade, entitlement check, per-user/global guards) is DEFERRED with the premium feature (Gate 2) — ship the spine read + `fresh_unavailable_reason` plumbing only. | R-places-11..14 (dormant seam), R-places-17 |
| PL-4 | Saved-places CRUD (4 routes) with role authz + 404 posture + conflict semantics. | R-places-15, R-places-16 |

**Tests required** roll up from each endpoint's checklist plus:

- [ ] Ingest job on a fixture GeoParquet: idempotent re-run (row counts stable), refresh window respected, failure path marks region `failed` and preserves data (PL-1)
- [ ] Cross-source dedup fixture: same venue from both sources yields one row, priority respected (PL-1)
- [ ] Grep-level guard: no code path writes `FreshPlaceDetails` fields to any Drizzle table or logger (PL-3)

---

*Trace: every R-places-N cites its section/endpoint inline. All 4 markers
resolved at Gate 2 (2026-07-09): destination input (structured, canonical
at schema spec) · source set (both, `overture > fsq_os` → R-places-18) ·
`place_ingest_regions` (approved) · FSQ premium (deferred from MVP). Zero
markers remain.*
