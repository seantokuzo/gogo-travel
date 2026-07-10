import { describe, expect, it } from "vitest";
import { PlaceSchema } from "./place.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

const base = {
  id: UUID,
  name: "Fushimi Inari Taisha",
  lat: 34.9671,
  lng: 135.7727,
  category: "shrine",
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
});
