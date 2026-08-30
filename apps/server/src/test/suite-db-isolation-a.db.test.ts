/**
 * T-S3.3 clone-isolation probe, leg A (of `suite-db-isolation-{a,b}`) —
 * the falsifiable proof behind R-test-6's "suites run file-parallel without
 * colliding": this leg and leg B request a suite database under the SAME
 * name and insert the SAME `users` primary key. On hard-isolated per-suite
 * clones both inserts succeed and each leg sees exactly its own row; on any
 * shared database one leg dies on `users_pkey`.
 *
 * Falsification (R-test-7): drop the nonce suffix in `createSuiteDb` (so
 * both legs resolve to one database name) and one leg goes RED with a
 * duplicate-key violation; skip the template migration in global setup and
 * both legs go RED on a missing `users` relation. Mutation-verified in the
 * T-S3.3 PR (evidence pasted there).
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

describe.skipIf(!dockerAvailable)("T-S3.3 clone isolation probe — leg A", () => {
  let suiteDb: SuiteDb;

  beforeAll(async () => {
    suiteDb = await createSuiteDb(ISOLATION_PROBE_DB_NAME);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  it("owns the fixed probe primary key alone, though leg B inserts the identical row", async () => {
    // Shared-database mutant: this insert (or leg B's identical one —
    // whichever lands second) rejects on `users_pkey`.
    await suiteDb.db.insert(schema.users).values({
      id: ISOLATION_PROBE_USER_ID,
      email: ISOLATION_PROBE_EMAIL,
      displayName: ISOLATION_PROBE_DISPLAY_NAME,
      googleSub: ISOLATION_PROBE_GOOGLE_SUB,
    });

    // Exactly ONE row: the clone started empty (zero-fixture template) and
    // leg B's identical concurrent write is invisible here.
    const rows = await suiteDb.db.select({ id: schema.users.id }).from(schema.users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(ISOLATION_PROBE_USER_ID);
  });
});
