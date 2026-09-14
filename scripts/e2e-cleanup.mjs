#!/usr/bin/env node
/**
 * Operator-only E2E fixture cleanup (S-4/T3 — session-door spec §5.4).
 *
 * The session door's `E2E_DOOR_MAX_FIXTURE_USERS` cap (R-door-14, default
 * 500) is a bounded escape hatch, not a reset — it never deletes anything.
 * This script is the ONLY way to reclaim that capacity: it deletes every
 * all-fixture trip, then every ownerless fixture user, then every remaining
 * fixture owner (skipping — never deleting or reassigning — any trip that
 * still has a live non-fixture member), retries once, and reports.
 *
 * It is invoked explicitly and manually only: never by the door, never
 * automatically per-run, never on any schedule (Sean's no-destructive-reset
 * ruling constrains what the DOOR does on a request; it does not forbid an
 * operator-invoked, offline maintenance script — which is what this is).
 *
 * The actual logic (`apps/server/src/e2e/cleanup.ts`'s `runE2eCleanup`) runs
 * in-process against the service layer directly — no HTTP request, no
 * session, no session door — sharing the SAME `deleteAccount` and the
 * extracted `deleteTripCore` the app itself uses, so cleanup can never drift
 * from what those functions actually do. This wrapper just spawns the real
 * TypeScript entry point (`apps/server/src/e2e/cleanup-cli.ts`) via `tsx`,
 * from the server workspace, the same way `boot-shape.test.ts` spawns
 * `src/index.ts` — `apps/server`'s own devDependency, not a root-hoisted
 * one (pnpm doesn't hoist here — the `seed-qa-places.mjs` precedent).
 *
 *   DATABASE_URL=postgresql://... node scripts/e2e-cleanup.mjs
 *   # or, against the local dev rig's generated test env:
 *   set -a && . apps/server/.env.test && set +a && node scripts/e2e-cleanup.mjs
 *
 * Exits non-zero whenever fixture capacity was not fully reclaimed after the
 * retry pass (a skipped mixed-membership owner, or a transient failure) —
 * never a silent partial run. Never touches a non-fixture account or a trip
 * with a non-fixture member (scoping guarantee: every candidate row is
 * selected by `apple_sub LIKE 'e2e:%'`, in `cleanup.ts`).
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const serverDir = join(repoRoot, "apps", "server");

  if (!process.env.DATABASE_URL) {
    console.error(
      "e2e-cleanup: DATABASE_URL is not set — point it at the e2e lane's database " +
        "(e.g. `set -a && . apps/server/.env.test && set +a`) before running this.",
    );
    process.exit(1);
  }

  const child = spawn(process.execPath, ["--import", "tsx", "src/e2e/cleanup-cli.ts"], {
    cwd: serverDir,
    // Forward the caller's env as-is (DATABASE_URL is the only var the CLI
    // reads) — no secret ever passes through argv (Law #1: argv lands in
    // shell history and is visible to every local process via `ps`).
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
  child.on("error", (err) => {
    console.error(`e2e-cleanup: failed to launch — ${err.message}`);
    process.exit(1);
  });
}

/**
 * Main-guard (review round 1 adversarial finding 4) — see
 * `apps/server/src/e2e/cleanup-cli.ts`'s identical guard for the full
 * rationale (`process.argv[1]` can be a symlink that resolves to this file;
 * `import.meta.url` always reports the resolved path, so a raw string
 * compare would silently never match a symlinked invocation). Without this,
 * importing the module for any reason (a future test, a bundler that
 * statically analyzes it) unconditionally checks `DATABASE_URL` and calls
 * `process.exit(1)` or spawns a child process at IMPORT time.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
