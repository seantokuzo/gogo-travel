/**
 * Unit pins for the booking service's place-FK error-mapping arm (round-2
 * A2). The `assertPlaceVisible` check → row write window is a real race
 * under READ COMMITTED (a place hard-deleted in between fires the FK), but
 * no deterministic DB test can schedule that interleaving — so the MAPPING
 * itself is pinned here, both driver shapes included (the places
 * `fkViolationTable` precedent: postgres-js says `constraint_name`,
 * pg-protocol's DatabaseError — the PROD Neon serverless shape no container
 * ever produces — says `constraint`).
 */
import { describe, expect, it } from "vitest";
import { BOOKINGS_PLACE_FK, isPlaceFkViolation } from "./service.js";

/** An Error carrying arbitrary protocol fields (both drivers subclass Error). */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields);
}

describe("isPlaceFkViolation (place-FK 23503 walker, both driver shapes)", () => {
  it("reads pg-protocol DatabaseError's `constraint` — the PROD (Neon serverless) shape", () => {
    expect(
      isPlaceFkViolation(driverError({ code: "23503", constraint: BOOKINGS_PLACE_FK })),
    ).toBe(true);
  });

  it("reads postgres-js's `constraint_name` — the TEST driver shape", () => {
    expect(
      isPlaceFkViolation(driverError({ code: "23503", constraint_name: BOOKINGS_PLACE_FK })),
    ).toBe(true);
  });

  it("walks a Drizzle cause chain to the wrapped protocol error", () => {
    const inner = driverError({ code: "23503", constraint_name: BOOKINGS_PLACE_FK });
    expect(isPlaceFkViolation(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("OTHER FK constraints on the write path stay loud (constraint-precise)", () => {
    expect(
      isPlaceFkViolation(
        driverError({ code: "23503", constraint_name: "bookings_trip_id_trips_id_fk" }),
      ),
    ).toBe(false);
    expect(isPlaceFkViolation(driverError({ code: "23503" }))).toBe(false);
  });

  it("non-FK errors and non-errors answer false (rethrow path)", () => {
    expect(
      isPlaceFkViolation(driverError({ code: "23505", constraint: BOOKINGS_PLACE_FK })),
    ).toBe(false);
    expect(isPlaceFkViolation(new Error("plain"))).toBe(false);
    expect(isPlaceFkViolation("not an error")).toBe(false);
    expect(isPlaceFkViolation(undefined)).toBe(false);
  });
});
