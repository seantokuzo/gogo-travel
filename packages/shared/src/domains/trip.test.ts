import { describe, expect, it } from "vitest";
import {
  deriveTripStatus,
  TripCreateSchema,
  TripListItemSchema,
  TripListQuerySchema,
  TripSchema,
  TripUpdateSchema,
  tripEndpoints,
} from "./trip.js";

describe("deriveTripStatus (trips spec §3.4 — single definition)", () => {
  it("is 'planning' before start_date", () => {
    expect(deriveTripStatus("2026-07-01", "2026-07-10", "2026-07-20")).toBe("planning");
  });
  it("is 'active' from start_date through end_date inclusive", () => {
    expect(deriveTripStatus("2026-07-10", "2026-07-10", "2026-07-20")).toBe("active");
    expect(deriveTripStatus("2026-07-15", "2026-07-10", "2026-07-20")).toBe("active");
    expect(deriveTripStatus("2026-07-20", "2026-07-10", "2026-07-20")).toBe("active");
  });
  it("is 'past' after end_date", () => {
    expect(deriveTripStatus("2026-07-21", "2026-07-10", "2026-07-20")).toBe("past");
  });
  it("is 'planning' when either date is missing", () => {
    expect(deriveTripStatus("2026-07-10", null, "2026-07-20")).toBe("planning");
    expect(deriveTripStatus("2026-07-10", "2026-07-01", undefined)).toBe("planning");
  });
  it("handles single-day trips", () => {
    expect(deriveTripStatus("2026-07-10", "2026-07-10", "2026-07-10")).toBe("active");
  });
});

describe("TripCreate", () => {
  const valid = {
    name: "Tokyo",
    destination_name: "Tokyo, Japan",
    destination_lat: 35.6812,
    destination_lng: 139.7671,
    start_date: "2026-09-01",
    end_date: "2026-09-10",
  };

  it("parses a valid create (dates + structured destination required)", () => {
    expect(TripCreateSchema.parse(valid).name).toBe("Tokyo");
  });

  it("rejects start_date > end_date", () => {
    expect(TripCreateSchema.safeParse({ ...valid, start_date: "2026-09-11" }).success).toBe(false);
  });

  it("rejects missing dates or coordinates (Gate 2: required at creation)", () => {
    const { start_date: _s, ...noStart } = valid;
    expect(TripCreateSchema.safeParse(noStart).success).toBe(false);
    const { destination_lat: _lat, ...noLat } = valid;
    expect(TripCreateSchema.safeParse(noLat).success).toBe(false);
  });

  it("rejects out-of-range coordinates and lowercase currency", () => {
    expect(TripCreateSchema.safeParse({ ...valid, destination_lat: 91 }).success).toBe(false);
    expect(TripCreateSchema.safeParse({ ...valid, base_currency: "usd" }).success).toBe(false);
  });
});

describe("TripUpdate", () => {
  it("accepts partial updates incl. clearing the status override with null", () => {
    expect(TripUpdateSchema.parse({ status: null }).status).toBeNull();
    expect(TripUpdateSchema.parse({ status: "past" }).status).toBe("past");
    expect(TripUpdateSchema.parse({ theme: null }).theme).toBeNull();
  });
  it("re-checks date order when both dates are in the body", () => {
    expect(
      TripUpdateSchema.safeParse({ start_date: "2026-09-11", end_date: "2026-09-01" }).success,
    ).toBe(false);
    expect(TripUpdateSchema.safeParse({ start_date: "2026-09-11" }).success).toBe(true);
  });
});

describe("TripListItem (trips spec §3.3 GET /trips)", () => {
  const trip = {
    id: "8f14e45f-ceea-467f-a8d9-4a1c4f5b6e7d",
    name: "Tokyo",
    destination_name: "Tokyo, Japan",
    destination_lat: 35.6812,
    destination_lng: 139.7671,
    start_date: "2026-09-01",
    end_date: "2026-09-10",
    status: "planning",
    status_override: null,
    base_currency: "USD",
    budget_cap_cents: null,
    theme: null,
    created_by: "8f14e45f-ceea-467f-a8d9-4a1c4f5b6e7e",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  };

  it("is Trip & { role, member_count } — member_count must be a positive int", () => {
    expect(TripListItemSchema.parse({ ...trip, role: "viewer", member_count: 3 }).role).toBe(
      "viewer",
    );
    expect(TripListItemSchema.safeParse({ ...trip, role: "viewer", member_count: 0 }).success).toBe(
      false,
    );
    expect(
      TripListItemSchema.safeParse({ ...trip, role: "viewer", member_count: 1.5 }).success,
    ).toBe(false);
    expect(TripListItemSchema.safeParse(trip).success).toBe(false); // role/count required
  });
});

describe("TripListQuery", () => {
  it("coerces string limits (query params arrive as strings) and enforces the server cap", () => {
    expect(TripListQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(TripListQuerySchema.parse({}).limit).toBeUndefined();
    expect(TripListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(TripListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(TripListQuerySchema.safeParse({ limit: "2.5" }).success).toBe(false);
  });
});

describe("tripEndpoints descriptors (contracts spec §3.6)", () => {
  it("mirror the §3.3 trip CRUD routes", () => {
    expect(tripEndpoints.createTrip.method).toBe("POST");
    expect(tripEndpoints.createTrip.path).toBe("/trips");
    expect(tripEndpoints.createTrip.body).toBe(TripCreateSchema);
    expect(tripEndpoints.listTrips.query).toBe(TripListQuerySchema);
    expect(tripEndpoints.getTrip.path).toBe("/trips/:tripId");
    expect(tripEndpoints.updateTrip.body).toBe(TripUpdateSchema);
    // PATCH returns the full updated Trip (R-trips-19) — no role on the wire.
    expect(tripEndpoints.updateTrip.response).toBe(TripSchema);
    expect(tripEndpoints.deleteTrip.method).toBe("DELETE");
  });
});
