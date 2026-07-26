/**
 * Spine-record normalization (places spec §3.1.4 step 3) — the single gate
 * between untrusted dataset rows and the upsert. Junk drops; valid rows pass
 * byte-exact except trim/NFC.
 */
import { describe, expect, it } from "vitest";
import { normalizeSpineRecord, type RawSpineRecord } from "./normalize.js";

const valid: RawSpineRecord = {
  sourceId: "ovt-1",
  name: "Belém Tower",
  lat: 38.6916,
  lng: -9.216,
  category: "tourist_attraction",
  wikiRef: null,
};

describe("normalizeSpineRecord", () => {
  it("passes a valid record through", () => {
    expect(normalizeSpineRecord(valid)).toEqual({
      sourceId: "ovt-1",
      name: "Belém Tower",
      lat: 38.6916,
      lng: -9.216,
      category: "tourist_attraction",
      wikiRef: null,
    });
  });

  it("trims and NFC-normalizes the name (§3.1.4: trim/NFC)", () => {
    // "Bele" + combining acute (NFD) must come out as the NFC "é".
    const nfd = "Belém Tower";
    // The literal above IS NFD — guard it so an editor silently normalizing
    // this file breaks the test loudly instead of hollowing it out.
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    const result = normalizeSpineRecord({ ...valid, name: `  ${nfd}  ` });
    expect(result?.name).toBe("Belém Tower");
    expect(result?.name).toBe(nfd.normalize("NFC"));
  });

  it("drops records without a usable name", () => {
    expect(normalizeSpineRecord({ ...valid, name: null })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, name: "" })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, name: "   " })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, name: "x".repeat(501) })).toBeNull();
  });

  it("drops records without a usable source_id (upsert key, R-db-6)", () => {
    expect(normalizeSpineRecord({ ...valid, sourceId: null })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, sourceId: "  " })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, sourceId: "x".repeat(201) })).toBeNull();
  });

  it("validates coordinate ranges; boundary values pass", () => {
    expect(normalizeSpineRecord({ ...valid, lat: 90.0001 })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lat: -90.0001 })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lng: 180.0001 })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lng: -180.0001 })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lat: null })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lng: Number.NaN })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lat: Number.POSITIVE_INFINITY })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, lat: 90, lng: -180 })).not.toBeNull();
    expect(normalizeSpineRecord({ ...valid, lat: -90, lng: 180 })).not.toBeNull();
  });

  it("keeps category as the raw taxonomy string; junk categories null out without dropping the record", () => {
    expect(normalizeSpineRecord({ ...valid, category: "Dining and Drinking > Bakery" })?.category).toBe(
      "Dining and Drinking > Bakery",
    );
    expect(normalizeSpineRecord({ ...valid, category: null })?.category).toBeNull();
    expect(normalizeSpineRecord({ ...valid, category: "  " })?.category).toBeNull();
    expect(normalizeSpineRecord({ ...valid, category: "x".repeat(501) })?.category).toBeNull();
  });

  it("carries wiki_ref through when present, else null (§3.1.4 step 3)", () => {
    expect(normalizeSpineRecord({ ...valid, wikiRef: " Q123 " })?.wikiRef).toBe("Q123");
    expect(normalizeSpineRecord({ ...valid, wikiRef: "" })?.wikiRef).toBeNull();
    expect(normalizeSpineRecord({ ...valid, wikiRef: "x".repeat(201) })?.wikiRef).toBeNull();
  });
});
