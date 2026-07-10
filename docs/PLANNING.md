# GoGo Travel — Planning Document

> Source of truth for architecture, design decisions, and the long-arc roadmap.
> Living spec, not a snapshot.
>
> **Naming convention:** stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) + canonical
> doc homes. See [ADR-001](decisions/ADR-001-naming-convention.md) and
> `.claude/rules/planning-doc-homes.md`.

---

## How to use this doc

| Doc | Purpose | When to read |
|-----|---------|--------------|
| `docs/PLANNING.md` (this file) | Architecture, design, full phase roadmap | Planning a phase, onboarding |
| `docs/QUEUE.md` | What's in flight RIGHT NOW | Every session start |
| `docs/STATE.md` | Active context, in-flight decisions, failed approaches | Every session start (auto-injected) |
| `docs/SECURITY.md` | Security findings + fix order | Security work |
| `docs/decisions/` | Locked decisions (append-only ADRs) | "Why did we do X?" |
| `docs/history/` | Completed-phase archives (append-only) | Post-mortems |
| `docs/SESSION-GUIDE.md` | Human operator playbook | Session start/end |
| `.specs/<area>/<name>.spec.md` | Feature/impl specs — the build contracts | Before building the thing |

---

## Overview

### What

**GoGo Travel** — a mobile travel app that holds a user's trips and covers the
full arc: plan it, book it, budget it, live it, remember it. Sean's brief,
verbatim scope:

**Core features (committed):**
- **Trips** — a user holds multiple trip plans; everything below is per-trip
- **Itinerary / calendar** — customizable calendar interface; day + range views
- **Bookings by category** — Stay (lodging); Travel (flights, trains, car/moped
  rentals); Activities/events
- **Maps** — save locations with times, estimated travel times between stops,
  clickable locations opening detail views
- **Budgeting** — per-trip budget interface with AI-powered expense estimation
  (food, transport, etc.)
- **AI recommendations** — suggested activities/food/lodging in destination
- **AI tour guide** — trivia / info on places being visited
- **Expense splitting** — Splitwise-style; send friends bills; Venmo/Zelle
  integrations or at minimum payment links on profile
- **Profiles** — customizable user profile (avatar, payment links, preferences)
- **Booking integrations / deeplinks** — minimize manual entry, maximize detail
  capture for all booking types
- **Photos / albums** — uploads pinned to map + itinerary; see pictures by place;
  private/public visibility so others planning the same destination can see
  experiences/reviews
- **Design system** — thoughtful, minimalistic, customizable (re-skinnable
  themes à la bartling-bachelor's ThemeProvider)

**Extras — APPROVED by Sean 2026-07-09, all four bundles committed:**
- Packing lists (AI-generated from destination/weather/duration)
- Weather forecast integrated into itinerary days
- Travel-document vault (passport/visa/insurance reminders + expiry alerts)
- Offline mode for the active trip (itinerary + maps + bookings cached)
- Collaborative trip planning (invite co-travelers, shared editing, votes on
  proposals — bartling had votes; proven pattern)
- Live-trip "today" view — a running home screen during the trip (next event,
  directions, countdowns)
- Flight status / delay notifications
- Currency converter + spend-in-local-currency logging
- Post-trip recap generator (album + stats + map trace)

### Why

Trip planning is scattered across booking sites, spreadsheets, group chats,
maps apps, and Splitwise. One app that holds the whole trip — and stays useful
DURING the trip — is the gap.

### Success metrics

- [ ] Sean plans and takes a real trip using only this app
- [ ] A full trip (lodging + transport + 10 activities) enterable in < 15 min
      via deeplinks/integrations
- [ ] Expense splitting round-trips a real group without a spreadsheet

---

## Architecture

**Stack locked — [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md).**

```
┌───────────────────────┐        ┌──────────────────────┐      ┌──────────────┐
│  apps/mobile          │  HTTP  │  apps/server         │      │  Postgres    │
│  Expo / React Native  │───────▶│  Hono + zod-validator│─────▶│  (Neon)      │
│  expo-router · TQ ·   │        │  Drizzle ORM         │      │              │
│  Zustand · tokens     │        │  auth · jobs         │      └──────────────┘
└──────────┬────────────┘        └──────────┬───────────┘
           │      shared contract           │
           └────────▶ packages/shared ◀─────┘
                     (@gogo/shared — Zod schemas, z.infer types)
```

- iOS first (simulator-driven dev), Android verification pass pre-launch.
- Styling: `StyleSheet` + design-token package; re-skinnable themes.

### Provider decisions (locked by S-2 research, 2026-07-09)

| Concern | Choice | Why (evidence: `.specs/research/`) |
|---------|--------|-----------------------------------|
| Map SDK | **@rnmapbox/maps** | Only real offline (tile packs, $0 extra); 25k MAU free; Google ToS bans its content on non-Google maps |
| Directions | Mapbox Directions (drive/walk/cycle) + Transitous (transit, degradable) | 100k free req/mo; Google Routes contractually unusable with Mapbox |
| Places spine | Overture / FSQ OS open data → **our Postgres** | Legally storable forever, LLM-safe (Apache 2.0/CDLA); Google Places bans storage + AI use |
| Place rich details | Foursquare hosted API (fetch-fresh, zero caching) | Only if premium fields warranted; ~$0–60/mo |
| AI | Claude server-side (Haiku 4.5 default, Sonnet 5 for recs/recaps), Batch API for pre-gen | Structured outputs w/ Zod; grounded in our POI spine + Wikipedia — never invent venues |
| AI policy | 30 calls/user/day, $50 alert / $100 kill-switch, entitlement-checked | Approved by Sean 2026-07-09 |
| Booking capture | Share-sheet (expo-share-intent) + permanent forward address (CloudMailin→Hono webhook); schema.org JSON-LD first, LLM fallback; needs-review queue | Approved; skip OAuth inbox (CASA tax) |
| Booking deeplinks | Kayak/Skyscanner (flights), Airbnb/Booking/Expedia/Vrbo (lodging), Trainline/Omio (trains), Kayak/Turo (cars); Viator + Ticketmaster APIs day one | All zero-approval; formats in research |
| Settle-up | Own ledger (record-only) + per-user payment handles + deeplink handoff (Venmo/CashApp/PayPal links, Zelle copy) | Splitwise ToS bans competitors; formats live-probed |
| Location | Foreground-only v1 (no background geofencing) | Approved; App Store friction avoided |

### Component map

```
apps/mobile (Expo, expo-router)
├── (auth)            sign-in (Apple + Google), onboarding
├── (trips)           trip list, create/join
└── [tripId]/         trip context
    ├── today         live-trip surface (auto-default while trip active)
    ├── itinerary     plan surface: day list + calendar-grid view
    ├── map           saved places, itinerary pins, photo pins, offline packs
    ├── money         budget, expenses, splits, settle-up
    └── more          photos, packing, docs vault, members, trip settings

apps/server (Hono)
routers: auth · trips · members/invites · itinerary · bookings · capture
         (email webhook + share parse) · places · expenses · settlements ·
         photos · ai · notifications · entitlements
jobs:    tour-guide pre-gen (Batch) · recap generation · leg-ETA refresh ·
         AI usage rollup/kill-switch · document expiry reminders

packages/shared   @gogo/shared — Zod schemas per domain (single source of truth)
packages/tokens   design tokens + theme definitions (re-skinnable)
```

### Data model (entity level — column-exact spec lands in `.specs/database/`)

**Identity & access:** `users` (profile, prefs, payment handles: venmo/cashtag/
paypalme/zelle+name) · `entitlements` (per-user plan + caps; ADR-005) ·
`push_tokens`.

**Trips & collab:** `trips` (name, destination, dates, status
planning/active/past, theme) · `trip_members` (role: owner/editor/viewer) ·
`invites` (token, role, expiry).

**Places:** `places` (source: overture/fsq_os/custom + source_id, name,
lat/lng, category, wiki_ref — our open-data spine, LLM-safe) ·
`saved_places` (trip_id, place_id, note).

**Itinerary & bookings:** `bookings` (category: lodging/flight/train/
car_rental/moped_rental/activity/restaurant/other; status: idea/planned/
booked; per-category `details` JSONB; price_cents; confirmation; source:
manual/email/share/deeplink_return) · `itinerary_items` (everything on the
calendar: booking-ref | place-visit | custom; day, start/end, order) ·
`travel_legs` (from→to item, mode, duration, distance — precomputed at sync
for offline ETAs).

**Money:** `expenses` (paid_by, amount_cents, currency, booking_id?) ·
`expense_shares` (per-member share_cents) · `settlements` (from→to,
amount_cents, method: venmo/cashapp/paypal/zelle/cash, recorded-only) ·
`budgets` (category caps + AI estimate). **All money integer cents; expense +
shares written atomically (transaction-capable driver only).**

**Capture:** `capture_inbox` (source: email/share, raw ref, parse_status:
pending/parsed/needs_review/failed, parsed JSONB) — the visible review queue.

**Photos & memories:** `photos` (storage key, taken_at, lat/lng?, place_id?,
itinerary_item_id?, **visibility: private/trip/public — default private, Law
#3**, blurhash) · recaps generated post-trip (Batch).

**AI:** `ai_usage` (per user/feature/day — caps + kill-switch) · `ai_cache`
(destination-keyed responses, 14–30d TTL) · `tour_guide_bundles` (per
trip+place, offline-downloadable).

**Utilities:** `packing_lists` · `documents` (vault: kind, expiry, reminder) ·
`weather_cache`.

### Cross-cutting patterns

- **Offline:** TanStack Query persist + MMKV/SQLite mutation queue (the-bach
  pattern); active trip bundle = itinerary + bookings + saved places + tour
  content + leg ETAs in SQLite; Mapbox tile pack per trip. Volatile data
  (hours, transit ETAs) online-only, degrade gracefully.
- **Collab sync v1:** REST + optimistic updates, refetch-on-focus,
  push-notification invalidation. No sockets in v1 (last-write-wins is fine
  for small groups); event-log seam kept so realtime can land later.
- **Auth (LOCKED at Gate 1, 2026-07-09):** Sign in with Apple + Google via
  Expo AuthSession; `jose` JWTs (short-lived access + refresh rotation).
  Apple sign-in is App-Store-mandatory once any social login exists. Passkeys
  later as a non-breaking enhancement. Zero passwords stored.
- **Capture pipeline:** webhook/share → `capture_inbox` → schema.org JSON-LD
  parse → LLM fallback (Haiku, structured output) → proposed booking →
  user confirms/edits → lands in trip. Failures visible, never silent.

---

## Security

- Threat model written in P-2 alongside the data model (auth, IDOR on trip
  resources, photo privacy boundaries, payment-link injection, location privacy).
- Findings tracked in `docs/SECURITY.md`.
- Sensitive paths (auto-escalate review): auth, payments/splitting, photo
  privacy/visibility, migrations, release workflows.

---

## Phase Roadmap

> Status enum locked by [ADR-002](decisions/ADR-002-status-enum-lock.md).
> **P-3..P-14 FROZEN 2026-07-09 (T-2.4)** — derived from the approved spec
> suite's task dependencies; the former provisional P-3..P-10 rows are
> replaced (they were placeholders, never locked). Verification ledger:
> `feature-ledger.json` (F-001..F-118, append-only — Law #8). Each phase =
> 2–6 reviewable PRs (ADR-001 sizing); spec task IDs (SH/DB/DS/NAV/AU/…) map
> to `T-N.M` rows in the Phase Detail blocks below.

| ID | Type | Title | Status | Priority | Depends on |
|----|------|-------|--------|----------|------------|
| P-1 | Phase | Workflow foundation (port machinery, CLAUDE.md, docs, ADRs 1-3, stack decision) | in-progress | P0 | — |
| P-2 | Phase | Research + upfront spec suite (product research, architecture, data model, per-feature specs, feature ledger, phase plan) | in-progress | P0 | P-1 |
| P-3 | Phase | Foundations: monorepo scaffold + `@gogo/shared` + DB schema | queued | P0 | P-2 |
| P-4 | Phase | Design system + navigation skeleton | queued | P0 | P-3 |
| P-5 | Phase | Auth, profiles & entitlements | queued | P0 | P-3, P-4 |
| P-6 | Phase | Trips, collaboration & places spine | queued | P0 | P-5 |
| P-7 | Phase | Itinerary & bookings (incl. deeplink-out) | queued | P0 | P-6 |
| P-8 | Phase | Maps, saved places & offline tile packs | queued | P0 | P-7 |
| P-9 | Phase | Money: budgets, expenses, splits & settle-up | queued | P0 | P-7 |
| P-10 | Phase | AI layer: platform, recommendations, estimates, tour guide, packing, recap | queued | P1 | P-8, P-9 |
| P-11 | Phase | Booking capture: email + share pipeline | queued | P1 | P-7, P-10 |
| P-12 | Phase | Photos & memories | queued | P1 | P-8 |
| P-13 | Phase | Today view, offline sync, notifications & utilities | queued | P1 | P-9, P-10, P-12 |
| P-14 | Phase | Launch readiness: device tests, Android pass, EAS, App Store | queued | P1 | P-13 |

---

## Phase Detail

### P-1 — Workflow foundation

- **Status:** in-progress · **Priority:** P0
- **Goal:** A fully-armed autonomous dev harness: ported machinery, CLAUDE.md
  constitution, planning docs, local review pipeline, autonomous loop — plus the
  stack decision (ADR-004) so P-2 can spec against a real target.
- **Acceptance criteria:**
  - [x] Machinery ported + rebranded (`GOGO-*` markers)
  - [x] CLAUDE.md + docs + ADR-003 authored
  - [ ] Aggregator tests green (`node --test .github/scripts/`)
  - [ ] Pushed to `origin/main`
  - [x] ADR-004 (stack) locked with Sean's buy-in — Expo/RN + Hono/Drizzle/
        Postgres, iOS-first, all four extras bundles committed
  - [x] Stack-specific bits pinned (T-1.4: CI gate command, engineer personas;
        path-scoped rules + formatter hook land with the P-3 scaffold)
- **Tasks:** T-1.1 port · T-1.2 author · T-1.3 commit/push · T-1.4 pin
  stack-specifics · S-1 stack spike
- **Linked ADRs:** ADR-001, ADR-002, ADR-003, ADR-004 (pending)

### P-2 — Research + upfront spec suite

- **Status:** queued · **Priority:** P0
- **Goal:** Specs complete enough to "one-shot" the build with minimal ambiguity.
  Front-load ALL the human-in-the-loop: interview Sean until zero
  `[NEEDS CLARIFICATION]` markers remain, then the build phases run autonomously.
- **Deliverables:**
  - S-2 research: competitor teardown, booking-deeplink landscape (flights /
    lodging / rentals / trains), maps SDK comparison, Splitwise/Venmo/Zelle
    integration reality-check, AI provider plan
  - Architecture + data model + API contract (this doc's Architecture section)
  - Per-feature specs in `.specs/<area>/` — three artifacts each:
    `requirements` (EARS acceptance criteria: "WHEN <condition> THE SYSTEM
    SHALL <behavior>"), `design`, `tasks` (traceable to requirement IDs)
  - `feature-ledger.json` — machine-checkable verification ledger (per feature:
    verification steps + `passes: false`). **Tamper rule: booleans flip only
    after verified testing; removing/editing entries is forbidden.**
  - Frozen phase roadmap (replaces the provisional P-3+ rows above)
  - Threat model + SECURITY.md seed
- **Approval gates (Sean):** feature set → architecture/data model → phase plan.
  Each gate is a real stop; after the last one, autonomy is the default.
- **Linked spikes:** S-1 (stack), S-2 (product research)

### P-3 — Foundations: scaffold, shared contracts, schema

- **Status:** queued · **Priority:** P0 · **Depends on:** P-2 · **~3–4 PRs**
- **Goal:** The skeleton everything builds in: pnpm + Turborepo monorepo
  (`apps/mobile` Expo dev build, `apps/server` Hono, TS strict everywhere),
  `@gogo/shared` as the single source of truth, and the column-exact Postgres
  schema with its baseline migration + constraint suite. Every version pinned
  via `npm view` + `npx expo-doctor` — never training data (R-shared-13).
- **Acceptance criteria:**
  - [ ] CI gate live and green at the root: `pnpm lint && pnpm typecheck &&
        pnpm test && pnpm build`
  - [ ] SH-1 checklist complete (enums, scalars, envelope, descriptors,
        16 domain modules, `ai/*` schemas + refiners) — all tests green
  - [ ] DB-1 checklist complete — initial migration applies to a blank
        Postgres; constraint/invariant suite green (money-law scan included)
  - [ ] Ledger F-001..F-009 verified with pasted evidence (Law #7)
- **Tasks:** T-3.1 monorepo scaffold + pinned versions + path-scoped rules /
  formatter hook (P-1 leftover) · T-3.2 `@gogo/shared` scaffold [SH-1] ·
  T-3.3 schema + initial migration + constraint suite [DB-1] · T-3.4 CI
  pipeline + `postgres-js` test harness
- **Escalations to batch at phase start (Autonomy Contract #3):**
  object-storage provider (S3/R2), Neon project setup, Mapbox account.
- **Linked specs:** `shared/contracts`, `database/schema`
- **Ledger:** F-001..F-009

### P-4 — Design system & navigation skeleton

- **Status:** queued · **Priority:** P0 · **Depends on:** P-3 · **~5–6 PRs**
- **Goal:** Every pixel's source: `@gogo/tokens` (ramps, scales, semantic
  mapping, 3 accent themes), the mobile theme runtime, the core component
  library + dev Gallery, and the full expo-router tree with per-tab stacks,
  modal conventions, and testID discipline — so every later screen lands on
  rails.
- **Acceptance criteria:**
  - [ ] Contrast matrix green for every scheme × accent pair (R-ds-8)
  - [ ] Gallery renders every component × variant × scheme × accent in the
        simulator (the Law #7 visual evidence surface)
  - [ ] Full route tree mounts placeholder screens; per-tab stacks hold
  - [ ] Lint enforcement live: literal colors, bare StyleSheet, and missing
        testIDs all fail CI
  - [ ] Ledger F-010..F-017 verified
- **Tasks:** T-4.1 tokens package + contrast matrix [DS-1, DS-2] · T-4.2
  theme runtime + createStyles/lint [DS-3, DS-4] · T-4.3 Text primitive +
  haptics [DS-5, DS-6] · T-4.4 components batch 1–2 [DS-7, DS-8] · T-4.5
  components batch 3 + Gallery [DS-9, DS-10] · T-4.6 route skeleton + testID
  tooling [NAV-1, NAV-7]
- **Note:** palette pick (Gate-2 item A1) still Sean's — placeholder ramps
  ship; the swap is pure data (R-ds-5), zero code churn.
- **Linked specs:** `design-system/tokens`, `client/navigation`
- **Ledger:** F-010..F-017

### P-5 — Auth, profiles & entitlements

- **Status:** queued · **Priority:** P0 · **Depends on:** P-3, P-4 ·
  **~6 PRs** · **Sensitive path: auth — auto-escalated review**
- **Goal:** Sign in with Apple + Google end-to-end: JWKS verification, ES256
  access + rotating refresh tokens with theft response, the middleware trio
  every other domain runs under (`requireAuth`, `requireTripMember`,
  `requireAiQuota`), profile/avatar/payment-handles/push-token endpoints,
  entitlements read, account deletion (soft-delete + PII scrub), and the
  client auth gate + onboarding + profile screens.
- **Acceptance criteria:**
  - [ ] Fresh install → Apple or Google sign-in → onboarding → trip list,
        on simulator, with zero passwords stored
  - [ ] Refresh rotation + reuse-theft family revocation proven against the
        running API
  - [ ] Middleware order + 404-indistinguishable authz harness green (the
        fixture every later spec's authz tests build on)
  - [ ] Token-hygiene log sweep clean; refresh token in secure store only
  - [ ] Ledger F-018..F-029 verified
- **Tasks:** T-5.1 shared auth schemas + auth tables/migration [AU-1, AU-2] ·
  T-5.2 provider verification + sign-in [AU-3] · T-5.3 issuance/rotation/
  sessions [AU-4] · T-5.4 middleware trio + error envelope + rate limits
  [AU-5] · T-5.5 profile/avatar/handles/push-tokens + entitlements read
  [AU-6, AU-7] · T-5.6 account deletion [AU-8] · T-5.7 session store + auth
  gate + sign-in screen [NAV-2] · T-5.8 onboarding + profile screens
- **Linked specs:** `api/auth-users`, `client/navigation`, `shared/contracts`
- **Ledger:** F-018..F-029

### P-6 — Trips, collaboration & places spine

- **Status:** queued · **Priority:** P0 · **Depends on:** P-5 · **~6 PRs**
- **Goal:** The app's spine: trip CRUD with the §3.2 permission matrix (the
  authz source of truth for every domain), members/roles/ownership transfer,
  multi-use invites with deep links, the push-invalidation event seam, the
  open-data places spine (region ingestion + search — trip creation both
  needs it for structured destinations and triggers it), and the trips-facing
  client screens + entry-redirect/default-tab logic.
- **Acceptance criteria:**
  - [ ] Two-account collab loop on simulators: create trip → invite link →
        second account joins → role change/transfer/removal all enforced
        server-side
  - [ ] Non-member IDOR posture proven: byte-identical 404s, no-access UI
  - [ ] Destination search hits the ingested Overture city subset; region
        ingestion is idempotent and failure-visible
  - [ ] Entry redirect + default-tab rules behave incl. 2+ active trips
  - [ ] Ledger F-030..F-042 verified
- **Tasks:** T-6.1 trip CRUD + settings + status seam [API-TRIPS-1] · T-6.2
  members + invites [API-TRIPS-2, API-TRIPS-3] · T-6.3 push-invalidation
  emitter [API-TRIPS-4] · T-6.4 places ingestion pipeline + region grid
  [PL-1] · T-6.5 place search + custom places [PL-2] · T-6.6 entry redirect +
  membership guard + deep-link registry [NAV-3, NAV-4, NAV-5] · T-6.7 trip
  list + create modal [CT-1, CT-2] · T-6.8 invite-join + members screens
  [CT-3, CT-4] · T-6.9 trip settings + collab client layer [CT-5, CT-6]
- **Note:** places spine rides here (not the maps phase) because trip
  creation depends on it (structured destination, R-places-1 ingest trigger).
  Event transport is stubbed at the emitter seam; real push lands P-13.
- **Linked specs:** `api/trips`, `api/places` (§ingestion/search),
  `client/trips`, `client/navigation`
- **Ledger:** F-030..F-042

### P-7 — Itinerary & bookings

- **Status:** queued · **Priority:** P0 · **Depends on:** P-6 · **~6 PRs**
- **Goal:** The plan surface: bookings by category (typed details, status
  machine, single-source-of-truth calendar items), the Ideas bucket, the
  day list with drag reorder + inline travel times (Mapbox/Transitous leg
  jobs), the calendar-grid gap view (the differentiator), add/edit flows for
  all 10 types, and the deeplink-out → return-prompt loop.
- **Acceptance criteria:**
  - [ ] A full trip is plannable in the simulator: ideas → scheduled days →
        reordered → travel times visible between stops
  - [ ] Calendar grid exposes gaps/overlaps; multi-day lodging renders as one
        spanning item both ways
  - [ ] Every partner deeplink builds its research-verified URL (snapshot
        suite) and the "Did you book it?" loop closes with
        `source='deeplink_return'`
  - [ ] Viewer role is read-only here, server-enforced
  - [ ] Ledger F-043..F-054 verified
- **Tasks:** T-7.1 booking service + router [IB-1] · T-7.2 itinerary router +
  composite read [IB-2] · T-7.3 travel-leg job + refresh [IB-3] · T-7.4 day
  list + drag reorder [IT-1, IT-2] · T-7.5 travel-time chips + conflict
  surfacing [IT-3, IT-4] · T-7.6 Ideas bucket + add/edit flows [IT-5, IT-7] ·
  T-7.7 calendar grid + multi-day rendering [IT-6] · T-7.8 deeplink-out
  builders + return loop [IT-8] · T-7.9 booking/item detail + offline degrade
  [IT-9, IT-10]
- **Linked specs:** `api/itinerary-bookings`, `client/itinerary`
- **Ledger:** F-043..F-054

### P-8 — Maps, saved places & offline tile packs

- **Status:** queued · **Priority:** P0 · **Depends on:** P-7 · **~5 PRs**
- **Goal:** The trip map: @rnmapbox/maps with themed styles, three pin
  families + clustering + day filter, place sheet/detail with spine data and
  the fetch-fresh non-persistence seam (premium details deferred), map
  search, foreground-only location, offline StylePacks/TileRegions with
  hygiene, and map↔itinerary cross-navigation.
- **Acceptance criteria:**
  - [ ] Saved + itinerary pins render day-coded with clustering; search bar
        drops temporary pins
  - [ ] Airplane-mode E2E inside a downloaded pack: tiles + pins + sheet work
  - [ ] Built plist has when-in-use key only — no background location
  - [ ] Mapbox attribution unobscured; no literal colors on the map layer
  - [ ] Ledger F-055..F-062 verified
- **Tasks:** T-8.1 place detail endpoint + saved-places CRUD [PL-3, PL-4] ·
  T-8.2 map shell: styles, camera, layers, clustering, day filter [MAP-1] ·
  T-8.3 pin interactions + search + location [MAP-2, MAP-4] · T-8.4 place
  detail screen + map↔itinerary linking [MAP-3, MAP-6] · T-8.5 offline packs
  lifecycle [MAP-5]
- **Linked specs:** `client/map`, `api/places`
- **Ledger:** F-055..F-062

### P-9 — Money: budgets, expenses, splits & settle-up

- **Status:** queued · **Priority:** P0 · **Depends on:** P-7 · **~6 PRs** ·
  **Sensitive path: payments/splitting — auto-escalated review; Law #2
  blocking criterion (integer cents only)**
- **Goal:** Splitwise-grade money: atomic expense+shares writes with the
  pinned four-type split math (shared client/server), multi-currency FX
  capture, computed balances with simplify-debts toggle, record-only
  settlements with the live-probed rail handoffs (Venmo/CashApp/PayPal/
  Zelle), send-the-bill request links, and per-category + overall budgets.
- **Acceptance criteria:**
  - [ ] A real group round-trip works on simulators: expenses → balances →
        settle rails → mark-as-settled → all settled up
  - [ ] Exact-sum invariant enforced server-side; no float anywhere in the
        money pipeline (property tests + wire checks)
  - [ ] Rail URL snapshots match research formats verbatim; mark-as-settled
        works with zero handles
  - [ ] Base currency locks at first expense; soft-deleted expenses leave a
        visible audit trail
  - [ ] Ledger F-063..F-074 verified
- **Tasks:** T-9.1 shared money math (`computeShares`/balances/simplify)
  [MON-1] · T-9.2 expenses CRUD + FX + soft delete [MON-2] · T-9.3 balances +
  settlements [MON-3, MON-4] · T-9.4 settle-requests + budgets [MON-5,
  MON-6] · T-9.5 money tab shell + balances segment [CMON-1, CMON-4] ·
  T-9.6 expense list/detail + add/edit modal [CMON-2, CMON-3] · T-9.7 settle
  screen + send-the-bill [CMON-5, CMON-6]
- **Note:** the AI expense estimate (MON-7 + CMON-1's CTA) needs the P-10
  platform — the CTA ships here as a visible disabled stub, wired in T-10.5.
  FX-rate provider pick is this phase's approved new-dependency escalation.
  Device tests D1–D4 (real-hardware rail behavior) are deferred to P-14 by
  design — the ledger gates store submission on them, not this phase.
- **Linked specs:** `api/money`, `client/money`
- **Ledger:** F-063..F-074

### P-10 — AI layer: platform, recommendations, estimates, tour guide, packing, recap

- **Status:** queued · **Priority:** P1 · **Depends on:** P-8, P-9 · **~6 PRs**
- **Goal:** Claude server-side behind hard gates: key custody + caps +
  per-feature ceilings + $50 alert/$100 kill-switch with integer cost math,
  the anonymous destination cache, the anti-hallucination prompt contract
  (grounded in our spine — venues unrepresentable unless provided), then the
  five features: recommendations, expense estimation, Batch tour-guide
  bundles (offline into SQLite), packing generation, post-trip recaps.
- **Acceptance criteria:**
  - [ ] Cap boundary + kill-switch + cache-hit-costs-nothing all proven
        against the running API (mocked model where appropriate)
  - [ ] Every generative output references real spine `place_id`s; refiner
        drops uncited facts; zero volatile facts in cached content
  - [ ] Tour bundles readable in airplane mode; recap is one-per-trip and
        privacy-filters highlights (Law #3 fixture)
  - [ ] AI estimate writes budgets and the money-tab CTA state machine works
  - [ ] Ledger F-075..F-083 verified
- **Tasks:** T-10.1 platform: middleware chain, accounting, spend controls
  [AI-1] · T-10.2 prompt templates + anti-hallucination suite [AI-2] ·
  T-10.3 recommendations [AI-3] · T-10.4 tour-guide pre-gen + client offline
  [AI-4, AI-5] · T-10.5 packing endpoint + expense estimate + money CTA
  wiring [AI-6, MON-7] · T-10.6 recap job + endpoint [AI-7]
- **Note:** Law #5 boundary — runtime API spend is server-env-keyed and
  kill-switched; dev/CI stay on mocks (no `ANTHROPIC_API_KEY` in CI, ADR-003).
- **Linked specs:** `api/ai`, `api/money` (§AI estimation), `client/money`
- **Ledger:** F-075..F-083

### P-11 — Booking capture: email + share pipeline

- **Status:** queued · **Priority:** P1 · **Depends on:** P-7, P-10 · **~5 PRs**
- **Goal:** The "forward it and it lands" magic: permanent forward address →
  CloudMailin webhook, share-sheet ingestion, JSON-LD-first parse with Haiku
  fallback + confidence routing, trip inference, high-confidence auto-file
  with push undo, the visible review queue (never silent), parse-reply
  emails, and the 30-day raw-retention privacy posture.
- **Acceptance criteria:**
  - [ ] Real booking-email fixtures land as proposed bookings; confirm
        creates the booking atomically; failures always visible with retry
  - [ ] Auto-file + one-tap undo round-trips; badge math correct
  - [ ] Shared PDFs/images/text/URLs ingest cold + warm, never dropped
  - [ ] PII-free logs, SSRF guard, raw purge on confirm/30 days — all proven
  - [ ] Ledger F-084..F-091 verified
- **Tasks:** T-11.1 forward address + webhook + sender management [CAP-1] ·
  T-11.2 share upload endpoint [CAP-2] · T-11.3 parse pipeline worker
  [CAP-3] · T-11.4 queue API + parse-reply + retention [CAP-4] · T-11.5
  share-intent client + capture entries [NAV-6, CAPC-1] · T-11.6 queue +
  onboarding screens [CAPC-2, CAPC-4] · T-11.7 review screen + undo flow
  [CAPC-3]
- **Note:** new-dependency escalations at phase start: CloudMailin inbound +
  a transactional outbound email provider (Autonomy Contract #3).
- **Linked specs:** `api/capture`, `client/capture`, `client/navigation`
- **Ledger:** F-084..F-091

### P-12 — Photos & memories

- **Status:** queued · **Priority:** P1 · **Depends on:** P-8 · **~5 PRs** ·
  **Sensitive path: photo visibility/privacy — auto-escalated review; Law #3
  blocking criterion**
- **Goal:** The trip journal: two-phase presigned uploads with an
  offline-tolerant queue, per-upload location consent with priming, the
  visibility boundary enforced on every read (private/trip/public, default
  private), day/place-grouped album, pin editing with suggest-never-auto-pin,
  visibility-safe map photo pins, public-by-place strip, moderation + GC.
- **Acceptance criteria:**
  - [ ] Another member's private photo is unreachable via grid, deep link,
        map feed, and place strip (the Law #3 E2E fixture)
  - [ ] Widening to public always requires the explicit confirm; narrowing is
        instant
  - [ ] Offline-queued uploads survive app kill and complete on reconnect
  - [ ] Consent-off uploads transmit no GPS end-to-end
  - [ ] Ledger F-092..F-100 verified
- **Tasks:** T-12.1 shared photo shapes + StoragePort + upload pipeline
  [PH-1, PH-2] · T-12.2 gallery/detail/PATCH/delete + public-by-place
  [PH-3, PH-4] · T-12.3 GC job [PH-5] · T-12.4 album grid [PHC-1] · T-12.5
  capture/upload queue client [PHC-2] · T-12.6 viewer + visibility control
  [PHC-3, PHC-4] · T-12.7 permission priming + map-pin contract [PHC-5,
  PHC-6]
- **Linked specs:** `api/photos`, `client/photos`, `client/map` (§photo pins)
- **Ledger:** F-092..F-100

### P-13 — Today view, offline sync, notifications & utilities

- **Status:** queued · **Priority:** P1 · **Depends on:** P-9, P-10, P-12 ·
  **~6 PRs**
- **Goal:** The during-trip composition layer: the today surface (timeline,
  hero countdown, leave-by, day states, quick actions), the active-trip
  SQLite offline bundle + persisted mutation queue, real push transport over
  the P-6 event seam (registration, prefs, catalog senders, digest, expiry,
  settle-up, coalesced itinerary changes), leave-by local notifications, and
  the utility APIs + screens (weather, documents vault, packing lists).
- **Acceptance criteria:**
  - [ ] Airplane-mode E2E: today + all trip tabs render fully from the
        bundle with staleness honesty; offline writes drain FIFO on reconnect
        with visible failed-changes recovery
  - [ ] Every notification category sends per prefs and tap-routes through
        the registry, cold and warm
  - [ ] Leave-by local alerts match the shared computation used on screen
  - [ ] Documents stay strictly owner-private; packing check-off works
        offline
  - [ ] Ledger F-101..F-112 verified
- **Tasks:** T-13.1 shared notification contracts + client registration/
  prefs [NTF-1, NTF-2] · T-13.2 send pipeline + catalog senders + jobs
  [NTF-3] · T-13.3 weather + documents + packing APIs & screens [UTL-1,
  UTL-2, UTL-3] · T-13.4 offline bundle infra [TDY-2] · T-13.5 mutation
  queue [TDY-3] · T-13.6 today screen [TDY-1] · T-13.7 tap-routing +
  leave-by scheduling [TDY-4, NTF-4]
- **Note:** weather provider pick is this phase's approved new-dependency
  escalation. Flight-status alerts stay deferred to v2 (Gate-2 H7).
- **Linked specs:** `client/today`, `api/notifications-utilities`
- **Ledger:** F-101..F-112

### P-14 — Launch readiness

- **Status:** queued · **Priority:** P1 · **Depends on:** P-13 · **~3–5 PRs**
- **Goal:** Ship it: the money spec's real-hardware device-test checklist
  (D1–D4), the Android verification pass, EAS production builds + TestFlight
  with a zero-secrets bundle audit, App Store readiness (privacy labels,
  account deletion, permission copy, universal-link domain swap), and a
  perf + security sweep against the threat model.
- **Acceptance criteria:**
  - [ ] D1–D4 executed on real iPhone + Android, results recorded in the
        ledger before submission (money spec §3 requirement)
  - [ ] Android pass complete; failures filed as B-N and fixed
  - [ ] TestFlight build runs the golden path against production; bundle
        audit clean (Law #1)
  - [ ] AASA/assetlinks live on Sean's purchased domain (Gate-2 item A3 —
        one-config `LINK_DOMAIN` swap)
  - [ ] Large-trip performance floor measured and recorded
  - [ ] Ledger F-113..F-118 verified — and every earlier ledger entry
        `passes: true` or explicitly waived by Sean
- **Tasks:** T-14.1 device tests D1–D4 + fixes · T-14.2 Android verification
  pass + fixes · T-14.3 EAS + TestFlight + secrets audit · T-14.4 App Store
  readiness + domain/AASA swap · T-14.5 perf + security sweep
- **Linked specs:** `client/money` (§device tests), `client/navigation`
  (§deep links), all — this phase closes the ledger
- **Ledger:** F-113..F-118

---

## Review Pipeline Configuration

> Local, in-session — [ADR-003](decisions/ADR-003-local-in-session-reviews.md).
> Mechanics: `.agents/skills/pr-review-pipeline/SKILL.md`; sentinel format:
> `.claude/rules/pr-review-files.md`.

- **Lanes (locked, 5):** correctness · security · tests · performance · conventions
- **Judge:** fresh impartial subagent → `merge | re-review | human-decides`;
  hard cap 4 rounds
- **Sensitive paths (auto-escalate + recommend `/code-review` at high effort):**
  `**/auth/**`, `**/payment*/**`, `**/split*/**`, photo visibility/privacy
  logic, `**/migrations/**`, `.github/workflows/**`
- **Project blocking criteria:** money handled in integer cents/Decimal only;
  no location/photo data crossing a privacy boundary without an explicit
  visibility check; secrets never in code
- **Per-phase re-evaluation:** when a phase introduces a new domain (AI layer,
  payments), re-check the lane mix before starting it.

---

## Decisions Log

> At-a-glance pointers. Full rationale in `docs/decisions/`.

| Date | ID | Decision | ADR | Revisit? |
|------|-----|----------|-----|----------|
| 2026-07-09 | ADR-001 | Stable IDs (P/T/B/S) + canonical doc homes (adopted from GSD template) | [ADR-001](decisions/ADR-001-naming-convention.md) | No |
| 2026-07-09 | ADR-002 | Status enum lock: `queued/in-progress/blocked/done/deferred/cancelled` | [ADR-002](decisions/ADR-002-status-enum-lock.md) | No |
| 2026-07-09 | ADR-003 | PR reviews run local in-session on Max — never GitHub Claude app / metered CI | [ADR-003](decisions/ADR-003-local-in-session-reviews.md) | No |
| 2026-07-09 | ADR-004 | Expo/RN + Hono + Drizzle/Postgres monorepo, iOS-first | [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md) | No |
| 2026-07-09 | ADR-005 | Free v1 + entitlement seams; offline/collab/splitting free forever | [ADR-005](decisions/ADR-005-free-v1-entitlement-seams.md) | No |
| 2026-07-09 | — | Provider set locked from S-2 evidence (Mapbox, open-data POI spine, Claude, dual-path capture, record-only settle-up, foreground-only location) | § Architecture table | At scale |
