import { describe, expect, it } from "vitest";
import {
  AI_FEATURE_CONFIG,
  BATCH_DISCOUNT_PERCENT,
  CAPTURES_PER_DAY,
  MODEL_PRICING,
  TOUR_GUIDE_MAX_PLACES_PER_TRIP,
} from "./ai-pricing.js";
import { AI_FEATURES } from "../enums.js";

describe("AI pricing config (ai spec §3.2)", () => {
  it("covers every ai_feature", () => {
    for (const feature of AI_FEATURES) {
      expect(AI_FEATURE_CONFIG[feature]).toBeDefined();
    }
  });

  it("prices are integer cents per MTok at standard (non-intro) rates", () => {
    expect(MODEL_PRICING["claude-haiku-4-5"]).toEqual({
      input_cents_per_mtok: 100,
      output_cents_per_mtok: 500,
    });
    expect(MODEL_PRICING["claude-sonnet-5"]).toEqual({
      input_cents_per_mtok: 300,
      output_cents_per_mtok: 1500,
    });
    for (const pricing of Object.values(MODEL_PRICING)) {
      expect(Number.isSafeInteger(pricing.input_cents_per_mtok)).toBe(true);
      expect(Number.isSafeInteger(pricing.output_cents_per_mtok)).toBe(true);
    }
  });

  it("feature→model/mode/ceiling table matches the spec", () => {
    expect(AI_FEATURE_CONFIG.recommendations).toMatchObject({
      model: "claude-sonnet-5",
      mode: "live",
      daily_ceiling: 10,
      cache_ttl_days: 14,
    });
    expect(AI_FEATURE_CONFIG.expense_estimate).toMatchObject({
      model: "claude-haiku-4-5",
      mode: "live",
      daily_ceiling: 10,
      cache_ttl_days: 14,
    });
    expect(AI_FEATURE_CONFIG.tour_guide).toMatchObject({
      model: "claude-haiku-4-5",
      mode: "batch",
      counts_against_daily_cap: false,
    });
    expect(AI_FEATURE_CONFIG.packing_list).toMatchObject({
      model: "claude-haiku-4-5",
      mode: "live",
      daily_ceiling: 5,
      cache_ttl_days: null, // live/uncached (Gate 2, H2)
    });
    expect(AI_FEATURE_CONFIG.recap).toMatchObject({ model: "claude-sonnet-5", mode: "batch" });
    expect(AI_FEATURE_CONFIG.capture_parse).toMatchObject({
      counts_against_daily_cap: false, // cap-exempt (Gate 2)
      mode: "live",
    });
  });

  it("structural ceilings", () => {
    expect(CAPTURES_PER_DAY).toBe(20);
    expect(TOUR_GUIDE_MAX_PLACES_PER_TRIP).toBe(50);
    expect(BATCH_DISCOUNT_PERCENT).toBe(50);
  });
});
