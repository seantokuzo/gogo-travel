#!/usr/bin/env bash
#
# Local E2E lane (ADR-007) — runs the Maestro flows in `.maestro/` against the
# booted iOS simulator and writes JUnit to `.tmp/e2e/`.
#
#   bash scripts/e2e.sh                      # release lane (excludes `dev`)
#   bash scripts/e2e.sh --tags dev           # dev-build-only flows
#   bash scripts/e2e.sh --flow .maestro/signin-renders.yaml
#   bash scripts/e2e.sh --device <udid>
#   bash scripts/e2e.sh -- --debug-output .tmp/e2e/debug   # passthrough
#
# NOT part of the CI gate. The gate is
# `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; this needs a native
# Release simulator build and a booted simulator, so it is a deliberate local
# pre-merge step. See ADR-007 and `.maestro/README.md`.
set -euo pipefail

# ── pins ──────────────────────────────────────────────────────────────────────
# Maestro is a JVM app installed OUTSIDE the repo (no package.json entry can
# pin it), so the pin is asserted here at run time. Override deliberately with
# MAESTRO_EXPECTED_VERSION=x.y.z when testing an upgrade.
MAESTRO_EXPECTED_VERSION="${MAESTRO_EXPECTED_VERSION:-2.10.0}"
APP_ID="app.gogotravel"

# Nothing about a test run leaves this machine (ADR-007 / Law #5).
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW_TARGET="$REPO_ROOT/.maestro"
OUT_DIR="$REPO_ROOT/.tmp/e2e"
DEVICE=""
INCLUDE_TAGS=""
EXCLUDE_TAGS="dev" # dev-build-only flows never run in the release lane
PASSTHROUGH=()

die() {
  echo "e2e: $*" >&2
  exit 1
}

# ── args ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tags)
      [[ $# -ge 2 ]] || die "--tags needs a value"
      INCLUDE_TAGS="$2"
      # An explicit tag selection owns the filter completely — otherwise
      # `--tags dev` would ask for the dev flows and exclude them in the same
      # breath, and silently run nothing.
      EXCLUDE_TAGS=""
      shift 2
      ;;
    --flow)
      [[ $# -ge 2 ]] || die "--flow needs a path"
      FLOW_TARGET="$2"
      shift 2
      ;;
    --device)
      [[ $# -ge 2 ]] || die "--device needs a UDID"
      DEVICE="$2"
      shift 2
      ;;
    --)
      shift
      PASSTHROUGH=("$@")
      break
      ;;
    -h | --help)
      # The header block, minus the shebang, up to the first line of code.
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) die "unknown argument: $1 (use -- to pass flags through to maestro)" ;;
  esac
done

# ── maestro ───────────────────────────────────────────────────────────────────
# The official installer puts it in ~/.maestro/bin, which is only on PATH in an
# interactive login shell — resolve it explicitly so this works from a script,
# a hook, or an agent.
if ! command -v maestro >/dev/null 2>&1; then
  if [[ -x "$HOME/.maestro/bin/maestro" ]]; then
    PATH="$HOME/.maestro/bin:$PATH"
    export PATH
  else
    die "maestro not found.
  Install ONLY from the official source (ADR-007):
    brew install mobile-dev-inc/tap/maestro
  or:
    export MAESTRO_VERSION=$MAESTRO_EXPECTED_VERSION
    curl -Ls https://get.maestro.mobile.dev | bash
  ⚠️ The npm package 'maestro' and the homebrew-CORE formula 'maestro' are
     unrelated projects that happen to share the name. Neither is this tool."
  fi
fi

# `maestro --version` prints the version on the last non-empty line (a first
# run may print an analytics notice above it).
ACTUAL_VERSION="$(maestro --version 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | tail -1)"
[[ -n "$ACTUAL_VERSION" ]] || die "could not read 'maestro --version' output"
if [[ "$ACTUAL_VERSION" != "$MAESTRO_EXPECTED_VERSION" ]]; then
  die "maestro $ACTUAL_VERSION installed, but this repo pins $MAESTRO_EXPECTED_VERSION.
  Flow semantics move between releases — upgrade deliberately (update the pin
  here and in ADR-007 / .maestro/README.md), or re-install the pinned version."
fi

# ── simulator ─────────────────────────────────────────────────────────────────
if [[ -z "$DEVICE" ]]; then
  DEVICE="$(xcrun simctl list devices booted |
    sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)) (Booted).*/\1/p' | head -1)"
fi
[[ -n "$DEVICE" ]] || die "no booted simulator. Boot one first:
  xcrun simctl boot <udid> && open -a Simulator
  (xcrun simctl list devices available)"

# A missing app is the single most common way this lane 'fails' — say so in one
# line instead of letting every flow die on launchApp.
if ! xcrun simctl get_app_container "$DEVICE" "$APP_ID" >/dev/null 2>&1; then
  die "$APP_ID is not installed on $DEVICE.
  Build and install the Release configuration first (ADR-007 build lane):
    LANG=en_US.UTF-8 npx expo prebuild --platform ios     # apps/mobile, CNG
    LANG=en_US.UTF-8 npx expo run:ios --configuration Release
  A Debug/dev build is for flow AUTHORING only — never the merge gate."
fi

# ── run ───────────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT_DIR/junit-$STAMP.xml"

ARGS=(--device "$DEVICE" test "$FLOW_TARGET"
  --format JUNIT
  --output "$REPORT"
  --test-output-dir "$OUT_DIR/artifacts-$STAMP"
  --test-suite-name "gogo-e2e")
[[ -n "$INCLUDE_TAGS" ]] && ARGS+=(--include-tags "$INCLUDE_TAGS")
[[ -n "$EXCLUDE_TAGS" ]] && ARGS+=(--exclude-tags "$EXCLUDE_TAGS")
[[ ${#PASSTHROUGH[@]} -gt 0 ]] && ARGS+=("${PASSTHROUGH[@]}")

echo "e2e: maestro $ACTUAL_VERSION · device $DEVICE · $FLOW_TARGET"
echo "e2e: junit → $REPORT"

set +e
maestro "${ARGS[@]}"
STATUS=$?
set -e

echo
if [[ -f "$REPORT" ]]; then
  echo "e2e: report $REPORT"
  grep -o '<testsuite [^>]*>' "$REPORT" || true
else
  echo "e2e: no JUnit report was written (maestro exited $STATUS before reporting)" >&2
fi
exit $STATUS
