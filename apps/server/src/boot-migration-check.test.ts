/**
 * Pure unit matrix for the refuse-vs-warn DECISION (B-28). No I/O, no
 * Docker — `checkMigrationState`'s own DB/journal behavior (including
 * against real Postgres) is covered in `db/migration-state.test.ts` /
 * `.db.test.ts`. There is no subprocess end-to-end variant: `getDb()`
 * (`db/index.ts`) always dials the Neon serverless WebSocket driver, which
 * cannot reach a vanilla Postgres (testcontainers included) without a
 * WS↔TCP proxy this repo doesn't run — the same boundary that keeps
 * `boot-shape.test.ts`'s composition-root arms deliberately DB-free. This
 * suite plus the `.db.test.ts` file together cover the same ground the real
 * `index.ts` wiring exercises: the decision branches here, the on-disk-vs-
 * applied comparison there. (Round-2, B-28: `boot-shape.test.ts` DOES now
 * carry one genuinely-executed subprocess arm for the dev-refuse path,
 * against a real Postgres, via a driver-injection harness — see that
 * file's header for why it isn't literally `src/index.ts`.)
 */
import { describe, expect, it } from "vitest";
import {
  decideBootMigrationAction,
  HEALTH_TAG_NAME_ENVS,
  REFUSE_ON_PENDING_ENVS,
  shapeMigrationStateForHealth,
} from "./boot-migration-check.js";
import { MIGRATE_COMMAND } from "./db/migration-state.js";
import type { MigrationState } from "./db/migration-state.js";

const FIXED_CHECKED_AT = "2026-01-01T00:00:00.000Z";
const CURRENT: MigrationState = {
  onDisk: 4,
  applied: 4,
  pending: [],
  pendingCount: 0,
  modified: [],
  modifiedCount: 0,
  checkedAt: FIXED_CHECKED_AT,
};
const BEHIND: MigrationState = {
  onDisk: 4,
  applied: 2,
  pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
  pendingCount: 2,
  modified: [],
  modifiedCount: 0,
  checkedAt: FIXED_CHECKED_AT,
};
const MODIFIED_ONLY: MigrationState = {
  onDisk: 4,
  applied: 4,
  pending: [],
  pendingCount: 0,
  modified: ["0001_edited_after_apply"],
  modifiedCount: 1,
  checkedAt: FIXED_CHECKED_AT,
};

describe("decideBootMigrationAction — the refuse/warn matrix (B-28 locked decision)", () => {
  it("happy: development + current DB → ok, no message", () => {
    expect(decideBootMigrationAction("development", CURRENT)).toEqual({ action: "ok" });
  });

  it("development + pending → REFUSE, naming every pending tag and the migrate command", () => {
    const decision = decideBootMigrationAction("development", BEHIND);
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.message).toContain("0002_lowly_venom");
    expect(decision.message).toContain("0003_outstanding_doctor_spectrum");
    expect(decision.message).toContain(MIGRATE_COMMAND);
  });

  it("test env + pending → WARN (keeps serving), same message content as the refuse case", () => {
    const decision = decideBootMigrationAction("test", BEHIND);
    expect(decision.action).toBe("warn");
    if (decision.action !== "warn") throw new Error("unreachable");
    expect(decision.message).toContain("0002_lowly_venom");
    expect(decision.message).toContain(MIGRATE_COMMAND);
  });

  it("production + pending → WARN, never refuse — must never take prod down (Law-adjacent B-28 requirement)", () => {
    const decision = decideBootMigrationAction("production", BEHIND);
    expect(decision.action).toBe("warn");
    if (decision.action !== "warn") throw new Error("unreachable");
    expect(decision.message).toContain(MIGRATE_COMMAND);
  });

  it("boundary: production + current → ok (an empty `pending` never warns, regardless of env)", () => {
    expect(decideBootMigrationAction("production", CURRENT)).toEqual({ action: "ok" });
  });

  it("boundary: exactly one pending migration still produces a full refuse message (not just a count)", () => {
    const decision = decideBootMigrationAction("development", {
      onDisk: 4,
      applied: 3,
      pending: ["0003_outstanding_doctor_spectrum"],
      pendingCount: 1,
      modified: [],
      modifiedCount: 0,
      checkedAt: FIXED_CHECKED_AT,
    });
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.message).toContain("0003_outstanding_doctor_spectrum");
  });

  it("REFUSE_ON_PENDING_ENVS contains ONLY development (the locked decision) — softening it to WARN-only is this ONE set", () => {
    // Falsification: this is the exact pin that breaks if a future change
    // widens or narrows the refuse set without updating this test — the
    // "one-line switch" the PR body points at.
    expect([...REFUSE_ON_PENDING_ENVS]).toEqual(["development"]);
  });

  // -------------------------------------------------------------------
  // modified-after-apply (B-28 round-2 fix): ALWAYS warn, NEVER refuse —
  // in every env, including development. Falsification per pin below.
  // -------------------------------------------------------------------

  it("development + modified-only (pending empty) → WARN, never refuse — no command fixes an edited-after-apply file", () => {
    // Falsification: collapsing the `modified` branch back into `pending`
    // (the round-2 regression this closes) makes `development` REFUSE here
    // instead of warn — this is the exact mutation the PR must guard.
    const decision = decideBootMigrationAction("development", MODIFIED_ONLY);
    expect(decision.action).toBe("warn");
    if (decision.action !== "warn") throw new Error("unreachable");
    expect(decision.message).toContain("0001_edited_after_apply");
    expect(decision.message).toMatch(/edited/i);
    // Never tells the developer to run the migrate command — it cannot fix this.
    expect(decision.message).not.toContain(MIGRATE_COMMAND);
  });

  it("production + modified-only → WARN, same posture as every other env (never gated by REFUSE_ON_PENDING_ENVS)", () => {
    const decision = decideBootMigrationAction("production", MODIFIED_ONLY);
    expect(decision.action).toBe("warn");
    if (decision.action !== "warn") throw new Error("unreachable");
    expect(decision.message).toContain("0001_edited_after_apply");
  });

  it("development + BOTH pending and modified → REFUSE (pending still drives refuse), message names both problems", () => {
    const both: MigrationState = {
      ...BEHIND,
      modified: ["0001_edited_after_apply"],
      modifiedCount: 1,
    };
    const decision = decideBootMigrationAction("development", both);
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.message).toContain("0002_lowly_venom");
    expect(decision.message).toContain("0001_edited_after_apply");
  });

  it("boundary: modified-only with pending EMPTY never refuses even in development (the exact round-2 regression shape)", () => {
    // The literal round-1-verifier reproduction: pending: [], modified:
    // [tag]. Falsification: reverting to `if (state.pending.length === 0)
    // return {action:"ok"}` (ignoring `modified` entirely) makes this "ok"
    // instead of "warn" — silently hiding the edited file. Reverting to
    // treating `modified` as `pending` makes this "refuse" instead — the
    // original regression.
    const decision = decideBootMigrationAction("development", MODIFIED_ONLY);
    expect(decision.action).not.toBe("refuse");
    expect(decision.action).not.toBe("ok");
    expect(decision.action).toBe("warn");
  });
});

describe("shapeMigrationStateForHealth — dev/test get tag names, everyone else gets a count (architecture review round-1 #3)", () => {
  it("development: pending tag names pass through unchanged", () => {
    expect(shapeMigrationStateForHealth("development", BEHIND)).toEqual(BEHIND);
  });

  it("test: pending tag names pass through unchanged", () => {
    expect(shapeMigrationStateForHealth("test", BEHIND)).toEqual(BEHIND);
  });

  it("production: pending tag NAMES are redacted to an empty array, but pendingCount stays accurate", () => {
    // Falsification: dropping the env branch (always returning `state`
    // unchanged) makes `pending` non-empty here — this is the exact
    // unauthenticated-disclosure the architecture lane flagged.
    const shaped = shapeMigrationStateForHealth("production", BEHIND);
    expect(shaped.pending).toEqual([]);
    expect(shaped.pendingCount).toBe(2);
    expect(shaped.onDisk).toBe(BEHIND.onDisk);
    expect(shaped.applied).toBe(BEHIND.applied);
  });

  it("production: modified tag NAMES are ALSO redacted, but modifiedCount stays accurate (same posture as pending)", () => {
    const shaped = shapeMigrationStateForHealth("production", MODIFIED_ONLY);
    expect(shaped.modified).toEqual([]);
    expect(shaped.modifiedCount).toBe(1);
  });

  it("development/test: modified tag names pass through unchanged", () => {
    expect(shapeMigrationStateForHealth("development", MODIFIED_ONLY)).toEqual(MODIFIED_ONLY);
    expect(shapeMigrationStateForHealth("test", MODIFIED_ONLY)).toEqual(MODIFIED_ONLY);
  });

  it("boundary: a current (empty-pending) state is unaffected by env — nothing to redact", () => {
    expect(shapeMigrationStateForHealth("production", CURRENT)).toEqual(CURRENT);
  });

  it("HEALTH_TAG_NAME_ENVS contains ONLY development and test", () => {
    expect([...HEALTH_TAG_NAME_ENVS].sort()).toEqual(["development", "test"]);
  });
});
