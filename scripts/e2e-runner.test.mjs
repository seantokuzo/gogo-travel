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
 * equals `$STUB_INSTALLED_APP_ID`, else 1 — the ENTIRE mismatch-die surface
 * this suite pins). `maestro` answers `--version` (prints
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
      if [[ "\${4:-}" == "\${STUB_INSTALLED_APP_ID:-}" ]]; then
        echo "/fake/Bundle/Application/\${4}.app"
        exit 0
      fi
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
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(maestroBin, { recursive: true });
  writeFileSync(join(bin, "xcrun"), XCRUN_STUB, { mode: 0o755 });
  writeFileSync(join(maestroBin, "maestro"), MAESTRO_STUB, { mode: 0o755 });
  const flowFile = join(root, "fixture-flow.yaml");
  writeFileSync(flowFile, FIXTURE_FLOW);
  return { root, home, bin, maestroBin, flowFile };
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
    ...envOverrides,
  };
  // `$OUT_DIR` (the JUnit/artifact destination) is NOT sandboxed — it is
  // always `<repoRoot>/.tmp/e2e`, fixed by the script itself — and `$STAMP`
  // has only 1-SECOND resolution, so two fast back-to-back test cases can
  // collide on the same `junit-<STAMP>.xml` path. Without this, a run that
  // deliberately suppresses its own report (STUB_MAESTRO_WRITE_REPORT=0)
  // could find a PRIOR test's stale file still sitting there and treat it as
  // its own — purge before every invocation so each run starts from a truly
  // empty OUT_DIR, never a timestamp-adjacent leftover.
  rmSync(join(repoRoot, ".tmp", "e2e"), { recursive: true, force: true });
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
    assert.match(doorResult.stdout, /exclude=\[dev,doorfree\]/);
    assert.match(doorResult.stdout, /session-door-entry\.yaml/);
    assert.doesNotMatch(doorResult.stdout, /session-door-absent\.yaml/);

    const doorfreeResult = runE2e(sandbox, ["--variant", "doorfree"], {
      STUB_INSTALLED_APP_ID: "app.gogotravel",
    });
    assert.equal(doorfreeResult.status, 0, doorfreeResult.stderr);
    assert.match(doorfreeResult.stdout, /exclude=\[dev,door\]/);
    assert.match(doorfreeResult.stdout, /session-door-absent\.yaml/);
    assert.doesNotMatch(doorfreeResult.stdout, /session-door-entry\.yaml/);
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
