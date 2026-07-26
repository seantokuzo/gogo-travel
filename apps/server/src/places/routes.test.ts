/**
 * Unit pins for the places router's driver-shape seams (T-6.5 round-1 #1).
 *
 * The FK-violation mapper is the one spot where the PROD driver's error
 * shape differs from the TEST driver's: postgres-js (testcontainers) says
 * `table_name`, pg-protocol's DatabaseError (Neon serverless) says `table`.
 * No container-backed test can produce the prod shape — so it is pinned
 * here synthetically, or the 409 reason silently degrades to "unknown" in
 * production only.
 */
import { describe, expect, it } from "vitest";
import { fkViolationTable } from "./routes.js";

/** An Error carrying arbitrary protocol fields (both drivers subclass Error). */
function driverError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("db error"), fields);
}

describe("fkViolationTable (23503 walker, both driver shapes)", () => {
  it("reads pg-protocol DatabaseError's `table` — the PROD (Neon serverless) shape", () => {
    const prod = driverError({ code: "23503", table: "saved_places" });
    expect(fkViolationTable(prod)).toBe("saved_places");
  });

  it("reads postgres-js's `table_name` — the TEST driver shape", () => {
    const test = driverError({ code: "23503", table_name: "itinerary_items" });
    expect(fkViolationTable(test)).toBe("itinerary_items");
  });

  it("prefers `table_name` when both are present, and walks a Drizzle cause chain", () => {
    const inner = driverError({
      code: "23503",
      table_name: "tour_guide_bundles",
      table: "tour_guide_bundles",
    });
    const wrapped = new Error("Failed query", { cause: inner });
    expect(fkViolationTable(wrapped)).toBe("tour_guide_bundles");
  });

  it("a 23503 with NEITHER field still answers 'unknown' (409, never a 500)", () => {
    expect(fkViolationTable(driverError({ code: "23503" }))).toBe("unknown");
  });

  it("non-FK errors and non-errors answer null (rethrow path)", () => {
    expect(fkViolationTable(driverError({ code: "23505", table: "places" }))).toBeNull();
    expect(fkViolationTable(new Error("plain"))).toBeNull();
    expect(fkViolationTable("not an error")).toBeNull();
    expect(fkViolationTable(undefined)).toBeNull();
  });
});
