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

### SESSION 2026-09-13/14 — B-7 CLOSED, B-28 done, S-4 door server+mobile merged, teardown fix, spec-pass round 2, feature-batch spec

Sean (director of product) ruled several parked spec questions in-session;
PR #72 (S-4 wave 2 session-door contract) merged.

**Rulings:** B-7 — bootstrap city/locality tier (Overture
`divisions`/`locality`, release `2026-08-19.0`, cut `population ≥ 100k OR
sovereign capital`, 6,927 rows, one-time snapshot posture like airports) +
parquet URLs + custom places as a permanent first-class fallback;
custom-destination UX = inline empty-results row in the picker (no map-drop
this pass) — three-part build split on the QUEUE B-7 row (part 3, nullable
coords, queued behind #75). Feature batch (2026-09-06): spec now (PR #71),
build after sign-off. Spec-pass: one consolidated doc (PR #70, ~300 items,
Sean still to rule). `.claude/agent-memory/`: gitignore + untrack (rides PR
#70). S-4 session-door design: all four recs approved (door-free build only
on door-touching PRs + phase close; client secret build-inlined, never in
the URL; unique fixture `user_key` per run, no destructive reset;
loopback/private socket-peer gate). PR #72 round 5 authorized; ultra review
waived.

**PR map:** #67 B-26 booking-form UX (r2) · #68/#69 B-27 safe-area +
modal-pin fixes (MERGED pre-session, device confirm owed) · #70 spec-pass
round-2 doc (open, Sean to rule) · #71 itinerary-evolution spec batch (open,
pending sign-off) · #72 S-4 wave-2 session-door contract (**MERGED
`178fc52`** — 5 rounds, security closed 5 blocking spec holes in r1) · #73
B-7 part 2 mobile custom destination (r2) · #74 B-28 migration-state check
(r1 fixes) · #75 B-7 part 1 server destination tier (r1 fixes). S-4 T4
(mobile door, `S-4/session-door-mobile`) in-progress; T3 (server) queued
behind #74; T5 (flows) queued behind T3+T4.

**Failed approaches (don't re-walk):** (1) shared PG container `afterAll`
teardown hit a 10s hook timeout under concurrent worktree `pnpm test` runs
(load 100–300); a standalone run stayed clean — fix is raise the timeout or
make the drop fire-and-forget, seen by four agents today. (2) A fresh
worktree's first `pnpm install` reported `FULL TURBO` for
lint/typecheck/build — a false cache hit; gate numbers must come from
`--force` runs.

**Infra:** Docker Desktop stuck in a `vmnetd` admin-password prompt loop —
fixed by Sean at the host level.

**Blockers updated below:** adds PR #70/#71 sign-offs, the sub-floor
search-name question, B-27 device confirmation; removes
`.claude/agent-memory/` and `chore/doctor-cleanup-review-loop` (merged PR
#65, 2026-09-09).

#### 2026-09-14 continuation — 8 more PRs merged (B-7 CLOSED, B-28 done, S-4 T3+T4 door merged, teardown fix)

Ten PRs closed out the 2026-09-13/14 session in total: #72 (S-4 wave-2
contract, covered above) and #76 (`chore/queue-sync-2026-09-13`, the first
docs-sync pass), plus eight more merged 2026-09-13/14:

- **#67 `b0e264b`** (B-26 booking-form UX) — scrollable zone picker in a
  PickerCard modal, required markers derived from shared Zod, real save
  errors mapped to fields, scroll-to-banner. Two review rounds; a round-1
  regression (keyboard avoider swallowed scrim taps) caught by the
  fix-verifier, fixed with `pointerEvents="box-none"`. Closes half of B-8's
  SECONDARY; the shared-schema ordering half stays deferred (R-shared-7).
  Accepted residual: a landscape-small window + open keyboard leaves the
  list tail under the keyboard. Device pass still owed (jest can't
  hit-test). A pre-existing `GridSurface.test.tsx` act-warning contention
  flake was seen once (new P3 QUEUE row).
- **#73 `51decf1`** (B-7 part 2, inline custom destination) — same-name race
  guard on `selectedPlace`, search-cache invalidation with a prod-staleTime
  pin.
- **#75 `a5e8a98`** (B-7 part 1, destination tier) — Overture
  `divisions`/`locality` release `2026-08-19.0`, cut `population ≥ 100k OR
sovereign capital`, 6,927 rows, migration 0004, capital arm via
  `capital_of_divisions subtype='country'` (Vatican absent — not an Overture
  locality). Two rounds + a NUL-byte guard fix; the round-1 fix introduced a
  test that imported the generator script's top-level I/O (live S3 + rewrite
  of committed JSON during `pnpm test`) — caught by the fix-verifier, fixed
  with a pure module + main-guarded CLI. **Landmine:** scripts with
  top-level I/O must never be imported by tests; 4 other
  `apps/server/scripts/*` files still have top-level I/O (new P3 QUEUE row).
- **#80 `e273e56`** (B-7 part 3, incl. #81 `578745a` merged into its branch)
  — nullable coords for custom places + trips (Option A), migration 0005.
  **B-7 is now CLOSED** (all three parts), pending Sean's device
  confirmation. Its adversarial review lane ran against a superseded head
  and its output was discarded by the judge; its PR body's S4/S5 matrix cell
  mislabels the `<`→`<=` mutation probe as a "fix" (it was the probe, not a
  fix).
- **#74 `40e23a3`** (B-28 migration-state check) — drift detection by set
  difference, `/health` wiring (`pendingCount`, `checkedAt`, dev-only tag
  names, 30s single-flight refresh), diagnostics leg, real subprocess arm
  for the dev refuse. Two rounds (round-1 watermark bug reproduced on real
  PG; round-2 edited-after-apply + unbounded `/health` regressions).
  **B-28 done.**
- **#78 `d53d69d`** (`chore/pg-teardown-timeout`) — bounded/tolerant
  `drop()` (12s `statement_timeout`, discriminating tolerance:
  57014/CONNECTION_*/ECONNREFUSED/ECONNRESET only), vitest `hookTimeout`
  30s; induced-load repro 9/8/10 → 0/0/0.
- **#79 `b6b6a39`** (S-4 T3, server session door) — positive opt-in env
  gate, IP-literal peer gate first, 4 KiB body cap, constant work on every
  rejection, byte-identical 401s (headers too), fixture-cleanup CLI,
  trip-delete core extracted from the route. One round; recovered from a
  masked-merge-failure incident (see landmines below) by restoring the
  branch from its SHA.
- **#77 `4025dc1`** (S-4 T4, mobile session door) — `gogo://e2e-session`
  route, triple client gate (secret ≥32 inlined, private API base, installed
  bundle id `.e2edoor`), prebuild-based `ios:door`/`ios:doorfree` scripts,
  reset-before-mint pinned. Two rounds; an AuthGate change was REVERTED at
  the orchestrator's decision (unfalsifiable auth-routing change — Autonomy
  #4). **S-4 T3+T4 done; T5 (`S-4/session-door-flows`) now in progress** —
  `--variant` lane defaults, evidence copy, flows 5–10 +
  `session-door-absent`; the reference-search E2E row rides it.

**New landmines (don't re-walk):**

1. **Masked merge failure** — `gh pr merge … | tail && … git push --delete`
   deleted a branch after a conflicting merge because the pipe hid the exit
   code; recovered via `git branch <b> <sha> && git push && gh pr reopen`.
   Rule: check MERGEABLE/CLEAN first, never pipe the merge, delete the
   branch in a separate step gated on state MERGED.
2. **Worktree-isolated agents cannot write into the main repo's `.tmp/`** —
   records come back in reports instead.
3. **Fresh-worktree `FULL TURBO` false cache hits** persist as a pattern —
   quote `--force` numbers only (restates the 09-13 daytime finding above).
4. **`expo run:ios` skips prebuild when `apps/mobile/ios/` exists** —
   bundle-id changes in `app.config.ts` need `expo prebuild` (the
   `ios:door`/`ios:doorfree` scripts do it).
5. **Test files importing a script with top-level I/O ran live network and
   rewrote committed data during `pnpm test`** (see #75 above).

**QUEUE sync:** B-7 and B-28 Active rows flipped `done`; the ID-less
migration-state row and the shared-PG-container teardown row both flipped
`done`; 5 new Recently-done narrative rows added (B-26, B-7, B-28,
PG-teardown, S-4 T3+T4); 8 new P3 follow-up Active rows filed (B-28
follow-ups, PG-teardown follow-ups, `apps/server/scripts/*` top-level-I/O
landmine, B-26 residuals, S-4 mobile-door overlapping-opens flake, B-7/#80
deferred follow-ups, `trips.destination_place_id` parked/deferred, B-7/#75
spec gaps).

### DEVICE QA SESSION 2026-09-11/12 — PR #66 merged (trip-switcher exit); B-19 confirmed fixed on device; migration-gap incident filed; PR #67 open

Sean ran device QA against `main` (`427bf08`) on his own phone, 2026-09-11
into 2026-09-12. Two PRs came out of it, plus a concrete process failure
worth its own landmine.

- **PR #66 `427bf08`** (B-25 — trip-switcher exit + error-path exit,
  merged): `TripSwitcherBar`'s `activeTrips.length < 2` gate is gone — the
  bar renders on every trip screen, and its sheet now lists every trip (not
  just active ones) via an "All trips" row that replaces to `(trips)`.
  Round-1 fix (`0dd855e`) corrected a blocking finding: the dominant entry
  path (`(trips)/index` → `router.push`) needs `router.dismissTo`, not
  `router.replace`, or leaving a trip stacks a second, phantom trip list.
  `TripErrorState` also gained a "Back to trips" exit. Several review
  findings were deferred rather than blocking — see the new QUEUE rows
  below.
- **PR #67 `B-26/booking-form-ux` — OPEN, NOT merged.** Fixes the
  time-zone picker's unscrollable 12-row cap (moves search+list into a
  `PickerCard` modal with a real `FlatList`), widens zone-name matching
  (accents, hyphenated IANA ids), adds required-field markers derived from
  the shared Zod schemas, and maps server/client validation failures onto
  the field that owns them instead of a generic banner (closes half of
  B-8's SECONDARY; the client-side ordering pre-check half stays open,
  Autonomy #6 scope call). Not device-verified; awaiting review.
- **Device QA — B-19 CONFIRMED FIXED.** First device confirmation of the
  itinerary-freeze fix (PR #60 `ef241ef`, the RNScreens foreign-modal
  wedge). Sean: "Freeze is fixed." QUEUE row flipped to `done`. This does
  not itself flip a feature-ledger row (B-19 was a bug fix, not a
  ledger-tracked feature) — but it clears the itinerary-freeze blocker that
  stood in front of the P-7 phase-QA ledger pass (F-043..F-054, still
  pending per QUEUE/Blockers), and is the evidence to cite when that pass
  runs.
- **Device QA — airport/airline reference search CONFIRMED WORKING** once
  Sean's dev DB was brought current (see the new landmine below).
- **Remaining findings, filed as new QUEUE Active rows:** a doubled top
  safe-area inset now universal on every trip screen since PR #66 removed
  the 2-active-trips gate (P2, needs Sean's device eyes on the fix);
  `.specs/client/navigation.spec.md` R-nav-23/§2.1 still describe the old
  2+-active gate (P2 spec-sync); `TripSwitcher.tsx`'s `ScrollView` +
  `.map()` over up to 100 rows (P3, deferred from #66 review); a flaky
  `money-screen.test.tsx` in-flight-PUT pin, characterised as pre-existing
  and NOT a #66 regression (P3); the reference-search E2E gap feeding S-4
  wave 2 (P1); and a migration-state check (P1, see below).
- **B-7 re-confirmed from the opposite side.** Sean hit the places
  cold-start deadlock again, this time saving a new trip rather than
  searching for a place: "we don't allow saving the trip if we don't find
  the location ... we only have a few hardcoded" (the 20
  `seed-qa-places.mjs` rows). Same root cause as the original filing, now
  confirmed from both directions. QUEUE row updated; still `blocked` on
  Sean's spec ruling; flagged as next session's work.

#### NEW failed-approach landmine — migration-state drift is silent end to end

Sean's dev DB was **two migrations behind** (`0002` — 4,133 airports + 893
airlines seed; `0003` — re-tightens the booking `NOT VALID` CHECK) for an
entire QA cycle before anyone noticed. **Nothing caught it:** the server
booted clean (no migration-state check at boot), the client gated and fired
its reference-search calls correctly, and CI was green (CI runs migrations
fresh every time, so a stale _local_ DB is invisible to it). The only
symptom was every airport/airline/flight-lookup search returning a 500 with
no signal anywhere pointing at "your DB is behind." Filed as a P1 QUEUE row
(migration-state check): a boot-time WARN or refuse-to-serve in
`development` on pending migrations > 0, and/or a `gogo://diagnostics` leg
reporting applied-vs-on-disk migration counts.

### REVIEW LOOP CLOSE-OUT 2026-09-07/08 — all seven PRs merged (#58–#64); B-8 CLOSED end to end; E2E lane live

Continuation of "REVIEW WAVE 2026-09-07" below (#58 `67055a1` / #60 `ef241ef`
merged there; #59/#61/#62 were STILL OPEN at that point). Every remaining PR
landed through the full local review loop (panel picked from the diff,
triage, independent fix verification, fresh judge), and two more PRs (#63,
#64) opened and merged in the same window. #58/#60 unchanged from that
section — see it for their full narrative; not repeated here.

- **PR #62 `89a664b`** (B-9 client half — airport/airline pickers + real
  per-endpoint timezones, closes B-8's client side): airport/airline
  typeahead pickers carry each endpoint's IANA zone into the paired time
  field, an always-visible zone picker, flight-number→airline inference, and
  a hard refusal to save a zoned time with no zone (no `Z` fallback). No new
  dependency — Hermes ships full ECMA-402 `Intl` on both platforms. 5 lanes →
  2 blocking, both fixed: an airport swap did not invalidate its zone (pick
  NRT → clear → type LAX saved origin LAX with a Tokyo zone, silently ~16h
  wrong; worse on edit, where a stale `raw` re-emitted the old offset); the
  composition core had only ever run on Node/V8's full-ICU `Intl`, never the
  shipped Hermes — with all three defensive gates removed, 60 of 120 sampled
  wall-hours composed a well-formed WRONG offset (not null, not a throw).
  Fix: three gates (`isIntlFaithful()` engine self-check, tzdb-range check,
  gap-signature check) plus a Hermes-Apple-shaped stub test suite. An
  independent re-verification later corrected the sweep count from a
  misreported 62→60 and one misclassified DST kind — record-correction only,
  no design change.
- **PR #59 `1b6d6ae`** (B-8 revert, DoD) — the temporary 12h
  `TZ_INVERSION_GRACE_MS` grace removed from the app-side mirror, and the
  strict `bookings_time_order_ck` re-added via migration 0003 as
  `ADD CONSTRAINT … NOT VALID`, deliberately grandfathering rows with
  already-inverted stored instants (rewriting them is Autonomy trigger #5 —
  Sean's call, never a migration's). 2 blocking, both fixed: a grandfathered
  row 500'd on any details-less write, including unscheduling its itinerary
  item (`deleteItem`'s `planned→idea` flip is an UPDATE of the booking) —
  fixed with a pre-write merged-instants guard plus a constraint-precise
  23514→400 fallback wired onto UPDATE paths only (INSERT stays a loud 500 —
  that would mean mirror/DB drift, a real bug, and must stay loud).
  Independent verification 11/11, judge merge/high. Merged-tree CI run
  deliberately (client fix + server revert verified together, not just
  separately). **⇒ B-8 IS CLOSED END TO END.**
- **PR #61 `e867968`** (S-4 phase 1 — Maestro E2E lane): ADR-007, pinned
  Maestro 2.10.0, a Release-config simulator build lane, four unauthed flows
  plus one dev-tagged flow, `scripts/e2e.sh`. Three review rounds. **Merge
  gate met for real**: one `bash scripts/e2e.sh` invocation →
  `tests="4" failures="0"` (178.188s), plus `--tags dev` →
  `tests="1" failures="0"`. The lane paid for itself before merging — the
  first honest run was 4/2, and the failure was a genuine device-only
  defect: the inert Release diagnostics marker rendered with a ZERO FRAME,
  excluded from the XCUITest accessibility hierarchy outright, so the
  assertion was unsatisfiable by construction. Falsified three ways on
  device (frameless FAILED, 40×40 COMPLETED, zero-size+`accessible` FAILED —
  cause is size, not accessibility). Fixed with `style={{ flex: 1 }}`. Wave 2
  (env-gated session door plus flows 5–10) is a separate, not-yet-started
  PR — QUEUE "S-4" row updated, still queued.
- **PR #63 `3fe201b`** (docs correction, B-9) — corrected a FALSE premise #62
  shipped: iOS Hermes does NOT ignore a requested `hourCycle`. Verified at
  the pinned commit (`HERMES_V1_VERSION_NAME=250829098.0.16` → `90f2385`;
  `PlatformIntlApple.mm` selects the hour pattern from the requested
  `hourCycle_`, the locale default applies only when the option is absent)
  and confirmed by a runtime probe in the app's own Hermes on the simulator
  (`hour=17` not `05`, `FAITHFUL=true`, all backward links resolve,
  `Not/AZone` throws). The three #62 gates never trip on the shipped engine
  but stay as belt-and-braces against a future regression. **Qualification:
  honored only when `hour12` is NOT also passed** — passing `hour12`
  discards the requested `hourCycle` and re-derives it from the locale
  default, turning h23 into h24 on `en-US` (midnight would read "24").
  Backward links (`Asia/Kolkata`→`Asia/Calcutta`, etc. — every India flight)
  resolve via an `NSTimeZone` fallback landed in hermes commit `8f9cf10fc`
  (2025-03-17, fixing #1607) — the GitHub PR itself shows closed-not-merged,
  because Meta lands Hermes changes via internal import.
- **PR #64 `5313e84`** (chore — repo-wide prettier sweep): one-time sweep,
  231 dirty files on the base. Two review rounds. **The sweep introduced
  seven markdown content corruptions**, all from prettier reading a
  line-initial `-`/`+`/`*` as a bullet marker or a leading `>` as a
  blockquote marker in raw prose (invisible in rendered output, but several
  of these files are read as raw text — grep'd, injected verbatim into
  session context, never rendered). Worst hits: `.agents/agents/backend-engineer.md:30`
  inverted a **Law #2 money-atomicity instruction** in a role file `CLAUDE.md`
  requires reading before backend work; **locked** ADR-004 made to read as
  excluding `npx expo-doctor`; `.specs/api/places.spec.md` made to read as
  folding schema changes in WITHOUT a migration (negating Law #6);
  `.specs/api/photos.spec.md` where `>20 items` became a blockquote,
  dropping 413/429/404 from the Errors contract. All repaired by making the
  punctuation non-line-initial (backticks preferred — prettier never
  reformats inside a code span). Also reverted three generator/tool-owned
  JSON files that had been reformatted anyway (`airports.json` /
  `airlines.json` / `icon.json` — `airports.json` alone was 91% of the
  sweep's raw diff) and excluded them going forward via `.prettierignore`.
  **Final net semantic delta vs `main`: one character, and it is a fix** (a
  prophylactic backtick in `docs/QUEUE.md`).

**E2E lane is now live and gate-proven** (PR #61 above) — the first PR in
this project to merge on a real device-execution gate, not just `pnpm test`.
**Host simulator wedge is RESOLVED** (see landmines below — stale blocker
note updated, not left standing).

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
  W2 ✅ MERGED 2026-08-30 — T-S3.5 (PR #43,
  3754a4e: gogo://diagnostics panel) ∥ T-S3.3 (PR #44, b903017: shared-PG container —
  Testcontainers P1 RETIRED, server 126s→21s; 65 files / 868). W3 ✅ MERGED 2026-08-30 — T-S3.4 (PR #45,
  65a8ac1: hostile fixtures — Sean's real NRT→LAX flight is now a library fixture; the
  AKL→PPT class is documented STILL-UNENTERABLE until B-9). **S-3 BUILD COMPLETE: all
  five tasks on main. Remaining: Sean reads PR #38 → merge locks ADR-006.** Narratives: QUEUE Recently-done rows.

#### The rig — Sean's steps, in order

1. **Kill + reopen the app** — Metro now serves merged main; B-5/B-6/B-10..13 reach
   the device as JS-only changes (no rebuild).
2. Verify sign-in + any server call. **THEN** delete `EXPO_PUBLIC_API_URL` from the
   gitignored `apps/mobile/.env` and restart Metro — tier 3 derives the host from the
   dev server now; the DHCP-fragile hardcode is retired.
3. Server/Neon/Docker unchanged; migration 0001 was already applied to Neon during
   the 2026-08-29 session.

#### DEVICE QA RESULTS 2026-09-06 — RUN COMPLETE

All rig, diagnostics, F-043, and polish legs PASS on device (run-sheet report):
B-5 verified live (.env workaround retired), B-14 cold-start deeplink verified,
diagnostics tier-3 verified, **F-043 FLIPPED** (3258959 — 20 features verified).
One FAIL: the one-tap picker commit (now B-15a). Findings triaged 2026-09-06:
bugs B-15..B-19 filed (B-15 pickers + B-16 ideas-sheet + B-17/18 dispatched,
B-19 freeze parked no-repro), B-20 input sweep queued after B-15, B-9 EXTENDED
(airlines + inference) w/ server half dispatched, and a four-feature Sean
spec-pass batch (overnight dual items · calendar tz switcher · calendar views ·
ideas status rework) awaiting spec text.

#### QA-WAVE BUILD-OUT 2026-09-06/07 — 3 of 4 PRs MERGED

B-15 (pickers: Done commit, PickerCard, keyboard, exclusive-open) · B-16 (Add-to-day
root cause BY DESIGN → the ideas rework is now THE FIX; prefill + end-only win shipped)
· B-17/18 (cancel booked-only per Sean's ruling over the contradicted §3.2 + rental
subtext) all MERGED, full pipeline each. **PR #50 (B-9 server: airports+airlines+0002)
fully verified, judge HELD on Sean's ODbL decision.** New rows: B-21 contention flakes
(P1 — threatens the act-0 gate, 3 sightings), picker options (Sean), VoiceOver
checkpoint labels. B-20 input sweep unblocked. Sean decisions outstanding: ODbL ·
spec-pass batch approach (rec: roadmap-prep draft) · B-16b interim gate copy ·
diagnostics entry ruling · PR #38 read · B-7 ruling.

#### QA-WAVE CLOSE-OUT 2026-09-06 — B-20 + B-21 MERGED, wave complete

B-20 (PR #51, 4bf592c): input sweep obvious class shipped through the full pipeline
(1 blocking seam-pin find fixed + verified; iata dirty-gate; schema-order fix).
**Q1–Q4 questionable list → Sean (Active row).** B-21 (PR #52, 5057326): contention
flakes determinized — SIGSTOP/SIGCONT pulse repro, fake-timer fix, 10/10 act-0;
the act-0 gate is trustworthy again. B-22 filed (React-19 guard re-pin + settle()
migration + worker handle). Overnight session-limit kill: 3 agents resumed in place,
zero work lost. **Sean decision queue (gate-order): ① ODbL (gates #50 → B-9 client
→ B-8 revert) ② Q1–Q4 ③ spec-pass batch approach ④ PR #38 read ⑤ B-16b copy ·
diagnostics entry · B-7.** Dispatchable sans Sean: VoiceOver checkpoint-label row,
lint-gap row, B-22.

#### P-9 W3 CLOSED 2026-09-06 — PR #32 resurrected and merged; B-24 prod bug found en route

T-9.4 (settle-requests + budgets + FX proxy) merged after a 9-day stale spell: zero-conflict
merge-from-main, suite conversion per the standing rider (row closed), full fresh 5-lane
round (0 blocking), verified fix leg, judge merge/high. The resurrection's image-bump probe
found **B-24**: PG 18 reclassified RESTRICT-delete FK violations 23503→23001 — on prod Neon
18.6 the places-delete 409 was plausibly a LIVE 500, masked by the 17 test image. Fix = PR #55
(in review; must merge-from-main + reconcile per the B-24 row). **W4 (T-9.6 expense screens,
T-9.7 settle + send-the-bill) is now dispatchable.** FX single-flight row filed (P3).

#### SEAN DECISION PACK 2026-09-07 — four rulings landed

① **ODbL CONFIRMED** → PR #50 (B-9 server half) cleared to merge (reconciliation vs
moved main in flight; then merge → B-9 client half dispatchable → then the B-8
grace + migration 0001 revert = B-8's DoD). Obligation: OSM/timezone-boundary-builder
attribution in README (present) + an open-source-licenses screen entry at ship;
NEVER bundle the airport+tz dataset into the app binary without revisiting ODbL
share-alike (that would be redistribution). ② **ADR-006 RATIFIED** → PR #38 merged
6a69fe5, Status flipped to Accepted. ③ **MAESTRO ADOPTED** → S-4 row + the handoff
below. ④ **SESSION DOOR APPROVED** (auth bypass for E2E; env-gated per Sean).

#### E2E LANE HANDOFF (for the next session) — self-contained; the research lives only here

**Decision:** Maestro CLI, local-first, against a local Release-config simulator
build; flows in `.maestro/` riding the lint-gated testID grammar (§2.7/§2.8 —
Maestro's `id` selector maps to testID directly). Why: the official Expo E2E path
(Expo's own docs document Maestro and only Maestro); free CLI, zero metered
components (Law #5 clean); `openLink` does gogo:// cold-start first-class.
**Detox disqualified on fact:** supported range RN 0.77–0.84; we ship RN 0.86.2
(its v21 alpha chases newer RN — not a base). Homegrown AXe rig = rebuilding
Maestro's wait/retry kernel; keep AXe as the escape hatch only.

**Task breakdown, in order:**

1. **ADR-007** — record the adoption + the Detox disqualifier + the constraints
   (local-first; no metered CI; AXe stays escape-hatch).
2. **Install pinned**: ⚠️ npm `maestro` (2.1.1) and homebrew-core `maestro`
   (0.17.3) are UNRELATED SQUATTER packages — install ONLY via
   `mobile-dev-inc/tap` or the official script, version-pinned (cli-2.10.x era,
   ~monthly cadence); JVM app, Java 17 is present; verify the
   `MAESTRO_CLI_NO_ANALYTICS` env opt-out at install.
3. **The build lane**: `npx expo run:ios --configuration Release` per merge
   candidate — dev-client builds are for flow AUTHORING only (black-box
   `launchApp` lands on the dev launcher; `clearState:true` wipes the stored
   Metro URL). Note: the installed sim app still carries the pre-#33 bundle id —
   a rebuild is due regardless.
4. **Flows 1–4 (unauthed, buildable immediately)**: `smoke-diagnostics-cold`
   (openLink gogo://diagnostics; handle the iOS SpringBoard open-prompt with a
   conditional runFlow — approval persists per sim), `deeplink-matrix` (codify
   the B-14 AXe matrix), `signin-renders`, `signin-cancel-surface` (MED
   feasibility — the ASWebAuthenticationSession sheet may resist accessibility
   taps; fall back to the door).
5. **The session door (APPROVED — Autonomy trigger #4 satisfied 2026-09-07)**:
   an auth bypass minting a test session, env-gated — Sean verbatim: "gated on
   env var such as NODE_ENV 'development' or 'testing' or 'e2e' if we want to be
   more targeted." Design at build (extend the `scripts/gen-test-env.mjs`
   throwaway-env pattern; double-gate so prod builds cannot carry it); full
   review pipeline, security lane mandatory.
6. **Flows 5–10 (the runsheet replacements)**: `session-door-entry`,
   `create-trip-golden` (datetimepicker path), `add-flight-dateline` (drive the
   REAL B-8 hostile-fixture wall times from `@gogo/shared/testing`),
   `ideas-to-schedule`, `cancel-visibility`, `cross-tab-state` (tab-bar presses
   ONLY — the vendored-navigator no-op rule).
7. Wire a local pre-merge script (JUnit output); GH-macOS CI optional later.

**Known limits (set expectations in ADR-007):** the @rnmapbox map canvas is
pixel/gesture territory — assert AROUND it via marker testIDs; picker/keyboard
FEEL stays a short human pass; flake posture = Maestro auto-wait (community
reputation best-in-class; `maestro-runner` is a drop-in speed swap to watch,
not adopt).

#### P-9 BUILD-OUT COMPLETE 2026-09-07 — W4 closed; session winding down

T-9.6 (PR #57) + T-9.7 (PR #56) merged through full payments panels (4 blocking each —
real bugs: #56's cross-account/cross-trip settle-return guards, #57's FX-latch
corruption — all kill-verified; the W2 merged-tree-gate obligation executed and
verifier-reproduced, 170 suites / 1741 act-0 on the union). The money phase's 7 tasks
are ALL on main across 8 PRs. **Queue head for the next build session: B-9 CLIENT half
(typeahead/pickers/tz population + the flight-lookup gate) → then the B-8 grace +
migration 0001 revert (B-8's DoD). The E2E lane (S-4) has its own handoff above.**
Sean-gated: the P-9 spec-pass batch row (43+ interpretations incl. G1/G2) · the
feature-spec batch (overnight flights, tz switcher, calendar views, ideas rework) ·
Q1–Q4 · B-16b copy · diagnostics entry · B-7. Ledger flips (F-063..F-074 + the QA-wave
features) ride the next device-QA run — the diagnostics panel + runsheet artifact stand ready.

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

#### REVIEW WAVE 2026-09-07 — PR #58 + #60 MERGED; #59/#61/#62 still open (session in progress)

**MERGED**

- **PR #58 `67055a1`** (chore/lint-gaps): the four queued lint gaps closed —
  `apps/mobile/jest.setup.js` into the expo lint gate (+ `globals@17.7.0`
  devDep, `globals.jest` scoped to that one file); `src/testing/**` +
  `src/test-utils/**` into the token-styling and no-restricted-imports
  exemptions; `no-restricted-imports` now bans `@gogo/shared/testing*` in
  prod scopes of BOTH apps; root `lint:root` extended to `scripts/`. 2-lane
  panel (correctness + conventions, deliberate for a config-only PR): 0
  blocking / 4 advisory, 3 fixed + 1 deferred, independent verification 8/8
  VERIFIED, judge merge/high. Worth preserving: the feared lint-scope
  narrowing was DISPROVED — `@expo/cli`'s `lintAsync.js` only pushes a
  DEFAULT_INPUT when `fs.existsSync` passes, and `apps/mobile` has only
  `src/` at its package root, so bare `expo lint` was already equivalent to
  `expo lint src`; the new invocation is a strict superset.
- **PR #60 `ef241ef`** (B-19/sheet-exit-before-modal-push): B-19 root-caused
  and fixed. Mechanism (source-verified): the DS `Sheet` renders an RN
  `Modal` that stays PRESENTED through its JS exit animation, so a
  `router.push` of a `presentation:"modal"` route in the same handler makes
  react-native-screens dismiss a FOREIGN (non-`RNSScreen`) modal; because the
  Sheet uses `animationType="none"` that dismissal is `animated:NO`, its
  `transitionCoordinator` is nil, `animateAlongsideTransition:completion:`
  no-ops, `finish()` never runs, and `_updatingModals` (a per-
  `RNSScreenStackView` ivar) is never cleared — so that ONE tab's stack can
  never present or dismiss a modal again. Explains every symptom: tab dead,
  other tabs fine, item saved server-side, only kill+reopen recovers, and it
  stopped reproducing once items existed (the natural add gesture with items
  present is the day-header `+`, which pushes with no Sheet open). Fix: an
  `onExited` callback fired when a null-rendering probe mounted INSIDE the RN
  Modal unmounts (its unmount coincides with the native dismissal
  completion), three call sites deferring their push into it, a
  per-presentation `Modal` `key` closing a stale-`isRendered` re-wedge
  window, and a landmine entry in `.claude/rules/mobile.md`. 5 lanes, 3
  blocking / 6 advisory, all fixed, independent verification 10/10 VERIFIED,
  judge merge/high. **Headline finding:** the tests lane proved the original
  "load-bearing" pin was TOOTHLESS — a naive `useEffect`-on-`mounted`
  implementation that still wedges on iOS kept all EIGHT original pins
  green, confirmed by execution twice (fixer + independent verifier). The
  fix now carries a file-local iOS-faithful `jest.mock` of RN's `Modal`.
  Also record: `animationType="fade"` WOULD fix the wedge in one line but
  was rejected on verified grounds — it maps to
  `UIModalTransitionStyleCrossDissolve` with `shouldAnimate:YES`, layering a
  UIKit cross-dissolve at a fixed duration over the Sheet's own spring
  slide, un-disableable by reduce-motion, across ~20 consumers (a DS motion
  change, not a bug fix).
- **`0d50988`**: five follow-up QUEUE rows filed (see that commit / the
  QUEUE Active table).

**STILL OPEN when this was written**

- **PR #62** (B-9/airports-airlines-client-forms) — the B-9 CLIENT half,
  +4080/-101 over 29 files, CI green, 5-lane panel in progress (security
  ship 0/1, performance ship 0/1 at time of writing). This is the REAL B-8
  fix. Note the branch name differs from the QUEUE row's
  `B-9/airports-airlines-client` because that name was held by a dead
  agent's worktree.
- **PR #59** (B-8/revert-tz-grace) — DRAFT, deliberately. Reverts the
  temporary 12h grace + re-adds the strict CHECK as migration 0003
  `NOT VALID`. Round 1: 2 blocking / 4 advisory, both blocking fixed
  (`86eac22`), independent verification VERIFIED on all 11 items. It is a
  draft because merging it before PR #62 would reinstate the original B-8 P0
  (every date-line flight rejected again). **Merge order is: #62 then #59.**
- **PR #61** (S-4/maestro-e2e-lane) — HELD. Fixes applied (`1f49ff5`), but 3
  of 4 release flows have never run green and ALL FOUR flows' assertions
  changed this round, so even the one earlier green run is stale. Merge
  gate: one `bash scripts/e2e.sh` run showing a non-zero test count and zero
  failures. Blocked by the simulator wedge (landmine below).

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
- **Host iOS simulator stack — RESOLVED 2026-09-07** (host reboot, Sean's
  call, executed). `xcrun simctl boot` completes normally again; PR #61's
  merge gate ran to completion against a live sim afterward
  (`tests="4" failures="0"`, 178.188s). The prior wedge (killed at 60s/75s;
  `kill -9` of the stale `SimLaunchHost.x86`; `killall -9` of the user-owned
  `CoreSimulatorService`; shutdown-all / Simulator.app restarts / orphaned
  `SimRenderServer`+`SimMetalHost` kills — none of it worked short of the
  reboot) is kept only as history in
  `.tmp/session-notes/sim-wedge-2026-09-07.md`, in case the class recurs.
- **Grandfathered-booking dead end**, present since PR #59 landed: an
  itinerary item derived from a booking with inverted stored instants
  CANNOT be unscheduled, because `deleteItem`'s R-ib-9 `planned → idea` flip
  is an UPDATE of the parent booking and the re-tightened `NOT VALID` CHECK
  rejects it (a specific 400, never a 500 — that was the round-1 fix).
  Reads, deletes and any details-CARRYING PATCH still work, and a details
  PATCH HEALS the row, which is exactly the B-9 re-entry flow — so it is
  mostly self-healing. The only exits are: edit the booking's times, or
  delete the booking. Permanent by design (rewriting Sean's stored data is
  Autonomy trigger #5) — this does not close when B-9/B-8 do; it is their
  documented residual.
- **Prettier rewrites line-initial punctuation in prose (PR #64).**
  CommonMark reads a bare `-`, `+`, or `*` at the start of a line — including
  a line a paragraph merely wraps onto — as a list marker, and a leading `>`
  as a blockquote marker; `*emphasis*` also gets normalized to `_emphasis_`.
  Invisible in rendered output, but several files in this repo are read as
  raw text (grep'd, `cat`'d, injected verbatim into session context, never
  rendered) — there the raw characters ARE the artifact. This corrupted a
  Law #2 money-atomicity instruction in a role file and silently altered a
  **locked** ADR before anyone noticed. Rule: any line-initial `-`/`+`/`*`/`>`
  in prose, and any bare `*...*` around a code-literal/glob/UI-copy string,
  must be escaped, joined onto the previous line, or put in backticks —
  backticks are the most durable fix, since prettier never reformats inside
  a code span.
- **B-19's ledger flip is NOT earned yet.** Nothing in PR #60 was
  device-verified (simulator down); the mechanism was established by
  reading `RNSScreenStack.mm` (vendored 4.25.2) and an RN 0.81.5 copy of
  `RCTModalHostViewComponentView.mm` (0.86.2's is not vendored). Device
  recipe lives in the PR #60 body: empty trip → Slow Animations → FAB →
  pick an option → save → try tapping; the discriminator is that the
  day-header `+` path never froze while the FAB path always did;
  `gogo://diagnostics` leg 6 should show NO dev error (a native wedge
  leaves no JS error). Also eyeball the ~200ms deferred transitions for
  jank.

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

### Rotated phases — archived, pointers only (rotated 2026-09-13)

Closed/code-complete phases live in `docs/history/`, not here (doc-homes rule:
STATE rotation is Claude's job). Their landmine digests, phase-QA checklists and
port-source notes were appended to the archives on 2026-09-13 before this section
was trimmed — nothing was dropped.

- **P-7 — Itinerary & bookings** (code-complete 2026-08-10; ledger F-043..F-054
  still `passes:false`, phase QA still un-run — batched with the P-6 checklist) →
  [PHASE-007](history/PHASE-007-itinerary-bookings.md). Rotated 2026-09-13 (STATE
  was over the ~1000-line advisory cap). Live tracking row: QUEUE "P-7 phase QA".
- **P-6 — Trips, collaboration & places spine** (code-complete 2026-07-31; ledger
  F-030..F-042 still `passes:false`, phase QA still un-run) →
  [PHASE-006](history/PHASE-006-trips-collab-places.md). **Appendix A.1** is the
  ①–⑦ sim checklist that gates those flips; **A.2** is the P-6 landmine digest
  (TanStack v5 mutate-callback seam, KEY-CACHE LAW, conflict-latch invariant, DS
  Sheet exit window, EPQ role pins, lock order, timestamptz parity, postgres-js
  `Date` binding, test-pin rules). Live tracking row: QUEUE "P-6 phase QA",
  `blocked` on Sean since 2026-08-16.
- **P-5 — Auth, profiles & entitlements** (code-complete 2026-07-25; ledger
  F-018..F-029 pends OAuth creds + server env from Sean) →
  [PHASE-005](history/PHASE-005-auth-profiles-entitlements.md).
- **P-4 — Design system + navigation skeleton** (CLOSED 2026-07-22; ledger
  F-010..F-017 all flipped on Sean's device pass) →
  [PHASE-004](history/PHASE-004-design-system-navigation.md), which carries the
  device-install bootstrap recipe.
- **P-2 — Upfront spec suite** (CLOSED 2026-07-10; 18 specs, ~280 EARS
  requirements, the 118-row feature ledger, the frozen P-3..P-14 roadmap) →
  [PHASE-002](history/PHASE-002-upfront-spec-suite.md), which carries the
  sibling-repo port sources for archaeology.

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

- **PR #70** (spec-pass round-2 consolidated decision doc, ~300 items) —
  awaiting Sean's rulings.
- **PR #71** (itinerary-evolution spec batch) — awaiting Sean's sign-off;
  both his questions already ruled (tz switcher = display-only; Month = true
  month grid).
- **Sub-floor destination-tier search names** (`Fez`/`Van`/`Ufa`/`Qom` etc. —
  54 rows under the 4-char global text-search floor) — Sean to rule:
  exact-match arm for sub-floor tier queries vs. lower the floor vs. accept.
  QUEUE Active row.
- **B-27 device confirmation still owed:** the doubled top safe-area inset
  fix shipped via PR #68 (`098b3e5`) but has not been confirmed on Sean's
  device.
- **Device confirmation newly owed (2026-09-13/14 merges):** B-26 (#67,
  booking-form UX); B-7 parts 1–3 (CLOSED — bootstrap tier + inline custom
  destination + nullable coords); B-28 (migration-state check). None yet
  run on Sean's device.
- **S-4 T5 PR** — session-door flows 5–10 (branch
  `S-4/session-door-flows`), in progress; will need review once opened.
- **Device QA still owed:** the F-0xx ledger flips, and the P-9
  spec-pass batch (43+ interpretations) plus the other Sean-gated spec
  decisions already tracked in `docs/QUEUE.md`. **B-19's freeze check is
  DONE** — confirmed fixed on a real device 2026-09-11 (see the
  2026-09-11/12 section above).
- **Mapbox account + access token** (escalation #3, PARKED — does not block
  the P-7 build; adapters are fixture-driven behind ports). Needed for: live
  travel-leg QA (P-7 phase QA at the earliest) and the P-8 `@rnmapbox/maps`
  SDK regardless. Free tier covers dev (100k Directions requests/mo);
  research run-rate estimate already includes it. QUEUE Blocked row.
- **P-6 phase QA** — sim checklist above (Claude-runnable after dev-client
  rebuild) + Sean's device pass; ledger F-030..F-042 flips after.
- (P-14) buy the universal-link domain.
