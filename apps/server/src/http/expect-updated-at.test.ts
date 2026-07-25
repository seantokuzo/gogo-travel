/**
 * Unit suite for the reusable `expect_updated_at` precondition helper
 * (trips spec §3.5 rule 2, R-trips-6). The end-to-end semantics (stale → 409
 * with the row unchanged; fresh-row microsecond echo → NO false conflict) run
 * against real Postgres in `trips/routes.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "./errors.js";
import {
  expectUpdatedAtPrecondition,
  STALE_UPDATED_AT_MESSAGE,
  STALE_UPDATED_AT_REASON,
  throwGuardedUpdateMiss,
} from "./expect-updated-at.js";

describe("expectUpdatedAtPrecondition", () => {
  it("returns undefined when the client sent no expect_updated_at (plain LWW)", () => {
    expect(expectUpdatedAtPrecondition(schema.trips.updatedAt, undefined)).toBeUndefined();
  });

  it("returns a SQL fragment when a precondition is present", () => {
    const fragment = expectUpdatedAtPrecondition(
      schema.trips.updatedAt,
      "2026-07-25T10:00:00.123Z",
    );
    // A defined fragment is ANDed into the UPDATE's WHERE; its ms-grain
    // `date_trunc` semantics (the micros landmine) are asserted end-to-end in
    // trips/routes.db.test.ts against real Postgres.
    expect(fragment).toBeDefined();
  });
});

describe("throwGuardedUpdateMiss", () => {
  it("row still exists → CONFLICT with the machine-readable stale reason", () => {
    let thrown: unknown;
    try {
      throwGuardedUpdateMiss(true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const httpError = thrown as HttpError;
    expect(httpError.code).toBe("CONFLICT");
    expect(httpError.message).toBe(STALE_UPDATED_AT_MESSAGE);
    expect(httpError.details).toEqual({ reason: STALE_UPDATED_AT_REASON });
  });

  it("row gone → NOT_FOUND with the shared indistinguishable message (deletes converge)", () => {
    let thrown: unknown;
    try {
      throwGuardedUpdateMiss(false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const httpError = thrown as HttpError;
    expect(httpError.code).toBe("NOT_FOUND");
    expect(httpError.message).toBe(NOT_FOUND_MESSAGE);
  });
});
