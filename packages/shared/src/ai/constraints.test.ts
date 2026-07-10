/**
 * The AI-schema constraint walker (SH-1 test requirement; contracts spec
 * §3.7): every ai/* schema — no recursion, no numeric range constraints,
 * object depth ≤ 3. Implemented over `z.toJSONSchema()`, the same
 * JSON-Schema view `zodOutputFormat` derives from.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as recommendations from "./recommendations.js";
import * as expenseEstimate from "./expense-estimate.js";
import * as tourGuide from "./tour-guide.js";
import * as packingList from "./packing-list.js";
import * as recap from "./recap.js";
import * as captureExtract from "./capture-extract.js";

const AI_SCHEMAS: ReadonlyArray<[name: string, schema: z.ZodType]> = [
  ["recommendations.RecommendationsOutput", recommendations.RecommendationsOutputSchema],
  ["expense-estimate.ExpenseEstimateOutput", expenseEstimate.ExpenseEstimateOutputSchema],
  ["tour-guide.TourGuideBundle", tourGuide.TourGuideBundleSchema],
  ["packing-list.PackingListOutput", packingList.PackingListOutputSchema],
  ["recap.Recap (full jsonb shape)", recap.RecapSchema],
  ["recap.RecapNarrativeOutput", recap.RecapNarrativeOutputSchema],
  ["capture-extract.CaptureExtraction", captureExtract.CaptureExtractionSchema],
];

const AI_MODULES: ReadonlyArray<[name: string, mod: Record<string, unknown>]> = [
  ["recommendations", recommendations],
  ["expense-estimate", expenseEstimate],
  ["tour-guide", tourGuide],
  ["packing-list", packingList],
  ["recap", recap],
  ["capture-extract", captureExtract],
];

/** z.int()'s implicit safe-int format bounds are NOT user range constraints. */
const isFormatBound = (value: unknown): boolean =>
  typeof value === "number" && Math.abs(value) >= Number.MAX_SAFE_INTEGER;

function collectNumericRangeViolations(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectNumericRangeViolations(child, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "number" || obj["type"] === "integer") {
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ]) {
      if (key in obj && !isFormatBound(obj[key])) {
        out.push(`${path}.${key} = ${String(obj[key])}`);
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    collectNumericRangeViolations(value, `${path}.${key}`, out);
  }
}

function maxObjectDepth(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((max, child) => Math.max(max, maxObjectDepth(child)), 0);
  }
  if (node === null || typeof node !== "object") return 0;
  const obj = node as Record<string, unknown>;
  const self = obj["type"] === "object" ? 1 : 0;
  let childMax = 0;
  for (const value of Object.values(obj)) {
    childMax = Math.max(childMax, maxObjectDepth(value));
  }
  return self + childMax;
}

describe("AI structured-output constraint walker (R-shared-7)", () => {
  it.each(AI_SCHEMAS.map(([name, schema]) => [name, schema] as const))(
    "%s: converts to JSON Schema, no recursion, no numeric ranges, depth ≤ 3",
    (_name, schema) => {
      // Conversion itself throws on unrepresentable constructs.
      const jsonSchema = z.toJSONSchema(schema);
      const serialized = JSON.stringify(jsonSchema);

      // No recursion: cycles surface as $ref/$defs (z.lazy) — none allowed.
      expect(serialized).not.toContain('"$ref"');
      expect(serialized).not.toContain('"$defs"');

      // Structured output requires an object root.
      expect((jsonSchema as Record<string, unknown>)["type"]).toBe("object");

      // No numeric range constraints (§3.7 rule 2).
      const violations: string[] = [];
      collectNumericRangeViolations(jsonSchema, "$", violations);
      expect(violations).toEqual([]);

      // Flat-ish nesting: ≤ 3 object levels (arrays of flat objects allowed).
      expect(maxObjectDepth(jsonSchema)).toBeLessThanOrEqual(3);
    },
  );

  it.each(AI_MODULES.map(([name, mod]) => [name, mod] as const))(
    "%s exports an integer SCHEMA_VERSION (R-shared-8)",
    (_name, mod) => {
      expect(Number.isSafeInteger(mod["SCHEMA_VERSION"])).toBe(true);
      expect(mod["SCHEMA_VERSION"] as number).toBeGreaterThanOrEqual(1);
    },
  );

  it("the walker itself catches violations (self-test)", () => {
    const bad = z.toJSONSchema(z.object({ n: z.number().min(3) }));
    const violations: string[] = [];
    collectNumericRangeViolations(bad, "$", violations);
    expect(violations).toHaveLength(1);

    const deep = z.toJSONSchema(
      z.object({ a: z.object({ b: z.object({ c: z.object({ d: z.string() }) }) }) }),
    );
    expect(maxObjectDepth(deep)).toBe(4);
  });
});
