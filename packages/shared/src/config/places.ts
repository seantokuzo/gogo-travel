/**
 * Places-spine shared config (places spec §3.1.3/§3.1.4/§3.2.4) — the
 * ingestion knobs both sides of the wire must agree on, plus the open-data
 * attribution registry (R-places-17).
 *
 * Threshold changes are CONFIG EDITS here (places spec §3.1.4 step 5:
 * "both config in `@gogo/shared`; thresholds tunable on real regions").
 */
import type { CoarseCategory, PlaceSource } from "../enums.js";

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
// Coarse-category mapping tables (§3.2.3) — T-6.5 / PL-2
// ---------------------------------------------------------------------------

/**
 * The ORDERED source-taxonomy → coarse tables behind
 * `coarseCategory(source, category)` (domains/place.ts) — first matching
 * keyword wins; no match ⇒ `'other'`.
 *
 * Matching model: the raw category string is lowercased and split into
 * alphanumeric TOKENS (every non-`[a-z0-9]` run is a separator), and a rule
 * fires when its keyword equals a whole token. Token equality — never
 * substring — so "Barbershop" is not a bar. This exact model is mirrored in
 * SQL by the server's `coarseCategorySqlExpr` (search's `coarse_category`
 * filter); keywords are single lowercase-ASCII-alphanumeric tokens BY
 * CONSTRUCTION (config test pins it) so the JS and SQL sides cannot diverge
 * on any keyword-relevant input.
 *
 * ONE table serves all three sources in v1: Overture snake_case labels
 * ("tourist_attraction"), FSQ OS " > " hierarchies ("Dining and Drinking >
 * Bakery") and custom free text all reduce to the same tokens. This is
 * heuristic, TUNABLE CONFIG (same posture as the dedup thresholds above) —
 * a miss degrades to `'other'`, never an error. Order is load-bearing where
 * token sets overlap; the blocks below document each precedence decision.
 */
export const COARSE_CATEGORY_RULES: ReadonlyArray<readonly [string, CoarseCategory]> = [
  // Nightlife OUTRANKS drink: a nightclub is not a bar.
  ["nightclub", "nightlife"],
  ["nightlife", "nightlife"],
  ["disco", "nightlife"],
  ["casino", "nightlife"],
  // Drink OUTRANKS the generic food fallbacks: "Dining and Drinking > Bar"
  // must resolve on "bar", not on "dining". "caf" is é-stripped "café" —
  // tokenization drops non-ASCII, so "Café" arrives as that token.
  ["bar", "drink"],
  ["pub", "drink"],
  ["brewery", "drink"],
  ["beer", "drink"],
  ["winery", "drink"],
  ["distillery", "drink"],
  ["cafe", "drink"],
  ["caf", "drink"],
  ["coffee", "drink"],
  ["tea", "drink"],
  // Food — specific venues first, then the FSQ top-level fallbacks.
  ["restaurant", "food"],
  ["bakery", "food"],
  ["pizza", "food"],
  ["pizzeria", "food"],
  ["deli", "food"],
  ["diner", "food"],
  ["bistro", "food"],
  ["food", "food"],
  ["dining", "food"],
  ["eat", "food"],
  // Lodging.
  ["hotel", "lodging"],
  ["hostel", "lodging"],
  ["motel", "lodging"],
  ["resort", "lodging"],
  ["lodging", "lodging"],
  ["accommodation", "lodging"],
  ["campground", "lodging"],
  ["guesthouse", "lodging"],
  // Transport — "travel" catches FSQ "Travel and Transportation".
  ["airport", "transport"],
  ["station", "transport"],
  ["transit", "transport"],
  ["transportation", "transport"],
  ["transport", "transport"],
  ["railway", "transport"],
  ["train", "transport"],
  ["bus", "transport"],
  ["ferry", "transport"],
  ["metro", "transport"],
  ["subway", "transport"],
  ["taxi", "transport"],
  ["parking", "transport"],
  ["travel", "transport"],
  // Attraction tokens that OUTRANK culture and outdoors: an "Arts and
  // Entertainment > Amusement Park" is an attraction, not culture ("arts")
  // and not a park.
  ["amusement", "attraction"],
  ["zoo", "attraction"],
  ["aquarium", "attraction"],
  ["monument", "attraction"],
  ["memorial", "attraction"],
  // Culture — "arts" catches the rest of FSQ "Arts and Entertainment"
  // (museums/theaters dominate that branch).
  ["museum", "culture"],
  ["gallery", "culture"],
  ["theater", "culture"],
  ["theatre", "culture"],
  ["historic", "culture"],
  ["historical", "culture"],
  ["heritage", "culture"],
  ["temple", "culture"],
  ["shrine", "culture"],
  ["church", "culture"],
  ["cathedral", "culture"],
  ["mosque", "culture"],
  ["synagogue", "culture"],
  ["culture", "culture"],
  ["cultural", "culture"],
  ["arts", "culture"],
  ["art", "culture"],
  // Outdoors — SPECIFIC venues only here, before the landmark fallbacks, so
  // "Landmarks and Outdoors > Park" resolves on "park"; the GENERIC
  // outdoor/outdoors tokens sit after those fallbacks, so the bare
  // "Landmarks and Outdoors" top level stays an attraction.
  ["park", "outdoors"],
  ["trail", "outdoors"],
  ["beach", "outdoors"],
  ["garden", "outdoors"],
  ["mountain", "outdoors"],
  ["lake", "outdoors"],
  ["forest", "outdoors"],
  ["hiking", "outdoors"],
  ["playground", "outdoors"],
  // Shopping.
  ["shop", "shopping"],
  ["store", "shopping"],
  ["market", "shopping"],
  ["supermarket", "shopping"],
  ["grocery", "shopping"],
  ["mall", "shopping"],
  ["retail", "shopping"],
  ["boutique", "shopping"],
  ["shopping", "shopping"],
  // Attraction fallbacks — FSQ "Landmarks and Outdoors" top level, Overture
  // "tourist_attraction", and the generic entertainment tail.
  ["landmark", "attraction"],
  ["landmarks", "attraction"],
  ["attraction", "attraction"],
  ["tourist", "attraction"],
  ["sightseeing", "attraction"],
  ["entertainment", "attraction"],
  // Generic outdoor tail — after the landmark fallbacks (see outdoors note).
  ["outdoor", "outdoors"],
  ["outdoors", "outdoors"],
];

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
