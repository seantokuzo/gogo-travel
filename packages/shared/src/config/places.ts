/**
 * Places-spine shared config (places spec §3.1.3/§3.1.4/§3.2.4) — the
 * ingestion knobs both sides of the wire must agree on, plus the open-data
 * attribution registry (R-places-17).
 *
 * Threshold changes are CONFIG EDITS here (places spec §3.1.4 step 5:
 * "both config in `@gogo/shared`; thresholds tunable on real regions").
 */
import type { PlaceSource } from "../enums.js";

// ---------------------------------------------------------------------------
// Region grid (§3.1.3) — consumed by `region-grid.ts` and the map client's
// offline TileRegion bounds (§3.5: one region definition, two consumers).
// ---------------------------------------------------------------------------

/** Grid cell edge in degrees: 0.5° ≈ 55 km (places spec §3.1.3). */
export const PLACES_REGION_GRID_DEGREES = 0.5;

// ---------------------------------------------------------------------------
// Cross-source dedup thresholds (§3.1.4 step 5, R-places-3)
// ---------------------------------------------------------------------------

/** A lower-priority record within this distance of a higher-priority place… */
export const PLACES_DEDUP_DISTANCE_M = 50;
/** …AND at/above this pg_trgm name similarity is a duplicate — skip insert. */
export const PLACES_DEDUP_NAME_SIMILARITY = 0.6;

// ---------------------------------------------------------------------------
// Source priority (R-places-18, resolved Gate 2 2026-07-09)
// ---------------------------------------------------------------------------

/**
 * The v1 spine source set, in deterministic dedup-priority order:
 * `overture > fsq_os`. Ingestion runs sources in THIS order so dedup
 * (R-places-3) always checks candidates against already-present
 * higher-priority rows. `custom` is not a spine source — user-created places
 * never participate in ingestion or dedup.
 */
export const SPINE_SOURCE_PRIORITY = ["overture", "fsq_os"] as const;
export type SpineSource = (typeof SPINE_SOURCE_PRIORITY)[number];

/** Narrowing guard: is this `place_source` one of the ingested spine sources? */
export function isSpineSource(source: PlaceSource): source is SpineSource {
  return (SPINE_SOURCE_PRIORITY as readonly PlaceSource[]).includes(source);
}

/** Sources that outrank `source` (the dedup targets when ingesting it). */
export function spineSourcesAbove(source: SpineSource): readonly SpineSource[] {
  return SPINE_SOURCE_PRIORITY.slice(0, SPINE_SOURCE_PRIORITY.indexOf(source));
}

// ---------------------------------------------------------------------------
// Attribution registry (R-places-17, §3.2.4)
// ---------------------------------------------------------------------------

export interface PlaceAttribution {
  /** Display string client surfaces render verbatim. */
  text: string;
  /** Link target for the attribution (provider policy/notice page). */
  url: string;
  /** Whether the provider's policy requires a logo/wordmark next to the text. */
  logo_required: boolean;
}

/**
 * Per-source attribution registry (§3.2.4). PL-1 ships the two open-data
 * spine entries it ingests; PL-3 widens the key union with `foursquare_api`
 * (+ `mapbox` on the map side) when the details surface lands.
 *
 * Wording verified against provider policy 2026-07-25 (R-places-17: never
 * from training data):
 *  - Overture (docs.overturemaps.org/attribution): text/logo attribution is
 *    NOT required for the places theme (CDLA-Permissive-2.0; no OSM/ODbL
 *    share-alike); the suggested citation is
 *    "Overture Maps Foundation, overturemaps.org". We ship it anyway —
 *    surfaced attribution is the product posture.
 *  - FSQ OS Places (opensource.foursquare.com/places-notice-txt): Apache-2.0;
 *    attribution to Foursquare must be preserved, and the full NOTICE.txt
 *    content must ship with our developer documentation when the data is
 *    redistributed via API — the display string below is the client-surface
 *    half, not a substitute for that notice.
 */
export const ATTRIBUTION: Readonly<Record<SpineSource, PlaceAttribution>> = {
  overture: {
    text: "Overture Maps Foundation, overturemaps.org",
    url: "https://docs.overturemaps.org/attribution/",
    logo_required: false,
  },
  fsq_os: {
    text: "Contains Foursquare Open Source Places data © Foursquare, licensed under Apache 2.0",
    url: "https://opensource.foursquare.com/places-notice-txt/",
    logo_required: false,
  },
};
