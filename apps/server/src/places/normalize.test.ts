/**
 * Spine-record normalization (places spec §3.1.4 step 3) — the single gate
 * between untrusted dataset rows and the upsert. Junk drops; valid rows pass
 * byte-exact except trim/NFC.
 */
import { describe, expect, it } from "vitest";
import { normalizeSpineRecord, type RawSpineRecord } from "./normalize.js";

// Control characters built at RUNTIME — a raw NUL/BEL/ESC byte in a source
// literal flags this file binary to git and breaks grep/review tooling
// (server rule; caught T-5.1 and again T-5.2).
const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const TAB = String.fromCharCode(9);

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
    // "Bele" + combining acute (NFD) must come out as the NFC "é". Built at
    // runtime via normalize("NFD") — deterministic regardless of how an
    // editor normalizes this file's literals — and guarded so the input
    // really is a different byte form than the expected output.
    const nfd = "Belém Tower".normalize("NFD");
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

  // Control chars (esp. NUL) are batch-killers: Postgres rejects NUL in text,
  // so one bad upstream row would deterministically fail its whole batch
  // statement on every retry and flip the region `failed` — the gate must eat
  // the record, never the region (R-places-4 posture).
  it("drops records whose identity fields carry control characters", () => {
    expect(normalizeSpineRecord({ ...valid, name: `Bel${NUL}m Tower` })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, name: `Bell${BEL} Tower` })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, name: `Two${TAB}Words` })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, sourceId: `ovt${NUL}-1` })).toBeNull();
    expect(normalizeSpineRecord({ ...valid, sourceId: `ovt-${ESC}[31m1` })).toBeNull();
  });

  it("nulls optional fields carrying control characters without dropping the record", () => {
    const nulByteCategory = normalizeSpineRecord({ ...valid, category: `food${NUL}court` });
    expect(nulByteCategory).not.toBeNull();
    expect(nulByteCategory?.category).toBeNull();

    const nulByteWikiRef = normalizeSpineRecord({ ...valid, wikiRef: `Q${NUL}12` });
    expect(nulByteWikiRef).not.toBeNull();
    expect(nulByteWikiRef?.wikiRef).toBeNull();
  });
});
