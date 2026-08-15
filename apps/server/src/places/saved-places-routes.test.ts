/**
 * Unit pins for the saved-places constraint walkers (T-8.1 / PL-4 — the
 * `fkViolationTable` / `isPlaceFkViolation` driver-trap precedent).
 *
 * The walkers are the one spot where the PROD driver's error shape differs
 * from the TEST driver's: postgres-js (testcontainers) says
 * `constraint_name`, pg-protocol's DatabaseError (Neon serverless) says
 * `constraint`. No container-backed test can produce the prod shape — so it
 * is pinned here synthetically, or the 409/404 mapping silently degrades to
 * a 500 in production only.
 */
import { describe, expect, it } from "vitest";
import {
  isSavedPlaceDuplicate,
  isSavedPlacePlaceFkViolation,
  SAVED_PLACES_PLACE_FK,
  SAVED_PLACES_TRIP_PLACE_UQ,
} from "./saved-places-routes.js";

/** An Error carrying arbitrary protocol fields (both drivers subclass Error). */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields);
}

describe("isSavedPlaceDuplicate (23505 → the R-places-16 409)", () => {
  it("reads pg-protocol DatabaseError's `constraint` — the PROD (Neon serverless) shape", () => {
    expect(
      isSavedPlaceDuplicate(driverError({ code: "23505", constraint: SAVED_PLACES_TRIP_PLACE_UQ })),
    ).toBe(true);
  });

  it("reads postgres-js's `constraint_name` — the TEST driver shape — and walks a cause chain", () => {
    const inner = driverError({ code: "23505", constraint_name: SAVED_PLACES_TRIP_PLACE_UQ });
    expect(isSavedPlaceDuplicate(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("is constraint-PRECISE: another unique violation stays loud (false)", () => {
    expect(
      isSavedPlaceDuplicate(driverError({ code: "23505", constraint_name: "some_other_uq" })),
    ).toBe(false);
    // A 23505 with NEITHER field is not this constraint either.
    expect(isSavedPlaceDuplicate(driverError({ code: "23505" }))).toBe(false);
  });

  it("ignores other SQLSTATEs and non-Errors", () => {
    expect(
      isSavedPlaceDuplicate(
        driverError({ code: "23503", constraint_name: SAVED_PLACES_TRIP_PLACE_UQ }),
      ),
    ).toBe(false);
    expect(isSavedPlaceDuplicate("nope")).toBe(false);
    expect(isSavedPlaceDuplicate(undefined)).toBe(false);
  });
});

describe("isSavedPlacePlaceFkViolation (23503 race residue → the canonical 404)", () => {
  it("accepts BOTH driver shapes for the place FK", () => {
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint: SAVED_PLACES_PLACE_FK }),
      ),
    ).toBe(true);
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint_name: SAVED_PLACES_PLACE_FK }),
      ),
    ).toBe(true);
  });

  it("walks a Drizzle cause chain", () => {
    const inner = driverError({ code: "23503", constraint_name: SAVED_PLACES_PLACE_FK });
    expect(isSavedPlacePlaceFkViolation(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("is constraint-PRECISE: the gate-proven trip FK stays loud (false)", () => {
    expect(
      isSavedPlacePlaceFkViolation(
        driverError({ code: "23503", constraint_name: "saved_places_trip_id_trips_id_fk" }),
      ),
    ).toBe(false);
    expect(isSavedPlacePlaceFkViolation(driverError({ code: "23505" }))).toBe(false);
  });
});
