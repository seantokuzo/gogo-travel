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
        `${report.skippedOwners.length} skipped owner(s), ` +
        `${report.transientFailures.length} transient failure(s); ` +
        `${report.remainingFixtureCount} fixture user(s) still live`,
    );
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
  } finally {
    await client.end();
  }
}

await main();
