/**
 * Feature→model map + per-model token pricing (contracts spec §3.7; ai spec
 * §3.2 — verified 2026-07-09, re-verify via the Models API before changing).
 *
 * The kill-switch job's cost math reads these: `ai_usage` stores TOKENS, not
 * dollars; cost is computed at read time (Law #2 clean, survives price
 * changes). Prices are INTEGERS in cents per million tokens — standard
 * pricing deliberately, not the Sonnet intro rate that expires 2026-08-31.
 */
import type { AiFeature } from "../enums.js";

export const AI_MODEL_IDS = ["claude-haiku-4-5", "claude-sonnet-5"] as const;
export type AiModelId = (typeof AI_MODEL_IDS)[number];

export interface ModelPricing {
  input_cents_per_mtok: number;
  output_cents_per_mtok: number;
}

export const MODEL_PRICING: Readonly<Record<AiModelId, ModelPricing>> = {
  "claude-haiku-4-5": { input_cents_per_mtok: 100, output_cents_per_mtok: 500 },
  "claude-sonnet-5": { input_cents_per_mtok: 300, output_cents_per_mtok: 1500 },
};

/** Batch mode is 50% off; feature→mode is static, so cost math applies this per feature. */
export const BATCH_DISCOUNT_PERCENT = 50;

export type AiMode = "live" | "batch";

export interface AiFeatureConfig {
  model: AiModelId;
  mode: AiMode;
  /** Counts against the user's global daily cap (`ai_calls_per_day`)? */
  counts_against_daily_cap: boolean;
  /** Per-feature daily ceiling (Gate 2); null = cap-exempt (structural caps apply instead). */
  daily_ceiling: number | null;
  /** `ai_cache` TTL in days; null = uncached / not response-cached. */
  cache_ttl_days: number | null;
}

export const AI_FEATURE_CONFIG: Readonly<Record<AiFeature, AiFeatureConfig>> = {
  recommendations: {
    model: "claude-sonnet-5",
    mode: "live",
    counts_against_daily_cap: true,
    daily_ceiling: 10,
    cache_ttl_days: 14,
  },
  expense_estimate: {
    model: "claude-haiku-4-5",
    mode: "live",
    counts_against_daily_cap: true,
    daily_ceiling: 10,
    cache_ttl_days: 14,
  },
  tour_guide: {
    model: "claude-haiku-4-5",
    mode: "batch",
    counts_against_daily_cap: false,
    daily_ceiling: null,
    cache_ttl_days: null,
  },
  packing_list: {
    model: "claude-haiku-4-5",
    mode: "live",
    counts_against_daily_cap: true,
    daily_ceiling: 5,
    /** Live/uncached (Gate 2, H2) — personal + cheap on Haiku. */
    cache_ttl_days: null,
  },
  recap: {
    model: "claude-sonnet-5",
    mode: "batch",
    counts_against_daily_cap: false,
    daily_ceiling: null,
    cache_ttl_days: null,
  },
  capture_parse: {
    model: "claude-haiku-4-5",
    mode: "live",
    /** Cap-exempt from the 30/day user cap — CAPTURES_PER_DAY applies instead (Gate 2). */
    counts_against_daily_cap: false,
    daily_ceiling: null,
    cache_ttl_days: null,
  },
};

/** Structural ceiling: 20 captures/day per user (schema spec §3.2 `ai_feature`, Gate 2). */
export const CAPTURES_PER_DAY = 20;

/** Structural cap: tour-guide bundles per trip (ai spec §3.2). */
export const TOUR_GUIDE_MAX_PLACES_PER_TRIP = 50;
