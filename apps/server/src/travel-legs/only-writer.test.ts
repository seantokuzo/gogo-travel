/**
 * T-7.3 only-writer pin (R-ib-22 / schema §3.3.11): `travel_legs` has ONE
 * writer — the leg-computation job (`travel-legs/recompute.ts`). This static
 * scan fails the moment any other production module writes the table, so the
 * invariant survives future phases without relying on review memory.
 *
 * Scope: production sources only (`*.test.ts` / `*.test-util.ts` excluded —
 * suites may seed/manipulate legs to stage scenarios). The schema definition
 * (`db/schema/itinerary.ts`) declares the table but cannot write it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Drizzle write entry points against the travelLegs table object. */
const WRITE_PATTERN = /\.(?:insert|update|delete)\(\s*(?:schema\.)?travelLegs\s*[),]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("travel_legs only-writer invariant (R-ib-22)", () => {
  const sources = walk(SRC_ROOT).filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test-util.ts"),
  );

  it("scans a realistic production tree (pattern-drift guard)", () => {
    // If the walk or filters break, this fails before the invariant can
    // silently pass over nothing.
    expect(sources.length).toBeGreaterThan(50);
  });

  it("the recompute module itself writes travel_legs (positive control)", () => {
    const recompute = readFileSync(join(SRC_ROOT, "travel-legs", "recompute.ts"), "utf8");
    expect(WRITE_PATTERN.test(recompute)).toBe(true);
  });

  it("NO production module outside travel-legs/recompute.ts writes travel_legs", () => {
    const offenders = sources.filter((file) => {
      if (file.endsWith(join("travel-legs", "recompute.ts"))) return false;
      return WRITE_PATTERN.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
