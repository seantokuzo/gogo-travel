/**
 * Paired server-side refiners (contracts spec §3.7 rule 2) — behavior tests.
 */
import { describe, expect, it } from "vitest";
import { AiRefinementError } from "./refinement.js";
import { refineRecommendations, RecommendationsOutputSchema } from "./recommendations.js";
import { ExpenseEstimateOutputSchema, refineExpenseEstimate } from "./expense-estimate.js";
import { refineTourGuideBundle, TourGuideBundleSchema } from "./tour-guide.js";
import { PackingListOutputSchema, refinePackingList } from "./packing-list.js";
import { RecapSchema, refineRecap } from "./recap.js";
import { CaptureExtractionSchema, refineCaptureExtraction } from "./capture-extract.js";

const A = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";
const B = "7a1e2c43-8f5b-4c6d-8e7f-1a2b3c4d5e6f";
const C = "8b2f3d54-9c6a-4d7e-9f8a-2b3c4d5e6f7a";

describe("refineRecommendations — grounding (invented venues unrepresentable end-to-end)", () => {
  const output = RecommendationsOutputSchema.parse({
    items: [
      { place_id: A, category: "activity", pitch: "Iconic gates", fit_reasons: ["culture"] },
      { place_id: B, category: "restaurant", pitch: "Invented bistro", fit_reasons: [] },
      { place_id: A, category: "activity", pitch: "Duplicate", fit_reasons: [] },
    ],
  });

  it("drops items whose place_id is not in the candidate set, and duplicates", () => {
    const refined = refineRecommendations(output, new Set([A]));
    expect(refined.items).toHaveLength(1);
    expect(refined.items[0]?.place_id).toBe(A);
  });

  it("keeps ranked order for surviving items", () => {
    const refined = refineRecommendations(output, new Set([A, B]));
    expect(refined.items.map((i) => i.place_id)).toEqual([A, B]);
  });
});

describe("refineExpenseEstimate — numeric/cross-field rules (money spec)", () => {
  it("passes a valid estimate through unchanged", () => {
    const output = ExpenseEstimateOutputSchema.parse({
      estimates: [
        { category: "food", basis: "per_person_per_day", low_cents: 3000, high_cents: 8000 },
        { category: "lodging", basis: "per_person_per_night", low_cents: 9000, high_cents: 25000 },
      ],
    });
    expect(refineExpenseEstimate(output)).toEqual(output);
  });

  it("rejects low > high", () => {
    const output = ExpenseEstimateOutputSchema.parse({
      estimates: [
        { category: "food", basis: "per_person_per_day", low_cents: 900, high_cents: 100 },
      ],
    });
    expect(() => refineExpenseEstimate(output)).toThrow(AiRefinementError);
  });

  it("rejects negative cents (the schema deliberately can't — §3.7 rule 2)", () => {
    const output = ExpenseEstimateOutputSchema.parse({
      estimates: [
        { category: "food", basis: "per_person_total", low_cents: -100, high_cents: 100 },
      ],
    });
    expect(() => refineExpenseEstimate(output)).toThrow(AiRefinementError);
  });

  it("rejects duplicate categories", () => {
    const output = ExpenseEstimateOutputSchema.parse({
      estimates: [
        { category: "food", basis: "per_person_per_day", low_cents: 1, high_cents: 2 },
        { category: "food", basis: "per_person_per_day", low_cents: 3, high_cents: 4 },
      ],
    });
    expect(() => refineExpenseEstimate(output)).toThrow(/duplicate/);
  });

  it("unknown categories are unrepresentable at the schema layer", () => {
    expect(
      ExpenseEstimateOutputSchema.safeParse({
        estimates: [
          { category: "souvenirs", basis: "per_person_per_day", low_cents: 1, high_cents: 2 },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("refineTourGuideBundle — cite-or-retract", () => {
  const bundle = TourGuideBundleSchema.parse({
    place_name: "Fushimi Inari Taisha",
    summary: "Thousands of vermilion torii gates.",
    sections: [{ title: "History", body: "Founded in 711..." }],
    facts: [
      { text: "Founded in 711", source_ref: "wiki:Q1194296" },
      { text: "Invented factoid", source_ref: "wiki:nonexistent" },
    ],
    sources: [{ id: "wiki:Q1194296", kind: "wikipedia", ref: "Fushimi Inari-taisha" }],
  });

  it("drops facts whose source_ref does not resolve into sources[]", () => {
    const refined = refineTourGuideBundle(bundle);
    expect(refined.facts).toEqual([{ text: "Founded in 711", source_ref: "wiki:Q1194296" }]);
    // round-trip invariant: every surviving fact resolves
    const ids = new Set(refined.sources.map((s) => s.id));
    expect(refined.facts.every((f) => ids.has(f.source_ref))).toBe(true);
  });

  it("throws on a bundle with no identity", () => {
    expect(() => refineTourGuideBundle({ ...bundle, place_name: "  " })).toThrow(AiRefinementError);
  });
});

describe("refinePackingList", () => {
  it("drops blank labels, non-positive qty, and case-insensitive duplicates", () => {
    const output = PackingListOutputSchema.parse({
      items: [
        { label: "  Passport ", qty: 1 },
        { label: "passport" },
        { label: "   " },
        { label: "Socks", qty: 0 },
        { label: "Adapter", qty: 2, category: "electronics" },
      ],
    });
    const refined = refinePackingList(output);
    expect(refined.items).toEqual([
      { label: "Passport", qty: 1 },
      { label: "Socks" },
      { label: "Adapter", qty: 2, category: "electronics" },
    ]);
  });

  it("output shape has no id/checked (server adds ids; checked starts false)", () => {
    const parsed = PackingListOutputSchema.parse({
      items: [{ label: "Hat", id: "x", checked: true }],
    });
    expect(parsed.items[0]).toEqual({ label: "Hat" });
  });
});

describe("refineRecap — server-computed stats sanity", () => {
  const recap = RecapSchema.parse({
    narrative_sections: [{ title: "Day one", body: "We landed..." }],
    stats: {
      days: 10,
      places_count: 14,
      distance_meters: 182_000,
      spend_total_cents: 412_350,
      currency: "USD",
      photos_count: 96,
    },
    highlight_photo_ids: [A, B],
    trace: [{ place_id: C, lat: 35.68, lng: 139.77, day: "2026-09-02" }],
  });

  it("passes a valid recap", () => {
    expect(refineRecap(recap)).toEqual(recap);
  });
  it("rejects negative stats (Law #2: spend is integer cents ≥ 0)", () => {
    expect(() =>
      refineRecap({ ...recap, stats: { ...recap.stats, spend_total_cents: -1 } }),
    ).toThrow(AiRefinementError);
  });
  it("rejects out-of-range trace coordinates", () => {
    expect(() =>
      refineRecap({
        ...recap,
        trace: [{ place_id: C, lat: 91, lng: 0, day: "2026-09-02" }],
      }),
    ).toThrow(AiRefinementError);
  });
  it("float spend totals are unrepresentable at the schema layer", () => {
    expect(
      RecapSchema.safeParse({
        ...recap,
        stats: { ...recap.stats, spend_total_cents: 100.5 },
      }).success,
    ).toBe(false);
  });
});

describe("refineCaptureExtraction — LLM fallback (capture spec stage 2)", () => {
  const valid = CaptureExtractionSchema.parse({
    category: "lodging",
    title: "Park Hyatt Tokyo",
    details: { category: "lodging", property_name: "Park Hyatt Tokyo", guests: 2 },
    price_cents: 90000,
    currency: "JPY",
    confirmation_code: "HT-123",
    confidence: "high",
  });

  it("passes a coherent extraction", () => {
    expect(refineCaptureExtraction(valid)).toEqual(valid);
  });

  it("rejects category/details mismatch (cross-field — refiner, not schema)", () => {
    const mismatched = CaptureExtractionSchema.parse({
      ...valid,
      details: { category: "flight", flight_number: "UA 837" },
    });
    expect(() => refineCaptureExtraction(mismatched)).toThrow(AiRefinementError);
  });

  it("rejects negative prices (schema can't carry the range — §3.7 rule 2)", () => {
    const negative = CaptureExtractionSchema.parse({ ...valid, price_cents: -5 });
    expect(() => refineCaptureExtraction(negative)).toThrow(/price_cents/);
  });

  it("permission to not know: a bare category + confidence parses", () => {
    expect(
      CaptureExtractionSchema.parse({
        category: "other",
        details: { category: "other" },
        confidence: "low",
      }).confidence,
    ).toBe("low");
  });

  describe("external_url sanitization (attacker-controlled email/share input)", () => {
    const withUrl = (external_url: string) =>
      CaptureExtractionSchema.parse({
        category: "activity",
        details: { category: "activity", venue_name: "Ghibli Museum", external_url },
        confidence: "medium",
      });

    it("drops javascript:/file:/custom-scheme URLs (sanitize, not throw)", () => {
      for (const url of [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "myapp://phish/settle-up",
        "intent://evil#Intent;end",
      ]) {
        const refined = refineCaptureExtraction(withUrl(url));
        expect(refined.details).not.toHaveProperty("external_url");
        // the rest of the details survive the drop
        expect(refined.details).toMatchObject({
          category: "activity",
          venue_name: "Ghibli Museum",
        });
      }
    });

    it("keeps http(s) URLs", () => {
      const https = withUrl("https://tickets.example.com/order/123");
      expect(refineCaptureExtraction(https)).toEqual(https);
      const http = withUrl("http://legacy.example.com/x");
      expect(refineCaptureExtraction(http).details).toMatchObject({
        external_url: "http://legacy.example.com/x",
      });
    });

    it("drops garbage that does not parse as a URL", () => {
      for (const url of ["not a url", "https://", "%%%", "  "]) {
        expect(refineCaptureExtraction(withUrl(url)).details).not.toHaveProperty("external_url");
      }
    });
  });
});
