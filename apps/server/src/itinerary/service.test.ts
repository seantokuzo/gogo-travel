/**
 * Unit pins for the itinerary service's place-FK error-mapping arm. The
 * `assertPlaceVisible` check → row write window is a real race under READ
 * COMMITTED (a place hard-deleted in between fires the FK), but no
 * deterministic DB test can schedule that interleaving — so the MAPPING
 * itself is pinned here, both driver shapes included (the bookings
 * `isPlaceFkViolation` precedent: postgres-js says `constraint_name`,
 * pg-protocol's DatabaseError — the PROD Neon serverless shape no container
 * ever produces — says `constraint`).
 */
import { describe, expect, it } from "vitest";
import { ITINERARY_ITEMS_PLACE_FK, isItemPlaceFkViolation } from "./service.js";

/** An Error carrying arbitrary protocol fields (both drivers subclass Error). */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields);
}

describe("isItemPlaceFkViolation (item place-FK 23503 walker, both driver shapes)", () => {
  it("reads pg-protocol DatabaseError's `constraint` — the PROD (Neon serverless) shape", () => {
    expect(
      isItemPlaceFkViolation(driverError({ code: "23503", constraint: ITINERARY_ITEMS_PLACE_FK })),
    ).toBe(true);
  });

  it("reads postgres-js's `constraint_name` — the TEST driver shape", () => {
    expect(
      isItemPlaceFkViolation(
        driverError({ code: "23503", constraint_name: ITINERARY_ITEMS_PLACE_FK }),
      ),
    ).toBe(true);
  });

  it("walks a Drizzle cause chain to the wrapped protocol error", () => {
    const inner = driverError({ code: "23503", constraint_name: ITINERARY_ITEMS_PLACE_FK });
    expect(isItemPlaceFkViolation(new Error("Failed query", { cause: inner }))).toBe(true);
  });

  it("OTHER FK constraints on the write path stay loud (constraint-precise)", () => {
    expect(
      isItemPlaceFkViolation(
        driverError({ code: "23503", constraint_name: "itinerary_items_trip_id_trips_id_fk" }),
      ),
    ).toBe(false);
    expect(isItemPlaceFkViolation(driverError({ code: "23503" }))).toBe(false);
  });

  it("non-FK errors and non-errors answer false (rethrow path)", () => {
    expect(
      isItemPlaceFkViolation(driverError({ code: "23505", constraint: ITINERARY_ITEMS_PLACE_FK })),
    ).toBe(false);
    expect(isItemPlaceFkViolation(new Error("plain"))).toBe(false);
    expect(isItemPlaceFkViolation("not an error")).toBe(false);
    expect(isItemPlaceFkViolation(undefined)).toBe(false);
  });
});
