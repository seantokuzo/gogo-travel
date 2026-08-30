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

### QA WRAP SESSION 2026-08-30 — device-QA branch merged, polish shipped, S-3 testing overhaul launched

#### Outcomes (all merged to main, full 5-lane pipeline + independent fix verification + fresh judge, each)

- **PR #37 MERGED d4f7637** (qa/device-integration): B-4 Google nonce, B-6 dev error
  surfacing, dev-only request log, B-8 TEMPORARY 12h transport grace + migration 0001,
  seed-qa-places script, 3 ledger flips (F-023/F-044/F-051; **F-043 NOT flipped** —
  criteria 1–2 untested). Round 1: 4 blocking (ADR-002 status enum + 3 mutation-proven
  test gaps: B-8 boundary unpinned both sides, request-log mount wiring zero tests,
  google contract pinned by comments only — the B-4 mock-infidelity class) / 11
  advisory → 5-commit fix leg → verifier EXECUTED every deductive kill-chain to red in
  an isolated worktree (the fixer couldn't — live Metro/tsx-watch on the tree) →
  VERIFIED-CLEAN → judge merge/high. #35/#36 auto-resolved merged (branches contained).
  Escalation banner (sensitive+blocking) note-not-stop per precedent; `/code-review
ultra` remains available to Sean on the merged diff.
- **PR #39 MERGED 8b1ee89** (B-5, P0): `resolveApiBaseUrl` tier 3 derives the Metro
  host from `NativeModules.SourceCode.scriptURL`; `localhost` is now the
  simulator-terminal fallback ONLY; `file://` (release) refused at the `^https?://`
  anchor. ALL-5-LANES-SHIP round 1 (0 blocking / 3 advisory); same-round `@`-userinfo
  hardening fa90229 (guard-parse/fetch-parse agreement by construction);
  VERIFIED-CLEAN; judge merge/high. Follow-ups → QUEUE "B-5 follow-ups" row.
- **PR #40 MERGED dfaba92** (B-10..B-13 polish batch, 4 atomic commits + 2 fix-leg):
  B-10 DateField/TimeField screen-anchored modal picker + contextual seeding (value >
  context > today; flight arrival seeds from departure) — deliberate Modal-not-DS-Sheet,
  rationale in the DateField.tsx header (nested sheet stacks + sheet-tax), token-styled,
  DS dismissal grammar kept; B-11 day-header `+` add affordance (flat row array
  untouched — resolveDrop indices stable); B-12 derived check-in/check-out checkpoint
  indicators, render-only BY DATAFLOW (F-051 c2); B-13 peer Ideas/Cancelled bins,
  hide-when-empty, cancelled reachable via bin (F-043 c3, pinned end-to-end). Two
  pre-existing pins AMENDED and proven EQUIVALENT-OR-STRONGER (15 executed mutation
  probes; the old pins' exact regressions still red). Fix leg: spec synced to the
  Sean-ruled surfaces (R-itin-12/15/31, §2.3/2.6/2.9 — the spec had begun contradicting
  shipped behavior, a Law #4 revert hazard) + 4 caller seed pins + ISODate brand. One
  pushback UPHELD by the verifier (trip-settings seed pin unwritable — unrepresentable
  state). Judge merge/high. Mobile now 149 suites.
- **PR #38 OPEN — S-3 testing-overhaul strategy** (docs-only: ADR-006 _Proposed_ +
  `.specs/testing/testing-overhaul.spec.md`). **Held for Sean's read** — merging locks
  the ADR (doc-homes append-only), and it carries three Sean questions with parkable
  defaults recorded: B-7 ruling (suite pins it `it.fails` either way), diagnostics
  entry placement (deeplink-entry until ruled), generated-vs-committed test env keys
  (rec: generated). **W1 ✅ MERGED 2026-08-30 — T-S3.1 (PR #41, 0643621: faithful env +
  boot-shape suite) ∥ T-S3.2 (PR #42, aaf0742: mock-fidelity contracts — found a real
  mock fiction at rest, StyleURL v11-vs-v10). Server 62 suites / 857; mobile 151 / 1468.
  W2 DISPATCHED: T-S3.3 shared-PG fresh-DB (server) ∥ T-S3.5 device-smoke diagnostics
  panel (mobile). Narratives: QUEUE Recently-done rows.

#### The rig — Sean's steps, in order

1. **Kill + reopen the app** — Metro now serves merged main; B-5/B-6/B-10..13 reach
   the device as JS-only changes (no rebuild).
2. Verify sign-in + any server call. **THEN** delete `EXPO_PUBLIC_API_URL` from the
   gitignored `apps/mobile/.env` and restart Metro — tier 3 derives the host from the
   dev server now; the DHCP-fragile hardcode is retired.
3. Server/Neon/Docker unchanged; migration 0001 was already applied to Neon during
   the 2026-08-29 session.

#### Sean device-QA checklist (ledger-exact wording — no paraphrase)

- **F-043 criteria 1–2 (still untested; do NOT flip on less):**
  1. "create one booking per category" — `car_rental`, `moped_rental`, `activity`,
     `other` have never been created (flight/lodging/restaurant/train exist). Also
     untested: invalid detail shape → 400; price requires currency.
  2. category change on update rejected; instants denormalize from details.
     (Criterion 3 was evidenced 2026-08-29 — cancelled "Imperial Hotel Tokyo".)
- **B-10 one-tap check** (PR #40 correctness advisory): open a picker whose seed
  pre-highlights the wanted day (flight arrival after entering departure) and tap that
  highlighted day ONCE — does it commit? iOS inline pickers fire change only on VALUE
  change; if the tap no-ops we add a Done affordance. Recovery cue exists (field still
  reads "Select date").
- **Polish golden paths:** B-10 both date fields open full-width + seeded · B-11 add
  via the day header on a POPULATED day · B-12 stay shows check-in/check-out
  indicators that tap through to booking detail · B-13 bins hidden when empty,
  cancelled reachable by expanding Cancelled.

#### Still-true landmines carried forward

- **Device data is known-wrong (B-8 class):** every booking entered before the tz fix
  carries instants offset by the real timezone ("LAX => NRT" stores 2h49m for an ~11h
  flight). Re-enter after B-9 (airport table + IANA tz); don't trust itinerary
  ordering or leave-by math against them. The 12h grace + migration 0001 are
  TEMPORARY and revert TOGETHER when B-9 lands (that revert is the B-8 row's DoD).
- **B-7 (P0) is BLOCKED on a Sean spec ruling** (Autonomy Contract #1/#6): text-only
  destination vs self-seeding first search — options in the QUEUE row.
  `seed-qa-places.mjs` remains the QA workaround (now `--force`-guarded +
  owner-scoped).
- **Ask the ledger's exact criteria, never a paraphrase** (the 2026-08-29 session's
  repeated failure mode — deliberately preserved here).

### P-8 — Maps, saved places & offline tile packs (CODE-COMPLETE 2026-08-23 — pk token LANDED 2026-08-29; PHASE QA + F-055..F-062 FLIPS now RUNNABLE, device-gated on Sean)

- **Scope** (PLANNING § P-8): @rnmapbox/maps themed map, 3 pin families +
  clustering + day filter, place sheet/detail w/ spine data + dormant fresh
  seam, spine-backed search, foreground-only location, offline
  StylePacks/TileRegions w/ hygiene, map↔itinerary cross-nav. Scoped
  2026-08-15: 6 tasks T-8.1..T-8.6 (+T-8.7 integration rider, added at
  W3 close), ledger F-055..F-062, ~5 PRs, **ALL
  BUILDS TOKENLESS** (SDK download auth dead — pk token = Sean item at
  phase QA).
- **Wave plan:**
  - **W1 ✅ DONE 2026-08-15 — T-8.1 MERGED a40ea7f (PR #21) ∥ T-8.6 MERGED
    30caa40 (PR #20).** T-8.1: place detail + saved-places CRUD [PL-3,
    PL-4] — FIRST all-5-lanes-ship round 1 on a functional PR (0 blocking/6
    advisory, one fix leg a0fe8bb, verifier VERIFIED-CLEAN, judge
    merge/high; server 717→720). T-8.6: maps/location/network deps + config
    plugins w/ the foreground-only lock + `mapColors`/`mapDayColors` tokens
    (1 blocking filing gap + 5 advisory, fixed 30300cd, verifier
    VERIFIED-CLEAN, judge merge/high; tokens 322→323). Full narratives:
    QUEUE rows.
  - **W2 ✅ DONE 2026-08-18 — T-8.2 MERGED 08e656c (PR #23).** Map shell
    [MAP-1]: themed MapView, 3 clustered pin families, span-aware day
    filter, camera-fit w/ zero-span collapse, 3 frozen seams
    (sheet+onPinSelect → T-8.3 · offline pill → T-8.5 · trip-scoped
    pending-focus → T-8.4). 1 round + 1 fix leg + independent
    verification + targeted conventions r2 + judge merge/high; mobile
    1011→1097. Full narrative: QUEUE row. **Judge merge condition:** the
    interp-#1 pin-coverage structural closure is a named QUEUE Blocked
    row (P1, Sean spec pass) — rule BEFORE the phase closer.
    (Hermes/dedup chore also done — PR #22, 293d0ef; QUEUE row folded.)
  - **W3 ✅ DONE 2026-08-19 — T-8.3 MERGED c5e0b13 (PR #24) ∥ T-8.4
    MERGED 510d06b (PR #25).** T-8.3 [MAP-2, MAP-4]: sheet slot filled +
    geo-bound spine search + full R-map-16 lazy-permission machine +
    consume-once camera intent — 2 blocking (both test-pin gaps) / 12
    advisory, fix leg 429d84f+c25d4df, VERIFIED-CLEAN 7/7, judge
    merge/high; 116→129 suites / 1184. T-8.4 [MAP-3, MAP-6]: place detail
    screen (fresh seam STRUCTURAL) + saved-places mutations + per-kind
    linked-item reroute (the round's one blocker) + the
    place-fresh-persistence CI guard — 1 blocking / 9 advisory, fix leg
    daddb60+8bc0f30+64da0e1, VERIFIED-CLEAN 7/8 exact, judge merge/high;
    135 suites / 1243 tests. Full narratives: QUEUE rows. W3's
    reported-not-taken escalations accumulate into **T-8.7 (integration
    rider — QUEUE Active row); R-map-17's ledger row must NOT flip until
    it lands (judge-recorded)**.
  - **W4 ✅ DONE 2026-08-23 — T-8.7 MERGED 149b014 (PR #26) 2026-08-19 ∥
    T-8.5 MERGED 2c43848 (PR #27) 2026-08-23.** T-8.7: the W3 escalation
    accumulator delivered 9/9 (E1–E5 wiring, R-map-24 centering, telemetry
    OFF prod-real, distance-on-detail, both copy fixes); the round survived
    the session-limit interrupt (2 sentinels preserved, 3 lanes re-run
    fresh); 135 suites / 1289. T-8.5: §2.5 pack machine (pure module) + the
    ONE offlineManager/expo-network controller seam + MMKV annotation
    hygiene + pill/settings surfaces; **142 suites / 1348 tests on the
    fully-integrated tree**. Both 1-round + fix leg + VERIFIED-CLEAN +
    judge merge/high. **The merged-tree gate caught a REAL #26/#27 test
    contradiction** (#26's telemetry pins asserted the global mock omits
    the method; #27 delivered exactly that mock line — green on both
    branches, contradictory merged; the coordination tripwire fired exactly
    as designed; repaired equivalent-or-stronger w/ per-file registries,
    judge-affirmed). Full narratives: QUEUE rows.
  - **PHASE-QA ATTEMPT 2026-08-15** (the rebuild leg of W2's plan): the ONE
    dev-client rebuild ✅ **PASSED on main@293d0ef** — prebuild + CocoaPods
    clean (the feared Mapbox-SDK pod failure did NOT occur); bake verified
    in the built dylib (RNMBX ×244, RNDateTimePicker ×36, ExpoNetwork,
    MapboxCommon/CoreMaps/Turf/ExpoLocation frameworks, hermes-engine
    250829098.0.16); native smoke PASS (dtp real UIDatePicker · network ·
    location get-not-request no-TCC · clipboard seam round-trip); tokenless
    MapView = blank canvas + 401 MapLoad, documented expected state. BUT
    **all P-6 ①–⑦ + all P-7 checklist legs BLOCKED(creds)** — T-6.6 retired
    the "Open sample trip" dev door, no auth bypass exists (JWKS-verified
    sign-in only, no session seeding, server boots health-only without auth
    env), no tap automation. **ZERO ledger flips** (Law #7 — partial engine
    evidence only for F-052 picker module + F-054 copy engine, below the
    bar). **Sean ruling 2026-08-16: QA PARKED ("park QA, keep building")
    — no pending decision**; both unblock options — **(a)** drop the
    OAuth/server env → QA runs signed-in, or **(b)** approve a `__DEV__`
    session door (Autonomy Contract trigger #4) — stand recorded (QUEUE
    row) for whenever QA resumes. Evidence:
    `.tmp/qa-2026-08-15/MANIFEST.md`. Metro left running; rebuilt app
    installed on sim A6D3CE7C.
- **P-8 CLOSE SUMMARY (2026-08-23):** 7 build tasks + the Hermes chore, 8
  PRs (#20–#27), every review round-1-only (sole addendum: T-8.2's targeted
  conventions r2). Mobile 1011→**1348 tests** / 107→**142 suites** across
  the phase. **102 interpretations** recorded to the spec-pass batch (QUEUE
  Blocked row, now W1–W4 / PHASE COMPLETE). Committed follow-up rows filed
  (QUEUE Active): R-map-18 activation-mount ruling (P1, Sean) ·
  deliberate-camera-writer fit-sweep · keystroke pin-strobe + typeahead
  debounce · post-merge comment hygiene · remote-pack-deletion gap. Phase
  QA = the pk-token-gated checklist row (QUEUE Active, blocked) —
  F-055..F-062 flips pending; ledger verified byte-untouched through all 8
  PRs. **NEXT: P-9 (money) per the frozen roadmap — roadmap-prep pending
  Sean's go (P-9 is a SENSITIVE path: payments/splitting, auto-escalated
  reviews, Law #2).**
- **Key rulings** (six — PLANNING § P-8 Prep bullet; brief:
  `.tmp/p8-readiness-brief.md`): focusPlaceId = pending-focus store;
  warm-session offline bar — NO TQ persister; photo pins fixture-tested,
  empty-in-prod till P-12; config-swap default Mapbox styles; token at
  phase QA.
- **File-ownership note:** T-8.1 owns `apps/server/src/places/**` +
  `packages/shared` place domain + schema/migration; T-8.6 owns
  `apps/mobile` package.json/app.json + `packages/tokens` + lockfile —
  disjoint by construction.

### P-7 — Itinerary & bookings (CODE-COMPLETE 2026-08-10 — PHASE QA + F-043..F-054 FLIPS PENDING)

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
- **W6 ✅ T-7.9 MERGED a572947 (PR #19) 2026-08-10 — P-7 CODE-COMPLETE**
  (all 9 tasks, PRs #11–#19; full round narrative: QUEUE row). Booking/item
  detail + offline degrade; the cancel flow pinned end-to-end into
  `reconcileBookingRow`'s removal arm (survived 2 novel verifier probes).
  Mobile 898→**1011 tests / 107 suites**. 1 round + 1 fix leg (9e15a28 prod +
  e8c63f9 tests) + independent verification, judge merge/high. R1: 2 blocking
  (BOTH detail screens' R-itin-29 offline arms UNPINNED — a 5-way gap mutation
  stayed 66/66 green against the PR's explicit both-screens claim; snake_case
  `-field-{key}` testIDs forking the §2.7 kebab inventory) + 9 advisory —
  8 fixed, ONE defer (offline signal blind to mutation-cache transport
  failures → QUEUE row; rides the interp-15 measured-connectivity escalation).
  `refresh-legs` inherited deferral CLOSED WON'T-BUILD (§2.10 names day-of leg
  refresh verbatim; R-ib-23 covers online; R-itin-6 forbids the affordance —
  citations lane-verified). **NEW LANDMINES:** held-in-flight pins must
  collect deferred resolvers in an ARRAY (single slot strands the 2nd fire and
  WEDGES the file instead of going RED — now in mobile.md); the deeplink
  return-record store is device-local MMKV shared ACROSS trips — any clear
  path must be role/context-guarded (fixer's failed-open guard, verifier-
  validated). Large-diff escalation banner fired (3348 adds) — PR #16
  note-not-stop precedent; `/code-review ultra` stays available on the merged
  diff, Sean-triggered. **NEXT: phase QA — batch P-6 checklist ①–⑦ + P-7
  checklist in ONE dev-client rebuild + sim session → F-030..F-054 flips.**
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
- **PHASE-QA CHECKLIST (run on sim before ledger flips; rebuild precondition
  ✅ MET 2026-08-15 — dev client rebuilt on main@293d0ef, datetimepicker
  baked; the blocker is now CREDS, not the build — no signed-in path on sim;
  QA PARKED by Sean 2026-08-16 — the (a)/(b) unblock options stand recorded
  in the P-8 PHASE-QA ATTEMPT bullet + QUEUE row):** ① two-account collab loop:
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

- **P-9 ROADMAP-PREP COMPLETE 2026-08-24** (wave plan + headlines: PLANNING
  § P-9 Prep bullet; full readiness brief: `.tmp/p9-readiness-brief.md`).
  No migration owed; MON-1 math pre-built in shared; owed = 4 server
  routers + descriptors + minor-unit helpers + 3 client tasks + T-6.1
  TOCTOU rider. **ALL 3 RULINGS LANDED 2026-08-25 (Sean decision pack,
  recs accepted):** ① all money forms default `trip.base_currency`;
  ② shared ISO-4217 minor-unit helpers in T-9.1 (hand-rolled list) +
  call-site swap rider, dev booking data uncorrected; ③ FX = keyless
  Frankfurter v2 behind a thin Hono `GET /fx/rate` per-day-cache proxy
  (escalation #3 satisfied — no account, no key, $0; client fetches OUR
  endpoint). Send-the-bill links ship `gogo://` primary + placeholder
  https until the P-14 domain purchase. **W1 ✅ DONE — T-9.1 MERGED
  cf6f991 (PR #28) 2026-08-26**: 1 round + fix leg (4 blocking — 3
  security caps-class + 1 tests save-site-currency-wiring, mutation-
  proven — / 6 advisory, all fix-now, zero pushback), verifier
  VERIFIED-CLEAN 10/10, judge merge/high; shared 484 / mobile 1355;
  escalation banner (sensitive+blocking) note-not-stop, `/code-review
ultra` available on merged diff. Full narrative: QUEUE Recently-done
  row. **W2 ✅ DONE 2026-08-26 — T-9.3 MERGED 6b109cf (PR #29) ∥ T-9.2
  MERGED fcdabf4 (PR #30); merged-tree gate GREEN (server 60 files/817 =
  720+47+50 exact; mobile 1355).** Headline: a CROSS-PR SPLIT DISPOSITION
  (#29's blocker root-caused in #30's file, fixed there mutation-proven,
  both judges verified the other half) + a NEW server landmine (no-cycle
  lock proofs must audit IMPLICIT FK KEY-SHARE locks). Both 1 round + fix
  leg + VERIFIED-CLEAN + judge merge/high; narratives: QUEUE rows.
  **W3 DISPATCHED 2026-08-26: T-9.4 (settle-requests + budgets + fx proxy
  - the QUEUE obligations row: settlements mount · page-size hoist ·
    lock-chain doc sync · budgets trips-first order) ∥ T-9.5 (money tab
    shell + balances segment, mobile) — server∥mobile disjoint, worktrees.
- **GOOGLE SIGN-IN WORKS ON DEVICE 2026-08-29** — first real authenticated
  session on hardware. Evidence: `[req] POST /api/auth/google -> 200 (853ms)`
  in the dev server log, Neon shows `users 1 / auth_sessions 1 /
refresh_tokens 1`. It took THREE stacked bugs, each hiding the next — the
  order matters, because fixing them out of order looks like no progress:
  1. **B-4 (fixed, PR #35)** — `expo-auth-session` never mints a nonce on
     native, so our payload builder bailed and the app never called the
     server at all. See the nonce note in `apps/mobile/src/auth/google.ts`.
  2. **B-5 (OPEN, P0, QUEUE row)** — `resolveApiBaseUrl()` fell through to
     `http://localhost:3000`, so the phone called ITSELF. Google sign-in was
     fully working by then — valid `id_token` in hand — and the POST just
     went nowhere. Breaks EVERY device→server call. Worked around with a
     hardcoded `EXPO_PUBLIC_API_URL` in the gitignored `apps/mobile/.env`;
     that override MUST come out when B-5 lands (it dies on a DHCP change).
  3. **B-6 (OPEN, P1, QUEUE row)** — a bare `catch` in `sign-in.tsx:141`
     discarded every real error behind one generic banner, which is why #2
     read as an OAuth problem for two rounds.
  - **Method note worth keeping:** the miss that cost the most was verifying
    reachability by curling the server FROM THE MAC. That proved the server
    was up; it proved nothing about what the phone was dialing. For any
    device-side network failure, log the resolved base URL on the DEVICE
    first — it is one line and it is the whole answer.
  - Observability gap closed the same day: `apps/server/src/http/dev-request-log.ts`
    (PR #36) — the server previously emitted ONE log line total, so "rejected"
    and "never arrived" were indistinguishable. `no-console` never blocked
    this; the root eslint config allows `warn`/`error`.
- **ENV + DEVICE RIG FULLY GREEN 2026-08-29 — supersedes the BLOCKED(creds)
  status below.** Sean walked the env setup; everything signed-in is now
  unblocked. Landmines found and fixed (do not re-derive):
  - **Neon DB was EMPTY** — the URL connected fine (pooled endpoint,
    `sslmode=require&channel_binding=require`, PG 18.6) but migrations had
    never run. `pnpm --filter @gogo/server db:migrate` → 30 public tables +
    `drizzle.__drizzle_migrations`. A green connection probe is NOT proof of
    a migrated schema — check `information_schema.tables`.
  - **`AUTH_ES256_PRIVATE_KEY` had been pasted without its PEM armor**
    (184 ch, zero newlines = the bare base64 DER body) → `createPrivateKey`
    fails `DECODER routines::unsupported`. Canonical form is the WHOLE PEM as
    a `\n`-escaped single line in double quotes, ~241 ch. Node's
    `--env-file` expands `\n` to real newlines itself, and `pem()` in
    `auth/wire.ts` normalizes the other case — either survives.
  - **Auth env is ALL-OR-NOTHING across 8 vars and a PARTIAL set THROWS at
    boot** — it does NOT fall back to health-only (`buildAuthDepsFromEnv`).
    The 4 Apple vars carry deliberate THROWAWAYS (real P-256 key + 32-byte
    AES) so the gate clears for QA; Apple code exchange fails by design until
    the real portal setup at P-14. `ios.usesAppleSignIn` deliberately NOT
    added — the entitlement needs a real App ID with the capability.
  - **Bundle id `com.anonymous.gogo-travel` → `app.gogotravel`** (PR #33,
    036dac9) — Sean bought `gogotravel.app`. The AASA drift guard
    (`link-config-audit.test.ts:69`) caught the stale artifact in CI, exactly
    as designed. `app.json` `associatedDomains` still points at the
    `links.gogotravel.example` placeholder — now that the real domain is
    owned, the P-14 `LINK_DOMAIN` swap is unblocked early.
  - **`expo-auth-session@57.0.5` builds its native Google redirect as
    `${bundleId}:/oauthredirect`, NOT the reversed client id**
    (`build/providers/Google.js:145`), and prebuild already registers the
    bundle id as a `CFBundleURLScheme` — so a bundle-id rename needs zero
    `CFBundleURLTypes` work. Verified in `node_modules`, not training data.
  - **Verification evidence (config-level; the tap is Sean's):** Google
    authorize probe ACCEPTED `app.gogotravel:/oauthredirect` (302 → sign-in)
    and REJECTED `com.anonymous.gogo-travel:/oauthredirect` (302 →
    `/signin/oauth/error`, `authError` decodes to `redirect_uri_mismatch`) —
    a discriminating control, not a one-sided pass. Unsigned-JWT POST to
    `/api/auth/google` → **401 UNAUTHENTICATED, not 500**, proving jose
    fetched Google's JWKS and the whole verifier chain executes. Metro's
    served bundle (12.7 MB, `/.expo/.virtual-metro-entry.bundle?platform=ios`
    — NOT `/index.bundle`, which 404s under expo-router 57) contains all
    three `EXPO_PUBLIC_*` values inlined and no trace of the old bundle id.
  - **Mapbox pk token landed in BOTH envs** (`MAPBOX_ACCESS_TOKEN` server +
    `EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN` mobile) — the boot warning is gone.
    **The P-8 "pk token deferred to phase QA" park is RESOLVED**, unblocking
    F-055..F-062 map QA.
  - Rig now: LAN `192.168.1.69` (was `.23`), server `:3000` auth-mounted +
    Neon-backed, Metro `:8081` `--clear`, app installed + launched as
    `app.gogotravel`. `.env.example` rewritten against `src/env.ts` (it had
    only ever documented `DATABASE_URL`).
- **DEVICE-QA RIG LIVE 2026-08-24 (Sean unparked QA — backlogged P-5..P-8
  device pass):** dev client compiled for Sean's iPhone 15 Pro
  (`DerivedData-device`, arm64, RNMBX baked ×967, signed 4B8499Z59P, main @
  54f1c0e); Metro running LAN (192.168.1.23:8081; API URL auto-derives via
  hostUri → :3000/api). **INSTALLED + LAUNCHED on the iPhone 2026-08-26**
  (Developer Mode enabled by Sean; devicectl over LAN — note: first install
  attempt post-Dev-Mode-reboot hit "connection reset by peer", immediate
  retry succeeded — known-transient while the tunnel re-establishes); app
  serves the POST-#28-MERGE bundle (shared+tokens dist rebuilt after main
  sync — Metro resolves dist, not src); server on :3000 still
  HEALTH-ONLY (probed — auth env not loaded), so all signed-in legs remain
  BLOCKED(creds) until Sean drops server auth env + mobile Google client id
  (exact vars in the QA artifact). QA checklist artifact published
  (P-5→P-8 run sheet, ledger-tagged, expected-states documented).
- **P-8 ROADMAP-PREP COMPLETE 2026-08-15** (rulings + wave plan: PLANNING
  § P-8 Prep bullet; full readiness brief: `.tmp/p8-readiness-brief.md`).
  Sean rulings: ONE dev-client rebuild (T-8.6 absorbs the datetimepicker
  obligation) with **P-6+P-7 sim QA running ∥ P-8 W1 review**; Mapbox pk
  token deferred to P-8 phase QA (builds are tokenless — download auth dead);
  default Mapbox styles behind config swap. W1 DISPATCHED 2026-08-15
  (Sean buy-in) (T-8.1 server ∥ T-8.6 scaffold).

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
