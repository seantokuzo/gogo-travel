# PHASE-004 — Design System + Navigation Skeleton (CLOSED 2026-07-22)

> Append-only archive. Live docs: PLANNING (roadmap), QUEUE (pulse), STATE
> (active context). Predecessor: [PHASE-003](PHASE-003-foundations.md).

## Outcome

Every pixel now has a source (`@gogo/tokens`), every screen has a rail
(component library + full route tree), and every later phase inherits live
enforcement (contrast matrix, token-only lint, testID lint). The app ran for
the first time — simulator AND Sean's iPhone 15 Pro. Ledger F-010..F-017 all
flipped with executed evidence. PLANNING's T-4.1..T-4.6 shipped consolidated
as four PRs.

## Tasks (all merged through the full 5-lane review loop)

| Task                                  | Merge      | Rounds                                                                                                | Notes                                                                                                                                                                                                                       |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-4.1 @gogo/tokens (DS-1/2)           | 544bce8    | R1 fix-then-ship (45-seed pin blocker) → judge merge/high                                             | 312 tests; 258-pairing WCAG matrix; review-added pairing caught 3 real dark-mode AA failures; derive script byte-reproduces hexes                                                                                           |
| T-4.2 theme runtime (DS-3)            | 2026-07-17 | first clean R1 SHIP (0 blocking) → merge/high                                                         | MMKV + Appearance singleton seams; jest harness live; first-frame no-flash probe                                                                                                                                            |
| T-4.3 components + Gallery (DS-5..10) | 1fc755f    | R1 fix-then-ship (1 blocking) → merge/high                                                            | 14 components; blocker: RN 0.86 Pressable `accessible:true` default flattened ConfirmDialog to one AT element — `accessible={false}` fix revert-proven; fix agent died awaiting Docker, orchestrator ran gate/commit inline |
| T-4.4 navigation skeleton (NAV-1..7)  | e7a56e2    | first 5-lane 0-blocking R1 SHIP (12 advisories, all fixed) → merge/high, large-diff escalation waived | 36 route files, DS TabNav shell, TripIdProvider, testID ESLint guard + self-test; one advisory exposed a factually false test comment (back-behavior) — assertion now pins reality                                          |
| DS-4 completion (post-T-4.4 gap-fix)  | 7c75206    | direct (tooling)                                                                                      | R-ds-7 token-only lint was never built in T-4.2/T-4.3; shipped w/ 9-test self-suite; immediately caught Text.tsx builder indirection                                                                                        |
| Dev QA entries                        | ef58bd3    | direct (dev-only)                                                                                     | sample-trip door into the tab navigator — no user path exists until trips CRUD (P-6)                                                                                                                                        |

Mobile suite: 0 → **152 tests** (23 suites) across the phase. First GitHub
Actions CI run validated the T-3.4 workflow on real runners (run 29769331811,
all jobs green).

## Evidence (Law #7)

- **Machine:** contrast matrix 260/260; createStyles memo 5/5; token-only +
  testID lint self-suites (9 + committed probes); typetest compile checks;
  cold-URL mounting for all 27 spec routes; fs-walk route-audit completeness
  test; modal-presentation config capture.
- **Simulator sweep (2026-07-19/20,** `.tmp/qa/p4/`, session-scoped): 26/27
  routes visually mounted no-redbox (profile jest-only); modals as cards;
  OS light↔dark live re-render both directions; pref-over-OS; cold-boot
  persistence (deepWaters+dark relaunch); gallery 6-cell scheme×accent
  matrix; Dynamic-Type-max role caps hold; launch burst shows no light app
  frame. Driven by a temporary in-app QA driver (no tap automation exists;
  custom-scheme `simctl openurl` posts an unacceptable confirm dialog).
- **Device QA (Sean, iPhone 15 Pro, 2026-07-21/22): full checklist cleared**
  — press feedback, dialog/sheet interactions, hit targets, Dynamic Type,
  Reduce Motion, full gallery scroll across all 6 theme combos, theme
  persistence over kill+relaunch, per-tab history via real tab presses,
  modal-vs-push conventions. Checklist artifact:
  claude.ai/code/artifact/ce817582-2638-467e-9464-27c79fe18dd3
- F-011 registry probe: 4th palette → 397/400 parameterized tests auto-cover;
  the 3 failures are the T-4.1 seed-pin gate demanding pins (by design);
  zero component changes.

## Landmines codified this phase (rules/mobile.md)

1. RN 0.86 Pressable defaults `accessible:true` → containers flatten AT trees.
2. expo-router 57 vendors its react-navigation fork; `Tabs` from
   `expo-router/js-tabs`.
3. Declared `Stack.Screen` children register first → pin `initialRouteName`.
4. Navigator-instantiated tab routes inherit no `[tripId]` param → layout
   TripIdProvider.
5. Imperative cross-tab `router.push`/`navigate` silently no-ops inside the
   vendored tab navigator (sim-confirmed live) — cross-tab jumps need
   tab-bar-press plumbing.
6. RNTL-14 × expo-router harness quirks (async renderRouter, fake-timer leak,
   press-poisoned mounts) — documented in navigation-skeleton.test.tsx header.

## Device-install bootstrap (first time, 2026-07-21)

Recorded for repeatability: CocoaPods needs `LANG=en_US.UTF-8`; cert CN's
"(QWA2JXVLHT)" suffix is NOT the team — team is the OU field (4B8499Z59P
personal team; certs were valid all along); non-interactive codesign needs
`security set-key-partition-list -S apple-tool:,apple:,codesign: -s` once
(Sean ran it); build via `xcodebuild -workspace ios/gogotravel.xcworkspace
-scheme gogotravel -destination 'platform=iOS,id=<udid>'
-allowProvisioningUpdates DEVELOPMENT_TEAM=4B8499Z59P`, install/launch via
`devicectl`; profile auto-minted for the bundle+device. Dev-client + Metro
means JS-only changes need no rebuild — kill+reopen the app.

## Carried forward

- Release-build splash/appearance verification (dev-client splash is
  Expo-blue) → P-14 pre-launch QA.
- Bundle id `com.anonymous.gogo-travel` is a placeholder until the Apple
  Developer account (new id = new install).
- tsconfig comment overstates node-builtin guard (judge note, cosmetic).
- Unidentified one-time LogBox warnings toast on device (never reproduced
  under the console watcher; QA passed regardless) — watch for recurrence.
- B-1 (F-001 ledger amendment protocol) still awaits Sean's nod.
