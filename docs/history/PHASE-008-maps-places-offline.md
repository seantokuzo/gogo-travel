# PHASE-008: Maps, Saved Places & Offline Tile Packs

**Status:** Code-complete (phase QA pending — ledger F-055..F-062 flips gate
on Sean's device pass; the pk-token-gated checklist lives in QUEUE.md "P-8
phase QA" row; unblocked by the S-4 session door as of 2026-09-14, still
Sean-device-gated)
**Started:** 2026-08-15
**Completed:** 2026-08-23 (code-complete; 8 PRs merged, #20–#27)
**PRs:** #20–#27 (every judge verdict merge/high)

## What shipped

The trip map: `@rnmapbox/maps` themed `MapView`, three clustered pin
families + span-aware day filter, camera-fit with zero-span collapse, place
sheet/detail backed by the spine (fetch-fresh, no persistence — premium
details deferred), spine-backed geo-bound search with the full R-map-16
lazy-permission machine, foreground-only location, offline
StylePacks/TileRegions with hygiene (§2.5 pack machine, ONE
`offlineManager`/`expo-network` controller seam, MMKV annotation hygiene,
pill/settings surfaces), and map↔itinerary cross-navigation (per-kind
linked-item reroute). Ledger **F-055..F-062**. Specs:
`.specs/client/map.spec.md`, `.specs/api/places.spec.md`.

Scoped 2026-08-15 as 6 tasks (T-8.1..T-8.6) + T-8.7 integration rider (added
at W3 close). **Every build shipped tokenless** — Mapbox's SDK
download-token auth was dead (verified registry-side), so no PR in the phase
was blocked on Sean's Mapbox account; the runtime `pk.` token was deferred
to phase QA (landed 2026-08-29, after this phase code-completed) and gates
only sim tiles, pack QA, Studio styles, live legs, and the F-055..F-062
ledger flips themselves.

## Tasks completed

- T-8.1 [PL-3, PL-4] — place detail endpoint + saved-places CRUD — PR #21 (`a40ea7f`)
- T-8.6 — native scaffold: maps/location/network deps + config plugins,
  foreground-only lock, `mapColors`/`mapDayColors` tokens — PR #20 (`30caa40`)
- (Hermes/dedup chore, pre-rebuild) — PR #22 (`293d0ef`)
- T-8.2 [MAP-1] — map shell: themed `MapView`, 3 clustered pin families,
  day filter, camera-fit, 3 frozen seams — PR #23 (`08e656c`)
- T-8.3 [MAP-2, MAP-4] — sheet slot + geo-bound spine search +
  lazy-permission machine + consume-once camera intent — PR #24 (`c5e0b13`)
- T-8.4 [MAP-3, MAP-6] — place detail screen (fresh seam) + saved-places
  mutations + linked-item reroute — PR #25 (`510d06b`)
- T-8.7 — integration rider (W3 escalation accumulator: E1–E5 wiring,
  R-map-24 centering, telemetry off prod-real, distance-on-detail) —
  PR #26 (`149b014`)
- T-8.5 [MAP-5] — offline StylePacks/TileRegions lifecycle — PR #27 (`2c43848`)

## Decisions locked (promoted to ADRs)

None directly. Six key rulings were recorded operationally (PLANNING § P-8
Prep bullet; brief: `.tmp/p8-readiness-brief.md`) rather than promoted to an
ADR: `focusPlaceId` = pending-focus store; warm-session offline bar has NO
TanStack Query persister; photo pins are fixture-tested, empty-in-prod until
P-12; default Mapbox styles sit behind a config swap; the pk token lands at
phase QA, not before.

## What worked

- Shipping every PR tokenless (fixture-driven, ports-based) kept the whole
  phase unblocked by the Mapbox account — a pattern worth repeating whenever
  a paid SDK's build-time auth can be separated from its runtime auth.
- The merged-tree gate caught a **real** #26/#27 test contradiction before
  it reached `main` (both branches green in isolation, contradictory once
  merged) — the same coordination-tripwire class first proven in P-6/P-7,
  confirmed again here.
- 7 of 8 PRs were round-1-only; the sole addendum was T-8.2's targeted
  conventions round 2. Mobile suite count grew 1011→1348 tests (107→142
  suites) across the phase with zero regressions carried forward.

## What didn't / surprises

- **PHASE-QA ATTEMPT 2026-08-15** (the rebuild leg of W2's plan): the one
  dev-client rebuild **passed cleanly** on `main@293d0ef` — prebuild +
  CocoaPods clean (the feared Mapbox-SDK pod failure did not occur), native
  smoke passed, tokenless `MapView` behaved exactly as documented (blank
  canvas + 401 `MapLoad`). But **every P-6 and P-7 checklist leg was
  BLOCKED(creds)** — T-6.6 had already retired the "Open sample trip" dev
  door, so no auth bypass existed and no tap automation could sign in.
  **Zero ledger flips** (Law #7 — partial engine evidence only, below the
  bar). Sean ruling 2026-08-16: park QA, keep building. This blocker was
  only resolved a month later by the S-4 env-gated session door
  (2026-09-13/14) — worth remembering next time a phase's QA plan assumes
  an auth bypass that doesn't exist yet.
- The file-ownership split (T-8.1 owns `apps/server/src/places/**` +
  `packages/shared` place domain/migration; T-8.6 owns `apps/mobile`
  package.json/app.json + `packages/tokens` + lockfile) was disjoint by
  construction and produced zero conflicts across two parallel-dispatched
  tasks — a reusable pattern for scoping parallel waves.

## Open follow-ups

All carried as QUEUE rows: **P-8 phase QA** (the pk-token-gated checklist,
F-055..F-062 flips — session-door-unblocked as of 2026-09-14, still gated
on Sean's device); **R-map-18** activation-mount ruling (P1, Sean); the
deliberate-camera-writer fit-sweep; the search-keystroke pin-strobe +
typeahead debounce (across all four call sites at once); post-merge comment
hygiene (stale review-comment residue); the remote-pack-deletion gap
(security-affirmed). The **102-interpretation spec-pass batch**
(QUEUE Blocked row, W1–W4 / PHASE COMPLETE) is fully recorded but still
awaits Sean's rulings.

## Linked context

- STATE.md P-8 section rotated here 2026-09-15 (STATE was over the
  ~1000-line advisory cap after the 2026-09-13/15 session's additions).
  PLANNING.md's P-8 roadmap row now points here.
- Specs: `.specs/client/map.spec.md`, `.specs/api/places.spec.md`.
- Readiness brief: `.tmp/p8-readiness-brief.md`.
- Full per-PR review narratives: QUEUE.md "Recently done" rows T-8.1..T-8.7.
