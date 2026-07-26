# GoGo Travel — Active State

> **Short-term active context** for in-flight work. Advisory cap ~800–1000 lines.
> Locked decisions → `docs/decisions/ADR-NNN-*.md`. Completed phases → `docs/history/`.
> Stable IDs (`P-N` / `T-N.M` / `B-N` / `S-N`) per [ADR-001](decisions/ADR-001-naming-convention.md).
> Log **failed approaches** here too ("Tried X, didn't work because Y") — fresh
> sessions must not re-walk dead ends.

---

## CURRENT DIRECTION

Building **GoGo Travel** — a mobile travel app covering everything a person needs
for planning AND using during a trip. Multiple trips per user; itinerary/calendar,
bookings by category (lodging / flights / trains / car+moped rentals / activities),
maps with saved places + travel times, budgeting + AI expense estimates, AI
recommendations + AI tour guide, Splitwise-style expense splitting with Venmo/Zelle
handoff, photo albums pinned to map/itinerary (private/public), deeplink-first
booking integrations, minimal customizable design system.

**Operating model:** high-autonomy Claude builds from upfront specs; Sean is
planner/spec-maker/QA. Human-in-the-loop ONLY at the escalation triggers in
`CLAUDE.md § Autonomy Contract`. Reviews are **local in-session**
([ADR-003](decisions/ADR-003-local-in-session-reviews.md)) — no GitHub Claude app.

## Active phase context

### P-6 — Trips, collaboration & places spine (ACTIVE since 2026-07-25)

- **The app's spine** (~6 PRs, 9 tasks). Trip CRUD + §3.2 permission matrix
  (authz source of truth for every later domain), members/roles/ownership
  transfer, multi-use invites + deep links, push-invalidation emitter seam,
  open-data places spine (region ingest + search), trips client screens +
  entry-redirect/default-tab. Ledger **F-030..F-042**. Specs: `api/trips`,
  `api/places`, `client/navigation` (NAV-3/4/5), `shared/contracts`.
- **NO blocking escalations** (scoped 2026-07-25): places spine ingests OPEN
  datasets only (Overture + FSQ-OS GeoParquet via DuckDB, $0/no-key/no-account;
  Foursquare premium DEFERRED out of MVP → dormant R-places-11..14). Invites
  ship on `gogo://` + a `LINK_DOMAIN` placeholder; universal-link domain stays
  a P-14 Sean item. Permission matrix + transfer are fully specced (no
  security-model divergence). **No migration owed** — the P-3 baseline
  (`0000_certain_texas_twister.sql`) already has trips/trip_members/invites/
  places/saved_places/place_ingest_regions + `pg_trgm` GIN.
- **Task breakdown + build order (waves):**
  - **T-6.1** (S) trip CRUD router (POST/GET/GET:id/PATCH/DELETE `/trips`) —
    **first real consumer of the dormant `require-trip-member.ts`**; adds
    `TripListItem` shared shape + `expect_updated_at` conflict helper + status
    reconciliation + `base_currency` lock. Flips F-030/031/033, establishes
    F-038 IDOR harness. NO migration. **✅ MERGED f11f686 (PR #2) 2026-07-25** —
    round-1 fix-then-ship (1 blocking: unbounded string caps; fixed 758f0be),
    judge merge/high, ultra waived. F-030/031/033 code-complete; flips pend
    phase QA (need Wave-4/5 client screens to exercise).
  - **Wave 2 — COMPLETE 2026-07-25:** T-6.2 **✅ MERGED 5694f83 (PR #4)** —
    2 dual-lane-convergent blockers (zero-owner strand, cascade deadlock)
    fixed + pinned with deterministic held-lock tests; global lock order
    users → trip_members → invites now codified in code docs. T-6.4
    **✅ MERGED e5a2c97 (PR #3)** — sargable dedup EXPLAIN-pinned; new dep
    @duckdb/node-api@1.5.5-r.1. Server suite 433, shared 348.
    T-6.5 carry-forwards: enqueue-volume bounds; consumes `enqueueSearchMiss`;
    adds PlaceCreate/coarseCategory shared shapes.
  - **Wave 3:** T-6.3 **✅ MERGED 0cc55d1 (PR #5) 2026-07-25** — clean
    round-1 SHIP (0 blocking, 5 lanes); emitter dormant until P-13 (obligations
    parked in QUEUE). T-6.5 (S, `/places/search` + custom places) — building.
  - **Wave 4:** T-6.6 (M, entry-redirect + default-tab + tab-memory + `[tripId]`
    guard/no-access + deep-link registry).
  - **Wave 5 (parallel):** T-6.7 (M, trip list + create modal), T-6.8 (M,
    invite-join + members), T-6.9 (M, settings + collab client layer).
- **Existing seams:** `apps/server/src/http/require-trip-member.ts` (dormant,
  404-indistinguishable, `createRequireTripMember`); `apps/server/src/app.ts`
  (only auth+users mounted at :82/:86 — T-6.1 mounts `/trips`);
  `packages/shared/src/domains/trip.ts` (`deriveTripStatus` done; ADD
  `TripListItem`/`InvitePreview`/`OwnershipTransfer`/`PlaceCreate`/
  `coarseCategory`/`LINK_DOMAIN`); P-4 mobile placeholders in
  `apps/mobile/src/app/(trips)/` + `[tripId]/_layout.tsx` (NAV-3/4 seams marked).
- **Carry-forwards:** sole-owner-ghost + account-deletion trip reconcile
  RESOLVED at T-6.1 (solely-owned trips cascade — judge-validated as the only
  invariant-consistent mechanization; **spec-amendment note**: no spec sentence
  says it verbatim, derived from R-trips-1/8/10 + R-db-8). Remaining, with
  owners: invite-accept TOCTOU + `FOR UPDATE` sole-owner guard + keyset-cursor
  helper extraction → T-6.2; push-event test bullets (§3.3 trip.updated/deleted,
  §3.5 status_changed) → T-6.3; base-currency TOCTOU → P-9 money QUEUE row;
  users' `:userId` 400-vs-404 convergence → P3 QUEUE row. notification-priming
  wires to the T-6.3 push seam (transport still P-13, stays partial). Txn
  landmine: atomic multi-writes (owner+member, transfer, invite-accept) MUST
  use the WS `Pool`/`postgres-js`, never Neon-HTTP.
- **T-6.1 landmines (fresh sessions, don't re-walk):** timestamptz stores µs
  but the wire is ms — naive `updated_at` equality 409s every fresh row; use
  `date_trunc('milliseconds', col) = $iso::timestamptz` (parity proven on both
  drivers). Raw `Date` params crash postgres-js drizzle `sql` templates — bind
  canonical ISO string + explicit cast. Key-presence authz needs falsy-value
  pinning tests (`{status: null}` — a truthiness refactor passes green suites).
  Membership aggregates (member_count-style) must join LIVE users or legacy
  ghost rows inflate counts. Observer-less TanStack cache asserts under
  `gcTime: 0` are GC-timer races — pin `gcTime: Infinity` per-key in that test.
- **T-6.2 landmines (add to the T-6.1 list):** write predicates on
  role-bearing rows must PIN the role (`ne(role,'owner')`) — EPQ re-evaluation
  after a lock wait lands unguarded writes on the promoted row version.
  ON DELETE CASCADE lock order = FK-trigger CREATION order (0000: invites
  before trip_members) — never assume cascades follow your explicit order;
  fence multi-row deleters with an ordered `FOR UPDATE` SELECT first. Global
  lock order is users → trip_members → invites; multi-row lockers order by
  user_id (in-trip) / trip_id (cross-trip). Liveness doors: any INSERT
  creating a membership/ownership for the caller takes the caller's users row
  FOR SHARE (live-only) as FIRST lock, or account-deletion mints ghosts.
- **Status:** Waves 1+2 MERGED 2026-07-25 (T-6.1 f11f686, T-6.4 e5a2c97,
  T-6.2 5694f83 — main green, server 433). Wave 3 (T-6.3 ∥ T-6.5) dispatched
  2026-07-26. Auth on-device QA (P-5 ledger) runs in parallel whenever Sean
  wires OAuth.

### P-5 — Auth, profiles & entitlements (CODE-COMPLETE 2026-07-25 → archived)

- **P-5 done, ledger pending QA.** T-5.1..T-5.8 merged CI-green — full server +
  client auth stack. Archived: [PHASE-005](history/PHASE-005-auth-profiles-entitlements.md).
  **Ledger F-018..F-029 stays `passes:false`** — verification = the feature
  exercised in the running app (Law #7), which needs Sean's OAuth credentials
  (Apple Sign-In entitlement + `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`) + server env
  (`APPLE_CLIENT_ID` / `GOOGLE_CLIENT_IDS` + ES256/Apple keys). Flips after
  on-device QA (same pattern as P-4's F-010..F-017).
- **Deferred (tracked in QUEUE):** avatar UPLOAD → P-12 (object storage,
  Sean-deferred 2026-07-24; client ships avatar _display_ only) — carry the
  `avatar_key`→server-signed-read-URL security note into the P-12 wire;
  notification-priming onboarding step → P-6 push seam. F-024/F-025 land
  partially, verify fully at P-12.
- **Testcontainers contention (QUEUE P1, LIVE cross-phase):** 9+ DB suites boot
  Postgres in parallel → port-bind timeout + WEDGES the Docker daemon. Workaround:
  server suite `--no-file-parallelism`; real fix = shared globalSetup container.
  Hits every future DB-suite task.
- Review-mode: local 5-lane pipeline + fresh impartial judge is the standard gate;
  `/code-review ultra` optional (2 free left), substitutable by a deep local
  self-review when Sean waives it.

### P-4 — Design system + navigation skeleton (CLOSED 2026-07-22)

- **4/4 build tasks + 2 direct commits merged; ledger F-010..F-017 ALL
  flipped** (sim evidence sweep + Sean's full device-QA pass on iPhone 15
  Pro — checklist cleared 2026-07-22). Archive:
  `docs/history/PHASE-004-design-system-navigation.md` (incl. the
  device-install bootstrap recipe + landmine list). Mobile suite 152 tests.
- First native builds: simulator AND Sean's iPhone. Dev QA doors on trip
  list: Component gallery + Open sample trip (both `__DEV__`-only).
- Gotchas for future sessions: node >=22.9 (env-file flag); mobile TS ~6.0.3
  is Expo's pin; guard-job comments must never contain literal trigger keys;
  PG assignment cast rounds numeric->bigint (app-boundary z.int is the gate);
  CocoaPods needs UTF-8 locale; JS-only changes reach the device app via
  kill+reopen (Metro), no rebuild.

### P-2 — Upfront spec suite (CLOSED 2026-07-10; P-1 push still pending)

- **Where we are:** Gates 1 AND 2 passed 2026-07-09. Full spec suite written
  (18 files, ~280 EARS requirements) by 11 parallel spec agents; all 59
  punch-list questions approved wholesale (see `.specs/OPEN-QUESTIONS.md` —
  now the decision record); both resolution agents ran — **zero markers
  remain**. Cross-agent sync items applied (push_tokens.timezone, packing
  live-uncached, map search bar). Judgment calls flagged by resolvers are
  logged in their reports; notable: editors can only edit/delete their OWN
  expenses (per approved permission matrix), sole-owner account deletion →
  409 transfer-first.
- **T-2.4 DONE:** `feature-ledger.json` (118 features, F-001..F-118, all
  `passes:false`, 466 requirement IDs verified) + frozen roadmap **P-3..P-14**
  (12 phases, ~62 PRs) in PLANNING § Phase Detail. **GATE 3 OPEN — Sean
  approves the phase plan → P-3 build starts.**
- Sequencing notes from T-2.4 (binding): places spine ships with trips (P-6);
  AI expense-estimate CTA stubs in P-9, wires in P-10; capture (P-11) needs
  the AI platform (P-10); push emitter stubs P-6, transport lands P-13.
- Sean's open action items: **Gate 3 approval** · palette pick (artifact
  claude.ai/code/artifact/229f853e-c9d3-49a9-b439-96a0c27f914f) · gh auth
  login (push) · (later, P-14) buy universal-link domain.
- **Port sources, for archaeology:** `../the-bach` (in-session 5-lane review
  pipeline — its ADR-002 is our ADR-003; commands; hooks), `../get-sean-done`
  (canonical GSD template: doc system, autonomous loop, naming ADRs),
  `../bartling-bachelor` (product exemplar — mobile PWA, design system, itinerary
  UX), `../roi-gen` (STATE discipline), `../seantokuzo-mcp` (rules/hooks patterns).
- **Research base:** autonomous-build patterns synthesis (Anthropic harness
  posts, Spec Kit, Kiro, Ralph loop) — see PLANNING.md § P-2 for how it lands.

## In-flight decisions

- ~~S-1 stack~~ → **LOCKED 2026-07-09 as
  [ADR-004](decisions/ADR-004-stack-expo-rn-hono-drizzle.md)**: Expo/RN +
  Hono + Drizzle/Postgres monorepo, iOS-first, StyleSheet+tokens styling.
  Extras all approved (live-trip, utilities, collab, recap).
- ~~S-2 product research~~ → **DONE 2026-07-09.** All five streams banked in
  `.specs/research/`: `competitors.md`, `booking-integrations.md`,
  `maps-places.md`, `payments-settle-up.md`, `ai-architecture.md`.
  Headlines: all-in-one slot validated w/ no good competitor execution;
  splitting+payment-handoff is uncontested; **Mapbox over Google (Google ToS
  bans Places/Routes content on non-Google maps + AI use — this supersedes
  the AI report's Google-Places grounding; ground AI in our Overture/FSQ-OS
  POI spine instead)**; settle-up = record-only ledger + handle deeplinks
  (formats live-probed); Viator + Ticketmaster APIs instant-approve day one;
  Amadeus self-serve dies 2026-07-17 (we never touch it). Total run-rate
  ~$40–120/mo at 1k MAU. Spec-shaping sign-offs pending (see Blockers).

## Blockers / Waiting on Sean

- ~~Push blocked~~ → RESOLVED 2026-07-16: pushed to origin.
- ~~All P-2 gates~~ → passed. No open Sean items except: (P-14) buy the
  universal-link domain.
