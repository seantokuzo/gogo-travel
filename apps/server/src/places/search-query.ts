/**
 * The /places/search query (T-6.5 / PL-2; places spec §3.3, R-places-6/8) —
 * exported UNEXECUTED so the db suite can EXPLAIN the exact production query
 * (plan-shape regression pin, the T-6.4 dedup-probe precedent).
 *
 * SARGABILITY CONTRACT (T-6.4 round-1 blocking finding, generalized):
 * - Text mode drives on the pg_trgm OPERATOR `name % $q` — the ONLY form
 *   `places_name_trgm_idx` (GIN) can serve. `similarity()` in function form
 *   can never use the index (spine-upsert.ts note) and appears here ONLY as
 *   ranking arithmetic over already-matched rows.
 * - Geo mode drives on bare-column `lat`/`lng BETWEEN` range probes against
 *   `places_lat_lng_idx` — columns stay UNCAST (numeric, as indexed); all
 *   casts happen on the parameter side. The exact `near` distance predicate
 *   (equirectangular, the spine-upsert formula) is a RESIDUAL filter over
 *   the box prefilter's survivors.
 * - Everything else (visibility, coarse filter, rank) is residual by design.
 *
 * RANKING (spec: "exact ranking expression is implementation detail;
 * determinism required for cursor stability"): ONE bigint rank key
 *
 *   rank = simMillionths × 10^10 + proximity
 *     simMillionths = round(similarity(name, q) × 10^6)   ∈ [0, 10^6], 0 sans q
 *     proximity     = max(0, 10^9 − round(distance_mm))   ∈ [0, 10^9], 0 sans geo
 *
 * ordered `(rank DESC, id DESC)`. Similarity strictly dominates (any
 * similarity step outranks any proximity delta — blend = "best text match
 * first, nearer wins ties"); geo-only degenerates to nearest-first;
 * proximity zeroes out beyond 1,000 km. The key is a nonnegative ≤ 17-digit
 * integer, so it rides the shared keyset-cursor codec (≤ 18-digit bigint +
 * uuid) and the same strictly-smaller row-value predicate the trips list
 * uses; recomputing the expression on both sides of the comparison keeps
 * pages exact (integer arithmetic — no float round-trip drift).
 */
import { and, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { COARSE_CATEGORY_RULES } from "@gogo/shared/config/places";
import type { CoarseCategory } from "@gogo/shared/enums";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { KeysetCursor } from "../http/keyset-cursor.js";

/** Meters per degree of latitude (spherical mean) — spine-upsert's scale. */
const METERS_PER_DEGREE_LAT = 111_320;

/**
 * SQL twin of the shared `coarseCategory` mapping (§3.2.3): tokenizes the
 * category exactly like `coarseCategoryTokens` (lowercase; every non-[a-z0-9]
 * run is a separator) and takes the FIRST matching rule, via a space-padded
 * token string + ordered CASE. Both sides derive from the SAME ordered
 * `COARSE_CATEGORY_RULES`, and keywords are pinned `/^[a-z0-9]+$/` by the
 * config test — which is also why `sql.raw` is safe here (no user input, no
 * LIKE metacharacters representable) and keeps ~130 rule branches from
 * becoming bind params. The one-row VALUES wrapper computes the token string
 * once instead of once per WHEN.
 */
export function coarseCategorySqlExpr(categoryColumn: AnyPgColumn): SQL<string> {
  const whens = COARSE_CATEGORY_RULES.map(
    ([keyword, coarse]) => `when _t.toks like '% ${keyword} %' then '${coarse}'`,
  ).join(" ");
  return sql<string>`(select case ${sql.raw(whens)} else 'other' end from (values ((' ' || regexp_replace(lower(coalesce(${categoryColumn}, '')), '[^a-z0-9]+', ' ', 'g') || ' '))) as _t(toks))`;
}

export interface SearchBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface PlacesSearchParams {
  /** The authenticated caller — the custom-place visibility subject (R-places-8). */
  userId: string;
  /** NFC-normalized search text (shared schema handles that). */
  q?: string | undefined;
  /** Viewport filter (`bbox` param), already parsed + range-checked. */
  bbox?: SearchBox | undefined;
  /** Proximity filter (`near` + effective radius), already defaulted. */
  near?: { lat: number; lng: number; radiusM: number } | undefined;
  /** Derived coarse-category filter (§3.2.3). */
  coarse?: CoarseCategory | undefined;
  /**
   * Widens custom-place visibility to THIS trip's referenced places
   * (R-places-8). Caller MUST have verified membership first — this module
   * trusts it (the route owns the indistinguishable-404 posture).
   */
  tripId?: string | undefined;
  /** Decoded page cursor (first component = prior page's last rank key). */
  cursor?: KeysetCursor | null | undefined;
  /** Page size + 1 sentinel — the route owns the arithmetic. */
  limit: number;
}

/** The `near` prefilter box: radius → degrees, pole-clamped. In general the
 * box OVER-covers and the exact distance residual trims the corners —
 * EXCEPT above |lat| ≈ 89.43° (where cos(lat) < the 0.01 clamp): there the
 * lng half-width is an UNDER-estimate and the polar sliver beyond it is
 * DELIBERATELY excluded (the alternative is near-full-ring lng spans for a
 * search area that contains nothing). Longitude also never wraps across
 * ±180 — the v1 posture the shared bbox schema pins (no antimeridian
 * viewports); a circle straddling the date line loses its far side. */
export function nearPrefilterBox(lat: number, lng: number, radiusM: number): SearchBox {
  const latHalf = radiusM / METERS_PER_DEGREE_LAT;
  const lngHalf =
    radiusM / (METERS_PER_DEGREE_LAT * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return {
    minLat: Math.max(-90, lat - latHalf),
    maxLat: Math.min(90, lat + latHalf),
    minLng: Math.max(-180, lng - lngHalf),
    maxLng: Math.min(180, lng + lngHalf),
  };
}

export function placesSearchQuery(db: DbClient, params: PlacesSearchParams) {
  const places = schema.places;

  // ---- ranking anchor: the near point, else the bbox center --------------
  const anchor = params.near
    ? { lat: params.near.lat, lng: params.near.lng }
    : params.bbox
      ? {
          lat: (params.bbox.minLat + params.bbox.maxLat) / 2,
          lng: (params.bbox.minLng + params.bbox.maxLng) / 2,
        }
      : null;

  // Equirectangular meters from the anchor (residual/ranking only — the
  // column casts here are fine because no index probe runs through them).
  const distanceM = anchor
    ? sql`(111320.0::float8 * sqrt(power(${places.lat}::float8 - ${anchor.lat}::float8, 2) + power((${places.lng}::float8 - ${anchor.lng}::float8) * cos(radians(${anchor.lat}::float8)), 2)))`
    : null;

  const simTerm =
    params.q !== undefined
      ? sql`(round(similarity(${places.name}, ${params.q})::numeric * 1000000)::bigint * 10000000000::bigint)`
      : sql`0::bigint`;
  // B-7 part 3: a coordinate-less custom place (places.lat/lng NULL) can
  // only reach here with an anchor if the geo BETWEEN predicates below
  // somehow let it through (they don't — NULL BETWEEN is never true, so
  // such a row never survives the WHERE). `greatest` alone (no `coalesce`
  // belt, round-1 review finding) already can't return NULL here: one
  // argument is the literal `0::bigint`, and Postgres's `GREATEST`/`LEAST`
  // skip NULL arguments — they return NULL only when EVERY argument is NULL
  // — so `greatest(0::bigint, NULL::bigint)` is `0`, not `NULL`, even if
  // `distanceM` itself went NULL. The `coalesce(..., 0::bigint)` this
  // replaced was PROVEN dead by that same fact (its wrapped expression can
  // never actually be NULL) — kept as a misleading "belt" that never
  // engages; removed rather than documented as inert.
  const proxTerm = distanceM
    ? sql`greatest(0::bigint, 1000000000::bigint - round(${distanceM} * 1000.0)::bigint)`
    : sql`0::bigint`;
  const rankExpr = sql<string>`(${simTerm} + ${proxTerm})`;

  // ---- predicates ---------------------------------------------------------
  const predicates: SQL[] = [];

  // R-places-8 / Law #3 posture: custom places are visible ONLY to their
  // creator, plus — when the (membership-verified) trip scope is given —
  // to that trip's members via the trip's references (saved / itinerary /
  // booking). Spine rows are global. AND-residual, so it never disturbs the
  // driving index probe.
  predicates.push(
    params.tripId !== undefined
      ? sql`(${places.source} <> 'custom' or ${places.createdBy} = ${params.userId}::uuid or ${places.id} in (
          select sp.place_id from saved_places sp where sp.trip_id = ${params.tripId}::uuid
          union
          select ii.place_id from itinerary_items ii where ii.trip_id = ${params.tripId}::uuid and ii.place_id is not null
          union
          select b.place_id from bookings b where b.trip_id = ${params.tripId}::uuid and b.place_id is not null
        ))`
      : sql`(${places.source} <> 'custom' or ${places.createdBy} = ${params.userId}::uuid)`,
  );

  // Text: the pg_trgm OPERATOR form — the GIN-index-driving predicate
  // (cutoff = pg_trgm.similarity_threshold, PG default 0.3).
  if (params.q !== undefined) {
    predicates.push(sql`${places.name} % ${params.q}`);
  }

  // Geo: bare-column BETWEEN probes (params cast, columns never). B-7 part 3:
  // no predicate change needed here — a coordinate-less custom place
  // (lat/lng NULL) never satisfies `NULL BETWEEN ...`, so it is automatically
  // excluded from bbox/near search and automatically included in text-only
  // search. Pinned in routes.db.test.ts.
  if (params.bbox) {
    predicates.push(
      sql`${places.lat} between ${params.bbox.minLat}::numeric and ${params.bbox.maxLat}::numeric`,
      sql`${places.lng} between ${params.bbox.minLng}::numeric and ${params.bbox.maxLng}::numeric`,
    );
  }
  if (params.near && distanceM) {
    const box = nearPrefilterBox(params.near.lat, params.near.lng, params.near.radiusM);
    predicates.push(
      sql`${places.lat} between ${box.minLat}::numeric and ${box.maxLat}::numeric`,
      sql`${places.lng} between ${box.minLng}::numeric and ${box.maxLng}::numeric`,
      // The exact circle, residual over the box survivors.
      sql`${distanceM} <= ${params.near.radiusM}::float8`,
    );
  }

  // BLEND (q + geo together) is DELIBERATELY NOT plan-pinned (round-1 #11):
  // with both predicate families present the planner must stay free to
  // drive from the trgm GIN, the lat/lng btree, or a BitmapAnd of both as
  // row statistics evolve — pinning today's pick would turn a future
  // planner improvement into a red test. Only the single-mode drivers are
  // EXPLAIN-pinned (routes.db.test.ts).

  if (params.coarse !== undefined) {
    predicates.push(sql`${coarseCategorySqlExpr(places.category)} = ${params.coarse}`);
  }

  // Keyset page: strictly-smaller (rank, id) tuples — the codec pre-validated
  // both components (≤18-digit integer / uuid), so the casts cannot throw.
  if (params.cursor) {
    predicates.push(
      sql`(${rankExpr}, ${places.id}) < (${params.cursor.micros}::bigint, ${params.cursor.id}::uuid)`,
    );
  }

  return db
    .select({ place: places, rankKey: rankExpr })
    .from(places)
    .where(and(...predicates))
    .orderBy(sql`${rankExpr} desc, ${places.id} desc`)
    .limit(params.limit);
}

export interface PlacesExactTierMatchParams {
  /** Trimmed, NFC-normalized query text (SearchTextSchema handles that). */
  q: string;
  /** Derived coarse-category filter (§3.2.3) — review R1 A1/ADVISORY-2:
   * same AND-residual filter `placesSearchQuery` applies, so this arm can't
   * leak a tier row through a mismatched `coarse_category`. */
  coarse?: CoarseCategory | undefined;
  /** Decoded page cursor (first component is the constant rank key below). */
  cursor?: KeysetCursor | null | undefined;
  /** Page size + 1 sentinel — the route owns the arithmetic (text/geo-arm precedent). */
  limit: number;
}

/**
 * B-7 follow-up (Sean's ruling, 2026-09-14; places spec R-places-28):
 * sub-floor (`q.length < PLACES_SEARCH_TEXT_ONLY_MIN_CHARS`, trimmed)
 * TEXT-ONLY destination queries no longer 400 (the floor moved from a
 * validation reject to an arm SELECTION — `@gogo/shared`'s
 * `PlaceSearchQuerySchema`, see that file's comment) — `routes.ts` sends
 * them here instead of `placesSearchQuery`.
 *
 * Deliberately a SEPARATE, narrower query, not `placesSearchQuery` with
 * different params:
 *  - EXACT match only (`tierNameFoldExpr(name) = tierNameFoldExpr(q)`,
 *    case-insensitive / accent-folded / trimmed via the shared schema
 *    helper, `db/schema/places.ts`) — NEVER the `%` trigram operator. That
 *    is the whole point: a 2-3 char `q` against the trgm GIN is the
 *    O(10^5-10^6)-candidate scan `PLACES_SEARCH_TEXT_ONLY_MIN_CHARS`
 *    exists to prevent (config/places.ts); this arm never touches that
 *    index, and a widened `LIKE '<q>%'` prefix match would silently
 *    reopen the same blowup (falsified by the "Fe" 2-char pin,
 *    destination-tier.db.test.ts — a real tier row, "Fez", would leak
 *    into a 2-char prefix query that must return empty).
 *  - Bootstrap destination TIER rows only (`source = 'overture' AND
 *    category = 'locality'`, the migration-0004 seed) — driven by the
 *    partial index `places_tier_name_folded_idx` (EXPLAIN-pinned,
 *    destination-tier.db.test.ts, mirroring the SARGABILITY CONTRACT
 *    pins above).
 *  - `custom`-source places are UNCONDITIONALLY excluded — not even the
 *    caller's own. R-places-8 / Law #3 holds trivially (no visibility
 *    predicate needed at all: the tier-only filter structurally can never
 *    match a `source='custom'` row), and this doubles as the "no POI
 *    scan" contract — a custom place is never read by this query,
 *    regardless of who is asking (falsified by the creator-owned-"Fez"
 *    pin, not just the stranger one).
 *  - No bbox/near — `routes.ts` only reaches this arm when both geo bounds
 *    are absent; a short `q` WITH a geo bound keeps using the existing
 *    geo-bounded arm (`placesSearchQuery`), unaffected. `coarse_category`
 *    IS applied here (review R1 A1/ADVISORY-2 fix — it was silently
 *    dropped before): the same AND-residual `coarseCategorySqlExpr` filter
 *    the trigram/geo arm uses, so `?q=Fez&coarse_category=food` correctly
 *    excludes a locality (Fez's own `coarse_category` is `other`) instead
 *    of leaking it through a mismatched category filter. The driving fold
 *    predicate/index are unaffected — this is a residual AND, same posture
 *    as `placesSearchQuery`'s coarse filter above.
 *  - `rankKey` is a constant `0` — every match is equally "exact," nothing
 *    to rank by — so page order is pure `id DESC`, still stable across
 *    pages via the SAME keyset-cursor codec the text/geo arm uses
 *    (`routes.ts` builds the cursor/envelope identically regardless of
 *    which arm ran the query).
 */
export function placesExactTierMatchQuery(db: DbClient, params: PlacesExactTierMatchParams) {
  const places = schema.places;
  const rankExpr = sql<string>`0::bigint`;

  const predicates: SQL[] = [
    // Literal text, not bound params: matching the partial index's WHERE
    // clause verbatim (byte-for-byte, `db/schema/places.ts`) is what lets
    // Postgres apply it regardless of prepared-statement generic-plan mode
    // (SARGABILITY CONTRACT precedent, this file's header comment).
    sql`${places.source} = 'overture' and ${places.category} = 'locality'`,
    sql`${schema.tierNameFoldExpr(places.name)} = ${schema.tierNameFoldExpr(sql`${params.q}`)}`,
  ];

  if (params.coarse !== undefined) {
    predicates.push(sql`${coarseCategorySqlExpr(places.category)} = ${params.coarse}`);
  }

  if (params.cursor) {
    predicates.push(
      sql`(${rankExpr}, ${places.id}) < (${params.cursor.micros}::bigint, ${params.cursor.id}::uuid)`,
    );
  }

  return db
    .select({ place: places, rankKey: rankExpr })
    .from(places)
    .where(and(...predicates))
    .orderBy(sql`${rankExpr} desc, ${places.id} desc`)
    .limit(params.limit);
}
