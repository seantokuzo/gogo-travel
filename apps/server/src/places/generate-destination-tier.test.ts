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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESTINATION_NAME_MAX_CHARS } from "@gogo/shared/domains/trip";
import {
  NAME_MAX,
  toSeed,
  type DestinationSeed,
  type DivisionRow,
} from "../../scripts/generate-destination-tier.js";

const DESTINATIONS_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "reference-data",
  "destinations.json",
);
const destinations = JSON.parse(readFileSync(DESTINATIONS_JSON, "utf8")) as DestinationSeed[];

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

/**
 * Committed dataset pins (round-1 review, adversarial-verifier F9/A3): the
 * capital arm's small-sovereign-state coverage, and the two documented
 * gaps, checked directly against the shipped `destinations.json` rather
 * than a live Overture re-query (no network needed for this suite).
 */
describe("destinations.json: capital-arm coverage and documented gaps", () => {
  it("no seeded name exceeds the wire cap (mirrors the generator's own NAME_MAX refusal)", () => {
    const longest = destinations.reduce((max, d) => Math.max(max, d.name.length), 0);
    for (const d of destinations) {
      expect(d.name.length, `${d.sourceId} (${d.name}) exceeds NAME_MAX`).toBeLessThanOrEqual(
        NAME_MAX,
      );
    }
    // Documents reality, not a magic number: currently well under the cap.
    expect(longest).toBeLessThanOrEqual(NAME_MAX);
  });

  const CAPITAL_PINS: ReadonlyArray<{ name: string; country: string }> = [
    { name: "Yaren", country: "NR" },
    { name: "Funafuti", country: "TV" },
    { name: "City of San Marino", country: "SM" },
    { name: "Vaduz", country: "LI" },
    { name: "Monaco", country: "MC" },
    { name: "Ngerulmud", country: "PW" },
    { name: "Palikir", country: "FM" },
  ];

  it.each(CAPITAL_PINS)(
    "$name ($country) is seeded and flagged isCountryCapital (low/no-population microstate capital)",
    ({ name, country }) => {
      const hit = destinations.find((d) => d.name === name && d.country === country);
      expect(hit, `${name} (${country}) not found in destinations.json`).toBeDefined();
      expect(hit?.isCountryCapital).toBe(true);
      // Every pin here is chosen BECAUSE population alone would not have
      // included it — proves the capital arm, not the population arm, did
      // the including.
      expect((hit?.population ?? 0) < 100_000).toBe(true);
    },
  );

  it("Vatican City is absent — a documented gap, not a regression (Overture tags it subtype='macrohood', never 'locality', in this release)", () => {
    const hit = destinations.find((d) => d.name === "Vatican City");
    expect(hit).toBeUndefined();
  });

  it("Wellington, NZ is present via the population arm but isCountryCapital is false — a documented upstream data gap (capital_of_divisions is null for NZ, both directions)", () => {
    const hit = destinations.find((d) => d.name === "Wellington" && d.country === "NZ");
    expect(hit, "Wellington (NZ) not found in destinations.json").toBeDefined();
    expect(hit?.isCountryCapital).toBe(false);
    expect((hit?.population ?? 0) >= 100_000).toBe(true); // included via population, not the capital arm
  });
});
