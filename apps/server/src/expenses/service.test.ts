/**
 * Expense service error-shape units (PR #30 R1): pins the BOTH-driver-shape
 * contract on `isExpenseBookingFkViolation` — the bookings
 * `isPlaceFkViolation` precedent — because the integration harness
 * (postgres-js) can only ever produce the `constraint_name` wire shape; the
 * PROD Neon serverless driver throws pg-protocol `DatabaseError`s exposing
 * `constraint` instead, a shape no container run reaches. Also pins the
 * `isDeadlockError` 40P01 walk backing the bounded retry (service module
 * doc's honest-residual note).
 */
import { describe, expect, it } from "vitest";
import {
  EXPENSES_BOOKING_FK,
  isDeadlockError,
  isExpenseBookingFkViolation,
} from "./service.js";

const shaped = (props: Record<string, unknown>): Error =>
  Object.assign(new Error("db failure"), props);

describe("isExpenseBookingFkViolation (both driver shapes — PR #30 R1)", () => {
  it("matches the postgres-js TEST-driver shape (constraint_name)", () => {
    expect(
      isExpenseBookingFkViolation(
        shaped({ code: "23503", constraint_name: EXPENSES_BOOKING_FK }),
      ),
    ).toBe(true);
  });

  it("matches the pg-protocol PROD-driver shape (constraint) no container ever produces", () => {
    expect(
      isExpenseBookingFkViolation(shaped({ code: "23503", constraint: EXPENSES_BOOKING_FK })),
    ).toBe(true);
  });

  it("walks wrapped causes (drizzle re-wraps driver errors)", () => {
    const wrapped = new Error("Failed query", {
      cause: shaped({ code: "23503", constraint: EXPENSES_BOOKING_FK }),
    });
    expect(isExpenseBookingFkViolation(wrapped)).toBe(true);
  });

  it("is constraint-PRECISE: other FKs on the write path stay loud", () => {
    expect(
      isExpenseBookingFkViolation(
        shaped({ code: "23503", constraint_name: "expenses_trip_id_trips_id_fk" }),
      ),
    ).toBe(false);
  });

  it("rejects other SQLSTATEs and non-Errors", () => {
    expect(
      isExpenseBookingFkViolation(shaped({ code: "23514", constraint_name: EXPENSES_BOOKING_FK })),
    ).toBe(false);
    expect(isExpenseBookingFkViolation("23503")).toBe(false);
    expect(isExpenseBookingFkViolation(null)).toBe(false);
  });
});

describe("isDeadlockError (40P01 walk — PR #30 R1)", () => {
  it("matches a top-level 40P01 and a cause-wrapped one", () => {
    expect(isDeadlockError(shaped({ code: "40P01" }))).toBe(true);
    expect(
      isDeadlockError(new Error("Failed query", { cause: shaped({ code: "40P01" }) })),
    ).toBe(true);
  });

  it("rejects other codes and non-Errors — the retry must never eat a real failure", () => {
    expect(isDeadlockError(shaped({ code: "23503" }))).toBe(false);
    expect(isDeadlockError(new Error("plain"))).toBe(false);
    expect(isDeadlockError("40P01")).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });
});
