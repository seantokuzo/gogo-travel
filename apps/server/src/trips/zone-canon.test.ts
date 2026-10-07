/**
 * `canonicalizeZone` — the zone allow-list gate (B-30 round-1 server F3).
 * DB-free; the routes' use of it (create/PATCH store the canonical spelling,
 * unlisted ids 400, booking zones go through it too) is in
 * `destination-tz.db.test.ts`.
 *
 * REGENERATING `tz-zone-names.ts` (the drift test below goes red on a
 * tz-lookup bump): run this one-liner from `apps/server` and paste the array
 *   node -e "const s=require('fs').readFileSync(require.resolve('@photostructure/tz-lookup'),'utf8');console.log(JSON.parse(s.match(/,T=(\[[^\]]*\]);/)[1]).map(n=>'  \"'+n+'\",').join('\n'))"
 *
 * Falsification (each exercised): swap the lookup for `Intl` acceptance alone
 * (`isValidTimeZone`) → the legacy-alias rows and `SystemV/AST4` go red;
 * canonicalise through `resolvedOptions().timeZone` → the modern-spelling
 * rows (`Asia/Kolkata`, `Europe/Kyiv`, `Pacific/Kanton`) go red on engines
 * that rewrite them.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allowedZoneNames, canonicalizeZone } from "./zone-canon.js";
import { TZ_LOOKUP_ZONE_NAMES } from "./tz-zone-names.js";

const require = createRequire(import.meta.url);

describe("tz-zone-names.ts is pinned to the installed tz-lookup", () => {
  /** The `T` table embedded in tz.js — the package exports only the lookup function. */
  const embedded = (): string[] => {
    const source = readFileSync(require.resolve("@photostructure/tz-lookup"), "utf8");
    const match = /,T=(\[[^\]]*\]);/.exec(source);
    if (match?.[1] === undefined) throw new Error("tz-lookup's zone table was not found in tz.js");
    return JSON.parse(match[1]) as string[];
  };

  it("lists exactly the zones tz-lookup embeds (436 at 11.7.0) — a library bump forces a regeneration", () => {
    expect(TZ_LOOKUP_ZONE_NAMES).toEqual(embedded());
    expect(TZ_LOOKUP_ZONE_NAMES).toHaveLength(436);
    expect(new Set(TZ_LOOKUP_ZONE_NAMES).size).toBe(436);
  });
});

describe("canonicalizeZone — accepts every zone the product can mint", () => {
  it("every one of the 436 tz-lookup zones is accepted verbatim (a DERIVED zone must always pass)", () => {
    const rejected = TZ_LOOKUP_ZONE_NAMES.filter((zone) => canonicalizeZone(zone) !== zone);
    expect(rejected).toEqual([]);
  });

  it("every distinct airports.tz value is accepted verbatim (booking arrives_tz/departs_tz come from these picks)", () => {
    const airports = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../reference-data/airports.json"), "utf8"),
    ) as { tz: string }[];
    const zones = [...new Set(airports.map((row) => row.tz))];
    expect(zones.length).toBeGreaterThan(300);
    const rejected = zones.filter((zone) => canonicalizeZone(zone) !== zone);
    expect(rejected).toEqual([]);
  });

  it("UTC (the default zone) and the engine's own canonical ids are accepted", () => {
    for (const zone of ["UTC", "Asia/Calcutta", "Europe/Kiev", "America/Argentina/Buenos_Aires"]) {
      expect(canonicalizeZone(zone), zone).toBe(zone);
    }
    // The allow-list is the union: bigger than tz-lookup's table alone.
    expect(allowedZoneNames().length).toBeGreaterThanOrEqual(TZ_LOOKUP_ZONE_NAMES.length);
  });
});

describe("canonicalizeZone — stores the modern IANA spelling, case-insensitively", () => {
  it.each([
    ["asia/tokyo", "Asia/Tokyo"],
    ["ASIA/TOKYO", "Asia/Tokyo"],
    ["America/los_angeles", "America/Los_Angeles"],
    ["america/argentina/buenos_aires", "America/Argentina/Buenos_Aires"],
    ["utc", "UTC"],
    ["etc/gmt+12", "Etc/GMT+12"],
    ["pacific/kiritimati", "Pacific/Kiritimati"],
  ])("%s -> %s", (input, canonical) => {
    expect(canonicalizeZone(input)).toBe(canonical);
  });

  it("does NOT rewrite modern ids to the engine's older aliases (resolvedOptions().timeZone would: Kolkata->Calcutta, Kyiv->Kiev, Kanton->Enderbury — the ids old Hermes rejects)", () => {
    for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "Pacific/Kanton"]) {
      expect(canonicalizeZone(zone), zone).toBe(zone);
      expect(canonicalizeZone(zone.toLowerCase()), zone).toBe(zone);
    }
  });
});

describe("canonicalizeZone — rejects everything outside the allow-list (V8 would resolve most of these)", () => {
  it.each([
    "SystemV/AST4", // V8 resolves it; Hermes' NSTimeZone has no SystemV/
    "SystemV/EST5EDT",
    "Japan", // legacy country alias
    "EST",
    "MST",
    "HST",
    "Zulu",
    "GMT",
    "US/Pacific",
    "Asia/Tokyo ",
    " Asia/Tokyo",
    "Asia//Tokyo",
    "/Asia/Tokyo",
    "Asia/Tokyo/",
    "+09:00",
    "UTC+9",
    "Etc/GMT+15",
    "Mars/Olympus_Mons",
    "",
    " ",
    "asia\\tokyo",
    "Asia/Tokyo\u0000",
    "Asia/Tokyo; DROP TABLE trips",
    "‮Asia/Tokyo",
    "__proto__",
    "constructor",
    "toString",
    "A".repeat(65),
    `Asia/${"T".repeat(60)}`,
  ])("rejects %j", (input) => {
    expect(canonicalizeZone(input)).toBeNull();
  });

  it("is total: hostile input never throws and costs microseconds", () => {
    const started = process.hrtime.bigint();
    for (let i = 0; i < 2000; i += 1) {
      canonicalizeZone(`Zone${i}/${"x".repeat(i % 80)}é`);
      canonicalizeZone("a".repeat(i));
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(500);
  });
});
