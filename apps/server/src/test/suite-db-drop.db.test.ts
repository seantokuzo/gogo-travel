/**
 * QUEUE "Shared PG container afterAll teardown timeout under concurrent
 * gates", round-1 review finding — `drop()`'s REAL wiring was unpinned:
 * `suite-db-teardown.test.ts` exercises `boundedTolerantTeardown` against
 * FAKE steps, so nothing caught `client.end({ timeout: MS / 1000 })`
 * silently regressing to `client.end({ timeout: MS })` — postgres-js wants
 * SECONDS (Context7 `postgres`@3.4.9: `sql.end({ timeout })` — "Timeout in
 * seconds"; on the 5000-second value the mutation produces, the library's
 * own destroy() backstop never fires within any run, so the "belt" the
 * `suite-db.ts` file comment leans on is fiction). This suite spies on the
 * REAL `postgres.Sql#end` the way `createSuiteDb` actually wires it,
 * against a REAL clone on the shared testcontainer — prod-shaped, not a
 * mock of postgres-js's own contract.
 *
 * Falsification: in `suite-db.ts`, change
 * `client.end({ timeout: POOL_END_TIMEOUT_MS / 1000 })` to
 * `client.end({ timeout: POOL_END_TIMEOUT_MS })` (drop the `/ 1000`) and
 * the "pins the SECONDS unit conversion" case below goes RED — the spy
 * observes the raw-millisecond value instead of the constant's own
 * `/ 1000`. Reverted after verifying (evidence in the PR body).
 */
import postgres from "postgres";
import { describe, expect, inject, it, vi } from "vitest";
import { createSuiteDb, POOL_END_TIMEOUT_MS, type SuiteDb } from "./suite-db.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place: src/test/global-setup.ts (T-S3.3 shared container).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;

describe.skipIf(!dockerAvailable)("createSuiteDb().drop() — real wiring", () => {
  it(
    "pins the SECONDS unit conversion: the clone's client.end() is called with MS/1000, not raw MS",
    async () => {
      const suiteDb: SuiteDb = await createSuiteDb("drop_wiring_probe");

      const endSpy = vi.spyOn(suiteDb.client, "end");
      try {
        await suiteDb.drop();

        expect(endSpy).toHaveBeenCalledTimes(1);
        // SECONDS, not the millisecond constant itself — the exact unit bug
        // the round-1 review's mutation probe found shipping silently (3
        // files / 7 tests stayed GREEN with the bug live).
        expect(endSpy).toHaveBeenCalledWith({ timeout: POOL_END_TIMEOUT_MS / 1000 });
        // Guards the pin itself against a no-op mutation of the constant:
        // if POOL_END_TIMEOUT_MS ever stopped being expressed in ms, this
        // still fails loudly instead of silently asserting against itself.
        expect(POOL_END_TIMEOUT_MS / 1000).toBe(5);
      } finally {
        endSpy.mockRestore();
      }
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "resolves cleanly, drops the clone from pg_database, and tolerates a second drop() call",
    async () => {
      const suiteDb: SuiteDb = await createSuiteDb("drop_gone_probe");
      const dbName = new URL(suiteDb.uri).pathname.slice(1);

      await expect(suiteDb.drop()).resolves.toBeUndefined();

      const adminUri = inject("dbAdminUri");
      const admin = postgres(adminUri, { max: 1, onnotice: () => undefined });
      try {
        const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
        expect(rows).toHaveLength(0);
      } finally {
        await admin.end();
      }

      // The clone's own pool is already ended and the database already
      // gone — `drop()` must still resolve, never throw, on a second call
      // (`SuiteDb.drop`'s own "safe to call once" contract, exercised here
      // as "safe even if called again").
      await expect(suiteDb.drop()).resolves.toBeUndefined();
    },
    BOOT_TIMEOUT_MS,
  );
});
