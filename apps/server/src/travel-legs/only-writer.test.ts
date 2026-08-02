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

/**
 * Raw-SQL evasion channel: the builder scan above cannot see
 * `db.execute(sql`…travel_legs…`)`. Any sql-template mention of the table
 * outside recompute.ts / the schema definition fails the scan — a raw READ
 * would trip it too, deliberately: whoever needs one amends this pin
 * consciously instead of slipping past it.
 */
const RAW_SQL_PATTERN = /sql`[^`]*travel_legs/;

/**
 * Third evasion channel: the Drizzle INTERPOLATED-identifier form —
 * `sql`DELETE FROM ${schema.travelLegs}`` — names the table object, not the
 * snake_case string, so RAW_SQL_PATTERN never sees it. Any `travelLegs`
 * inside a sql-template interpolation trips this one.
 */
const RAW_SQL_INTERP_PATTERN = /sql`[^`]*\$\{[^}`]*travelLegs\b/;

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

  it("raw-SQL pattern catches the evasion shapes (positive control)", () => {
    expect(
      RAW_SQL_PATTERN.test("await db.execute(sql`DELETE FROM travel_legs WHERE id = ${id}`)"),
    ).toBe(true);
    expect(RAW_SQL_PATTERN.test("sql`UPDATE travel_legs SET provider = 'x'`")).toBe(true);
    expect(RAW_SQL_PATTERN.test("sql`INSERT INTO\n  travel_legs (trip_id)`")).toBe(true);
    // Builder writes and prose mentions do NOT trip it.
    expect(RAW_SQL_PATTERN.test("tx.insert(schema.travelLegs).values(x)")).toBe(false);
    expect(RAW_SQL_PATTERN.test("// the travel_legs table is derived data")).toBe(false);
  });

  it("interpolated-identifier pattern catches the Drizzle table-object form (positive control)", () => {
    expect(
      RAW_SQL_INTERP_PATTERN.test("await db.execute(sql`DELETE FROM ${schema.travelLegs}`)"),
    ).toBe(true);
    expect(RAW_SQL_INTERP_PATTERN.test("sql`UPDATE ${travelLegs} SET provider = 'x'`")).toBe(true);
    expect(
      RAW_SQL_INTERP_PATTERN.test(
        "sql`INSERT INTO\n  ${schema.travelLegs} (trip_id) VALUES (${id})`",
      ),
    ).toBe(true);
    // A later interpolation in the same template is still caught.
    expect(
      RAW_SQL_INTERP_PATTERN.test("sql`WHERE id = ${id} AND EXISTS (SELECT 1 FROM ${travelLegs})`"),
    ).toBe(true);
    // Builder writes, prose, and OTHER tables' interpolations do NOT trip it.
    expect(RAW_SQL_INTERP_PATTERN.test("tx.insert(schema.travelLegs).values(x)")).toBe(false);
    expect(RAW_SQL_INTERP_PATTERN.test("// travelLegs is written by recompute only")).toBe(false);
    expect(RAW_SQL_INTERP_PATTERN.test("sql`${schema.bookings.startsAt} ASC NULLS LAST`")).toBe(
      false,
    );
  });

  it("NO production module outside recompute.ts/schema touches travel_legs via raw sql", () => {
    const offenders = sources.filter((file) => {
      if (file.endsWith(join("travel-legs", "recompute.ts"))) return false;
      if (file.includes(join("db", "schema"))) return false;
      const source = readFileSync(file, "utf8");
      return RAW_SQL_PATTERN.test(source) || RAW_SQL_INTERP_PATTERN.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
