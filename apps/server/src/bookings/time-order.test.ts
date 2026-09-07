/**
 * `time-order.ts` units (round-1 B1): the grandfathered-row guard and the
 * 23514 → 400 fallback that keep migration 0003's `NOT VALID` grandfathering
 * from turning into 500s.
 *
 * The both-driver-shape pin is the `isExpenseBookingFkViolation` /
 * `isPlaceFkViolation` precedent: the integration harness (postgres-js) can
 * only ever produce the `constraint_name` wire shape, while the PROD Neon
 * serverless driver throws pg-protocol `DatabaseError`s exposing `constraint`
 * — a shape no container run reaches, so only a unit can pin it.
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../http/errors.js";
import {
  BOOKINGS_TIME_ORDER_CK,
  STORED_INSTANTS_INVERTED_MESSAGE,
  assertStoredInstantsOrdered,
  isTimeOrderCkViolation,
  rethrowTimeOrderCkMapped,
} from "./time-order.js";

const shaped = (props: Record<string, unknown>): Error =>
  Object.assign(new Error("db failure"), props);

const EARLIER = new Date("2027-04-24T08:00:00Z");
const LATER = new Date("2027-04-24T17:00:00Z");

describe("assertStoredInstantsOrdered (the merged-instants guard)", () => {
  it("throws VALIDATION_FAILED naming the STORED row, not the payload", () => {
    let thrown: unknown;
    try {
      assertStoredInstantsOrdered(LATER, EARLIER);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const httpError = thrown as HttpError;
    expect(httpError.code).toBe("VALIDATION_FAILED");
    expect(httpError.message).toBe(STORED_INSTANTS_INVERTED_MESSAGE);
    expect(httpError.details).toEqual({
      details: "stored end before start",
      rejected_by: "service",
    });
    // Distinct from `derivedInstantsOf`'s payload message on purpose — the two
    // causes have different fixes, and a client that conflates them tells the
    // user to edit the wrong thing.
    expect(httpError.message).not.toBe("the category's primary end time precedes its start time");
  });

  it("admits ordered, EQUAL (`<=`, not `<`) and half-open instants — the constraint's own disjuncts", () => {
    expect(() => assertStoredInstantsOrdered(EARLIER, LATER)).not.toThrow();
    expect(() => assertStoredInstantsOrdered(EARLIER, EARLIER)).not.toThrow();
    expect(() => assertStoredInstantsOrdered(LATER, null)).not.toThrow();
    expect(() => assertStoredInstantsOrdered(null, EARLIER)).not.toThrow();
    expect(() => assertStoredInstantsOrdered(null, null)).not.toThrow();
  });
});

describe("isTimeOrderCkViolation (both driver shapes)", () => {
  it("matches the postgres-js TEST-driver shape (constraint_name)", () => {
    expect(
      isTimeOrderCkViolation(shaped({ code: "23514", constraint_name: BOOKINGS_TIME_ORDER_CK })),
    ).toBe(true);
  });

  it("matches the pg-protocol PROD-driver shape (constraint) no container ever produces", () => {
    expect(
      isTimeOrderCkViolation(shaped({ code: "23514", constraint: BOOKINGS_TIME_ORDER_CK })),
    ).toBe(true);
  });

  it("walks wrapped causes (drizzle re-wraps driver errors)", () => {
    const wrapped = new Error("Failed query", {
      cause: shaped({ code: "23514", constraint: BOOKINGS_TIME_ORDER_CK }),
    });
    expect(isTimeOrderCkViolation(wrapped)).toBe(true);
  });

  it("is constraint-PRECISE: the other CHECKs on the booking write path stay LOUD", () => {
    // Their service mirrors are supposed to catch the value first; mapping
    // every 23514 to a 400 would silence exactly the drift the two-file
    // lockstep pins exist to detect.
    for (const other of [
      "bookings_price_nonnegative_ck",
      "bookings_price_currency_ck",
      "bookings_currency_upper_ck",
      "itinerary_items_end_day_ck",
    ]) {
      expect(isTimeOrderCkViolation(shaped({ code: "23514", constraint_name: other }))).toBe(false);
    }
  });

  it("rejects other SQLSTATEs and non-Errors", () => {
    // 23503 is the FK code — a different mapping (canonical 404) owns it.
    expect(
      isTimeOrderCkViolation(shaped({ code: "23503", constraint_name: BOOKINGS_TIME_ORDER_CK })),
    ).toBe(false);
    expect(isTimeOrderCkViolation(shaped({ code: "23514" }))).toBe(false);
    expect(isTimeOrderCkViolation("23514")).toBe(false);
    expect(isTimeOrderCkViolation(null)).toBe(false);
  });
});

describe("rethrowTimeOrderCkMapped (the 23514 fallback)", () => {
  it("maps the violation onto the SAME 400 the pre-write guard answers", () => {
    const driverError = shaped({ code: "23514", constraint_name: BOOKINGS_TIME_ORDER_CK });
    let thrown: unknown;
    try {
      rethrowTimeOrderCkMapped(driverError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe("VALIDATION_FAILED");
    expect((thrown as HttpError).message).toBe(STORED_INSTANTS_INVERTED_MESSAGE);
    // …but says WHICH layer caught it: `constraint` means the pre-write guard
    // missed a path and Postgres was the last line — a bug report, not a
    // routine rejection.
    expect((thrown as HttpError).details).toEqual({
      details: "stored end before start",
      rejected_by: "constraint",
    });
  });

  it("rethrows everything else UNCHANGED — a real bug must not become a 400", () => {
    const unrelated = shaped({ code: "23505", constraint_name: "bookings_capture_id_uq" });
    expect(() => rethrowTimeOrderCkMapped(unrelated)).toThrow(unrelated);
    const plain = new Error("boom");
    expect(() => rethrowTimeOrderCkMapped(plain)).toThrow(plain);
  });
});
