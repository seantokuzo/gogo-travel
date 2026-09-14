/**
 * `coords-ck.ts` units (B-7 part 3 round-1 fix): the 23514 → 400 fallback
 * for the three nullable-coordinate CHECK constraints. Same both-driver-shape
 * precedent as `bookings/time-order.test.ts` — postgres-js (the test driver)
 * exposes `constraint_name`, pg-protocol (the PROD Neon driver) exposes
 * `constraint`; no container run ever produces the prod shape, so only a
 * unit test pins it.
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../http/errors.js";
import {
  PLACES_COORDS_PAIR_CK,
  PLACES_SPINE_COORDS_CK,
  TRIPS_DESTINATION_COORDS_PAIR_CK,
  rethrowCoordsCkMapped,
} from "./coords-ck.js";

const shaped = (props: Record<string, unknown>): Error =>
  Object.assign(new Error("db failure"), props);

describe("rethrowCoordsCkMapped", () => {
  it("maps places_coords_pair_ck (postgres-js shape) onto VALIDATION_FAILED", () => {
    const driverError = shaped({ code: "23514", constraint_name: PLACES_COORDS_PAIR_CK });
    let thrown: unknown;
    try {
      rethrowCoordsCkMapped(driverError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe("VALIDATION_FAILED");
    expect((thrown as HttpError).message).toBe("lat and lng must both be present or both be null");
    expect((thrown as HttpError).details).toEqual({ rejected_by: "constraint" });
  });

  it("maps trips_destination_coords_pair_ck (pg-protocol PROD shape no container produces)", () => {
    const driverError = shaped({ code: "23514", constraint: TRIPS_DESTINATION_COORDS_PAIR_CK });
    let thrown: unknown;
    try {
      rethrowCoordsCkMapped(driverError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe("VALIDATION_FAILED");
  });

  it("maps places_spine_coords_ck onto its own, source-specific message", () => {
    const driverError = shaped({ code: "23514", constraint_name: PLACES_SPINE_COORDS_CK });
    let thrown: unknown;
    try {
      rethrowCoordsCkMapped(driverError);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).code).toBe("VALIDATION_FAILED");
    expect((thrown as HttpError).message).toBe(
      "coordinates cannot be cleared for this place's source",
    );
  });

  it("walks wrapped causes (drizzle re-wraps driver errors)", () => {
    const wrapped = new Error("Failed query", {
      cause: shaped({ code: "23514", constraint: PLACES_COORDS_PAIR_CK }),
    });
    expect(() => rethrowCoordsCkMapped(wrapped)).toThrow(HttpError);
  });

  it("rethrows everything else UNCHANGED — a real bug must not become a 400", () => {
    const unrelated = shaped({ code: "23514", constraint_name: "places_custom_source_id_ck" });
    expect(() => rethrowCoordsCkMapped(unrelated)).toThrow(unrelated);
    const wrongCode = shaped({ code: "23503", constraint_name: PLACES_COORDS_PAIR_CK });
    expect(() => rethrowCoordsCkMapped(wrongCode)).toThrow(wrongCode);
    const plain = new Error("boom");
    expect(() => rethrowCoordsCkMapped(plain)).toThrow(plain);
  });
});
