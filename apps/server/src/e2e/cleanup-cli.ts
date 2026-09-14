/**
 * Operator CLI for `runE2eCleanup` (S-4/T3 — session-door spec §5.4).
 * Invoked ONLY via `scripts/e2e-cleanup.mjs` — explicitly, manually, never by
 * the door, never on a schedule (Sean's no-destructive-reset ruling — this
 * runs offline, against the service layer directly, no HTTP, no session).
 *
 * Connects with `postgres-js` (the repo's local/test-rig driver — this
 * targets a dev or e2e-lane database, never a Neon serverless prod
 * endpoint) directly from `DATABASE_URL`, runs the cleanup, prints the
 * report, and exits non-zero iff `remainingFixtureCount > 0` (§5.4 step 6) —
 * a non-zero exit always means "capacity was not fully reclaimed, check the
 * log," never a silent partial run.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema/index.js";
import { runE2eCleanup } from "./cleanup.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("e2e-cleanup: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzle({ client, schema });

  try {
    const report = await runE2eCleanup({
      db,
      // Fixture rows never carry a real `apple_credentials` row, so this key
      // is never actually used to decrypt anything — see `cleanup.ts`'s
      // `E2eCleanupDeps` doc.
      appleCredentialsKey: Buffer.alloc(32, 0),
    });

    console.warn(
      `e2e-cleanup: deleted ${report.tripsDeleted} trip(s), ${report.usersDeleted} user(s); ` +
        `${report.tripFailures.length} trip failure(s), ` +
        `${report.skippedOwners.length} skipped owner(s), ` +
        `${report.transientFailures.length} transient failure(s); ` +
        `${report.remainingFixtureCount} fixture user(s) still live`,
    );
    if (report.tripFailures.length > 0) {
      console.warn(
        "e2e-cleanup: trip failure ids (retry the script to resolve): " +
          report.tripFailures.map((f) => f.tripId).join(", "),
      );
    }
    if (report.skippedOwners.length > 0) {
      console.warn(
        "e2e-cleanup: skipped owner ids (trip has a non-fixture member — resolve manually): " +
          report.skippedOwners.map((s) => s.userId).join(", "),
      );
    }
    if (report.transientFailures.length > 0) {
      console.warn(
        "e2e-cleanup: transient failure user ids (retry the script to resolve): " +
          report.transientFailures.map((f) => f.userId).join(", "),
      );
    }

    process.exitCode = report.remainingFixtureCount > 0 ? 1 : 0;
  } catch (error) {
    // Review round 1 correctness finding 3: `deleteAllFixtureTrips`/
    // `deleteRemainingFixtureUsers` now isolate every per-trip/per-user
    // failure, so this SHOULD be unreachable in normal operation — but a
    // failure OUTSIDE either loop (the `liveFixtureUsers` query itself, a
    // pool-level blip) must still print something and exit non-zero rather
    // than dying silently mid-run (the module's own "never a silent partial
    // run" promise).
    console.error(
      `e2e-cleanup: unexpected failure — ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

/**
 * Main-guard (review round 1 adversarial finding 4 / the PR #75 symlink
 * lesson): compare REAL paths, not raw strings. `process.argv[1]` can be a
 * symlink (a pnpm bin shim, a global install) that resolves to THIS file;
 * `import.meta.url` always reports the file's resolved, post-symlink path.
 * A naive `import.meta.url === \`file://${process.argv[1]}\`` string
 * compare would then never match a symlinked invocation, silently skipping
 * `main()` on every REAL run — the opposite failure mode from the one this
 * guard exists to prevent (`main()` running on a bare `import`).
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
