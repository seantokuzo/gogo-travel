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
- **The sim may still carry the pre-PR-#33 bundle id `com.anonymous.gogo-travel`.**
  The current id is **`app.gogotravel`** (`app.json`). A rebuild installs the
  new one; the stale app is a separate icon and can be deleted.
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
pnpm --filter @gogo/mobile e2e          # release lane (excludes `dev` flows)
bash scripts/e2e.sh --tags dev          # dev-build-only flows
bash scripts/e2e.sh --flow .maestro/signin-renders.yaml
bash scripts/e2e.sh -- --debug-output .tmp/e2e/debug
```

JUnit lands in `.tmp/e2e/junit-<timestamp>.xml`, screenshots and command
artifacts in `.tmp/e2e/artifacts-<timestamp>/`. `.tmp/` is gitignored.

The runner requires a **booted** simulator and refuses to start without one:

```bash
xcrun simctl list devices available
xcrun simctl boot <udid> && open -a Simulator
```

## Flows

| Flow                          | Tags              | What it pins                                                                                                                                                 |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smoke-diagnostics-cold.yaml` | `smoke` `release` | B-14: a cold-start `gogo://` deeplink into an (auth) route is not stomped to sign-in. Two arms — a control cold-start that MUST reach sign-in, then the pin. |
| `deeplink-matrix.yaml`        | `release`         | The §2.3 registry × the signed-out gate, cold and warm: 6 cold cells + 2 warm-parity cells (R-nav-16).                                                       |
| `signin-renders.yaml`         | `smoke` `release` | Sign-in mounts on the real runtime with Google **unconfigured** — the exact state that crashed the screen in T-5.7.                                          |
| `signin-cancel-surface.yaml`  | `release`         | The Google door renders disabled; cancelling the Apple provider sheet is not an error. MED feasibility — see ADR-007 limit 4.                                |
| `diagnostics-panel-dev.yaml`  | `dev`             | The `gogo://diagnostics` panel's own surface. **Debug build only** — see below.                                                                              |

`subflows/` holds `runFlow: file:` fragments (`cold-open`, `warm-open`). They
are parameterised and meaningless standalone; `config.yaml` restricts test
discovery to top-level `*.yaml` so they are never run as flows.

### Why one flow is `dev`-only

The diagnostics panel is `__DEV__`-gated by design (T-S3.5: a release build
renders `null`, both arms pinned) and the merge lane is Release by design
(ADR-007). Both are correct; they just do not intersect. So the coverage
splits: `smoke-diagnostics-cold.yaml` pins the **B-14 invariant** on Release
(the actual regression — the deeplink is not stomped), and
`diagnostics-panel-dev.yaml` pins the panel's own testIDs on a Debug build:

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
