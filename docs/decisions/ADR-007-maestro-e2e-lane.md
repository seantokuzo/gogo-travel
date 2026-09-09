# ADR-007: Maestro is the E2E lane — local-first, against a Release simulator build

**Status:** Accepted (ruled by Sean 2026-09-07)
**Date:** 2026-09-07
**Supersedes:** none
**Superseded by:** none

## Context

[ADR-006](ADR-006-testing-strategy-overhaul.md) built four layers above unit
tests (faithful env + boot shapes · mock-fidelity contracts · shared-container
fresh-DB · device smoke · hostile fixtures) and explicitly **parked** tap
automation: "Maestro/Detox tap automation, device-farm SaaS — NOT adopted"
(S-3, `.specs/testing/testing-overhaul.spec.md`). The park was a scope call,
not a rejection. What ADR-006 could not fix is the class of bug that only
exists once the JS bundle, the native runtime, and the OS all meet: five device
bugs (B-4..B-8) were caught by Sean in QA, none catchable by ~3000 unit tests.
B-14 — the cold-start deeplink stomp — was found by Sean mid-QA and is the
sharpest example: it required a **real cold launch delivering a real
`gogo://` URL to a real navigator**. `renderRouter`'s `serverUrl` prefetch is
the structural blind spot (lane-confirmed during B-14's review): its initial
URL flows in synchronously, so `useSegments()` is coherent from the very first
render — on device the initial URL arrives from the native module and can
resolve asynchronously, which is exactly the window B-14 lived in. That blind
spot is real and is the reason this lane exists — but it is not "nothing in
jest reproduced it": `diagnostics-coldstart-race.test.tsx` (added alongside
the B-14 fix, refined in PR #46 R1) is the bespoke falsification pin that
renders `ExpoRoot` directly with a promise-valued `getLinkingURL` to drive
that real async branch, runs in CI, and stays red on unfixed main. This lane's
`smoke-diagnostics-cold.yaml` is not the ONLY regression pin for B-14; it adds
the real native initial-URL delivery on top of that jest pin.

The residual gap after ADR-006 is therefore: **nobody but Sean drives the real
app.** Every regression in navigation, cold start, deeplink delivery, or the
gate's redirect ordering is discovered manually, one QA pass at a time.

Constraints the choice has to respect:

- **Law #5 — no metered API spend.** Anything with a per-run cloud bill, a
  device-farm subscription, or a seat charge is out by construction.
- **[ADR-003](ADR-003-local-in-session-reviews.md) — reviews and automation run
  local, in-session.** GH-hosted macOS runners are optional later, never the
  gate that has to exist first.
- **RN 0.86.2 / Expo 57** ([ADR-004](ADR-004-stack-expo-rn-hono-drizzle.md)).
  The stack is at the leading edge; a runner that lags RN is unusable.
- The repo already has the selector substrate: the **lint-gated testID grammar**
  (`.specs/client/navigation.spec.md` §2.7, R-nav-22 — raw RN interactives in
  `src/app`/`src/navigation` fail lint without a testID).

Prior art in this repo: **AXe tap automation was proven working 2026-09-04** and
drove the B-14 deeplink QA matrix autonomously (ADR-006 §"What we rejected").
It works — but it is a raw tap driver, not a test runner: no wait/retry kernel,
no assertions, no reporting, no flake tolerance.

## Decision

**We adopt Maestro CLI as the E2E lane.** Flows live in `.maestro/` at the repo
root, select elements through the existing testID grammar (Maestro's `id:`
selector maps to iOS `accessibilityIdentifier`, which is exactly what RN's
`testID` sets), and run **locally** against a **Release-configuration
simulator build** via `scripts/e2e.sh` / `pnpm --filter @gogo/mobile e2e`.

Specifics that are part of the decision, not implementation detail:

1. **Version + install path are pinned.** Maestro **2.10.0**, installed from
   the official installer (`https://get.maestro.mobile.dev`, `MAESTRO_VERSION`
   pinned) into `~/.maestro/bin`, or `brew install mobile-dev-inc/tap/maestro`.
   ⚠️ **Squatter warning:** the npm package `maestro` and the _homebrew-core_
   formula `maestro` are **unrelated projects** that happen to share the name.
   Installing either gets you something that is not this tool. Only
   `mobile-dev-inc/tap` and the official script are Maestro. The runner asserts
   the version at startup so a drifted local install fails loudly instead of
   silently changing semantics.
2. **Analytics off.** `MAESTRO_CLI_NO_ANALYTICS=1` is exported by
   `scripts/e2e.sh` for every invocation, and the first run wrote
   `~/.maestro/analytics.json` with `"enabled": false`. Nothing about a test
   run leaves the machine.
3. **The build lane is Release.** Merge-candidate runs go against a
   `-configuration Release` simulator build (`xcodebuild`, or
   `npx expo run:ios --configuration Release`) with a **dedicated
   derived-data path**. Debug/dev-client builds
   are for **flow authoring only** — a black-box `launchApp` against a
   dev-client build lands on the dev launcher, and `clearState: true` wipes the
   stored Metro URL, so an authoring build cannot be the gate.
4. **Maestro is additive.** It does not replace jest, the server suite, the
   `gogo://diagnostics` device-smoke panel, or Sean's human QA pass. It
   replaces the _runsheet_ — the scripted sequence of taps a human currently
   repeats every phase.
5. **AXe stays the escape hatch.** When a surface is unreachable through
   accessibility (see Known limits), AXe's coordinate taps remain the fallback,
   invoked deliberately and documented at the call site — never as the default
   driver.
6. **Not in the CI gate.** The gate command stays
   `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. The E2E lane is a
   **local pre-merge lane**. A GitHub macOS runner is a future option, weighed
   on its own merits (minute cost is real money on private repos), not assumed.

### Why Maestro

- **It is the official Expo E2E path.** Expo's own testing documentation
  documents Maestro, and only Maestro, for end-to-end flows. Being on the
  path the framework maintainers keep working is worth more than any feature
  comparison — it is the difference between "our runner broke on the Expo 58
  upgrade" and "the upgrade docs tell us what changed".
- **Free CLI, zero metered components.** Maestro Cloud exists and is paid;
  the CLI is not, and we use only the CLI. Law #5 is satisfied by
  construction, not by discipline.
- **`openLink` does `gogo://` cold start first-class.** This is the specific
  capability B-14 needed and jest could not provide: kill the app, deliver a
  custom-scheme URL, assert where the navigator actually landed.
- **The wait/retry kernel is the product.** Maestro's assertions are fluent —
  `assertVisible` / `assertNotVisible` auto-wait and retry (~7s default) rather
  than sampling once. That kernel is precisely what a homegrown AXe rig would
  have to rebuild, badly, and it is why the flake posture below is what it is.
- **Selector substrate already exists.** `id:` → `accessibilityIdentifier` →
  RN `testID`, and testIDs are lint-gated here. Adoption cost on the app side
  is approximately zero.

### Why not Detox — disqualified on fact, not preference

Detox's supported React Native range is **0.77–0.84**. We ship **RN 0.86.2**.
That is not a "probably fine" gap: Detox's synchronization hooks into RN
internals, which is exactly the surface that moves between minors. Detox's v21
alpha line chases newer RN, but an alpha is not a base for the only thing
standing between us and a manual runsheet. Detox is reconsiderable if and when
its stable range covers our RN — a new ADR, not a quiet swap.

## Alternatives considered

**Detox.** Rejected on the supported-RN-range fact above. Secondary strikes:
grey-box synchronization means Detox failures are frequently Detox's own
sync bugs, and it requires a native test target (more prebuild surface in a CNG
project where `apps/mobile/ios` is generated and gitignored).

**Homegrown AXe rig.** AXe tap automation is proven in this repo (2026-09-04,
B-14 matrix) and stays as the escape hatch. Rejected as the _primary_ lane
because "make AXe into a test runner" means writing a wait/retry kernel,
an assertion vocabulary, a selector layer, flake tolerance, and a JUnit
reporter — i.e. rewriting Maestro, with one maintainer, and owning every bug in
it. The correct use of a proven raw driver is as the fallback for what the
framework cannot reach, not as the framework.

**Appium / WebdriverIO.** Rejected: heaviest setup in the field (server +
driver + capability matrix), the slowest feedback loop of the options, and
nothing in the extra generality buys us anything — we test one app on one
platform first. Its cross-platform reach only matters at the Android
verification pass, which is a different problem with a different budget.

**Device-farm SaaS (BrowserStack / Sauce / Maestro Cloud).** Rejected under
Law #5 and Autonomy trigger #3 — metered spend and an account signup. Also
solves a problem we do not have: we need _one_ deterministic simulator, not a
device matrix.

**`maestro-runner` (devicelab-dev).** A third-party drop-in replacement for the
Maestro CLI advertising ~3.6× speed and ~14× less memory. **Watch, do not
adopt.** It is a re-implementation by a different vendor; adopting it now
trades the official-Expo-path benefit (the entire reason Maestro wins) for
speed we do not yet need. Revisit only if CLI run time becomes the binding
constraint, and only as its own ADR.

**Keep doing manual QA.** The status quo. Rejected: it is precisely what
produced five device bugs found by the one human in the loop, and it does not
scale past the number of runsheets Sean is willing to re-run per phase.

## Consequences

### Positive

- Cold-start and deeplink behavior become **testable**. The B-14 class of bug
  gets a regression pin that runs on demand instead of a note in STATE.
- The runsheet becomes code. Phase QA stops being "re-do the taps" and becomes
  "read the JUnit".
- Zero new spend, zero new accounts, zero new CI surface (Law #5, ADR-003).
- No app-source cost: the flows ride testIDs the lint rule already forces to
  exist. E2E coverage becomes a reason the testID grammar keeps paying off,
  rather than a new obligation.

### Negative

- **A Release simulator build is now a pre-merge prerequisite** for the E2E
  lane, and it is slow (full native build; CocoaPods needs
  `LANG=en_US.UTF-8`). The lane is deliberately _not_ wired into
  `pnpm test` for this reason.
- **A JVM dependency** enters the local toolchain (Maestro is a JVM app; Java
  17 is present on this machine). It is not a repo dependency — nothing in
  `package.json` changes — but a fresh machine needs it.
- One more thing to keep pinned and to notice when it drifts. Mitigated by the
  runner's version assertion.
- **CNG friction:** `apps/mobile/ios` is generated and gitignored, so every
  fresh worktree needs `expo prebuild` + `pod install` before it can build.

### Neutral

- Flows are YAML, not TypeScript. No typecheck, no lint, no refactor tooling
  over them — the safety net is that they are executed constantly and fail
  loudly. Keep them short and keep the selectors in the grammar.
- Maestro is on a roughly monthly release cadence. Pinning means deliberate
  upgrades; it also means we will lag by design.

## Known limits (set expectations here, not in a post-mortem)

1. **The `__DEV__` gate vs the Release build lane.** The
   `gogo://diagnostics` panel is `__DEV__`-only by design (T-S3.5: a release
   build mounts no dev surface — an inert `diagnostics-screen-inert` marker,
   not the real panel; both arms pinned). A Release build therefore **cannot**
   assert the panel's own testIDs. This is not a defect in either decision — it
   is the intersection of two correct ones. The split we adopt:
   `smoke-diagnostics-cold.yaml` asserts the **B-14 invariant** on Release (the
   cold-start deeplink is not stomped back to sign-in — the actual regression —
   plus the route's own liveness, via the inert marker, so the pin cannot be
   satisfied by a crashed app), while `diagnostics-panel-dev.yaml` asserts the
   panel's testIDs and is **tagged `dev`**, excluded from the Release lane, and
   run against a Debug build with Metro when the panel itself is under change.
   Never "solve" this with a conditional that passes on both builds — that is a
   vacuous pin, and this repo has scar tissue from exactly that shape.
2. **The Mapbox map canvas is pixel/gesture territory.** `@rnmapbox/maps`
   renders to a native canvas with no accessibility tree worth asserting on.
   Flows assert **around** it — marker/annotation testIDs, the surrounding
   chrome, the sheet that a marker tap opens — never the map's own rendering.
   Map _appearance_ stays a human pass.
3. **Picker and keyboard _feel_ stays human.** Maestro can drive
   `@react-native-community/datetimepicker` and assert the resulting value, but
   "does the wheel feel right, does the keyboard cover the field, does the
   sheet spring" is not assertable. Those stay in Sean's QA pass.
4. **`ASWebAuthenticationSession` may resist accessibility taps.** The
   OAuth sheet is a separate out-of-process UI. `sign-in-cancel-surface.yaml`
   is written to the point of the sheet; if the sheet's Cancel is not
   reachable, the flow is marked and the coverage moves to the **session door**
   (the env-gated test-session bypass, approved 2026-09-07, wave 2) rather than
   being faked. That flow also assumes the lane's simulator is NOT signed into
   an Apple Account — a real environmental dependency, not a universal
   invariant — and is tagged `env-no-apple-account` so a reader (and a future
   runner) knows it. It leaves cleanup to an `onFlowComplete` hook so a failure
   partway through does not strand a system sheet for the next flow in the run
   (S-4 round 1: this happened once and cascaded one real failure into 4/4
   red).
5. **Flake posture: trust the auto-wait.** Maestro's fluent assertions retry;
   we do **not** paper over timing with `- wait` sleeps. If a flow is flaky,
   the fix is a better selector or `extendedWaitUntil` with a stated timeout,
   never a blind sleep. Sleeps are how a suite becomes slow _and_ still flaky.
6. **Unauthed reach is shallow.** Without the session door, flows can only
   exercise sign-in, the deeplink registry's gate behavior, and the dev panel.
   Everything past the gate (trips, itinerary, money, map) is wave 2 and
   depends on the door.
7. **`deeplink-matrix.yaml` pins gate/transport behavior, not the registry's
   individual mappings.** Its five cold cells (C1–C5) all assert the same
   postcondition — `sign-in-screen` visible — so they carry one bit between
   them: a gated link still gates, cold and warm parity holds for the (auth)
   route, and nothing crashes or hangs on any of the five shapes. They do
   **not** distinguish one registry mapping from another (delete or mis-map
   `/invite/[token]` → `/join/[token]` in `deep-links.ts` and C2 still goes
   green via the fallback path). The registry's actual mapping correctness is
   unit-covered in `deep-links.test.ts`; this flow's job is the gate/transport
   behavior around it.

## Links

- [ADR-003](ADR-003-local-in-session-reviews.md) — local in-session automation;
  no metered CI
- [ADR-004](ADR-004-stack-expo-rn-hono-drizzle.md) — Expo/RN + the RN version
  that disqualifies Detox
- [ADR-006](ADR-006-testing-strategy-overhaul.md) — the four layers this ADR
  adds a fifth to; the park this ADR unparks
- `.specs/testing/testing-overhaul.spec.md` — S-3 strategy spec
- `.specs/client/navigation.spec.md` §2.3 (deep-link registry), §2.7 (testID
  grammar — the selector substrate)
- `.maestro/README.md` — install, run, and flow inventory
- `scripts/e2e.sh` — the local runner
- S-4 (QUEUE) — the spike this ADR concludes; B-14 (QUEUE) — the bug that
  motivated it
