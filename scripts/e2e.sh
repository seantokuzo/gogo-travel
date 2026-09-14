#!/usr/bin/env bash
#
# Local E2E lane (ADR-007) — runs the Maestro flows in `.maestro/` against the
# booted iOS simulator and writes JUnit to `.tmp/e2e/`.
#
#   bash scripts/e2e.sh                      # release lane (door build, excludes `dev`)
#   bash scripts/e2e.sh --variant doorfree    # door-free proof (session-door-absent)
#   bash scripts/e2e.sh --tags dev           # dev-build-only flows (implies --variant dev)
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

# Nothing about a test run leaves this machine (ADR-007 / Law #5).
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOW_TARGET="$REPO_ROOT/.maestro"
OUT_DIR="$REPO_ROOT/.tmp/e2e"
DEVICE=""
INCLUDE_TAGS=""
EXCLUDE_TAGS="dev" # dev-build-only flows never run in the release lane
VARIANT=""         # resolved below (R-door-15) — door|dev|doorfree
TAGS_EXPLICIT=""   # raw --tags value, if any — feeds the --variant derivation
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
      TAGS_EXPLICIT="$2"
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
    --variant)
      [[ $# -ge 2 ]] || die "--variant needs a value (door|dev|doorfree)"
      VARIANT="$2"
      case "$VARIANT" in
        door | dev | doorfree) ;;
        *) die "--variant must be door, dev, or doorfree (got: $VARIANT)" ;;
      esac
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

# ── variant / app id resolution (R-door-15) ─────────────────────────────────
# No single hard-coded bundle id for every lane — each lane resolves its OWN
# default, and every lane's default is env-overridable via GOGO_E2E_APP_ID.
# `--variant` wins outright when given; otherwise derive from `--tags`:
# `--tags dev` (and ONLY that exact value) implies the `dev` lane; every other
# invocation — including the default, no-flag run (today's default merge-gate
# cadence) — implies `door`. `doorfree` is NEVER derived from --tags/--flow —
# the periodic door-free proof must pass --variant doorfree explicitly, since
# its default tag filter is otherwise identical to the door lane's.
if [[ -z "$VARIANT" ]]; then
  if [[ "$TAGS_EXPLICIT" == "dev" ]]; then
    VARIANT="dev"
  else
    VARIANT="door"
  fi
fi

case "$VARIANT" in
  door) DEFAULT_APP_ID="app.gogotravel.e2edoor" ;;
  dev) DEFAULT_APP_ID="app.gogotravel" ;;
  doorfree) DEFAULT_APP_ID="app.gogotravel" ;;
esac
# GOGO_E2E_APP_ID (operator-settable, same override pattern as
# MAESTRO_EXPECTED_VERSION/--device) overrides the variant-derived default
# outright, for any variant.
APP_ID="${GOGO_E2E_APP_ID:-$DEFAULT_APP_ID}"

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

# A missing/wrong app is the single most common way this lane 'fails' — say so
# in one line instead of letting every flow die on launchApp. This doubles as
# the runner's own lane self-check (R-door-15): an install of the wrong
# variant fails this by construction (the resolved id is simply not what is
# installed), and the message names both the resolved id and the active
# --variant, not a fixed string, so a wrong-variant run is diagnosable from
# the failure text alone.
if ! xcrun simctl get_app_container "$DEVICE" "$APP_ID" >/dev/null 2>&1; then
  die "$APP_ID (--variant $VARIANT) is not installed on $DEVICE.
  Build and install the matching configuration first:
    door      → cd apps/mobile && set -a && . ../server/.env.test && set +a && \\
                LANG=en_US.UTF-8 pnpm ios:door
    dev       → cd apps/mobile && npx expo run:ios   (Debug — flow AUTHORING only)
    doorfree  → cd apps/mobile && unset EXPO_PUBLIC_E2E_DOOR_SECRET && \\
                LANG=en_US.UTF-8 pnpm ios:doorfree
  See ADR-007 / .maestro/README.md / session-door.spec.md §5.2.
  Wrong app installed for this --variant? Pass --variant explicitly, or set
  GOGO_E2E_APP_ID to override the resolved id outright."
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
  --test-suite-name "gogo-e2e"
  -e "APP_ID=$APP_ID")
[[ -n "$INCLUDE_TAGS" ]] && ARGS+=(--include-tags "$INCLUDE_TAGS")
[[ -n "$EXCLUDE_TAGS" ]] && ARGS+=(--exclude-tags "$EXCLUDE_TAGS")
[[ ${#PASSTHROUGH[@]} -gt 0 ]] && ARGS+=("${PASSTHROUGH[@]}")

echo "e2e: maestro $ACTUAL_VERSION · device $DEVICE · variant $VARIANT · appId $APP_ID · $FLOW_TARGET"
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

  # ── evidence durability (R-door-10) ──────────────────────────────────────
  # A completed run's JUnit + artifacts must survive outside this worktree —
  # a `git clean`, a worktree teardown, or a later `--force` regen of
  # apps/server/.env.test must never take the only copy of a run's evidence
  # with it. Runs REGARDLESS of pass/fail (STATUS is untouched below): the
  # failing run is exactly the one you most need durable evidence for. A
  # failed copy fails the WHOLE run — an evidence-copy failure must never be
  # swallowed behind a green `maestro` exit.
  EVIDENCE_DIR="$HOME/.gogo/e2e/$STAMP"
  if ! mkdir -p -m 700 "$EVIDENCE_DIR" 2>/dev/null; then
    die "could not create the evidence directory $EVIDENCE_DIR (R-door-10) —
  refusing to treat this run's report as durable. Check that
  $(dirname "$EVIDENCE_DIR") is writable."
  fi
  # `mkdir -m` only applies to directories it actually CREATES — an already-
  # existing (e.g. re-run in the same second) EVIDENCE_DIR keeps whatever mode
  # it had, so pin the mode explicitly rather than trust the create-time flag.
  chmod 700 "$EVIDENCE_DIR"
  EVIDENCE_JUNIT="$EVIDENCE_DIR/$(basename "$REPORT")"
  if ! cp "$REPORT" "$EVIDENCE_JUNIT" 2>/dev/null; then
    die "failed to copy the JUnit report to $EVIDENCE_JUNIT (R-door-10) — this
  run's evidence is not durable outside the worktree; treat it as unverified
  even though maestro itself exited $STATUS."
  fi
  if [[ -d "$OUT_DIR/artifacts-$STAMP" ]]; then
    EVIDENCE_ARTIFACTS="$EVIDENCE_DIR/artifacts-$STAMP"
    if ! cp -R "$OUT_DIR/artifacts-$STAMP" "$EVIDENCE_ARTIFACTS" 2>/dev/null; then
      die "failed to copy the artifact directory to $EVIDENCE_ARTIFACTS (R-door-10)."
    fi
  fi
  # Maestro writes its OWN per-run log under a timestamp it picks itself
  # (not $STAMP — a different clock read, a different format), so the only
  # reliable way to name it is to ask for the newest entry after the run.
  MAESTRO_LOG_DIR="$(ls -t "$HOME/.maestro/tests" 2>/dev/null | head -1)"
  echo "e2e: evidence copied → $EVIDENCE_DIR (mode 700, outside the worktree)"
  echo "e2e: junit copy → $EVIDENCE_JUNIT"
  if [[ -n "$MAESTRO_LOG_DIR" ]]; then
    echo "e2e: maestro log → $HOME/.maestro/tests/$MAESTRO_LOG_DIR/maestro.log"
  else
    echo "e2e: maestro log → (none found under $HOME/.maestro/tests)"
  fi
else
  die "no JUnit report was written at $REPORT (maestro exited $STATUS before
  reporting). There is nothing to verify a pass against — treat this as a
  failure, not a warning."
fi
exit $STATUS
