/**
 * Bootstrap destination-tier generator — unit coverage for the pure
 * name-cap logic (B-7 round-1 blocking finding): `scripts/
 * generate-destination-tier.ts`'s `NAME_MAX` used to be a second literal
 * (500, mirroring `normalize.ts`'s `places.name` column cap) that had
 * silently diverged from `TripCreateSchema.destination_name`'s wire cap
 * (200) — a tier row longer than 200 chars would seed and search fine, then
 * 400 at `POST /trips`, an unrecoverable dead end on device. `NAME_MAX` is
 * now `DESTINATION_NAME_MAX_CHARS` imported from `@gogo/shared`, so this
 * file pins the exact boundary against that shared constant rather than a
 * re-guessed literal — a future re-divergence (either side changing without
 * the other) reds here.
 *
 * No Docker, no network, no DuckDB — `toSeed` is a pure function over an
 * already-fetched row.
 */
import { describe, expect, it } from "vitest";
import { DESTINATION_NAME_MAX_CHARS } from "@gogo/shared/domains/trip";
import { NAME_MAX, toSeed, type DivisionRow } from "../../scripts/generate-destination-tier.js";

function row(overrides: Partial<DivisionRow> = {}): DivisionRow {
  return {
    id: "test-id-1",
    name: "Testville",
    country: "US",
    lat: 12.5,
    lng: -34.5,
    population: 500_000,
    is_country_capital: false,
    wikidata: null,
    ...overrides,
  };
}

describe("generate-destination-tier: NAME_MAX tracks the shared wire cap", () => {
  it("NAME_MAX equals DESTINATION_NAME_MAX_CHARS (TripCreateSchema.destination_name), not normalize.ts's 500-char column cap", () => {
    expect(NAME_MAX).toBe(DESTINATION_NAME_MAX_CHARS);
    expect(NAME_MAX).toBe(200);
  });

  it("a 200-char name round-trips into a seed (at the cap, not over it)", () => {
    const name200 = "A".repeat(200);
    const skipped: string[] = [];
    const seed = toSeed(row({ name: name200 }), skipped);
    expect(seed, `unexpectedly skipped: ${skipped.join("; ")}`).not.toBeNull();
    expect(seed?.name).toBe(name200);
    expect(seed?.name.length).toBe(200);
    expect(skipped).toEqual([]);
  });

  it("a 201-char name is refused — it can never exist in the generated JSON", () => {
    const name201 = "A".repeat(201);
    const skipped: string[] = [];
    const seed = toSeed(row({ name: name201 }), skipped);
    expect(seed).toBeNull();
    expect(skipped).toEqual(["test-id-1: unusable name"]);
  });

  // Mutation-verify: reverting NAME_MAX to the old hardcoded 500 (i.e.
  // asserting against 500 instead of the shared constant) would make BOTH
  // assertions above pass differently — the 201-char case would stop being
  // refused. This test's failure mode IS the round-1 bug: a name the wire
  // schema rejects that the generator still happily seeds.
  it("falsification: a name between the old 500-char column cap and the 200-char wire cap is refused", () => {
    const name300 = "B".repeat(300);
    const skipped: string[] = [];
    const seed = toSeed(row({ name: name300 }), skipped);
    expect(seed).toBeNull();
    expect(skipped).toEqual(["test-id-1: unusable name"]);
  });
});
