/**
 * AI cache-key derivation — single shared implementation (schema spec
 * R-db-10; ai spec §3.6.1/§3.6.2; contracts spec §3.7 rule 3).
 *
 * `cache_key = sha256(feature ∥ destination ∥ travel_style ∥ season ∥
 * schema_version)` — user-anonymous BY CONSTRUCTION: no user or trip id is
 * accepted, so cached responses are shareable across users. English-only v1:
 * `locale` deliberately not a key input (Gate 2).
 */
import type { AiFeature, TravelStyle } from "../enums.js";
import type { ISODate } from "../scalars.js";
import { canonicalizeTravelStyles } from "../domains/user.js";
import { sha256Hex } from "./sha256.js";

export const SEASONS = ["winter", "spring", "summer", "autumn", "unknown"] as const;
export type Season = (typeof SEASONS)[number];

/**
 * Non-whitespace control characters (`\p{Cc}` minus `\s`): whitespace
 * controls (tab/newline/…) collapse to a single space in
 * `canonicalizeDestination`; the rest — including the U+001F cache-key
 * separator — are stripped outright.
 */
const NON_WHITESPACE_CONTROL_REGEX = /(?!\s)\p{Cc}/gu;

/**
 * Destination segment pinning (ai spec §3.6.1): lowercased, trimmed,
 * internal whitespace collapsed, remaining control characters stripped —
 * display-string keyed, and no control char can survive into the preimage
 * (the separator-safety invariant `deriveAiCacheKey` relies on).
 */
export function canonicalizeDestination(destination_name: string): string {
  return destination_name
    .replace(NON_WHITESPACE_CONTROL_REGEX, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const NORTHERN_SEASONS: Record<number, Season> = {
  12: "winter",
  1: "winter",
  2: "winter",
  3: "spring",
  4: "spring",
  5: "spring",
  6: "summer",
  7: "summer",
  8: "summer",
  9: "autumn",
  10: "autumn",
  11: "autumn",
};

const HEMISPHERE_FLIP: Record<Season, Season> = {
  winter: "summer",
  spring: "autumn",
  summer: "winter",
  autumn: "spring",
  unknown: "unknown",
};

/**
 * Deterministic season derivation (ai spec §3.6.2): meteorological season of
 * the trip midpoint month, hemisphere-flipped when `destination_lat < 0`;
 * `'unknown'` when dates are absent; null lat → northern assumed.
 */
export function deriveSeason(
  destination_lat: number | null | undefined,
  start_date: ISODate | null | undefined,
  end_date: ISODate | null | undefined,
): Season {
  if (!start_date || !end_date) return "unknown";
  const startMs = Date.parse(`${start_date}T00:00:00Z`);
  const endMs = Date.parse(`${end_date}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "unknown";
  const midpoint = new Date(Math.floor((startMs + endMs) / 2));
  const month = midpoint.getUTCMonth() + 1;
  const northern = NORTHERN_SEASONS[month] as Season;
  const southern = destination_lat != null && destination_lat < 0;
  return southern ? HEMISPHERE_FLIP[northern] : northern;
}

export interface AiCacheKeyInput {
  feature: AiFeature;
  /** Raw `trips.destination_name` — canonicalized internally. */
  destination: string;
  /** The caller's `UserPrefs.travel_style` — canonicalized internally (sorted-unique `+`-joined; empty → 'any'). */
  travelStyle: readonly TravelStyle[] | undefined;
  season: Season;
  /** The feature module's `SCHEMA_VERSION` (R-shared-8) — stale shapes never parse against new schemas. */
  schemaVersion: number;
}

/**
 * Segment separator: US (unit separator) — cannot appear in any segment:
 * `canonicalizeDestination` strips control characters, and every other
 * segment (feature, canonicalized travel styles, season, schema version)
 * draws from a fixed control-char-free vocabulary.
 */
const SEPARATOR = "\u001f";

export function deriveAiCacheKey(input: AiCacheKeyInput): string {
  const preimage = [
    input.feature,
    canonicalizeDestination(input.destination),
    canonicalizeTravelStyles(input.travelStyle),
    input.season,
    String(input.schemaVersion),
  ].join(SEPARATOR);
  return sha256Hex(preimage);
}
