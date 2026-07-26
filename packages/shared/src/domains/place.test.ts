import { describe, expect, it } from "vitest";
import {
  coarseCategory,
  coarseCategoryTokens,
  PlaceCreateSchema,
  PlaceSchema,
  PlaceSearchQuerySchema,
  PlaceUpdateSchema,
} from "./place.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

const base = {
  id: UUID,
  name: "Fushimi Inari Taisha",
  lat: 34.9671,
  lng: 135.7727,
  category: "shrine",
  coarse_category: "culture",
  wiki_ref: "Q1194296",
  created_by: null,
  created_at: "2026-07-10T00:00:00Z",
  updated_at: "2026-07-10T00:00:00Z",
};

describe("Place source/source_id invariant (R-db-6 mirror)", () => {
  it("open-data sources carry a source_id", () => {
    expect(
      PlaceSchema.parse({ ...base, source: "overture", source_id: "gers-123" }).source_id,
    ).toBe("gers-123");
  });
  it("custom places have NULL source_id", () => {
    expect(
      PlaceSchema.parse({ ...base, source: "custom", source_id: null, created_by: UUID }).source,
    ).toBe("custom");
  });
  it("rejects custom + source_id and open-data without source_id", () => {
    expect(PlaceSchema.safeParse({ ...base, source: "custom", source_id: "x" }).success).toBe(
      false,
    );
    expect(PlaceSchema.safeParse({ ...base, source: "fsq_os", source_id: null }).success).toBe(
      false,
    );
  });
  it("coarse_category is required and enum-bound (§3.2 wire shape)", () => {
    const noCoarse = { ...base, source: "overture", source_id: "g" } as Record<string, unknown>;
    delete noCoarse.coarse_category;
    expect(PlaceSchema.safeParse(noCoarse).success).toBe(false);
    expect(
      PlaceSchema.safeParse({
        ...base,
        source: "overture",
        source_id: "g",
        coarse_category: "temples",
      }).success,
    ).toBe(false);
  });
});

describe("coarseCategory mapping (§3.2.3)", () => {
  it("maps Overture snake_case labels via whole tokens", () => {
    expect(coarseCategory("overture", "tourist_attraction")).toBe("attraction");
    expect(coarseCategory("overture", "restaurant")).toBe("food");
    expect(coarseCategory("overture", "coffee_shop")).toBe("drink"); // coffee outranks shop
    expect(coarseCategory("overture", "hotel")).toBe("lodging");
    expect(coarseCategory("overture", "beer_garden")).toBe("drink"); // beer outranks garden
  });

  it("maps FSQ OS ' > ' hierarchies, resolving order-sensitive branches", () => {
    expect(coarseCategory("fsq_os", "Dining and Drinking > Bakery")).toBe("food");
    expect(coarseCategory("fsq_os", "Dining and Drinking > Bar")).toBe("drink");
    expect(coarseCategory("fsq_os", "Dining and Drinking")).toBe("food");
    expect(coarseCategory("fsq_os", "Landmarks and Outdoors > Park")).toBe("outdoors");
    expect(coarseCategory("fsq_os", "Landmarks and Outdoors")).toBe("attraction");
    expect(coarseCategory("fsq_os", "Travel and Transportation > Metro Station")).toBe(
      "transport",
    );
    expect(coarseCategory("fsq_os", "Arts and Entertainment > Amusement Park")).toBe(
      "attraction", // amusement outranks both arts and park
    );
  });

  it("maps custom free text and degrades unknowns to 'other'", () => {
    expect(coarseCategory("custom", "late-night ramen restaurant")).toBe("food");
    expect(coarseCategory("custom", "Mom's favorite museum")).toBe("culture");
    expect(coarseCategory("custom", "quantum flux emporium")).toBe("other");
    expect(coarseCategory("custom", null)).toBe("other");
    expect(coarseCategory("custom", "")).toBe("other");
    expect(coarseCategory("custom", "!!! ***")).toBe("other");
  });

  it("matches whole tokens only — 'Barbershop' is not a bar", () => {
    expect(coarseCategoryTokens("Barbershop")).toEqual(["barbershop"]);
    expect(coarseCategory("fsq_os", "Business and Professional Services > Barbershop")).toBe(
      "other",
    );
  });

  it("nightlife outranks drink; é-stripped café still lands on drink", () => {
    expect(coarseCategory("fsq_os", "Dining and Drinking > Nightclub")).toBe("nightlife");
    expect(coarseCategoryTokens("Café")).toEqual(["caf"]);
    expect(coarseCategory("fsq_os", "Dining and Drinking > Café")).toBe("drink");
  });
});

describe("PlaceCreate / PlaceUpdate (R-places-9/10; T-6.1 string-cap convention)", () => {
  const valid = { name: "Mom's House", lat: 34.1, lng: -118.2 };

  it("accepts a minimal create and an optional category", () => {
    expect(PlaceCreateSchema.parse(valid).category).toBeUndefined();
    expect(PlaceCreateSchema.parse({ ...valid, category: "family" }).category).toBe("family");
  });

  it("rejects blank names, out-of-range coordinates, uncapped strings", () => {
    expect(PlaceCreateSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(PlaceCreateSchema.safeParse({ ...valid, lat: 90.1 }).success).toBe(false);
    expect(PlaceCreateSchema.safeParse({ ...valid, lng: -180.5 }).success).toBe(false);
    expect(PlaceCreateSchema.safeParse({ ...valid, name: "x".repeat(201) }).success).toBe(false);
    expect(
      PlaceCreateSchema.safeParse({ ...valid, category: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("update is partial; category:null clears; same caps apply", () => {
    expect(PlaceUpdateSchema.parse({}).name).toBeUndefined();
    expect(PlaceUpdateSchema.parse({ category: null }).category).toBeNull();
    expect(PlaceUpdateSchema.parse({ name: "Renamed" }).name).toBe("Renamed");
    expect(PlaceUpdateSchema.safeParse({ lat: 91 }).success).toBe(false);
    expect(PlaceUpdateSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("PlaceSearchQuery (§3.3 GET /places/search)", () => {
  it("requires at least one of q / bbox / near", () => {
    expect(PlaceSearchQuerySchema.safeParse({}).success).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ coarse_category: "food" }).success).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ q: "belem" }).success).toBe(true);
  });

  it("q: ≥ 2 chars, capped, NFC-normalized", () => {
    expect(PlaceSearchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ q: "x".repeat(201) }).success).toBe(false);
    // NFD "Belém" (e + combining acute, spelled as an escape so no tooling
    // can silently re-normalize the literal) parses to the NFC form.
    const nfd = "Bele\u0301m";
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    const parsed = PlaceSearchQuerySchema.parse({ q: nfd });
    expect(parsed.q).toBe(nfd.normalize("NFC"));
  });

  it("bbox parses minLng,minLat,maxLng,maxLat into named fields", () => {
    const parsed = PlaceSearchQuerySchema.parse({ bbox: "-9.5,38.5,-9,39" });
    expect(parsed.bbox).toEqual({ min_lng: -9.5, min_lat: 38.5, max_lng: -9, max_lat: 39 });
  });

  it("rejects malformed bboxes: arity, junk, empty parts, range, inversion", () => {
    for (const bad of [
      "1,2,3", // arity
      "a,b,c,d", // junk
      "-9.5,,-9,39", // empty part (Number('') === 0 trap)
      "-9.5,38.5,-9,91", // lat out of range
      "-181,38.5,-9,39", // lng out of range
      "-9,38.5,-9.5,39", // minLng > maxLng
      "-9.5,39,-9,38.5", // minLat > maxLat
    ]) {
      expect(PlaceSearchQuerySchema.safeParse({ bbox: bad }).success).toBe(false);
    }
  });

  it("near parses lat,lng; radius_m is bounded and requires near", () => {
    const parsed = PlaceSearchQuerySchema.parse({ near: "38.7,-9.14", radius_m: "2500" });
    expect(parsed.near).toEqual({ lat: 38.7, lng: -9.14 });
    expect(parsed.radius_m).toBe(2500);

    expect(PlaceSearchQuerySchema.safeParse({ near: "91,-9" }).success).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ near: "38.7" }).success).toBe(false);
    expect(
      PlaceSearchQuerySchema.safeParse({ near: "38.7,-9.14", radius_m: 50_001 }).success,
    ).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ near: "38.7,-9.14", radius_m: 0 }).success).toBe(
      false,
    );
    // radius without near is a client bug, surfaced — not silently ignored.
    expect(PlaceSearchQuerySchema.safeParse({ q: "belem", radius_m: 100 }).success).toBe(false);
  });

  it("limit is coerced and capped at 50; trip_id must be a uuid", () => {
    expect(PlaceSearchQuerySchema.parse({ q: "belem", limit: "50" }).limit).toBe(50);
    expect(PlaceSearchQuerySchema.safeParse({ q: "belem", limit: 51 }).success).toBe(false);
    expect(PlaceSearchQuerySchema.safeParse({ q: "belem", limit: 0 }).success).toBe(false);
    expect(PlaceSearchQuerySchema.parse({ q: "belem", trip_id: UUID }).trip_id).toBe(UUID);
    expect(
      PlaceSearchQuerySchema.safeParse({ q: "belem", trip_id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});
