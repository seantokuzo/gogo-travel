# PHASE-007: Itinerary & Bookings

**Status:** Code-complete (phase QA pending — ledger F-043..F-054 flips gate on
Sean's device pass; checklist lives in QUEUE.md "P-7 phase QA" row)
**Started:** 2026-07-31 (kickoff after P-6 code-complete)
**Completed:** 2026-08-10 (code-complete; 9/9 tasks merged, PRs #11–#19)
**PRs:** #11–#19 (every judge verdict merge/high)

## What shipped

Bookings by category (10 detail types, §3.2 status machine, single-source
calendar items via the §3.1 booking↔item contract), the Ideas bucket, a day
list with drag reorder + inline travel-time chips (Mapbox/Transitous leg
jobs), the calendar-grid gap view (hour axis, virtualized day pager, overlap
split, all-day/spanning-lodging lane), add/edit flows for all 10 booking
types (place picker), deeplink-out builders + return-prompt loop, and
booking/item detail screens with offline degrade. Ledger **F-043..F-054**.
Specs: `.specs/api/itinerary-bookings.spec.md`, `.specs/client/itinerary.spec.md`.

Scoped 2026-07-31 with **no migration owed** (0000 baseline already had
bookings / itinerary_items / travel_legs) and **no blocking escalations**:
travel-leg adapters built fixture-driven behind ports; the Mapbox
account/token stayed a parked Sean item (Transitous keyless community MOTIS
instance covered transit-only in the interim); deeplink-out is pure client
URL construction, no partner APIs or keys.

## Tasks completed

- T-7.1 [IB-1] — Booking domain service + bookings router + §3.7 shared
  contract + dirty-day no-op seam — PR #11 (b67ba9c)
- T-7.2 [IB-2] — Itinerary router (item CRUD, day-order PUT, composite read) — PR #12 (f529373)
- T-7.3 [IB-3] — Travel-leg dirty-day queue + debounced worker + Mapbox/Transitous adapters — PR #13 (c440396)
- T-7.8 [IT-8] — Deeplink-out builders + return-prompt loop — PR #14 (70569fe)
- T-7.4 [IT-1, IT-2] — Itinerary tab shell: day list, drag reorder, view-toggle — PR #15 (merged)
- T-7.7 [IT-6] — Calendar grid + spanning-lodging lane — PR #16 (7a48caf)
- T-7.6 [IT-5, IT-7] — Ideas bucket + add/edit flows (10 types, place picker) — PR #17 (c587a6b)
- T-7.5 [IT-3, IT-4] — Travel-time chips + conflict surfacing — PR #18 (a84c9cf)
- T-7.9 [IT-9, IT-10] — Booking/item detail screens + offline degrade — PR #19 (a572947)

Final suite counts: mobile 517→1011 tests (72→107 suites) across the phase.

## Decisions locked (promoted to ADRs)

None promoted — phase ran entirely inside ADR-001..004. The NUL-byte incident
(below) produced a repo-wide guard, not an ADR.

## What worked

- **Frozen-seam dispatch (W1 → W2/W3 parallel → W4 parallel → W5 parallel → W6
  serial):** T-7.1's dirty-day `markDaysDirty` interface froze at W1 so T-7.2
  and T-7.3 could build against it in disjoint files with zero cross-wave file
  contention — the same pattern repeated at W4 (T-7.7 grid ∥ T-7.6 Ideas/add-edit)
  with zero conflicts across two large concurrent PRs.
- Client-wave composition firmed up as server waves landed (P-6 pattern
  repeated successfully).
- Independent verifiers re-ran claimed fixes rather than grading reports —
  caught a genuinely unreachable-claimed amendment more than once across the
  phase.

## What didn't / surprises

- **🔴 NUL-byte / invisible-diff incident (T-7.5) — the most important thing
  this phase learned.** Two raw `U+0000` bytes typed into `legs-model.ts` made
  git classify it BINARY: `gh pr diff` rendered zero lines, GitHub's API
  reported `additions=0, patch=false`, so a 6641-byte production module
  (including `pickDefaultMode`) passed a five-lane review that structurally
  could not display it — and BSD `grep` exits 1 silently on such a file, so an
  agent searching concludes the symbol doesn't exist. tsc/eslint/expo-lint all
  passed anyway. Fixed + guard-enforced repo-wide
  (`.github/scripts/check-nul-bytes.mjs`, wired into the Guard job, 49 tests,
  exit contract pinned both directions). The rule had lived ONLY in
  `server.md` (path-scoped to `apps/server/**`), which is exactly why mobile
  re-stepped it — a universal landmine must not live in one workspace's rule
  file; now in `.claude/rules/mobile.md`. Residual, never closed: a
  `.gitattributes` `*.ts -diff` line reproduces the identical invisible diff
  with zero NUL bytes.
- **Vacuous-pin taxonomy (7 found across T-7.5/T-7.6/T-7.7 — a green suite
  proves nothing until mutated), all folded into `.claude/rules/mobile.md`:**
  (1) rejecting an already-settled promise never observes in-flight state; (2)
  non-strict zod strips unknown keys so a misspelled field round-trips green;
  (3) RNTL won't fire a handler on a `disabled` element, so "press it, assert
  nothing happened" passes with the guard gone; (4) a fixture where two
  behaviors yield the same value (23:00, where clip-at-midnight ==
  start+60min); (5) a control arm that structurally can't reach the code it
  controls for (a car rental can never hit a `lodging` clause); (6) a "no-op
  mutation" that looks like a passing falsification (`undefined ?? null`); (7)
  asserting a negative with no ungated control. Rule: every negative assertion
  needs a control arm proving it could have failed, and every probe must be
  confirmed applied via `git diff --stat` before its result is trusted.
- **T-7.1 landmines (binding on all P-7+ surfaces):** caps must cover every
  schema class, not just obvious strings (zod `iso.datetime()` accepted an
  unbounded-fractional-seconds 2MB string as "valid" — found IN the caps-fix
  diff; sweep the whole union on any wire surface: strings, arrays, array
  elements, every formatted-scalar class). Place visibility has ONE home
  (`apps/server/src/places/visibility.ts`) — every surface writing a
  client-supplied `place_id` is a visibility grant and must use the
  indistinguishable-404 posture, or it's a Law #3 bypass. Lock order extended:
  users → trip_members → invites → bookings → itinerary_items; mutating a
  booking-kind item goes through the booking service (parent FOR UPDATE
  first), never directly. The place-FK 23503 → canonical-404 mapping is
  constraint-precise (`isPlaceFkViolation` handles both driver field shapes).
- **T-7.8 Sheet exit-window tax RESOLVED at the DS level (PR #16 rider):**
  `pointerEvents:"none"` while exiting + an unmount-latch guard
  (re-armed in the effect body, StrictMode-proof) landed in
  `components/Sheet.tsx`. Existing consumer exit-drains became harmless
  no-ops; new sheet consumers need no special posture. Residual (pinned by the
  reworked members test): same-frame multi-touch can still land two presses
  before the closing commit — the hook-level v5 mutation seam handles that
  overlap.
- DS Sheet gained `dismissDisabled` (T-7.6, strictly additive, default off):
  gates all four dismissal routes behind one memoized `guardedDismiss` and
  renders the close affordance visibly disabled; the swipe route is wired but
  not test-pinned (no non-vacuous pin is constructible — PanResponder needs
  real touch history).
- Client cache invariant (T-7.6): the cached default bookings list must always
  satisfy the server's R-ib-10 predicate — `reconcileBookingRow` inserts only
  non-cancelled rows and removes rows that become cancelled. T-7.9's R-itin-26
  cancel wiring must not regress this to a map-replace.

## Open follow-ups

All carried as QUEUE rows: P-7 phase QA (ledger F-043..F-054 flips, batched
with the P-6 checklist in one dev-client rebuild + sim session); Mapbox
account/token still parked (Blocked row) — travel legs return transit-only
(Transitous) until `MAPBOX_ACCESS_TOKEN` lands; offline signal blind to
mutation-cache transport failures (T-7.9 R1 defer, rides the interp-15
measured-connectivity escalation); `.gitattributes` NUL-byte-diff residual
(not closed); the P-6/P-7 spec-pass batches (27 T-7.6/T-7.7 interpretations +
35 T-7.5 interpretations) tracked in QUEUE.

## Linked context

- STATE.md P-7 section rotated here 2026-09-13 (STATE was over the ~1000-line
  advisory cap). The vacuous-pin taxonomy, T-7.1 landmines, and the NUL-byte
  guard are already codified in `.claude/rules/mobile.md` / `server.md` /
  CI guard scripts — this archive is the durable narrative, not their only home.
- Specs: `.specs/api/itinerary-bookings.spec.md`, `.specs/client/itinerary.spec.md`.
- Full per-PR review narratives: QUEUE.md "Recently done" rows T-7.1..T-7.9
  (this archive is the summary; QUEUE rows are the detail).
