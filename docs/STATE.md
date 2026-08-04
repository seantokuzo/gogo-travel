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

## ▶ NEXT SESSION — START HERE (written 2026-08-03, delete when stale)

**Say "next" and do this, in order:**

1. **`gh pr list --state open`.** T-7.9's PR (booking/item detail + offline
   degrade, branch `P-7/T-7-9-detail-offline`) was dispatched and the builder
   stops at PR creation BY DESIGN — it does not review or merge.
   - **PR exists** → run **`/review <N>`**. That's the whole job this session.
   - **No PR** → the builder died mid-build. Its worktree is under
     `.claude/worktrees/`; check `git -C <worktree> log --oneline -3` and
     either resume it or re-dispatch from the T-7.9 brief (scope below).
2. **Everything you need about the change is in the PR body** — scope, spec
   refs, pasted evidence, mutation-probe results, and a numbered
   Interpretations list were all required deliverables. `gh pr view <N>`.
3. **On merge → P-7 is CODE-COMPLETE.** Then: phase-QA checklist + the
   **F-043..F-054 ledger flips** (Law #7 — flips need the feature exercised
   in the running app, NOT green tests). P-6's checklist is still pending too.

**Review-pipeline rules that cost real rounds when ignored:**

- 🔴 **Count the WRITERS before fanning out lanes.** A gate-runner and a
  falsification-prober both WRITE to the checkout. **At most ONE mutating
  agent per worktree** — others get `isolation: "worktree"` (then check out
  the PR branch AND build `@gogo/shared` + `@gogo/tokens`, or ~84 suites are
  red) or run serially. Three concurrent probers produced a FALSE-RED gate
  on PR #18. Pure readers (security/perf/conventions via `gh pr diff`) can
  share freely. Canonical: `.claude/rules/pr-review-files.md`.
- 🔴 **Brief every lane with the vacuous-pin taxonomy** (7 flavors, in
  `.claude/rules/mobile.md` + below). Seven were found across PRs #16-#18;
  all passed CI and lint and read correctly to a human. Only mutation found
  them. Require: every negative assertion has an ungated CONTROL arm, and
  every probe is confirmed applied via `git diff --stat` before its result
  is trusted (a silent no-op mutation already produced one false claim).
- **Highest-value targets for T-7.9 specifically:** (a) the **cancel flow is
  the FIRST real consumer of `reconcileBookingRow`'s removal arm** — a
  cancelled booking must leave the default list and appear under the Ideas
  bucket's cancelled view; pin both directions; (b) offline degrade must not
  turn **absent travel legs** (the normal state while Mapbox is parked) into
  an error; (c) fix diffs are where this phase's defects live — every fix leg
  on #17 and #18 introduced something the next round caught, so verify fixes
  independently and re-review targeted lanes rather than going straight to
  the judge.
- Round cap 4; judge is a fresh agent with no review history; merge
  `--merge` only; CI green first — **note `main` has NO branch protection, so
  that gate is discipline, not mechanism** (Sean's open item).

## Active phase context

### P-7 — Itinerary & bookings (ACTIVE since 2026-07-31)

- **The plan surface** (~6 PRs, 9 tasks T-7.1..T-7.9, PLANNING § P-7):
  bookings by category (10 detail types, §3.2 status machine, single-source
  calendar items via the §3.1 booking↔item contract), Ideas bucket, day list
  w/ drag reorder + inline travel times (Mapbox/Transitous leg jobs),
  calendar-grid gap view (the differentiator), add/edit flows for all types,
  deeplink-out → return-prompt loop. Ledger **F-043..F-054**. Specs:
  `.specs/api/itinerary-bookings.spec.md`, `.specs/client/itinerary.spec.md`.
- **Scoped 2026-07-31 — NO migration owed** (0000 baseline has bookings /
  itinerary_items / travel_legs, verified) and **NO blocking escalations**:
  travel-leg adapters build fixture-driven behind ports (T-6.4 $0 precedent);
  the **Mapbox account + token is a PARKED Sean item** (QUEUE Blocked row —
  needed for live leg QA later and P-8 maps SDK anyway; Transitous is a
  keyless community MOTIS instance). Deeplink-out is pure client URL
  construction (§2.7, research-verified) — no partner APIs, no keys.
- **Wave plan (build order):**
  - **W1:** T-7.1 [IB-1] booking domain service + bookings router + §3.7
    shared contract additions + §3.3 time-derivation helpers (shared — server
    writes AND client optimistic updates use the same functions) + a
    **dirty-day no-op seam** (T-6.3 dormant-emitter precedent: frozen
    `markDaysDirty` contract now, T-7.3 fills the internals — zero cross-wave
    file contention). **RIDER:** T-6.8 security defer — strip the raw invite
    `token` from the invites-list envelope (separate commit, same PR; QUEUE
    row said "next server touch").
  - **W2 (parallel, worktrees):** T-7.2 [IB-2] itinerary router (item CRUD +
    kind checks + booking-item protection, day-order PUT, composite read
    `{items, legs}`) — calls the W1 seam from item mutations ∥ T-7.3 [IB-3]
    travel-leg dirty-day queue + debounced worker + Mapbox/Transitous
    adapters + staleness refresh + rate-limited `refresh-legs` — fills the
    seam internals; files disjoint by construction.
  - **W3:** T-7.4 [IT-1, IT-2] itinerary tab shell: plan-mode day list,
    sections, day-jump strip, view-toggle + per-trip persistence, drag
    reorder (new DnD dependency — exact-pin + provenance per T-6.4
    precedent), TanStack hooks layer over the new descriptors.
  - **W4 (parallel):** T-7.7 [IT-6] calendar grid + spanning-lodging lane ∥
    T-7.6 [IT-5, IT-7] Ideas bucket + add/edit flows (10 types, place picker).
  - **W5 (parallel):** T-7.5 [IT-3, IT-4] travel-time chips + conflict
    surfacing ∥ T-7.8 [IT-8] deeplink-out builders + return-prompt loop
    (built as a self-contained panel component + URL-builder module so W4/W6
    surfaces consume it rather than collide with it).
  - **W6:** T-7.9 [IT-9, IT-10] booking/item detail screens + offline
    degrade of the tab.
  - Client-wave composition firms up as server waves land (P-6 pattern).
- **Contract notes:** §3.7 additions land at W1 — `BookingCreate`/`Update`/
  `BookingWithItems`/`ScheduleBookingInput`, `ItineraryItemCreate`/`Update`,
  `DayOrderInput`, `ItineraryRead`, `ISOTime` scalar, endpoint descriptors.
  Viewer role is read-only here, server-enforced (R-ib-24) — reuse the F-038
  byte-identity IDOR harness. LWW semantics (R-ib-18) are the offline-sync
  spec's foundation — don't improvise beyond them.
- **Status:** **P-7 SERVER SURFACE COMPLETE** — W1 **T-7.1 ✅ MERGED b67ba9c
  (PR #11)** · W2 **T-7.2 ✅ MERGED f529373 (PR #12)** (bodyLimit rider) ∥
  **T-7.3 ✅ MERGED c440396 (PR #13) 2026-08-01** [IB-3 travel-leg job +
  refresh, 3 rounds, judge merge/high — the live dirty-day `travelLegs.marker`
  is now wired into BOTH bookings AND itinerary deps, so item mutations reach
  the live worker]. **T-7.1 bookings + T-7.2 itinerary + T-7.3 travel-legs all
  merged.** W5 **T-7.8 ✅ MERGED 70569fe (PR #14) 2026-07-31** — deeplink-out
  builders + return-prompt loop, 3 rounds, judge merge/high (full narrative:
  QUEUE row). W3 **T-7.4 [IT-1/IT-2] ✅ MERGED (PR #15) 2026-08-01** — day
  list + drag reorder; `react-native-reorderable-list` JS-only dep (NO
  dev-client rebuild — datetimepicker landmine avoided). CLEAN round-1
  all-5-lanes-ship (0 blocking, 8 advisory), judge merge/high; mobile 517→568.
  **W3 DONE.** The T-7.4 itinerary hooks/screen live at
  `apps/mobile/src/data/itinerary.ts`, `apps/mobile/src/app/[tripId]/itinerary/`,
  and `apps/mobile/src/features/itinerary/` — successor tasks EXTEND these (T-7.5
  adds a `leg` DayListRow variant at the marked seam; T-7.7 replaces
  `itinerary-grid-placeholder`; T-7.6 mounts DeeplinkReturnHost + reuses the
  bookings keys). Remaining P-7 **client** tasks: T-7.5 [IT-3,IT-4] (travel-time
  chips + conflict — needs T-7.4's legs seam), T-7.6 [IT-5,IT-7] (Ideas bucket +
  add/edit flows — needs T-7.4 shell + owns the `DeeplinkReturnHost` mount),
  T-7.7 [IT-6] (calendar grid — replaces T-7.4's grid placeholder), T-7.9
  [IT-9,IT-10] (booking/item detail + offline degrade). All consume T-7.1's frozen seams.
  **Mapbox token still PARKED** (Blocked row) — travel legs return transit-only
  (Transitous keyless) until Sean drops `MAPBOX_ACCESS_TOKEN`; NOT a blocker for
  T-7.4/7.5 UI (absent legs = "no data" by design).
- **W4 (dispatched 2026-08-01, parallel isolated worktrees off `202ed49` —
  the zero-behavior GridSurface seam-prep commit): T-7.7 ✅ MERGED 7a48caf
  (PR #16) 2026-08-02** [IT-6 calendar grid: hour axis, virtualized day
  pager + pinned lockstep header, overlap split, all-day chips +
  spanning-lodging lane, gap-tap prefill; +46 mobile tests, 86 suites/699
  total; 1 round: 4 lanes ship + tests fix-then-ship (1 blocking — grid
  pixel geometry unfalsifiable, mutation-proven — + 6 advisory, all fixed
  or deferred same round), independent verifier re-ran all falsifications,
  judge merge/high. Judge NOTE for Sean: size-escalation banner NOT
  precedent-waived (diff 41% tests = majority source) — `/code-review
ultra` remains available on the merged diff, user-triggered] ∥ **T-7.6
  ✅ MERGED c587a6b (PR #17) 2026-08-02** [IT-5 Ideas bucket + IT-7 add/edit
  flows (10 types, place picker, gap-tap day+time prefill consumed) +
  `DeeplinkReturnHost` MOUNTED; **key-homing ruling EXECUTED** —
  `bookingKeys` deleted, `queryKeys` is the one key home. Mobile 699→776
  (92 suites). 2 rounds + 4 fix legs + 3 independent verifications; judge
  merge/high (it re-ran the whole gate itself rather than grading reports).
  27 interpretations → QUEUE spec-pass row]. **W4 DONE — W5 (T-7.5 travel
  chips + conflict) and W6 (T-7.9 detail + offline) remain.** T-7.7's 15
  interpretations (incl. MIN_BLOCK_HEIGHT floor + grid testIDs) also in the
  QUEUE spec-pass row.
- **W5 ✅ T-7.5 MERGED a84c9cf (PR #18) 2026-08-03** [IT-3 travel chips +
  mode sheet + Google-Maps directions handoff + absent-leg states · IT-4
  list overlap chips + sort-by-time + the R-itin-20 form conflict notice].
  Mobile 776→**898 tests / 99 suites**; guard suite 49. 2 rounds + 4 fix
  legs + 3 independent verifications + a targeted security pass; judge
  merge/high (it independently probed the 4th fix leg, which no verifier
  had covered, and read `legs-model.ts` in full). 35 interpretations →
  spec-pass row. **P-7 is now ONE TASK from code-complete: T-7.9
  [IT-9, IT-10] booking/item detail + offline degrade.** Run it serially
  (it wants the screen file) unless a seam is frozen first, per the W4
  precedent — the frozen-seam pattern produced ZERO conflicts across two
  large concurrent PRs and is the reason W4 worked.
- **W6 DISPATCHED 2026-08-03 (in-flight, PHASE CLOSER):** T-7.9
  [IT-9 R-itin-24..26 · IT-10 R-itin-27, R-itin-29] booking/item detail
  screens + offline degrade — SERIAL, sole agent, isolated worktree off
  `0473eac`. Owns both stub routes (`booking/[bookingId].tsx`,
  `item/[itemId].tsx`), detail components, `data/bookings.ts` extensions
  (cancel/delete), and the tab's offline posture. **Its cancel flow is the
  FIRST real consumer of `reconcileBookingRow`'s removal arm** — the
  cancelled-booking cache invariant becomes reachable here, so it must be
  pinned both directions. Inherited deferrals routed to this task: T-7.8's
  R-itin-29 offline deferral and T-7.5's `refresh-legs` client affordance
  (R-itin-6 forbids a retry prompt on the chip surface itself).
  **On merge, P-7 is CODE-COMPLETE → phase QA + F-043..F-054 ledger flips.**
- **🔴 NUL-BYTE / INVISIBLE-DIFF INCIDENT (T-7.5, the most important thing
  this phase learned).** Two raw `U+0000` bytes typed into
  `legs-model.ts` made git classify it BINARY: `gh pr diff` rendered ZERO
  lines and GitHub's API reported `additions=0, patch=false`, so a
  6641-byte production module (incl. `pickDefaultMode`) passed a FIVE-LANE
  review that structurally could not display it — and BSD `grep` exits 1
  **silently** on such a file, so an agent searching concludes the symbol
  doesn't exist. tsc/eslint/expo-lint all pass. Fixed + **guard-enforced
  repo-wide** (`.github/scripts/check-nul-bytes.mjs`, wired into the Guard
  job, 49 tests, exit contract pinned both directions). Rule now in
  `.claude/rules/mobile.md`; it had lived ONLY in `server.md`, path-scoped
  to `apps/server/**`, which is exactly why mobile re-stepped it —
  **a universal landmine must not live in one workspace's rule file.**
  Residual, NOT closed (QUEUE row): a `.gitattributes` `*.ts -diff`
  reproduces the identical invisible diff with zero NUL bytes.
- **Vacuous-pin taxonomy (7 found in T-7.5/T-7.6 — a green suite proves
  nothing until mutated).** All in `.claude/rules/mobile.md`: (1) rejecting
  an already-settled promise never observes in-flight state; (2) non-strict
  zod STRIPS unknown keys so a misspelled field round-trips green; (3) RNTL
  won't fire a handler on a `disabled` element, so "press it, assert
  nothing happened" passes with the guard gone; (4) a fixture where two
  behaviors yield the same value (23:00, where clip-at-midnight ==
  start+60min); (5) a CONTROL arm that structurally can't reach the code it
  controls for (a car rental can never hit a `lodging` clause); (6) a "no-op
  mutation" that looks like a passing falsification (`undefined ?? null`);
  (7) asserting a negative with no ungated control. **Rule: every negative
  assertion needs a control arm proving it could have failed, and every
  probe must be confirmed applied via `git diff --stat` before its result
  is trusted.**
- **T-7.6/T-7.7 landmines (NEW — 3 VACUOUS-PIN FLAVORS, all codified in
  `.claude/rules/mobile.md`; a green suite proved nothing three times in one
  PR):** (1) a pin that rejects an ALREADY-SETTLED promise never observes the
  in-flight state — optimistic write + rollback flush in one notify batch;
  (2) `BookingDetailsSchema` (and any non-strict zod object) STRIPS unknown
  keys, so a misspelled detail key round-trips green — assert
  `parsed.data == built.details`; (3) RNTL won't fire a handler on a
  `disabled` element, so "press it, assert nothing happened" passes with the
  guard removed. **Rule: every negative assertion needs an ungated control
  arm proving it could have failed.** Also: the DS Sheet scrim is unqueryable
  in RNTL (`opacity:0` Animated.View, entrance value never advances) — drive
  the close button, or `includeHiddenElements: true`.
- **DS Sheet gained `dismissDisabled`** (T-7.6, strictly additive, default
  off): gates all four dismissal routes (close/scrim/swipe/Android-back)
  behind one memoized `guardedDismiss` AND renders the close affordance
  visibly disabled. Use it for any sheet wrapping an uninterruptible
  operation — and pair it with a caller-side `isPending` early-return, since
  the swipe route is wired but **not test-pinned** (documented gap: no
  non-vacuous pin is constructible — PanResponder needs real touch history).
- **Client cache invariant (T-7.6):** the cached default bookings list must
  always satisfy the server's R-ib-10 predicate — `reconcileBookingRow`
  inserts only non-cancelled rows and REMOVES rows that become cancelled.
  T-7.9 wires R-itin-26 cancel; do not regress this to a map-replace.
- **T-7.1 landmines (NEW — binding on all P-7+ surfaces):**
  - **Caps must cover EVERY schema class, not just obvious strings** — zod
    `iso.datetime()` accepts unbounded fractional seconds; a 2MB string is a
    "valid datetime" (PR #11 R2 blocker, found IN the caps-fix diff). When
    capping a wire surface, sweep the whole union: strings, arrays, array
    ELEMENTS, and every formatted-scalar class.
  - **Place visibility has ONE home:** `apps/server/src/places/visibility.ts`
    — every surface that writes a client-supplied `place_id` (bookings now;
    itinerary items T-7.2; anything later) MUST consume it with the
    indistinguishable-404 posture. `bookings.place_id` (and soon
    `itinerary_items.place_id`) is a VISIBILITY GRANT in places search —
    writing it unchecked is a Law #3 bypass (PR #11 R1 blocker class).
  - **Lock order extended:** users → trip_members → invites → bookings →
    itinerary_items. Mutating a booking-kind item goes THROUGH the booking
    service (parent booking FOR UPDATE first), never directly.
  - **Dirty-day seam:** `bookings/dirty-days.ts` interface FROZEN
    (`markDaysDirty`, post-commit-only, never-throws, duplicates OK);
    T-7.3 owns the internals.
  - Place-FK 23503 → canonical 404 mapping is constraint-precise
    (`isPlaceFkViolation` handles both driver field shapes); copy that
    pattern for any new FK-race mapping.
- **T-7.8 landmine → RESOLVED at DS level (PR #16 rider, 2026-08-02):** the
  Sheet exit-window tax (bit T-6.9, PR #14 R2+R3) is LIFTED —
  `pointerEvents:"none"` while exiting + unmount-latch guard (re-armed in
  the effect body, StrictMode-proof) landed in `components/Sheet.tsx`.
  Existing consumer exit-drains are now harmless no-ops; new sheet
  consumers need NO special posture. Residual (documented, pinned by the
  reworked members test): same-frame multi-touch can still land two
  presses before the closing commit — the hook-level v5 mutation seam is
  what handles that overlap, so that seam rule still binds.

### P-6 — Trips, collaboration & places spine (CODE-COMPLETE 2026-07-31 → archived; PHASE QA PENDING)

- 9/9 tasks merged (PRs #2–#10, every judge merge/high). Narrative archived:
  [PHASE-006](history/PHASE-006-trips-collab-places.md); per-PR detail in
  QUEUE "Recently done". Ledger **F-030..F-042 stays `passes:false`** until
  the checklist below runs (Law #7).
- **PHASE-QA CHECKLIST (run on sim before ledger flips; REBUILD the dev
  client FIRST — datetimepicker native module):** ① two-account collab loop:
  create → invite (share sheet opens) → join via gogo:// link → role change →
  transfer → remove (T-6.2/6.8/6.9); ② warm-start deep-link URL transport
  (jest-untestable leg, T-6.6); ③ offline cached-shell mount
  (source-verified only, T-6.6); ④ native universal-link modals (T-6.6);
  ⑤ trip create golden path w/ native range picker + destination typeahead
  (T-6.7); ⑥ settings: edit name/destination/dates/theme/currency, stale-409
  two-device conflict, leave (non-owner), delete (owner), owner-leave 409
  copy (T-6.9); ⑦ trip list: pagination past page 1, offline refocus retains
  rows w/ banner (T-6.7). **B-2 note:** press→settle act-stabilization is
  load-sensitive under harsher-than-CI starvation — if act warnings
  resurface under host contention, that's the class.
- **LIVE LANDMINE DIGEST (P-7+ hits these classes — full narratives in the
  archive):**
  - **TanStack v5 drops per-call mutate callbacks for superseded calls** —
    NEVER hang per-call callbacks on a shared mutation instance; use the
    hook-level `onMutationError`/`onMutationSuccess` seam (members.ts +
    trip-settings.ts precedents) or pending-gate every affordance. Bit P-6
    twice (T-6.8 found it; T-6.9 reintroduced it).
  - **KEY-CACHE LAW:** `["trip-list"]` is a disjoint root; NOTHING may live
    under a `["trips", ...]` prefix except the trip-detail subtree the
    guard's 404-scrub evicts. `invalidateTripLists(qc)` is the ONLY
    sanctioned list invalidation. New P-7 keys (itinerary, bookings) must
    join the detail subtree or their own disjoint root — decide at T-7.4.
  - **Conflict latch must be CONSUMED on every terminal path** (re-seed,
    effect, dismiss); invariant: latch armed ⟺ notice visible.
  - **DS Sheet is hit-testable through its ~200ms exit animation** — QUEUE
    row for the DS-level guard; until it lands, every new sheet consumer
    needs its own pending-gate posture.
  - `expect_updated_at` always reads the FRESH context row, never the seeded
    form snapshot.
  - **Server:** write predicates on role-bearing rows PIN the role (EPQ
    re-eval); global lock order users → trip_members → invites (extend, don't
    reorder, if P-7 adds locked tables); cascade lock order = FK-trigger
    CREATION order — fence multi-row deleters with an ordered `FOR UPDATE`
    SELECT; membership INSERTs take the caller's users row FOR SHARE
    (live-only) FIRST; atomic multi-writes use the WS `Pool`/`postgres-js`,
    never Neon-HTTP; timestamptz µs-vs-ms — `date_trunc('milliseconds')`
    for wire equality; raw `Date` params crash postgres-js drizzle `sql`
    templates — bind ISO string + explicit cast; membership aggregates join
    LIVE users only.
  - **Tests:** key-presence authz needs falsy-value pins; observer-less
    cache asserts pin `gcTime: Infinity`; RNTL v14 async-act boundaries
    awaited; server DB suites run `--no-file-parallelism` (Testcontainers
    contention, QUEUE P1).

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

### P-2 — Upfront spec suite (CLOSED 2026-07-10)

- Gates 1+2+3 ALL passed. 18 spec files, ~280 EARS requirements, zero markers.
  `feature-ledger.json` (118 features F-001..F-118) + frozen roadmap P-3..P-14
  in PLANNING § Phase Detail. Notable resolver calls: editors edit/delete only
  their OWN expenses; sole-owner account deletion → 409 transfer-first.
- **Port sources, for archaeology:** `../the-bach` (in-session 5-lane review
  pipeline — its ADR-002 is our ADR-003; commands; hooks), `../get-sean-done`
  (canonical GSD template: doc system, autonomous loop, naming ADRs),
  `../bartling-bachelor` (product exemplar — mobile PWA, design system, itinerary
  UX), `../roi-gen` (STATE discipline), `../seantokuzo-mcp` (rules/hooks patterns).

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

- **Mapbox account + access token** (escalation #3, PARKED — does not block
  the P-7 build; adapters are fixture-driven behind ports). Needed for: live
  travel-leg QA (P-7 phase QA at the earliest) and the P-8 `@rnmapbox/maps`
  SDK regardless. Free tier covers dev (100k Directions requests/mo);
  research run-rate estimate already includes it. QUEUE Blocked row.
- **P-6 phase QA** — sim checklist above (Claude-runnable after dev-client
  rebuild) + Sean's device pass; ledger F-030..F-042 flips after.
- (P-14) buy the universal-link domain.
