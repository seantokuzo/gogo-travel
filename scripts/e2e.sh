#!/usr/bin/env bash
#
# Local E2E lane (ADR-007) — runs the Maestro flows in `.maestro/` against the
# booted iOS simulator and writes JUnit to `.tmp/e2e/`.
#
#   bash scripts/e2e.sh                      # release lane (excludes `dev`)
#   bash scripts/e2e.sh --tags dev           # dev-build-only flows
#   bash scripts/e2e.sh --flow .maestro/sign-in-renders.yaml
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
      # Same failure class as --tags above: leaving the default `dev`-exclude
      # filter active while naming one explicit flow can filter out the very
      # flow you asked for and silently run nothing. An explicit --flow target
      # owns the filter completely, just like an explicit --tags selection.
      EXCLUDE_TAGS=""
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

# `command -v` resolves whichever `maestro` comes first on $PATH — which may
# be a same-named squatter (npm global package, or the homebrew-CORE formula;
# both unrelated projects, see ADR-007 / .maestro/README.md) sitting ahead of
# ~/.maestro/bin. A `--version` string match alone is not binary identity:
# resolve the symlink chain and require the REAL path to be one this repo
# recognizes before trusting anything the binary prints.
RESOLVED_MAESTRO="$(command -v maestro)"
REAL_MAESTRO="$RESOLVED_MAESTRO"
while [[ -L "$REAL_MAESTRO" ]]; do
  LINK="$(readlink "$REAL_MAESTRO")"
  [[ "$LINK" == /* ]] || LINK="$(dirname "$REAL_MAESTRO")/$LINK"
  REAL_MAESTRO="$LINK"
done
REAL_MAESTRO="$(cd "$(dirname "$REAL_MAESTRO")" && pwd -P)/$(basename "$REAL_MAESTRO")"

MAESTRO_IDENTITY_OK=0
if [[ -d "$HOME/.maestro/bin" ]]; then
  # $HOME itself may sit behind a symlink (e.g. macOS's /var → /private/var),
  # so canonicalize it the same way REAL_MAESTRO was, or a legitimate install
  # fails this check on a path technicality.
  HOME_MAESTRO_BIN_REAL="$(cd "$HOME/.maestro/bin" && pwd -P)"
  case "$REAL_MAESTRO" in
    "$HOME_MAESTRO_BIN_REAL/"*) MAESTRO_IDENTITY_OK=1 ;;
  esac
fi
if [[ "$MAESTRO_IDENTITY_OK" -eq 0 ]] && command -v brew >/dev/null 2>&1; then
  # The sanctioned brew source is the mobile-dev-inc tap specifically — not
  # whatever formula named "maestro" brew happens to resolve.
  TAP_PREFIX="$(brew --prefix mobile-dev-inc/tap/maestro 2>/dev/null || true)"
  if [[ -n "$TAP_PREFIX" && -d "$TAP_PREFIX" ]]; then
    TAP_REAL="$(cd "$TAP_PREFIX" && pwd -P)"
    case "$REAL_MAESTRO" in
      "$TAP_REAL"*) MAESTRO_IDENTITY_OK=1 ;;
    esac
  fi
fi
[[ "$MAESTRO_IDENTITY_OK" -eq 1 ]] || die "maestro on \$PATH resolves to $REAL_MAESTRO,
  which is neither ~/.maestro/bin (the official installer) nor the
  mobile-dev-inc/tap homebrew formula. This is very likely the npm package
  'maestro' or the homebrew-CORE formula 'maestro' — unrelated projects that
  share the name (ADR-007 / .maestro/README.md). Uninstall the squatter, or
  fix \$PATH ordering so ~/.maestro/bin (or 'brew install
  mobile-dev-inc/tap/maestro') resolves first."

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

# ── flow selection ───────────────────────────────────────────────────────────
# Independently enumerate which top-level flows the current --tags/--flow
# filter selects, using the same include/exclude semantics maestro's CLI
# applies, so a filter that matches nothing is caught BEFORE invoking
# maestro — not just after, from the JUnit report (belt-and-braces #2; the
# JUnit-based guard below is the second layer for anything this misses). This
# is also what catches a flow-layout change (e.g. a future wave nesting flows
# under `.maestro/release/`, which `config.yaml`'s `flows: - "*.yaml"` does
# not match) reducing the lane to zero tests — this enumeration reads the same
# top-level layout `config.yaml` does, so it degrades the same way and fails
# loudly instead of silently.
flow_tags() {
  # Tags sit in the flow's YAML header, one per `- <tag>` line under a
  # top-level `tags:` key, before the `---` command-list separator.
  awk '
    /^---$/ { exit }
    /^tags:/ { intags=1; next }
    intags && /^  - / { sub(/^  - /, ""); printf "%s,", $0; next }
    intags { intags=0 }
  ' "$1"
}

SELECTED_FLOWS=()
if [[ -f "$FLOW_TARGET" ]]; then
  SELECTED_FLOWS=("$FLOW_TARGET")
elif [[ -d "$FLOW_TARGET" ]]; then
  for f in "$FLOW_TARGET"/*.yaml; do
    [[ -e "$f" ]] || continue
    [[ "$(basename "$f")" == "config.yaml" ]] && continue
    TAGS=",$(flow_tags "$f")"
    MATCHED=1
    if [[ -n "$INCLUDE_TAGS" ]]; then
      MATCHED=0
      IFS=',' read -ra WANT <<<"$INCLUDE_TAGS"
      for w in "${WANT[@]}"; do
        [[ "$TAGS" == *",$w,"* ]] && MATCHED=1 && break
      done
    fi
    if [[ "$MATCHED" -eq 1 && -n "$EXCLUDE_TAGS" ]]; then
      IFS=',' read -ra EXCL <<<"$EXCLUDE_TAGS"
      for x in "${EXCL[@]}"; do
        [[ "$TAGS" == *",$x,"* ]] && MATCHED=0 && break
      done
    fi
    [[ "$MATCHED" -eq 1 ]] && SELECTED_FLOWS+=("$f")
  done
fi

echo "e2e: ${#SELECTED_FLOWS[@]} flow(s) selected (include=[${INCLUDE_TAGS:-*}] exclude=[${EXCLUDE_TAGS:-none}]):"
# `"${arr[@]}"` on a zero-element array throws "unbound variable" under
# `set -u` on bash < 4.4 — stock macOS /bin/bash is 3.2.57 and hits this
# every time the filter matches nothing, dying here instead of at the
# crafted `die` below (S-4 round 2, verifier-caught on bash 3.2.57,
# confirmed clean on bash 5.2.26 pre-fix). The `${arr[@]+"${arr[@]}"}`
# guard expands to nothing when the array is empty instead of dereferencing
# it, and is a no-op for a non-empty array — verified identical on both.
for f in "${SELECTED_FLOWS[@]+"${SELECTED_FLOWS[@]}"}"; do
  echo "  - $f"
  case ",$(flow_tags "$f")" in
    *,env-no-apple-account,*)
      echo "      NOTE: assumes the simulator is NOT signed into an Apple Account —"
      echo "      its Apple-cancel cell goes red for environmental reasons otherwise."
      ;;
  esac
done
[[ "${#SELECTED_FLOWS[@]}" -gt 0 ]] || die "0 flows matched the current filter for $FLOW_TARGET
  (include=[${INCLUDE_TAGS:-*}] exclude=[${EXCLUDE_TAGS:-none}]). Nothing would
  run — refusing before even invoking maestro. Check --tags/--exclude-tags
  against the flow's own tag header, or the --flow target path."

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
  SUITE_TAG="$(grep -o '<testsuite [^>]*>' "$REPORT" || true)"
  [[ -n "$SUITE_TAG" ]] && echo "$SUITE_TAG"
  # Belt-and-braces: a tag/flow filter that matches nothing makes maestro exit
  # 0 with zero testcases run — a silent false pass, the worst failure mode a
  # testing tool can have. Fail loudly instead of trusting a green exit code
  # alone (this is what the --flow fix above prevents at the source; this
  # guard catches every other way to reach the same empty-run state).
  TEST_COUNT="$(sed -n 's/.*tests="\([0-9]*\)".*/\1/p' <<<"$SUITE_TAG")"
  if [[ "$STATUS" -eq 0 && "${TEST_COUNT:-0}" -eq 0 ]]; then
    die "0 testcases ran (JUnit tests=\"0\") but maestro exited 0 — the tag/flow
  filter matched nothing. Check --tags/--exclude-tags against the --flow
  target, or the workspace's tag headers, before treating this as a pass."
  fi
else
  die "no JUnit report was written at $REPORT (maestro exited $STATUS before
  reporting). There is nothing to verify a pass against — treat this as a
  failure, not a warning."
fi
exit $STATUS
