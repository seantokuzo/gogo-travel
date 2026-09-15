#!/usr/bin/env node
/**
 * `scripts/e2e.sh` self-test (S-4 T5 — session-door.spec.md §2.1 R-door-10,
 * R-door-15). No existing automated harness covers the shell runner, and
 * both requirements are behavior of the RUNNER, not the app under test — so
 * this suite drives the real `scripts/e2e.sh` as a child process against
 * STUBBED `xcrun`/`maestro` binaries (a fresh `$HOME` + a `$PATH` prefix per
 * test), never a real simulator or a real Maestro install. Follows the
 * `.github/scripts/*.test.mjs` precedent (`node:test`, plain assert) — see
 * `.claude/rules/ci.md`. Runnable directly:
 *
 *   node --test scripts/e2e-runner.test.mjs
 *
 * Wired into `pnpm test` via the root `package.json` "test" script (turbo
 * only owns workspace packages — `scripts/` is not one — so this needed an
 * explicit, minimal addition alongside `turbo run test`) so it runs inside
 * the CLAUDE.md root gate with no simulator required, per the T5 obligation.
 *
 * Stub design: `xcrun` answers `simctl list devices booted` (one fake UDID)
 * and `simctl get_app_container <device> <appid>` (exit 0 iff `<appid>`
 * equals `$STUB_INSTALLED_APP_ID` OR appears in the space-separated
 * `$STUB_INSTALLED_APP_IDS` — the latter simulates multiple apps installed
 * at once, for the sibling-variant guard — else 1). `maestro` answers
 * `--version` (prints
 * `$STUB_MAESTRO_VERSION`, default 2.10.0) and, for a real test invocation,
 * dumps its full argv to `$STUB_ARGV_DUMP` (so a test can assert exactly what
 * `-e APP_ID=...` the runner resolved and passed through), writes a JUnit
 * report to whatever `--output` path it was given (`$STUB_MAESTRO_TESTS` /
 * `$STUB_MAESTRO_FAILURES` control its counts, `$STUB_MAESTRO_WRITE_REPORT=0`
 * suppresses it entirely), and writes a fake
 * `$HOME/.maestro/tests/<ts>/maestro.log` (`$STUB_MAESTRO_WRITE_LOG=0`
 * suppresses it) — mirroring the REAL Maestro CLI's own behavior closely
 * enough for the runner's post-run parsing to exercise for real. The stub
 * `maestro` binary is placed at `$HOME/.maestro/bin/maestro` specifically —
 * the sanctioned install path `scripts/e2e.sh`'s own identity check requires
 * (ADR-007 squatter guard) — rather than fighting that check from a test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const e2eScript = join(repoRoot, "scripts", "e2e.sh");
const STUB_UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

const XCRUN_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "simctl" ]]; then
  case "\${2:-}" in
    list)
      echo "    Fake iPhone (\${STUB_UDID}) (Booted)"
      ;;
    get_app_container)
      REQ="\${4:-}"
      if [[ -n "$REQ" && "$REQ" == "\${STUB_INSTALLED_APP_ID:-}" ]]; then
        echo "/fake/Bundle/Application/\${REQ}.app"
        exit 0
      fi
      # $STUB_INSTALLED_APP_IDS (space-separated, S-4 round 1 advisory 7):
      # simulates MULTIPLE apps installed at once, for the sibling-variant
      # guard — $STUB_INSTALLED_APP_ID alone can only ever represent one.
      for id in \${STUB_INSTALLED_APP_IDS:-}; do
        if [[ "$REQ" == "$id" ]]; then
          echo "/fake/Bundle/Application/\${REQ}.app"
          exit 0
        fi
      done
      exit 1
      ;;
    *)
      exit 0
      ;;
  esac
else
  exit 0
fi
`;

const MAESTRO_STUB = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "\${STUB_MAESTRO_VERSION:-2.10.0}"
  exit 0
fi
if [[ -n "\${STUB_ARGV_DUMP:-}" ]]; then
  printf '%s\\n' "$@" > "$STUB_ARGV_DUMP"
fi
OUTPUT=""
TESTDIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2 ;;
    --test-output-dir) TESTDIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$TESTDIR" ]] && mkdir -p "$TESTDIR"
if [[ "\${STUB_MAESTRO_WRITE_REPORT:-1}" == "1" && -n "$OUTPUT" ]]; then
  TESTS="\${STUB_MAESTRO_TESTS:-6}"
  FAILURES="\${STUB_MAESTRO_FAILURES:-0}"
  cat > "$OUTPUT" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="gogo-e2e" tests="$TESTS" failures="$FAILURES">
</testsuite>
XML
fi
if [[ "\${STUB_MAESTRO_WRITE_LOG:-1}" == "1" ]]; then
  LOGDIR="$HOME/.maestro/tests/\${STUB_MAESTRO_LOG_TS:-19700101_000000}"
  mkdir -p "$LOGDIR"
  echo "fake maestro log" > "$LOGDIR/maestro.log"
fi
exit "\${STUB_MAESTRO_EXIT:-0}"
`;

const FIXTURE_FLOW = [
  "appId: ${APP_ID}",
  "name: fixture",
  "tags:",
  "  - release",
  "---",
  "- launchApp",
  "",
].join("\n");

/** A fresh, isolated `$HOME` + stub-bin sandbox — one per test, never shared. */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "e2e-runner-test-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const maestroBin = join(home, ".maestro", "bin");
  // S-4 round 1 advisory 8: the script's own `$OUT_DIR` (JUnit/artifacts
  // destination) must NEVER be the repo's real `.tmp/e2e` — this suite ran
  // 9 test() cases, each of which used to `rm -rf` that shared directory,
  // and `pnpm test` runs it on every gate. A concurrent real human run's
  // in-progress evidence, or a future test added alongside these, would get
  // wiped mid-flight. `$GOGO_E2E_OUT_DIR` (added to scripts/e2e.sh
  // specifically for this) redirects it under this sandbox's own mkdtemp'd
  // root instead — unique per test by construction, so no purge is needed
  // either.
  const out = join(root, "out");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(maestroBin, { recursive: true });
  writeFileSync(join(bin, "xcrun"), XCRUN_STUB, { mode: 0o755 });
  writeFileSync(join(maestroBin, "maestro"), MAESTRO_STUB, { mode: 0o755 });
  const flowFile = join(root, "fixture-flow.yaml");
  writeFileSync(flowFile, FIXTURE_FLOW);
  return { root, home, bin, maestroBin, flowFile, out };
}

/** Run the real `scripts/e2e.sh` against a sandbox's stubbed toolchain. */
function runE2e(sandbox, args, envOverrides = {}) {
  const env = {
    // A deliberately MINIMAL, explicit PATH — never the real inherited one —
    // so a real local `maestro`/`xcrun` install can never leak into a "stub"
    // assertion (the exact hermeticity this suite exists to guarantee).
    PATH: [sandbox.maestroBin, sandbox.bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: sandbox.home,
    STUB_UDID,
    // See makeSandbox's comment — this sandbox's own scratch dir, never the
    // repo's real `.tmp/e2e`.
    GOGO_E2E_OUT_DIR: sandbox.out,
    ...envOverrides,
  };
  return spawnSync("/bin/bash", [e2eScript, ...args], { env, encoding: "utf8" });
}

function cleanup(sandbox) {
  rmSync(sandbox.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// R-door-15 — lane-scoped app-id matrix
// ---------------------------------------------------------------------------

test("default invocation (no --variant, no --tags) resolves the door lane's app.gogotravel.e2edoor", () => {
  const sandbox = makeSandbox();
  try {
    const argvDump = join(sandbox.root, "argv.txt");
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_ARGV_DUMP: argvDump,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /variant door/);
    const argv = readFileSync(argvDump, "utf8");
    assert.match(argv, /APP_ID=app\.gogotravel\.e2edoor/);
    // S-4 round 1 finding 2: RUN_ID was computed but never passed to
    // maestro at all (`-e RUN_ID=...` missing from ARGS) — every `${RUN_ID}`
    // in every flow silently resolved to the literal string "undefined".
    // Pin the actual `-e RUN_ID=<hex>` argv line, not just its absence: 8-11
    // lowercase hex chars (`%x%03x` of epoch-seconds + a `$RANDOM` suffix,
    // advisory 5), one full line so a stray "undefined" or empty value
    // cannot slip past a substring match.
    assert.match(argv, /^RUN_ID=[0-9a-f]{8,11}$/m);
  } finally {
    cleanup(sandbox);
  }
});

// ---------------------------------------------------------------------------
// R-door-14 §5.4 — RUN_ID's USER_KEY budget (E2eUserKeySchema, 32-char cap)
// ---------------------------------------------------------------------------

test("R-door-14: every real `<prefix>-${RUN_ID}` USER_KEY template fits E2eUserKeySchema's 32-char cap", () => {
  // Reads the REAL flow files this repo ships (not a synthetic stand-in) —
  // exactly what `scripts/e2e.sh` interpolates RUN_ID into. Scans file
  // CONTENT for the actual `<prefix>-${RUN_ID}` templates (both the
  // `USER_KEY: "<name>-${RUN_ID}"` shape most door flows pass to
  // `subflows/session-door.yaml`, and `session-door-absent.yaml`'s own
  // inline `user_key=<name>-${RUN_ID}` in its cold-open LINK) rather than
  // assuming every flow's bare FILENAME is used this way — a flow with no
  // door dependency at all (e.g. `diagnostics-panel-dev.yaml`) never
  // composes a USER_KEY and must not be budget-checked as if it did (that
  // over-broad version of this pin was caught failing against this repo's
  // own real flows while writing it — diagnostics-panel-dev's 21-char name
  // alone doesn't fit the cap, but it never needs to). Budgets for RUN_ID's
  // WORST case (11 hex chars: 8-char hex epoch-seconds + the `%03x`
  // `$RANDOM` suffix, S-4 round 1 advisory 5) rather than today's actual
  // value, so this pin does not silently rot as the wall clock advances
  // toward hex epoch-seconds' 9th digit (~year 2106) or shrinks the margin
  // in the meantime.
  const flowsDir = join(repoRoot, ".maestro");
  const flowFiles = readdirSync(flowsDir).filter((f) => f.endsWith(".yaml") && f !== "config.yaml");
  assert.ok(flowFiles.length > 0, "expected at least one real flow file under .maestro/");
  const RUN_ID_MAX_LEN = 11;
  const USER_KEY_MAX_LEN = 32; // packages/shared/src/domains/e2e.ts E2eUserKeySchema
  const TEMPLATE_RE = /([a-z0-9][a-z0-9-]*)-\$\{RUN_ID\}/g;
  let templatesFound = 0;
  for (const file of flowFiles) {
    const content = readFileSync(join(flowsDir, file), "utf8");
    for (const match of content.matchAll(TEMPLATE_RE)) {
      templatesFound += 1;
      const prefix = match[1];
      const keyLen = prefix.length + 1 + RUN_ID_MAX_LEN; // "<prefix>-<RUN_ID>"
      assert.ok(
        keyLen <= USER_KEY_MAX_LEN,
        `${file}: USER_KEY template "${prefix}-\${RUN_ID}" would be ${keyLen} ` +
          `chars at RUN_ID's worst-case length (${RUN_ID_MAX_LEN}) — over ` +
          `E2eUserKeySchema's ${USER_KEY_MAX_LEN}-char cap`,
      );
    }
  }
  assert.ok(
    templatesFound > 0,
    "expected at least one real `<prefix>-${RUN_ID}` USER_KEY template under .maestro/ — " +
      "if this is legitimately zero, the door flows no longer use RUN_ID-based keys and this pin is stale",
  );
});

test("S-4 round 1 advisory 5: the SCRIPT's own generated RUN_ID actually fits every real flow's USER_KEY budget", () => {
  // The test above is a static, forward-looking budget check against an
  // assumed worst-case RUN_ID length — it would NOT catch e2e.sh itself
  // regressing to a longer RUN_ID (e.g. reverting to the full `$STAMP`,
  // R-door-14/session-door spec §5.4's original bug). This test runs the
  // REAL script once, captures the RUN_ID it actually generated from the
  // stub's argv dump, and re-derives the budget against THAT length — a
  // genuine regression pin against the script's own behavior, not an
  // assumption about it.
  const sandbox = makeSandbox();
  try {
    const argvDump = join(sandbox.root, "argv.txt");
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_ARGV_DUMP: argvDump,
    });
    assert.equal(result.status, 0, result.stderr);
    const argv = readFileSync(argvDump, "utf8");
    const runIdMatch = /^RUN_ID=([0-9a-z]+)$/m.exec(argv);
    assert.ok(runIdMatch, `no RUN_ID=... line found in argv:\n${argv}`);
    const actualRunIdLen = runIdMatch[1].length;

    const flowsDir = join(repoRoot, ".maestro");
    const flowFiles = readdirSync(flowsDir).filter(
      (f) => f.endsWith(".yaml") && f !== "config.yaml",
    );
    const USER_KEY_MAX_LEN = 32;
    const TEMPLATE_RE = /([a-z0-9][a-z0-9-]*)-\$\{RUN_ID\}/g;
    for (const file of flowFiles) {
      const content = readFileSync(join(flowsDir, file), "utf8");
      for (const match of content.matchAll(TEMPLATE_RE)) {
        const prefix = match[1];
        const keyLen = prefix.length + 1 + actualRunIdLen;
        assert.ok(
          keyLen <= USER_KEY_MAX_LEN,
          `${file}: USER_KEY template "${prefix}-\${RUN_ID}" would be ${keyLen} chars ` +
            `against the SCRIPT'S ACTUAL RUN_ID ("${runIdMatch[1]}", ${actualRunIdLen} ` +
            `chars) — over E2eUserKeySchema's ${USER_KEY_MAX_LEN}-char cap`,
        );
      }
    }
  } finally {
    cleanup(sandbox);
  }
});

test("S-4 round 1 advisory 5: two back-to-back invocations mint DIFFERENT RUN_IDs (no same-second collision)", () => {
  // Before this fix, RUN_ID was hex epoch-SECONDS alone — two runs started
  // within the same wall-clock second (plausible: a fast --include-wip
  // re-run, or two operators racing the lane) minted the IDENTICAL RUN_ID,
  // colliding on both their USER_KEY (R-door-8, a stale/duplicate fixture
  // user) and their evidence directory (R-door-10, one run's report
  // silently overwriting the other's). The `$RANDOM` suffix breaks the tie.
  const sandbox = makeSandbox();
  try {
    const argvDumpA = join(sandbox.root, "argv-a.txt");
    const resultA = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_ARGV_DUMP: argvDumpA,
    });
    assert.equal(resultA.status, 0, resultA.stderr);
    const argvDumpB = join(sandbox.root, "argv-b.txt");
    const resultB = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_ARGV_DUMP: argvDumpB,
    });
    assert.equal(resultB.status, 0, resultB.stderr);
    const runIdA = /^RUN_ID=([0-9a-z]+)$/m.exec(readFileSync(argvDumpA, "utf8"))[1];
    const runIdB = /^RUN_ID=([0-9a-z]+)$/m.exec(readFileSync(argvDumpB, "utf8"))[1];
    assert.notEqual(runIdA, runIdB, "two back-to-back runs minted the same RUN_ID");
  } finally {
    cleanup(sandbox);
  }
});

test("--tags dev with no --variant resolves the dev lane's app.gogotravel (not derived to door/doorfree)", () => {
  const sandbox = makeSandbox();
  try {
    const argvDump = join(sandbox.root, "argv.txt");
    const result = runE2e(sandbox, ["--tags", "dev", "--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel",
      STUB_ARGV_DUMP: argvDump,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /variant dev/);
    const argv = readFileSync(argvDump, "utf8");
    assert.match(argv, /APP_ID=app\.gogotravel$/m);
  } finally {
    cleanup(sandbox);
  }
});

test("--variant doorfree resolves app.gogotravel and is NEVER derived automatically from --tags/--flow", () => {
  const sandbox = makeSandbox();
  try {
    const argvDump = join(sandbox.root, "argv.txt");
    // Passes --tags dev too, on purpose: an explicit --variant must win
    // outright over the tag-derivation rule, not merely coincide with it.
    const result = runE2e(
      sandbox,
      ["--variant", "doorfree", "--tags", "dev", "--flow", sandbox.flowFile],
      {
        STUB_INSTALLED_APP_ID: "app.gogotravel",
        STUB_ARGV_DUMP: argvDump,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /variant doorfree/);
    const argv = readFileSync(argvDump, "utf8");
    assert.match(argv, /APP_ID=app\.gogotravel$/m);
  } finally {
    cleanup(sandbox);
  }
});

test("R-door-15: --variant door excludes session-door-absent; --variant doorfree excludes the door-tagged authenticated flows", () => {
  const sandbox = makeSandbox();
  try {
    // Deliberately NOT --flow here — this exercises the REAL .maestro/
    // directory (the default FLOW_TARGET) so the pin covers the actual
    // flow tags this repo ships, not a synthetic stand-in. Fully offline:
    // the shell script's own awk-based tag scan reads the YAML text
    // directly, no maestro/simulator involved before the (stubbed) binary
    // ever runs.
    const doorResult = runE2e(sandbox, ["--variant", "door"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
    });
    assert.equal(doorResult.status, 0, doorResult.stderr);
    // `wip` joins the default exclusion set (S-4 round 1 finding 3) — every
    // lane's exclusion is now three independent pieces (dev/lane/wip)
    // combined unconditionally, never reset wholesale by --tags (advisory 6,
    // pinned separately below).
    assert.match(doorResult.stdout, /exclude=\[dev,doorfree,wip\]/);
    assert.match(doorResult.stdout, /session-door-entry\.yaml/);
    assert.doesNotMatch(doorResult.stdout, /session-door-absent\.yaml/);

    const doorfreeResult = runE2e(sandbox, ["--variant", "doorfree"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel",
    });
    assert.equal(doorfreeResult.status, 0, doorfreeResult.stderr);
    assert.match(doorfreeResult.stdout, /exclude=\[dev,door,wip\]/);
    assert.match(doorfreeResult.stdout, /session-door-absent\.yaml/);
    assert.doesNotMatch(doorfreeResult.stdout, /session-door-entry\.yaml/);
  } finally {
    cleanup(sandbox);
  }
});

test("S-4 round 1 finding 3: `wip`-tagged flows are excluded from the door lane by default and included via --include-wip", () => {
  const sandbox = makeSandbox();
  try {
    const defaultResult = runE2e(sandbox, ["--variant", "door"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
    });
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.match(defaultResult.stdout, /exclude=\[dev,doorfree,wip\]/);
    // cross-tab-state joined the wip set later in this same round (a
    // genuine, spec-contradicting server bug found via a live door run —
    // apps/server/src/trips/status.ts's UTC `today` vs the client's
    // local-tz `today`, `.specs/api/trips.spec.md` §3.4's own "Timezone
    // note" — not a flow bug, out of this task's lane to fix).
    for (const wipFlow of [
      "add-flight-dateline.yaml",
      "ideas-to-schedule.yaml",
      "cancel-visibility.yaml",
      "cross-tab-state.yaml",
    ]) {
      assert.doesNotMatch(
        defaultResult.stdout,
        new RegExp(wipFlow.replace(".", "\\.")),
        `${wipFlow} must not be selected by default (it is tagged wip)`,
      );
    }
    // A non-wip door flow stays selected — proves the wip exclusion isn't
    // accidentally swallowing the whole lane.
    assert.match(defaultResult.stdout, /session-door-entry\.yaml/);

    const includeWipResult = runE2e(sandbox, ["--variant", "door", "--include-wip"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
    });
    assert.equal(includeWipResult.status, 0, includeWipResult.stderr);
    assert.match(includeWipResult.stdout, /exclude=\[dev,doorfree\]/);
    for (const wipFlow of [
      "add-flight-dateline.yaml",
      "ideas-to-schedule.yaml",
      "cancel-visibility.yaml",
      "cross-tab-state.yaml",
    ]) {
      assert.match(includeWipResult.stdout, new RegExp(wipFlow.replace(".", "\\.")));
    }
  } finally {
    cleanup(sandbox);
  }
});

test("S-4 round 1 advisory 6: an explicit --tags selection cannot smuggle a doorfree-only flow into the door lane", () => {
  const sandbox = makeSandbox();
  try {
    // Every flow in this suite carries `release` — before this fix,
    // --tags release cleared EXCLUDE_TAGS wholesale, so it matched
    // EVERYTHING including session-door-absent (doorfree-only) even while
    // the active variant/app id is the DOOR build. The lane partition must
    // survive an explicit --tags selection.
    const result = runE2e(sandbox, ["--variant", "door", "--tags", "release"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /session-door-absent\.yaml/);
    // And the wip exclusion survives an explicit --tags selection too —
    // add-flight-dateline is release+door+wip, so a bare "release" filter
    // would otherwise let it straight back in.
    assert.doesNotMatch(result.stdout, /add-flight-dateline\.yaml/);
    assert.match(result.stdout, /session-door-entry\.yaml/);
  } finally {
    cleanup(sandbox);
  }
});

test("GOGO_E2E_APP_ID overrides every lane's default, including door and dev", () => {
  const sandbox = makeSandbox();
  try {
    const argvDumpDoor = join(sandbox.root, "argv-door.txt");
    const doorResult = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "custom.override.id",
      GOGO_E2E_APP_ID: "custom.override.id",
      STUB_ARGV_DUMP: argvDumpDoor,
    });
    assert.equal(doorResult.status, 0, doorResult.stderr);
    assert.match(readFileSync(argvDumpDoor, "utf8"), /APP_ID=custom\.override\.id$/m);

    const argvDumpDev = join(sandbox.root, "argv-dev.txt");
    const devResult = runE2e(sandbox, ["--tags", "dev", "--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "custom.override.id",
      GOGO_E2E_APP_ID: "custom.override.id",
      STUB_ARGV_DUMP: argvDumpDev,
    });
    assert.equal(devResult.status, 0, devResult.stderr);
    assert.match(readFileSync(argvDumpDev, "utf8"), /APP_ID=custom\.override\.id$/m);
  } finally {
    cleanup(sandbox);
  }
});

test("a wrong-variant install dies naming BOTH the resolved app id and the active --variant", () => {
  const sandbox = makeSandbox();
  try {
    // Door lane wants app.gogotravel.e2edoor; only the door-FREE id is
    // "installed" — the exact R-door-15 process-failure shape.
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /app\.gogotravel\.e2edoor/);
    assert.match(result.stderr, /--variant door/);
  } finally {
    cleanup(sandbox);
  }
});

test("S-4 round 1 advisory 7: refuses to run when BOTH app.gogotravel and app.gogotravel.e2edoor are installed", () => {
  const sandbox = makeSandbox();
  try {
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_IDS: "app.gogotravel.e2edoor app.gogotravel",
    });
    assert.notEqual(result.status, 0, "must refuse when both sibling app ids are installed");
    assert.match(result.stderr, /app\.gogotravel\.e2edoor/);
    assert.match(result.stderr, /app\.gogotravel\b/);
    assert.match(result.stderr, /gogo:\/\//);
  } finally {
    cleanup(sandbox);
  }
});

test("S-4 round 1 advisory 7: a single installed variant (not both) is unaffected by the sibling guard", () => {
  const sandbox = makeSandbox();
  try {
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_IDS: "app.gogotravel.e2edoor",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    cleanup(sandbox);
  }
});

// ---------------------------------------------------------------------------
// R-door-10 — evidence durability
// ---------------------------------------------------------------------------

test("R-door-10: a completed run copies evidence outside the worktree (mode 700) and prints the maestro.log path", () => {
  const sandbox = makeSandbox();
  try {
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_MAESTRO_TESTS: "1",
      STUB_MAESTRO_FAILURES: "0",
      STUB_MAESTRO_LOG_TS: "20260914_120000",
    });
    assert.equal(result.status, 0, result.stderr);

    const evidenceMatch = /evidence copied → (\S+)/.exec(result.stdout);
    assert.ok(evidenceMatch, `expected an "evidence copied →" line in:\n${result.stdout}`);
    const evidenceDir = evidenceMatch[1];
    assert.ok(
      evidenceDir.startsWith(sandbox.home),
      `evidence dir ${evidenceDir} must live under the fake $HOME, never the repo worktree`,
    );
    assert.ok(
      !evidenceDir.startsWith(repoRoot),
      "evidence dir must never sit inside the repo worktree",
    );
    assert.ok(existsSync(evidenceDir), `${evidenceDir} was not created`);
    assert.equal(statSync(evidenceDir).mode & 0o777, 0o700, "evidence dir must be mode 700");

    const junitMatch = /junit copy → (\S+)/.exec(result.stdout);
    assert.ok(junitMatch, `expected a "junit copy →" line in:\n${result.stdout}`);
    assert.ok(existsSync(junitMatch[1]), `${junitMatch[1]} (the copied JUnit) was not written`);

    const logMatch = /maestro log → (\S+)/.exec(result.stdout);
    assert.ok(logMatch, `expected a "maestro log →" line in:\n${result.stdout}`);
    assert.match(logMatch[1], /20260914_120000\/maestro\.log$/);
    assert.ok(existsSync(logMatch[1]), `${logMatch[1]} (maestro's own log) does not exist`);
  } finally {
    cleanup(sandbox);
  }
});

test("R-door-10: a failed copy (unwritable/missing destination parent) fails the run and prints no success line", () => {
  const sandbox = makeSandbox();
  try {
    // `mkdir -p "$HOME/.gogo/e2e/<stamp>"` cannot create a directory THROUGH
    // an existing plain FILE at `$HOME/.gogo` — a portable, non-root way to
    // force the create to fail without relying on chmod-based permission
    // tricks (which some sandboxes/containers ignore for the invoking user).
    writeFileSync(join(sandbox.home, ".gogo"), "not a directory");
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
    });
    assert.notEqual(result.status, 0, "a failed evidence copy must fail the whole run");
    assert.doesNotMatch(
      result.stdout,
      /evidence copied →/,
      "no success line may print on a failed copy",
    );
    assert.match(result.stderr, /could not create the evidence directory/);
  } finally {
    cleanup(sandbox);
  }
});

test("R-door-10: maestro exiting before writing a report still fails loudly (pre-existing guard, unaffected by the copy step)", () => {
  const sandbox = makeSandbox();
  try {
    const result = runE2e(sandbox, ["--flow", sandbox.flowFile], {
      STUB_INSTALLED_APP_ID: "app.gogotravel.e2edoor",
      STUB_MAESTRO_WRITE_REPORT: "0",
      STUB_MAESTRO_EXIT: "1",
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /evidence copied →/);
    assert.match(result.stderr, /no JUnit report was written/);
  } finally {
    cleanup(sandbox);
  }
});
