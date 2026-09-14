# `.maestro/` — the E2E lane

Maestro flows that drive the real app on a real simulator. Decision, rationale
and known limits: [ADR-007](../docs/decisions/ADR-007-maestro-e2e-lane.md).
Runner: [`scripts/e2e.sh`](../scripts/e2e.sh).

This lane is **local pre-merge**, not CI. The CI gate is unchanged:
`pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Install — read this before you type `install maestro`

> ⚠️ **The npm package `maestro` and the homebrew-CORE formula `maestro` are
> UNRELATED PROJECTS that happen to share the name.** Neither is this tool.
> Installing either gets you something else entirely, and it will not announce
> itself.

Only two sources are Maestro:

```bash
# preferred
brew install mobile-dev-inc/tap/maestro

# official installer (use this if brew wants to build deps from source —
# e.g. an outdated Command Line Tools install blocks the tap)
export MAESTRO_VERSION=2.10.0
curl -Ls https://get.maestro.mobile.dev | bash
```

**Pinned version: `2.10.0`** — asserted at runtime by `scripts/e2e.sh`, which
refuses to run against a different one (flow semantics move between releases).
Upgrading means changing the pin here, in the runner, and in ADR-007, on
purpose.

Installed at `~/.maestro/bin/maestro` on this machine. Maestro is a JVM app;
**Java 17+** must be on PATH (nothing in `package.json` pins it — it is a
machine dependency, not a repo dependency). The official installer appends
`~/.maestro/bin` to `~/.zshrc` / `~/.bash_profile`; `scripts/e2e.sh` also
resolves that path directly, so the lane works from a non-login shell.

### Analytics: off

`scripts/e2e.sh` exports `MAESTRO_CLI_NO_ANALYTICS=1` (and
`MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true`) on every invocation. Setting
it before the **first** run also writes `~/.maestro/analytics.json` with
`"enabled": false`, which is the durable opt-out — verify with:

```bash
grep '"enabled"' ~/.maestro/analytics.json   # → "enabled" : false
```

## The build lane

Merge-candidate runs go against a **Release-configuration simulator build**.
`apps/mobile/ios` is generated and gitignored (CNG), so a fresh worktree
prebuilds first:

```bash
cd apps/mobile
LANG=en_US.UTF-8 npx expo prebuild --platform ios   # CocoaPods needs the locale
LANG=en_US.UTF-8 npx expo run:ios --configuration Release
```

Traps, all previously hit here:

- **CocoaPods needs `LANG=en_US.UTF-8`.** Without it `pod install` dies on a
  locale error.
- **`npx expo run:ios` exits right after launch in a non-interactive shell.**
  That is fine — the app is built and installed; only the log stream ended.
- **🔴 UNINSTALL the pre-PR-#33 `com.anonymous.gogo-travel` app before running —
  it HIJACKS the `gogo:` scheme and breaks every `openLink` cell.** The current
  id is **`app.gogotravel`** (`app.json`), but the stale app registers
  `CFBundleURLSchemes: [gogo, com.anonymous.gogo-travel]` too, so with both
  installed iOS may hand a `gogo://…` URL to the _stale_ one. It is a Debug
  build with no embedded jsbundle, so it comes up on the RN redbox **"No script
  URL provided … unsanitizedScriptURLString = (null)"** and every deeplink flow
  fails on an assertion about a screen that was never in the app under test.
  Cost 2/4 red on the first real S-4 run, 2026-09-07. The fix is one line:

  ```bash
  xcrun simctl uninstall <UDID> com.anonymous.gogo-travel
  ```

  General rule: the `openLink` cells are only meaningful when **exactly one**
  installed app claims `gogo:`. Check with
  `xcrun simctl get_app_container <UDID> com.anonymous.gogo-travel` — "No such
  file or directory" is what you want.

- **🔴 SAME TRAP, new cause: a door build AND the door-free build installed
  side by side.** `app.json`'s `"scheme": "gogo"` is shared — `app.config.ts`'s
  door variant only suffixes `bundleIdentifier`/`name`, never the scheme — so
  `app.gogotravel.e2edoor` and `app.gogotravel` BOTH claim `gogo:` whenever
  both are installed at once (e.g. building door then door-free back to back
  to verify both lanes in one sitting, S-4 T5, 2026-09-14). `openLink` then
  becomes nondeterministic about which one iOS hands the URL to — this
  produced a real, reproducible `session-door-absent` false failure
  (`e2e-session-screen`/`-error` where `-inert` was expected — the door
  build answering a link meant for the door-free one), confirmed by
  `xcrun simctl uninstall <UDID> app.gogotravel.e2edoor` making the SAME run
  green immediately after, with no other change. `--variant doorfree`'s own
  proof is therefore only trustworthy with the door build ABSENT from the
  simulator — never test both variants' `openLink` flows on one simulator in
  the same session without uninstalling the other first.

- **`expo run:ios` has no `--derived-data` flag** and finds the built product by
  scraping the default `~/Library/Developer/Xcode/DerivedData` path out of the
  build log. Derived data is still isolated per checkout because the key is a
  hash of the _project path_, and each worktree has its own. To pin it
  explicitly, drive `xcodebuild` directly:

  ```bash
  cd apps/mobile/ios
  xcodebuild -workspace gogotravel.xcworkspace -scheme gogotravel \
    -configuration Release -sdk iphonesimulator \
    -destination 'platform=iOS Simulator,id=<UDID>' \
    -derivedDataPath ../../../.tmp/xcode-derived \
    ONLY_ACTIVE_ARCH=YES build
  xcrun simctl install <UDID> \
    ../../../.tmp/xcode-derived/Build/Products/Release-iphonesimulator/gogotravel.app
  ```

- **Pass `ONLY_ACTIVE_ARCH=YES` on a Release simulator build.** Release defaults
  it to `NO`, so xcodebuild compiles the whole dependency tree for **both**
  `x86_64` and `arm64` — roughly double the wall time for a slice the simulator
  will never load. (Cost measured the hard way on the first S-4 build.)
- **A dev-client / Debug build is for flow AUTHORING only.** Black-box
  `launchApp` against one lands on the dev launcher, and `clearState: true`
  wipes the stored Metro URL. It is never the merge gate.

## Run

```bash
pnpm --filter @gogo/mobile e2e          # release lane (door build, excludes `dev` flows)
bash scripts/e2e.sh --variant doorfree  # the periodic door-free proof (flows 1-4 + session-door-absent)
bash scripts/e2e.sh --tags dev          # dev-build-only flows (implies --variant dev)
bash scripts/e2e.sh --flow .maestro/sign-in-renders.yaml
bash scripts/e2e.sh -- --debug-output .tmp/e2e/debug
```

JUnit lands in `.tmp/e2e/junit-<timestamp>.xml`, screenshots and command
artifacts in `.tmp/e2e/artifacts-<timestamp>/`. `.tmp/` is gitignored.

Before invoking maestro, the runner independently enumerates which flows the
current `--tags`/`--flow`/`--exclude-tags` filter selects and prints the
count and the list (S-4 round 1) — and refuses to run at all if that count is
zero. After the run it also refuses to treat a JUnit report with `tests="0"`
(or no report at all) as a pass, even if maestro itself exited `0`. Both are
defense against a filter silently matching nothing.

### App id / build variant (R-door-15)

Every flow's `appId:` reads `${APP_ID}` — Maestro's own env-var substitution
— rather than a literal, injected by the runner via `-e APP_ID=<value>` on
every `maestro test` invocation. There is no single hard-coded bundle id:
each lane resolves its own default, every one overridable with
`GOGO_E2E_APP_ID`:

| `--variant`           | Default app id           | Build                                           |
| --------------------- | ------------------------ | ----------------------------------------------- |
| `door` (default)      | `app.gogotravel.e2edoor` | `pnpm ios:door` — the merge-gate build          |
| `dev` (`--tags dev`)  | `app.gogotravel`         | `npx expo run:ios` (Debug) — authoring only     |
| `doorfree` (explicit) | `app.gogotravel`         | `pnpm ios:doorfree` — the door-free proof build |

`--variant` wins outright when passed. Otherwise it derives from `--tags`:
`--tags dev` implies `dev`; every other invocation (including the default,
no-flag run) implies `door`. `doorfree` is **never** derived automatically —
pass `--variant doorfree` explicitly, since its default tag filter is
otherwise identical to `door`'s. The installed-app self-check
(`scripts/e2e.sh`, the `xcrun simctl get_app_container` guard) runs against
the resolved id, so a wrong-variant install `die()`s naming both the
resolved id and the active `--variant`.

### Evidence durability (R-door-10)

A completed run's JUnit report and artifact directory are copied to
`~/.gogo/e2e/<timestamp>/` (mode `0700`, outside this worktree) regardless of
pass/fail, and the run prints that path, the copied JUnit path, and the
run's own `~/.maestro/tests/<maestro-timestamp>/maestro.log` path (Maestro
picks its own timestamp for this — a different clock read than the runner's
`$STAMP` — so the runner resolves it post-run as the newest entry under
`~/.maestro/tests`). A failed copy fails the whole run, even if `maestro`
itself exited `0`.

The runner requires a **booted** simulator and refuses to start without one:

```bash
xcrun simctl list devices available
xcrun simctl boot <udid> && open -a Simulator
```

## Flows

| Flow                          | Tags                             | What it pins                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke-diagnostics-cold.yaml` | `smoke` `release`                | B-14: a cold-start `gogo://` deeplink into an (auth) route is not stomped to sign-in. Two arms — a control cold-start that MUST reach sign-in, then the pin, which also asserts the route's own liveness marker.                                              |
| `deeplink-matrix.yaml`        | `release`                        | The signed-out gate holds cold and warm for 6 cold cells + 2 warm-parity cells (R-nav-16) — gated links gate, the (auth) route doesn't, nothing crashes or hangs. Does **not** pin the registry's individual mappings (unit-covered in `deep-links.test.ts`). |
| `sign-in-renders.yaml`        | `smoke` `release`                | Sign-in mounts on the real runtime with Google **unconfigured** — the exact state that crashed the screen in T-5.7. Asserts the Google door is `enabled: false`, not just visible.                                                                            |
| `sign-in-cancel-surface.yaml` | `release` `env-no-apple-account` | The Google door renders disabled; cancelling the Apple provider sheet is not an error. MED feasibility — see ADR-007 limit 4. Assumes the sim is NOT signed into an Apple Account (the tag says so).                                                          |
| `diagnostics-panel-dev.yaml`  | `dev`                            | The `gogo://diagnostics` panel's own surface. **Debug build only** — see below.                                                                                                                                                                               |

`subflows/` holds `runFlow: file:` fragments (`cold-open`, `warm-open`). They
are parameterised and meaningless standalone; `config.yaml` restricts test
discovery to top-level `*.yaml` so they are never run as flows.

### Why one flow is `dev`-only

The diagnostics panel is `__DEV__`-gated by design (T-S3.5: a release build
renders no dev surface — an inert `diagnostics-screen-inert` marker, not the
real panel; both arms pinned) and the merge lane is Release by design
(ADR-007). Both are correct; they just do not intersect. So the coverage
splits: `smoke-diagnostics-cold.yaml` pins the **B-14 invariant** on Release
(the actual regression — the deeplink is not stomped — plus route liveness via
the inert marker), and `diagnostics-panel-dev.yaml` pins the panel's own
testIDs on a Debug build:

```bash
pnpm --filter @gogo/mobile start        # terminal 1 — Metro
bash scripts/e2e.sh --tags dev          # terminal 2
```

**Do not "fix" this by writing one flow that passes on both configurations.**
A conditional satisfied by a blank screen is a vacuous pin.

## Writing flows here

- **Selectors are testIDs.** Maestro's `id:` maps to iOS
  `accessibilityIdentifier`, which is what RN's `testID` sets. The grammar is
  `.specs/client/navigation.spec.md` §2.7 (`<screen>-<element>[-qualifier]`,
  roots `<screen>-screen`, tabs `tab-bar-{key}`) and it is lint-gated, so the
  IDs a flow needs generally already exist. Text selectors are for system UI
  (SpringBoard prompts, provider sheets) that has no testID to give.
- **Cross-tab moves go through the tab bar.** `router.push()` to a route in
  another tab silently no-ops inside expo-router 57's vendored tab navigator
  (sim-confirmed, P-4 QA). A flow that "navigates" cross-tab must press
  `tab-bar-{key}`.
- **Every negative assertion needs a positive control.** `assertNotVisible` is
  also satisfied by a crashed app, a stuck splash, and an app that never
  launched. Pair it with an arm that proves the thing IS observable on this
  build in this run — `smoke-diagnostics-cold.yaml` is the worked example.
- **No blind `- wait`.** Maestro's assertions auto-wait and retry (~7s). When
  more is genuinely needed, `extendedWaitUntil` with a stated timeout, so the
  intent is in the file.
- **Cold means cold.** `stopApp` before `openLink`, or the URL arrives as a
  warm `url` event on a different code path — which is how a cold-start
  regression hides behind a green warm test.

## Not covered (yet)

- Everything past the auth gate — trips, itinerary, money, map. Waiting on the
  **session door** (env-gated test session, approved 2026-09-07; wave 2).
- The `https://links.gogotravel.example/…` universal-link transport: the domain
  is a placeholder until the P-14 buy and serves no AASA, so a simulator will
  not route it to the app.
- The Mapbox map canvas (assert _around_ it via marker testIDs) and
  picker/keyboard feel — both stay a human pass. ADR-007 limits 2 and 3.
