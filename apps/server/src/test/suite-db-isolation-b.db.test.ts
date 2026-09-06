/**
 * T-S3.3 clone-isolation probe, leg B — the mirror of
 * `suite-db-isolation-a.db.test.ts`; see that header for the full contract
 * and falsification. Same suite-db name, same fixed primary key, same
 * assertions: both legs green is only possible on hard-isolated clones.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { createSuiteDb, type SuiteDb } from "./suite-db.js";
import {
  ISOLATION_PROBE_DB_NAME,
  ISOLATION_PROBE_DISPLAY_NAME,
  ISOLATION_PROBE_EMAIL,
  ISOLATION_PROBE_GOOGLE_SUB,
  ISOLATION_PROBE_USER_ID,
} from "./suite-db-isolation.shared.js";

// Docker probe, loud skip banner, and the CI hard-fail all live in ONE
// place: src/test/global-setup.ts (T-S3.3 shared container).
const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;

describe.skipIf(!dockerAvailable)("T-S3.3 clone isolation probe — leg B", () => {
  let suiteDb: SuiteDb;

  beforeAll(async () => {
    suiteDb = await createSuiteDb(ISOLATION_PROBE_DB_NAME);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  it("owns the fixed probe primary key alone, though leg A inserts the identical row", async () => {
    // Shared-database mutant: this insert (or leg A's identical one —
    // whichever lands second) rejects on `users_pkey`.
    await suiteDb.db.insert(schema.users).values({
      id: ISOLATION_PROBE_USER_ID,
      email: ISOLATION_PROBE_EMAIL,
      displayName: ISOLATION_PROBE_DISPLAY_NAME,
      googleSub: ISOLATION_PROBE_GOOGLE_SUB,
    });

    const rows = await suiteDb.db.select({ id: schema.users.id }).from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ISOLATION_PROBE_USER_ID);
  });
});
