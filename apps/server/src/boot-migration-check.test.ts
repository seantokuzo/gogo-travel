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
 * applied comparison there.
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
  checkedAt: FIXED_CHECKED_AT,
};
const BEHIND: MigrationState = {
  onDisk: 4,
  applied: 2,
  pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
  pendingCount: 2,
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

  it("boundary: a current (empty-pending) state is unaffected by env — nothing to redact", () => {
    expect(shapeMigrationStateForHealth("production", CURRENT)).toEqual(CURRENT);
  });

  it("HEALTH_TAG_NAME_ENVS contains ONLY development and test", () => {
    expect([...HEALTH_TAG_NAME_ENVS].sort()).toEqual(["development", "test"]);
  });
});
