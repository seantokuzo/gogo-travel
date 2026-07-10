# AI Platform & Features Spec — `.specs/api/ai.spec.md`

> **Task:** T-2.3 (AI bundle) · **Status:** DRAFT — pending Sean approval (P-2
> gate). Not approvable until zero `[NEEDS CLARIFICATION]` markers remain.
>
> **Sources:** `docs/PLANNING.md § Architecture` (provider table + AI policy —
> approved 2026-07-09), CLAUDE.md Laws #1/#2/#3/#5/#7/#8, ADR-005 (entitlement
> seams), `.specs/research/ai-architecture.md` (the AI bible — models, caching,
> caps, kill-switch, grounding, anti-hallucination, batch pre-gen, offline
> bundles), `.specs/research/maps-places.md` (grounding = OUR POI spine +
> Wikipedia; Google Places is ToS-banned for AI use — supersedes the AI
> report's grounding source), Claude API facts re-verified 2026-07-09 via the
> claude-api skill (model ids, pricing, Batch API, structured outputs).
>
> **Companion specs (CANONICAL — this spec must never drift from them):**
> `.specs/database/schema.spec.md` (`ai_usage` §3.3.18, `ai_cache` §3.3.19,
> `tour_guide_bundles` §3.3.20, `packing_lists` §3.3.21, `weather_cache`
> §3.3.23, enums §3.2) and `.specs/shared/contracts.spec.md` (error envelope
> §3.5, AI structured-output constraints §3.7, `SCHEMA_VERSION` + cache-key
> derivation, entitlement config §R-shared-12).

---

## 1. Scope

The AI platform in `apps/server` (middleware, accounting, spend controls,
caching, prompt rules, jobs) and four AI features: **recommendations**,
**tour guide**, **packing lists**, **trip recap**. Also: AI-content UX
disclosure conventions and degradation behavior.

**Uses the platform but specced elsewhere:** `expense_estimate`
(budgets/money spec) and the capture-pipeline LLM fallback (capture spec) —
both flow through this spec's middleware, accounting, and prompt rules; their
endpoint/job contracts live in their own specs.

### 1.1 The spend boundary (Law #5 — read this first)

Law #5 ("no metered API spend, no scheduled LLM jobs", ADR-003) governs the
**development workflow**: CI, the review pipeline, and the autonomous loop
never call the Anthropic API and never hold `ANTHROPIC_API_KEY`. The
**product runtime** is different: `apps/server` (request handlers + its batch
jobs) calls the paid Anthropic API — this is the approved AI-policy row in
PLANNING's provider table and research escalation #1 (paid account, $50
alert / $100 kill-switch). The key is a server-only production secret
(Law #1): never in git, never in CI, never in the mobile app. Tests mock the
Anthropic client (R-ai-2).

---

## 2. Requirements (EARS)

### 2.1 Platform — key custody, gates, accounting, spend

- **R-ai-1 (server-side only):** WHEN any Claude call is made THE SYSTEM
  SHALL make it from `apps/server` (request handlers or server jobs) using
  `ANTHROPIC_API_KEY` from server environment only; `apps/mobile` SHALL
  contain no Anthropic SDK, key, or direct model call path (CI check:
  dependency scan of the mobile workspace).
- **R-ai-2 (dev spend boundary):** WHEN tests, CI, or the local dev loop run
  THE SYSTEM SHALL NOT call the Anthropic API — the Anthropic client is
  injected and mocked in tests; no `ANTHROPIC_API_KEY` exists in CI
  environments (Law #5, ADR-003).
- **R-ai-3 (entitlement gate):** WHEN any counted AI request executes THE
  SYSTEM SHALL, within the request and before any model call, resolve the
  caller's effective entitlements (`overrides ?? PLAN_DEFAULTS[plan]`,
  R-shared-12) and read the caller's `ai_usage` rows for the current UTC day
  (schema spec R-db-5).
- **R-ai-4 (global daily cap):** WHEN the caller's summed counted calls for
  the UTC day have reached the effective `ai_calls_per_day` (default 30,
  ADR-005 / approved policy) THE SYSTEM SHALL reject with 429
  `AI_CAP_EXCEEDED` before any model call, with
  `details: { feature, cap, resets_at }`.
- **R-ai-5 (per-feature ceilings):** WHEN a feature's own daily ceiling is
  reached THE SYSTEM SHALL reject with 429 `AI_CAP_EXCEEDED` even if the
  global cap has headroom. Ceilings are shared config
  (`config/entitlements.ts`), not migrations. Approved values (within the
  30/day global cap): `recommendations` 10/day, `expense_estimate` 10/day,
  `packing_list` 5/day; `tour_guide` and `recap` are system-initiated
  (cap-exempt per R-ai-6) with structural caps instead —
  `TOUR_GUIDE_MAX_PLACES_PER_TRIP = 50` and one recap per trip. (Resolved
  2026-07-09, Gate 2)
- **R-ai-6 (usage accounting):** WHEN a model call completes (live) or a
  batch result is reconciled THE SYSTEM SHALL record it in `ai_usage` via a
  single upsert-increment on PK `(user_id, feature, day)` — `calls + 1`,
  `input_tokens`/`output_tokens` added (schema spec §3.3.18). Batch usage
  (tour guide, recap) is attributed to `trips.created_by` for accounting and
  is **cap-exempt** (structural caps in R-ai-5 apply instead); live features
  are cap-counted.
- **R-ai-7 (kill-switch):** WHEN month-to-date modeled spend (§3.5 cost
  math) ≥ `AI_KILL_SWITCH_CENTS` (10 000¢ = $100) THE SYSTEM SHALL reject
  every AI request with 503 `AI_DISABLED` and SHALL NOT submit new batch
  jobs. The kill-switch is **derived state** (computed from `ai_usage` ×
  pricing config, memoized ≤ 5 min per process) — no toggle table; it
  auto-releases at UTC month rollover or on config raise.
- **R-ai-8 (spend alert):** WHEN the daily spend job finds month-to-date
  spend ≥ `AI_SPEND_ALERT_CENTS` (5 000¢ = $50) THE SYSTEM SHALL emit an ops
  notification (job cadence = dedup; delivery mechanism is P-3 infra). All
  spend math SHALL be integer arithmetic on token counts × integer price
  config — no float money anywhere (Law #2, R-db-1).
- **R-ai-9 (cache-first):** WHEN a cacheable AI request arrives THE SYSTEM
  SHALL derive the cache key via the shared derivation —
  `sha256(feature ∥ destination ∥ travel_style ∥ season ∥ schema_version)`
  (schema spec R-db-10, contracts spec R-shared-8) — and on a hit return the
  cached payload with **no model call, no cap decrement, and no `ai_usage`
  row**; cache-hit traffic is subject only to generic rate limiting
  (`RATE_LIMITED`).
- **R-ai-10 (cache write):** WHEN a validated output is produced for a
  cacheable feature THE SYSTEM SHALL write it to `ai_cache` with the
  feature's TTL (§3.6) and no user or trip identifier (R-db-10 —
  user-anonymous, shareable).
- **R-ai-11 (structured outputs, validated):** WHEN any Claude call is made
  THE SYSTEM SHALL use structured outputs — `client.messages.parse()` with
  `zodOutputFormat` (from `@anthropic-ai/sdk/helpers/zod`) against the
  feature's `@gogo/shared` `ai/*` schema (which honors contracts spec §3.7:
  no recursion, no numeric range constraints, ≤ 3 nesting levels) — followed
  by the schema's paired server-side refiner. WHEN parsing or refinement
  fails THE SYSTEM SHALL retry once, then fail with 503 `AI_UPSTREAM`; an
  unvalidated payload SHALL never be persisted or returned.

### 2.2 Platform — anti-hallucination prompt rules (testable)

- **R-ai-12 (grounded-facts-only):** WHEN a generative prompt is built THE
  SYSTEM SHALL include a structured grounding block — facts with stable ids
  sourced ONLY from our places spine, Wikipedia/Wikivoyage extracts,
  `weather_cache`, and server-computed statistics — plus the external-
  knowledge restriction instruction ("use only the provided facts"). Venue-
  referencing outputs SHALL reference provided `place_id`s only; the output
  schemas make invented venues unrepresentable (contracts spec §3.7 rule 4),
  and the refiner SHALL drop any item whose `place_id` is not in the
  prompt's candidate set. Google Places content SHALL never appear in any
  prompt (ToS ban — maps-places research).
- **R-ai-13 (unknown-permitted):** WHEN a generative prompt is built THE
  SYSTEM SHALL include explicit permission to answer "unknown" or omit, and
  the output schemas SHALL keep fact-bearing fields optional/omittable
  (contracts spec §3.7 rule 5).
- **R-ai-14 (cite-or-retract):** WHEN an output claim carries a source
  reference THE SYSTEM SHALL verify it resolves to a source provided in the
  prompt, and SHALL drop (retract) any fact whose reference does not resolve
  — before persisting or returning (applies to `TourGuideBundle.facts[]` and
  any future sourced field).
- **R-ai-15 (volatile-facts-never-from-LLM):** THE SYSTEM SHALL NOT include
  volatile facts (opening hours, prices, ratings, open-now status, transit
  times, wait times) in any AI output schema, prompt grounding block, or
  cached/persisted AI payload; prompts SHALL forbid emitting them, and
  clients SHALL render volatile facts only from live data (Foursquare
  fetch-fresh, weather_cache, legs) at display time.
- **R-ai-16 (no-concise-instruction trap):** Prompt templates SHALL NOT
  contain brevity instructions ("be concise/brief/short", "in N words",
  "keep it short") — conciseness cuts hallucination resistance up to 20%
  (research §anti-hallucination #6). Generation runs full-length; trimming
  happens in post-processing or at display. Enforced by a lint test over all
  prompt templates against a banned-phrase list.
- **R-ai-17 (verification pass at pre-gen):** WHEN content is generated via
  the Batch API (tour guide, recap) THE SYSTEM SHALL include a
  Chain-of-Verification step (§3.9.3) before marking content ready —
  affordable in batch, per research §anti-hallucination #5.

### 2.3 Platform — disclosure & degradation

- **R-ai-18 (AI disclosure):** WHEN AI-generated content is displayed THE
  SYSTEM SHALL visibly label it as AI-generated (§3.11 conventions), show
  its generation time where staleness matters, and render source
  attributions for Wikipedia/Wikivoyage-derived content (CC BY-SA requires
  attribution — legal, not cosmetic).
- **R-ai-19 (graceful degradation):** WHEN an AI request fails for cap,
  kill-switch, or upstream reasons THE SYSTEM SHALL return the typed error
  (`AI_CAP_EXCEEDED` 429 / `AI_DISABLED` 503 / `AI_UPSTREAM` 503 — contracts
  spec §3.5) and the client SHALL degrade per §3.12 without blocking any
  non-AI feature; AI is additive, never load-bearing for core flows.

### 2.4 Recommendations

- **R-ai-20 (grounded candidates):** WHEN recommendations are generated THE
  SYSTEM SHALL select up to 20 candidate places from OUR spine near the
  trip's destination (§3.8.1 selection rule) and include them in-prompt as
  the complete universe of recommendable venues; the output is a ranked list
  of references to those candidates with annotations — never free-text venue
  names.
- **R-ai-21 (model + cache):** Recommendations SHALL use `claude-sonnet-5`,
  live, cached in `ai_cache` keyed by destination (R-ai-9); the cached
  payload is the full mixed-category set, filtered server-side per request.
- **R-ai-22 (saveable cards):** Each recommendation item SHALL be renderable
  as a card carrying the hydrated spine place (id, name, lat/lng, category)
  so "Save" creates a `saved_places` row via the places API with no extra
  lookup; saving is authz'd by that API (editor role), not this one.

### 2.5 Tour guide

- **R-ai-23 (batch pre-gen at T-3):** WHEN the tour-guide pre-gen trigger
  fires (§3.9.1: 3 days before trip start, or the manual "Prepare offline
  tour guide" action) THE SYSTEM SHALL enqueue one Anthropic Batch request
  (`claude-haiku-4-5`) per eligible place — the union of the trip's
  `saved_places` and itinerary `place_visit` places, up to
  `TOUR_GUIDE_MAX_PLACES_PER_TRIP` — creating `tour_guide_bundles` rows
  (`pending`, `batch_id` recorded) and skipping places whose bundle already
  exists (unique `(trip_id, place_id)`).
- **R-ai-24 (reconciliation):** WHILE any bundle is `pending` THE SYSTEM
  SHALL run a reconciliation job that polls the batch by `batch_id`, maps
  results by `custom_id`, validates + refines each `TourGuideBundle`
  (R-ai-11, R-ai-14), and flips rows to `ready` (content set) or `failed`;
  results arrive in any order and are keyed by `custom_id`, never position.
- **R-ai-25 (offline bundles):** WHEN a trip has `ready` bundles THE SYSTEM
  SHALL let members download them (§3.8.2) for storage in client SQLite
  keyed by `place_id`; on-tour bundle lookup SHALL be local-only (zero
  network). Bundle content is evergreen narrative only — volatile facts are
  forbidden in content (R-ai-15; schema spec §3.4.3).
- **R-ai-26 (foreground surfacing):** WHILE the tour screen is active
  (foreground-only location, locked in PLANNING) and the device is within
  `TOUR_GUIDE_TRIGGER_RADIUS_M` (config, default 75 m) of a place with a
  locally stored bundle THE SYSTEM SHALL surface that place's tour content,
  at most once per place per calendar day; no background location APIs are
  used in v1.

### 2.6 Packing lists

- **R-ai-27 (generation inputs):** WHEN a packing list is generated THE
  SYSTEM SHALL use `claude-haiku-4-5` with grounding inputs: destination
  name, trip duration (from dates; "unknown" when date-less), derived season
  (§3.6.2), the caller's `travel_style` (when set), and the `weather_cache`
  forecast for the destination WHEN available; WHEN weather is unavailable
  (no coords, provider down, trip beyond forecast horizon) THE SYSTEM SHALL
  generate without it rather than fail.
- **R-ai-28 (output, not persisted):** The endpoint SHALL return
  `PackingItem[]` (per schema spec §3.4.4, all `checked = false`,
  server-generated stable `id`s) without writing a `packing_lists` row;
  persistence flows through the packing-list CRUD (utilities spec) where the
  user reviews/edits, which sets `ai_generated = true` on save.

### 2.7 Trip recap

- **R-ai-29 (batch overnight post-trip):** WHEN a trip transitions to `past`
  (§3.10.1 trigger) THE SYSTEM SHALL enqueue one Batch request
  (`claude-sonnet-5`) generating the trip's recap exactly once per trip
  (idempotent on trip id), reconciled like R-ai-24.
- **R-ai-30 (grounded recap content):** The recap prompt SHALL contain only
  server-computed facts: trip stats (days, places visited, distance from
  `travel_legs`, spend totals from `expenses` in base currency — integer
  cents), the itinerary skeleton, and **aggregate, member-visible** photo
  metadata (counts per place/day). The LLM writes narrative over those facts
  only; it SHALL NOT receive photo image content, captions of non-`trip`/
  `public` photos, or any private-photo detail (Law #3).
- **R-ai-31 (deterministic album + trace):** Photo highlights SHALL be
  selected deterministically server-side (photo ids, §3.10.2) and the map
  trace computed from itinerary places — neither is LLM output. WHEN a recap
  is rendered THE SYSTEM SHALL filter highlight photos through
  `canViewPhoto` for the viewing member (Law #3; contracts spec §3.4
  `photo.ts`) — a member never sees another member's private photos in a
  recap.

---

## 3. Design

### 3.1 Architecture (locked pattern, research-verified)

```
Expo app ──HTTP──▶ Hono: auth → membership → kill-switch gate → entitlement+cap
                        → ai_cache check ──hit──▶ respond (no spend)
                        └─miss─▶ grounding fetch (spine / wiki / weather / stats)
                                → Claude (structured output) → Zod parse + refine
                                → ai_usage upsert → ai_cache write → respond

jobs: tour-guide pre-gen (Batch, on activation + daily sweep)
      recap generation (Batch, on trip → past)
      batch reconciliation (poll pending batch_ids)
      spend rollup: $50 alert / $100 kill-switch (pure SQL — no LLM)
      ai_cache eviction sweep (expires_at index)
```

No keys in the app — non-negotiable (R-ai-1). The Anthropic client is a
constructor-injected dependency of the AI service so tests substitute a mock
(R-ai-2, Law #7 evidence: the mock records exact prompts for the
anti-hallucination test suite).

### 3.2 Models & pricing config (`@gogo/shared` `config/ai-pricing.ts`)

Verified 2026-07-09 (claude-api skill + research; re-verify at P-3 via the
Models API — never from training data, R-shared-13):

| Feature | Model id | Mode | Cap treatment (ceilings resolved Gate 2) |
|---|---|---|---|
| `recommendations` | `claude-sonnet-5` | live, `ai_cache` | counted; 10/day ceiling |
| `expense_estimate` | `claude-haiku-4-5` | live, `ai_cache` | counted; 10/day ceiling (money spec owns endpoint) |
| `tour_guide` | `claude-haiku-4-5` | **Batch** at T-3 pre-gen (§3.9.1) | cap-exempt; structural cap 50 places/trip |
| `packing_list` | `claude-haiku-4-5` | live, **uncached** (§3.6.3, resolved Gate 2) | counted; 5/day ceiling |
| `recap` | `claude-sonnet-5` | **Batch** overnight post-trip | cap-exempt; once per trip |

Price constants are integers in **cents per million tokens**:
Haiku 4.5 = 100 in / 500 out; Sonnet 5 = 300 in / 1 500 out (standard
pricing deliberately, not the $2/$10 intro that expires 2026-08-31 — the
kill-switch budget math stays conservative and survives the intro's end).
Batch mode is 50% off; since feature→mode is static (table above), the cost
function applies the batch multiplier per feature — no batch flag column
needed in `ai_usage`.

### 3.3 Middleware chain (order is the contract)

1. **Auth** (`UNAUTHENTICATED` 401) → **trip membership** for trip-scoped
   routes (403/404 semantics per contracts spec §3.5, Law #3).
2. **Generic rate limit** (`RATE_LIMITED` 429) — applies to everything,
   including cache-hit traffic (R-ai-9).
3. **Kill-switch gate** (R-ai-7): month-to-date spend from `ai_usage(day)`
   rollup × pricing config, memoized ≤ 5 min → 503 `AI_DISABLED`.
4. **Entitlement + caps** (R-ai-3/4/5): resolve effective entitlements; read
   the caller's `ai_usage` rows for today; global 30/day then feature
   ceiling → 429 `AI_CAP_EXCEEDED` with `{ feature, cap, resets_at }`.
5. **Cache check** (R-ai-9) → hit short-circuits before any spend.
6. Handler: grounding → model → validate/refine → `ai_usage` upsert
   (R-ai-6) → cache write (R-ai-10) → respond.

Batch jobs run gates 3–4's equivalents at submission time: kill-switch gate
plus structural caps (bundle count per trip; one recap per trip). Cap-exempt
does not mean gate-exempt — a tripped kill-switch stops batch submission too.

**`capture_parse` and the cap** — Resolved at
`.specs/database/schema.spec.md`:§3.2 `ai_feature` (Gate 2, 2026-07-09):
capture parsing does NOT count against the user's 30/day AI cap; it has a
separate structural ceiling of 20 captures/day (capture spec enforces it).
The kill-switch requirement still means capture tokens are recorded in
`ai_usage` (the rollup is the only spend ledger), so `capture_parse` keeps
its enum value — cap-exempt, like `tour_guide`.

### 3.4 Typed errors (contracts spec §3.5 + one append)

| Condition | Status | `ErrorCode` |
|---|---|---|
| Daily/global or feature cap hit | 429 | `AI_CAP_EXCEEDED` |
| Kill-switch tripped | 503 | `AI_DISABLED` |
| Anthropic upstream failure / invalid output after retry | 503 | `AI_UPSTREAM` |
| Generic flood (incl. cache-hit hammering) | 429 | `RATE_LIMITED` |
| Trip lacks a resolvable destination for grounding | 400 | `VALIDATION_FAILED` |

`AI_UPSTREAM` (503) is a **new ErrorCode** — the enum is explicitly
append-only (contracts spec §3.5); this spec requires the one-line companion
addition there. Semantics: transient, retryable, "AI is busy" — distinct
from `AI_DISABLED` (policy stop, don't retry until notified).

### 3.5 Spend math & jobs (no float money, ever)

- `cost_microcents(feature, in_tokens, out_tokens)` = integer math over the
  §3.2 price table (`tokens × cents_per_mtok`, batch features halved),
  summed in `bigint` microcents, compared in cents rounded up. Cost is
  computed at read time from stored tokens — never stored as money (schema
  spec §3.3.18 note; survives price changes; Law #2 clean).
- **Kill-switch** is derived (R-ai-7): the middleware and the batch
  submitters compute month-to-date spend on demand (memoized). No state
  table, nothing to reset, restart-safe.
- **Daily spend job**: rolls up the month via the `ai_usage(day)` index; at
  ≥ $50 emits the ops alert (R-ai-8); logs the figure every run for
  observability. Pure SQL + arithmetic — not an LLM job (Law #5-compatible
  even in spirit).
- **Eviction sweep**: deletes `ai_cache` rows past `expires_at` (index
  exists for exactly this).

### 3.6 `ai_cache` usage

#### 3.6.1 Key derivation (shared, single implementation)

`deriveAiCacheKey(feature, destination, travelStyle, season, schemaVersion)`
per schema spec R-db-10 and contracts spec §3.7 rule 3 (SCHEMA_VERSION is a
key input so stale shapes never parse against new schemas — R-shared-8).
Segment pinning (deterministic + testable):

- `destination` = `lower(trim(trips.destination_name))` — display-string
  keyed; coords are used for candidate selection, not the key.
- `travel_style` = the caller's `UserPrefs.travel_style`, or the literal
  `"none"` when unset. Resolved at `.specs/shared/contracts.spec.md`:§3.4
  `user.ts` (Gate 2, 2026-07-09): multi-tag from the fixed set budget,
  comfort, luxury, foodie, adventure, culture, nightlife, family,
  relaxation — the key segment serializes the sorted tag list (canonical
  serialization pinned with the shared derivation).
- `season` — see §3.6.2.
- TTLs (config, research range 14–30d): `recommendations` 14d,
  `expense_estimate` 14d. (`packing_list` is live/uncached — §3.6.3,
  resolved Gate 2 — so it has no TTL row.)

Cache rows carry no user/trip id (R-db-10) — `travel_style` is a coarse
taxonomy value, not PII, which is what makes cross-user sharing legitimate.

**Locale** — Resolved at `.specs/database/schema.spec.md`:§3.3.19 (Gate 2,
2026-07-09): AI content is English-only v1; `locale` does NOT join the
cache key yet (it becomes a cache-buster key input if localization ever
ships). Prompts in this spec are written English-only.

#### 3.6.2 Season derivation (deterministic)

`season(destination_lat, start_date, end_date)`: meteorological season of
the trip midpoint month, hemisphere-flipped when `destination_lat < 0`;
`"unknown"` when dates are absent. Both upstream trips questions are
resolved at `.specs/database/schema.spec.md`:§3.3.4 (Gate 2, 2026-07-09):
trip dates are required at creation, and destination input is structured
(Overture-backed search; lat/lng always present) — so season and grounding
are guaranteed derivable for every trip created through the v1 flow. The
fallbacks stay as robustness only: null lat → northern hemisphere assumed;
null coords → recommendations and tour guide return 400
`VALIDATION_FAILED` ("set a destination on the map to enable AI features"),
packing proceeds name-only without weather (R-ai-27).

#### 3.6.3 Packing-list cache policy (resolved — Gate 2, 2026-07-09)

Decided: **live/uncached** (option a) — packing lists are personal and
cheap on Haiku (~$0.005/call); caching saves almost nothing at our scale
and duration has no slot in the canonical R-db-10 key formula, which stays
unamended. The contracts spec §3.7 table row annotating `packing-list.ts`
as `ai_cache` gets the one-line companion correction (that spec's owner is
applying it). (Resolved 2026-07-09, Gate 2)

### 3.7 Prompt construction (the anti-hallucination contract)

Every generative prompt is assembled from a versioned template plus a
grounding block; templates live in `apps/server/src/ai/prompts/` and are
unit-tested as data (Law #7 — the tests are the evidence):

1. **Grounding block** — a structured facts list, each fact with a stable id
   and source tag: spine rows (`place:<uuid>`), Wikipedia/Wikivoyage
   extracts (`wiki:<ref>`), weather (`weather:<cell>`), computed stats
   (`stat:<name>`). Only these sources exist (R-ai-12); Google Places never
   (ToS).
2. **Restriction clause** — "use only the facts provided above; do not use
   outside knowledge about specific venues, prices, or hours."
3. **Unknown permission** — "if the facts don't cover something, omit it or
   say unknown; an incomplete answer is correct, an invented one is wrong"
   (R-ai-13).
4. **Cite-or-retract instruction** where the schema carries source refs —
   every fact must name the id of a provided source (R-ai-14; the refiner
   enforces drop-on-unresolvable).
5. **Volatile-fact ban** — never state hours, prices, ratings, or "open
   now" (R-ai-15); schemas have no fields for them.
6. **No brevity instructions** anywhere in any template (R-ai-16); a lint
   test scans templates for the banned-phrase list.

Structured-output mechanics: `client.messages.parse()` +
`zodOutputFormat(schema)`; `parsed_output === null` is treated as a parse
failure (retry once → `AI_UPSTREAM`). Schemas obey contracts spec §3.7 (no
recursion, no numeric `.min()`/`.max()` — the SDK strips them — flat-ish
nesting); numeric/cross-field rules run in the paired server refiner after
parse. Zod major ↔ `zodOutputFormat` compatibility is pinned at P-3 via
`npm view` + Context7 (R-shared-13) — never assumed.

### 3.8 Endpoints

All endpoints inherit the middleware chain (§3.3) and the shared envelope
(success = schema body, errors = `ApiError`, contracts spec §3.5).

#### 3.8.1 POST `/trips/:trip_id/ai/recommendations`

Generate (or serve cached) destination recommendations as saveable cards.
**Auth**: Required — trip member (any role).

**Request** (body): `{ }` (reserved; no options v1).
Query: `?category=activity|restaurant|lodging` (optional filter — applied
server-side to the cached full set, so the cache key stays canonical).

**Candidate selection (the grounding spine, R-ai-20):** places from OUR
spine within `REC_CANDIDATE_RADIUS_KM` (config, default 30) of
`destination_lat/lng`, ranked by: `wiki_ref` present first (notability
proxy), per-category quotas (activities/food/lodging mix), then distance;
capped at 20. Fewer than 3 candidates → 200 with `items: []` and
`reason: "insufficient_places"` (degrade, don't hallucinate).

**Response 200**:

```
{
  items: Array<{
    place_id: Uuid,              // ∈ prompt candidate set — refiner-enforced
    place: Place,                // hydrated spine row (name, lat/lng, category)
    category: string,
    pitch: string,               // LLM annotation
    fit_reasons: string[]
  }>,                            // ranked
  generated_at: ISODateTime,
  model: string,
  cached: boolean
}
```

**Errors**: 401 `UNAUTHENTICATED` · 403/404 non-member (Law #3 semantics) ·
400 `VALIDATION_FAILED` (no destination coords) · 429
`AI_CAP_EXCEEDED`/`RATE_LIMITED` · 503 `AI_DISABLED`/`AI_UPSTREAM`.

**Requirements covered**: R-ai-3..5, 9..13, 15, 16, 18..22.

**Tests required**:
- [ ] Happy path: mocked model → ranked items, each `place_id` from the
      candidate set, hydrated `place` present, cache row written
- [ ] Cache hit: second call → no model invocation, no `ai_usage` row,
      `cached: true`
- [ ] Refiner drops items whose `place_id` ∉ candidates (invented venue
      unrepresentable end-to-end)
- [ ] Cap exhausted → 429 `AI_CAP_EXCEEDED` with `resets_at`; kill-switch →
      503 `AI_DISABLED`; parse failure ×2 → 503 `AI_UPSTREAM`
- [ ] Prompt snapshot: grounding block + restriction + unknown-permission
      present; no brevity phrases; no volatile-fact fields in schema
- [ ] Authz: non-member 404-indistinguishable; missing coords → 400

#### 3.8.2 GET `/trips/:trip_id/tour-guide/bundles`

Download manifest + content for the trip's tour-guide bundles (client stores
into SQLite for offline use, R-ai-25). **Auth**: Required — trip member.

**Request**: query `?status=ready|pending|failed` (default `ready`),
cursor pagination.

**Response 200**: `Paginated<{ id, trip_id, place_id, status,
content: TourGuideBundle | null, model, generated_at }>` — `content` per
schema spec §3.4.3 (`facts[].source_ref` → `sources[]`, cite-or-retract
shape).

**Errors**: 401 · 403/404 non-member. (No AI gates — this reads persisted
rows; generation already paid.)

**Requirements covered**: R-ai-23..25, 18 (sources rendered with
attribution).

**Tests required**:
- [ ] Happy path: ready bundles paginate with content; pending/failed
      filterable
- [ ] Every fact's `source_ref` resolves into `sources[]` (round-trip
      invariant on stored content)
- [ ] Authz: non-member 404

#### 3.8.3 POST `/trips/:trip_id/ai/packing-list`

Generate packing items for review — does not persist (R-ai-28).
**Auth**: Required — trip member.

**Request** (body): `{ }` (inputs derived server-side from the trip +
caller prefs + weather_cache, R-ai-27).

**Response 200**: `{ items: PackingItem[], generated_at: ISODateTime,
model: string, weather_used: boolean }` — items per schema spec §3.4.4,
`checked: false`, stable ids server-generated.

**Errors**: 401 · 403/404 · 429 `AI_CAP_EXCEEDED`/`RATE_LIMITED` · 503
`AI_DISABLED`/`AI_UPSTREAM`. (No 400 for missing coords — name-only
generation is allowed; `weather_used: false` signals the degrade.)

**Requirements covered**: R-ai-3..5, 11, 13, 15, 16, 18, 19, 27, 28.

**Tests required**:
- [ ] Happy path with weather present (`weather_used: true`) and absent
      (generation still succeeds, `weather_used: false`)
- [ ] Date-less trip → duration/season "unknown" path generates
- [ ] Output schema: no `checked: true`, ids unique/stable, refiner-clean
- [ ] Caps/kill-switch/upstream typed errors as in 3.8.1
- [ ] Nothing written to `packing_lists` by this endpoint

Persistence UX target — Resolved at
`.specs/database/schema.spec.md`:§3.3.21 (Gate 2, 2026-07-09): one shared
packing list per trip in v1 (simplest useful; uniqueness `unique(trip_id)`).

#### 3.8.4 GET `/trips/:trip_id/recap`

Fetch the trip's recap. **Auth**: Required — trip member.

**Response 200**: `{ status: 'pending' | 'ready' | 'failed',
content: Recap | null, generated_at: ISODateTime | null }` where `Recap` =
`{ narrative_sections: Array<{ title, body }>, stats: { days, places_count,
distance_meters, spend_total_cents, currency, photos_count },
highlight_photo_ids: Uuid[], trace: Array<{ place_id, lat, lng, day }> }`
(shape finalized in `@gogo/shared` `ai/recap.ts` with its own
`SCHEMA_VERSION`). `highlight_photo_ids` are filtered through `canViewPhoto`
per viewer at render (R-ai-31). 404 when the trip is not `past` / no recap
row exists.

**Errors**: 401 · 403/404 non-member · 404 no recap.

**Requirements covered**: R-ai-29..31, 18.

**Tests required**:
- [ ] Ready recap returns content; pending returns status without content
- [ ] Viewer-filtering truth table: member A's private photo id never
      renders for member B (Law #3)
- [ ] `spend_total_cents` integer, matches expenses rollup exactly (Law #2)
- [ ] Authz: non-member 404

### 3.9 Tour-guide pipeline (job side)

#### 3.9.1 Activation trigger

Eligible places = union of `saved_places.place_id` and itinerary
`place_visit.place_id`, capped (R-ai-23). Bundles are generated per
trip+place at the **T-3 trigger** (below), plus a **daily incremental
sweep** over `active` trips that batches any eligible place still missing
a bundle (covers places saved mid-trip; idempotent via the
`(trip_id, place_id)` unique). Note: schema spec §3.3.20's prose says "at
trip creation" — superseded here deliberately: at creation a trip has no
saved/itinerary places to generate for.

**Trigger timing — decided: T-3 days before `start_date`** (batch latency
≤ 24 h plus a home-wifi download window), **plus a manual "Prepare offline
tour guide" button** as the explicit fallback/early path. (Resolved
2026-07-09, Gate 2)

The dependent trips question — Resolved at
`.specs/database/schema.spec.md`:§3.3.4 `trips.status` (Gate 2,
2026-07-09): status is date-derived with manual owner override allowed
(override wins until cleared) — the T-3 trigger keys off `start_date`
directly, so it is independent of override state.

#### 3.9.2 Batch mechanics

One batch per trigger event (up to the cap's worth of requests), submitted
via the Message Batches API (50% off, async, ≤ 24 h, results retained 29
days). `custom_id` convention: `tg:{trip_id}:{place_id}` (recap:
`recap:{trip_id}`) — reconciliation maps by `custom_id` only. `batch_id` is
stored on each pending row; the reconciliation job (every 15 min while
pendings exist — uses the partial index) polls, validates, refines, flips
`ready`/`failed`. Kill-switch gate runs at submission (§3.3).

#### 3.9.3 Grounding + verification per place

Facts assembled server-side at submission: spine row fields (name,
category, coords) + Wikipedia/Wikivoyage extract when `wiki_ref` is set
(authenticated Wikimedia requests — anonymous is limited to 10 req/min;
CC BY-SA attribution captured into `sources[]`). No `wiki_ref` → generate
from spine facts alone with unknown-permission doing the work (a thin but
honest bundle beats an invented one). The Chain-of-Verification pass
(R-ai-17) rides the same batch: the generation request's output is checked
by a second batched request that receives the draft + the same facts and
returns per-fact verdicts; facts failing verification are dropped by the
refiner before `ready` (cite-or-retract, mechanically enforced).

#### 3.9.4 Client offline + surfacing (mobile contract)

Download over wifi post-activation into expo-sqlite keyed by `place_id`
(R-ai-25); the offline-trip bundle (PLANNING cross-cutting) includes tour
content. Surfacing (R-ai-26): `watchPositionAsync` with balanced accuracy +
`distanceInterval` while the tour screen is foregrounded; entering the
radius of a bundled place surfaces its card from SQLite (zero network);
dedup = one surface per place per calendar day, stored locally. Background
geofencing is explicitly out (v1 lock).

### 3.10 Recap pipeline (job side)

#### 3.10.1 Trigger + persistence

Enqueued when a trip transitions to `past` (date-derived, manual override
honored — schema spec §3.3.4, resolved Gate 2), overnight batch, exactly
once per trip. Recap persistence — Resolved at
`.specs/database/schema.spec.md`:§3.7 (Gate 2, 2026-07-09): the new
`recaps` table is APPROVED (entity-list addition; the schema spec is
folding it in). It mirrors `tour_guide_bundles` — trip-scoped, status +
jsonb content + `batch_id` — exactly the shape this spec's endpoint
(§3.8.4) and EARS were written against.

#### 3.10.2 Content assembly (what the LLM does and doesn't do)

Server computes: stats (integer cents for money), map trace (ordered
itinerary places), highlight photo ids (deterministic heuristic: spread
across days/places, prefer photos pinned to places, member-visible set
only). LLM (Sonnet 5, batch, CoVe pass per R-ai-17) writes
`narrative_sections` from the computed-facts grounding block only (R-ai-30).
Photos added after generation don't retroactively update the recap (v1;
regeneration is out of scope §3.13).

### 3.11 AI-content UX disclosure conventions

Semantic requirements (visual treatment belongs to the design-system spec):

1. **Label**: every AI-generated surface (recommendation cards, tour
   content, generated packing items, recap narrative) carries a persistent
   "AI-generated" indicator; it never masquerades as editorial or factual
   database content.
2. **Attribution**: tour content renders its `sources[]` (Wikipedia/
   Wikivoyage links + license notice) — CC BY-SA obligation, not optional.
3. **Freshness**: `generated_at` shown where staleness misleads
   (recommendations "Generated N days ago"; recap is inherently historical).
4. **Volatile-fact handoff**: any hours/price/rating shown near AI content
   comes from the live data path and is visually attributed to it (e.g.
   Foursquare fetch-fresh details) — never presented as part of the AI text
   (R-ai-15).
5. **Editability signal**: AI-seeded packing lists show their origin until
   first user edit (`ai_generated` flag semantics, schema spec §3.3.21).

### 3.12 Degradation matrix (kill-switch / caps / upstream)

| Surface | On `AI_CAP_EXCEEDED` | On `AI_DISABLED` / `AI_UPSTREAM` |
|---|---|---|
| Recommendations | "Daily AI limit reached — resets at {t}"; browse/search places normally | "AI suggestions unavailable right now"; browse/search unaffected |
| Tour guide | n/a (pre-generated; cap-exempt) | Existing downloaded bundles keep working offline; only new generation pauses |
| Packing | Manual list creation unaffected; generate button disabled with reason | Same |
| Recap | n/a (system-initiated) | Recap shows `pending`; album/photos view unaffected |
| Expense estimate | Budget entry unaffected; estimate chip hidden with reason | Same |

Clients branch on `error.code` (never message text). Core flows (trips,
itinerary, bookings, money, photos) have zero AI dependencies (R-ai-19).

### 3.13 Out of scope (explicit)

- `expense_estimate` endpoint contract — budgets/money spec (platform rules
  here still bind it).
- Capture LLM fallback contract — capture spec (ditto; cap-exempt with its
  own 20/day ceiling, resolved Gate 2 — §3.3).
- Packing-list CRUD/persistence — utilities spec (this spec only generates).
- Recap regeneration / re-run after new photos; recap sharing/export outside
  the trip.
- Voice/audio tour guide (research flags Google TTS bans; our stack is
  unaffected but audio is a later phase).
- Prompt-cache (Anthropic-side) optimization — a non-lever at our prompt
  sizes (< 4 096-token min prefix; research).
- Gemini Flash-Lite benchmark hedge — optional research escalation, not v1.
- Weather provider selection — build-phase escalation (schema spec §3.7);
  this spec consumes `weather_cache` provider-agnostically.
- Ops alert delivery mechanism (email/push target) — P-3 infra.
- Exact package versions / SDK pinning — P-3 scaffold (R-shared-13).

---

## 4. Tasks

Each sized to one agent session; queued as `T-N.M` rows at build time.
**Depends on:** DB-1 (schema) + SH-1 (shared contracts) landed.

### AI-1 — Platform: middleware chain, accounting, spend controls

**Covers:** R-ai-1..11, R-ai-19 (server half).

- [ ] Injected Anthropic client wrapper (live + batch + mock); key custody
      per §1.1
- [ ] Middleware chain §3.3 (kill-switch gate, entitlement + caps, cache)
- [ ] `ai_usage` upsert-increment; `cost_microcents` integer math;
      spend rollup job ($50 alert / $100 hard gate); eviction sweep
- [ ] `AI_UPSTREAM` ErrorCode companion addition to contracts spec §3.5

**Tests required:**
- [ ] Cap boundary: 29th call passes, 30th → `AI_CAP_EXCEEDED`; feature
      ceiling independent of global; cap-exempt features bypass user cap but
      write usage
- [ ] Kill-switch: spend fixture ≥ $100 → every endpoint 503 + batch
      submission refused; < $100 after month rollover → open again
- [ ] Cost math: token fixtures × price table = expected cents, zero floats
      (assert integer types end-to-end); batch features half-priced
- [ ] Cache hit: no model call, no usage row, no cap decrement
- [ ] Mobile workspace dependency scan: no Anthropic SDK/key (R-ai-1); CI
      env asserts no `ANTHROPIC_API_KEY` (R-ai-2)

### AI-2 — Prompt template system + anti-hallucination test suite

**Covers:** R-ai-12..17 (platform-wide), feeds every feature task.

- [ ] Template registry (versioned) + grounding-block builder (facts with
      ids/source tags)
- [ ] Refiner framework: candidate-set enforcement, cite-or-retract drop,
      volatile-field walker
- [ ] Template lint: banned brevity phrases; restriction + unknown clauses
      present in every generative template

**Tests required:**
- [ ] Snapshot every template: grounding block, restriction clause, unknown
      permission, no brevity phrases
- [ ] Refiner: unresolvable `source_ref` dropped; unknown `place_id`
      dropped; schema walker finds zero volatile-fact fields across `ai/*`

### AI-3 — Recommendations endpoint

**Covers:** R-ai-20..22 + §3.8.1. Checklist + tests = §3.8.1 list, plus
candidate-selection unit tests (radius, wiki_ref preference, quotas, cap 20,
`insufficient_places` degrade).

### AI-4 — Tour-guide pre-gen + reconciliation + bundles endpoint

**Covers:** R-ai-23..25 + §3.8.2, §3.9.1–3.9.3.

- [ ] T-3 trigger + manual "Prepare offline" action + daily incremental
      sweep (idempotent); structural cap; CoVe verification pass;
      reconciliation job (`custom_id` mapping, any-order results); bundles
      endpoint

**Tests required:** §3.8.2 list, plus: duplicate-place idempotency; failed
batch item → `failed` row (never silent); kill-switch blocks submission;
wiki-less place produces spine-only bundle (no invented facts).

### AI-5 — Tour-guide client offline + surfacing (mobile)

**Covers:** R-ai-25 (client half), R-ai-26 + §3.9.4.

**Tests required:** SQLite round-trip by `place_id`; airplane-mode lookup
works; radius trigger fires once per place per day; nothing triggers with
tour screen backgrounded (foreground-only lock).

### AI-6 — Packing-list endpoint

**Covers:** R-ai-27, R-ai-28 + §3.8.3 (checklist + tests = §3.8.3 list).
Live/uncached (§3.6.3, resolved Gate 2) — no cache branch to build.

### AI-7 — Recap job + endpoint

**Covers:** R-ai-29..31 + §3.8.4, §3.10. Storage shape resolved Gate 2:
the approved `recaps` table (§3.10.1), mirroring `tour_guide_bundles`.

**Tests required:** §3.8.4 list, plus: trigger idempotency (one recap per
trip); prompt snapshot contains only computed facts (no photo content, no
private-photo metadata — Law #3 fixture with mixed-visibility photos);
highlight selection deterministic (same inputs → same ids).

---

*Trace: every R-ai-N cites its design section inline; §3.8 endpoints list
covered requirements. All 11 markers resolved at Gate 2 (2026-07-09): owned
here — per-feature ceilings (approved as proposed, §2.1), tour-guide
trigger (T-3 days + manual button, §3.9.1), packing cache policy
(live/uncached, §3.6.3); repeated — travel_style (fixed multi-tag set),
recap persistence (`recaps` table approved), capture_parse (cap-exempt,
20/day ceiling), locale (English-only v1), trip dates (required),
destination input (structured), status transitions (derived + override),
packing-list ownership (shared per trip) — each resolved at its cited home.
Zero markers remain.*
