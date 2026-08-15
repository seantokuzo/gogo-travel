/**
 * Places domain — the open-data spine (contracts spec §3.4; schema spec
 * §3.3.7/§3.3.8; places spec §3.2). Deliberately minimal: rich/volatile
 * details (hours, ratings, photos) are fetch-fresh and never persisted
 * (licensing).
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
import {
  COARSE_CATEGORY_RULES,
  PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES,
  PLACES_SEARCH_TEXT_ONLY_MIN_CHARS,
} from "../config/places.js";
import {
  CoarseCategorySchema,
  PlaceSourceSchema,
  type CoarseCategory,
  type PlaceSource,
} from "../enums.js";
import { ISODateTimeSchema, LatSchema, LngSchema, UuidSchema } from "../scalars.js";

export const PlaceSchema = z
  .object({
    /** Our stable id — everything references this, never `source_id`. */
    id: UuidSchema,
    source: PlaceSourceSchema,
    /** Upstream id (Overture GERS / FSQ). NULL iff `source = 'custom'` (R-db-6). */
    source_id: z.string().nullable(),
    name: z.string(),
    lat: LatSchema,
    lng: LngSchema,
    /** Source taxonomy string, normalized where cheap. */
    category: z.string().nullable(),
    /** DERIVED from `category` via `coarseCategory` (§3.2.3) — not a DB column. */
    coarse_category: CoarseCategorySchema,
    /** Wikidata QID preferred (`Q…`); Wikipedia title accepted. Grounds the tour guide. */
    wiki_ref: z.string().nullable(),
    /** Set iff `source = 'custom'` (authz for edits to user-created places). */
    created_by: UuidSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .superRefine((val, ctx) => {
    // Mirrors the DB check: (source = 'custom') = (source_id IS NULL)
    if ((val.source === "custom") !== (val.source_id === null)) {
      ctx.addIssue({
        code: "custom",
        message: "source_id must be null exactly when source is 'custom'",
        path: ["source_id"],
      });
    }
  });
export type Place = z.infer<typeof PlaceSchema>;

/**
 * Saved-place note cap — the notes-like-prose bound (2000, the itinerary
 * `ItemNotesSchema` / booking `optionalNotes` convention). Applied on BOTH
 * the write shapes and the read schema (caps cover every schema class —
 * T-7.1 landmine): the server only ever persists what the write cap admitted,
 * so the read bound can never reject a legitimate row.
 */
const SavedPlaceNoteSchema = z.string().max(2000);

export const SavedPlaceSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  place_id: UuidSchema,
  note: SavedPlaceNoteSchema.nullable(),
  /** Attribution in collab trips; nullable so member removal doesn't lose the pin. */
  created_by: UuidSchema.nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type SavedPlace = z.infer<typeof SavedPlaceSchema>;

/**
 * List/read/write saved-place responses embed the place row (`SavedPlace &
 * { place: Place }`, spec §3.2) — one round trip renders the map pins + list.
 */
export const SavedPlaceWithPlaceSchema = SavedPlaceSchema.extend({
  place: PlaceSchema,
});
export type SavedPlaceWithPlace = z.infer<typeof SavedPlaceWithPlaceSchema>;

// ---------------------------------------------------------------------------
// Coarse categories (§3.2.3) — pure mapping over the shared config tables
// ---------------------------------------------------------------------------

/**
 * Category-string tokenizer — THE matching model both sides of the wire use
 * (the server's SQL `coarse_category` filter mirrors it expression-for-
 * expression from the same rule table): lowercase, then every non-[a-z0-9]
 * run is a separator. Whole-token equality only — never substring — so
 * "Barbershop" is not a bar.
 */
export function coarseCategoryTokens(category: string): string[] {
  return category.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * `coarse_category` derivation (§3.2.3): first `COARSE_CATEGORY_RULES` entry
 * whose keyword equals a token of `category` wins; no category / no match ⇒
 * `'other'`. Pure and total — never throws. `source` is part of the spec'd
 * signature (per-source tables are a config evolution); v1's table is
 * source-agnostic, so it is deliberately unused.
 */
export function coarseCategory(_source: PlaceSource, category: string | null): CoarseCategory {
  if (!category) return "other";
  const tokens = new Set(coarseCategoryTokens(category));
  if (tokens.size === 0) return "other";
  for (const [keyword, coarse] of COARSE_CATEGORY_RULES) {
    if (tokens.has(keyword)) return coarse;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Custom-place write shapes (§3.2, R-places-9/10)
// ---------------------------------------------------------------------------

/**
 * Free-text caps — DoS headroom, the T-6.1 convention (`trip.ts` caps):
 * generous for any real place name/category, bounded so no client-writable
 * string is unbounded. Spine ingest has its own (wider, dataset-junk) caps in
 * the server's normalize step; these are the USER-write caps.
 */
const PlaceNameSchema = z.string().trim().min(1).max(200);
const PlaceCategorySchema = z.string().trim().min(1).max(200);

/**
 * `POST /places` (places spec §3.3): the server sets `source = 'custom'`,
 * `source_id = NULL`, `created_by = caller` (R-places-9).
 */
export const PlaceCreateSchema = z.object({
  name: PlaceNameSchema,
  lat: LatSchema,
  lng: LngSchema,
  category: PlaceCategorySchema.optional(),
});
export type PlaceCreate = z.infer<typeof PlaceCreateSchema>;

/**
 * `PATCH /places/:placeId` (places spec §3.3): partial `PlaceCreate` —
 * creator-only server-side (R-places-10). `category: null` clears it.
 */
export const PlaceUpdateSchema = z.object({
  name: PlaceNameSchema.optional(),
  lat: LatSchema.optional(),
  lng: LngSchema.optional(),
  category: PlaceCategorySchema.nullable().optional(),
});
export type PlaceUpdate = z.infer<typeof PlaceUpdateSchema>;

// ---------------------------------------------------------------------------
// Search shapes (§3.3 GET /places/search, R-places-6..8)
// ---------------------------------------------------------------------------

/**
 * Search text: ≥ 2 chars (spec), capped, NFC-normalized so a decomposed
 * "Belém" scores against the NFC-stored spine names (ingest normalizes to
 * NFC) instead of silently under-matching.
 */
const SearchTextSchema = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .transform((val) => val.normalize("NFC"));

/** Search radius bound (spec: max 50,000 m). The default (2,000 m) is a server config constant. */
export const PLACES_SEARCH_RADIUS_M_MAX = 50_000;

const finiteCsvParts = (val: string, expected: number): number[] | null => {
  const parts = val.split(",");
  if (parts.length !== expected) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (part.trim() === "") return null; // Number("") === 0 — reject explicitly
    const num = Number(part);
    if (!Number.isFinite(num)) return null;
    nums.push(num);
  }
  return nums;
};

/** CLAMP an axis to the max search span, centered — never rejects (the
 * bounded window keeps a world-zoom "search this area" from licensing a
 * full-table scan; see PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES). A clamped
 * center stays in range: span > max ⇒ |center| ≤ axis_bound − span/2. */
const clampSpan = (min: number, max: number): [number, number] => {
  if (max - min <= PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES) return [min, max];
  const center = (min + max) / 2;
  const half = PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES / 2;
  return [center - half, center + half];
};

/**
 * `bbox=minLng,minLat,maxLng,maxLat` (spec §3.3 — Mapbox bounds order on the
 * wire; parsed into named fields so nobody downstream re-derives the order).
 * Inverted boxes are malformed — v1 has no antimeridian-crossing viewport
 * (map spec renders within [-180, 180]); a wrap-around search is two calls.
 * Oversized boxes CLAMP per axis to PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES
 * around the box center (degrade-not-reject: results follow where the user
 * is looking, and the scan stays index-bounded).
 */
const BboxQuerySchema = z
  .string()
  .max(120)
  .transform((val, ctx) => {
    const reject = (message: string) => {
      ctx.issues.push({ code: "custom", message, input: val });
      return z.NEVER;
    };
    const nums = finiteCsvParts(val, 4);
    if (!nums) return reject("bbox must be minLng,minLat,maxLng,maxLat");
    const [minLng, minLat, maxLng, maxLat] = nums as [number, number, number, number];
    if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180) {
      return reject("bbox out of range");
    }
    if (minLat > maxLat || minLng > maxLng) return reject("bbox min must not exceed max");
    const [clampedMinLat, clampedMaxLat] = clampSpan(minLat, maxLat);
    const [clampedMinLng, clampedMaxLng] = clampSpan(minLng, maxLng);
    return {
      min_lng: clampedMinLng,
      min_lat: clampedMinLat,
      max_lng: clampedMaxLng,
      max_lat: clampedMaxLat,
    };
  });

/** `near=lat,lng` (spec §3.3). */
const NearQuerySchema = z
  .string()
  .max(60)
  .transform((val, ctx) => {
    const reject = (message: string) => {
      ctx.issues.push({ code: "custom", message, input: val });
      return z.NEVER;
    };
    const nums = finiteCsvParts(val, 2);
    if (!nums) return reject("near must be lat,lng");
    const [lat, lng] = nums as [number, number];
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return reject("near out of range");
    return { lat, lng };
  });

/**
 * `GET /places/search` query (§3.3). At least one of `q` / `bbox` / `near`
 * is required; `radius_m` only means something with `near` (a silent drop
 * would hide client bugs, so the combination is rejected); `trip_id` widens
 * custom-place visibility to that trip (R-places-8 — membership checked
 * server-side with the indistinguishable-404 posture). `limit` max 50 (spec);
 * the default (20) is a server config constant.
 */
export const PlaceSearchQuerySchema = CursorQuerySchema.extend({
  q: SearchTextSchema.optional(),
  bbox: BboxQuerySchema.optional(),
  near: NearQuerySchema.optional(),
  radius_m: z.coerce.number().int().min(1).max(PLACES_SEARCH_RADIUS_M_MAX).optional(),
  coarse_category: CoarseCategorySchema.optional(),
  trip_id: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).superRefine((val, ctx) => {
  if (val.q === undefined && val.bbox === undefined && val.near === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "at least one of q, bbox, near is required",
    });
  }
  // TEXT-ONLY floor (round-1 perf finding): a 2–3-char q against the trgm
  // GIN alone is an O(10^5–10^6)-candidate scan at spine scale — see
  // PLACES_SEARCH_TEXT_ONLY_MIN_CHARS for the math. With a geo bound the
  // lat/lng window bounds the candidates instead, so map typeahead keeps
  // its 2-char floor.
  if (
    val.q !== undefined &&
    val.q.length < PLACES_SEARCH_TEXT_ONLY_MIN_CHARS &&
    val.bbox === undefined &&
    val.near === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: `text-only search requires q of at least ${PLACES_SEARCH_TEXT_ONLY_MIN_CHARS} characters (add a geo bound for shorter typeahead)`,
      path: ["q"],
    });
  }
  if (val.radius_m !== undefined && val.near === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "radius_m requires near",
      path: ["radius_m"],
    });
  }
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuerySchema>;
/** The pre-parse (client-side / query-string) shape. */
export type PlaceSearchQueryInput = z.input<typeof PlaceSearchQuerySchema>;

// ---------------------------------------------------------------------------
// Place details (§3.3 GET /places/:placeId, R-places-11..14/17 — PL-3)
// ---------------------------------------------------------------------------

/**
 * Why `fresh` was requested but not returned (§3.3 response contract).
 * Append-only tuple (R-shared-2 pattern; wire enum owned by this domain):
 *  - `no_fsq_id` — only `fsq_os`-sourced places carry an FSQ id to query
 *    (§3.4); Overture/custom places can never have premium details.
 *  - `not_entitled` — `resolveEntitlements(user).premium_place_details`
 *    is false (R-places-12; ADR-005 seam).
 *  - `upstream_error` — the FSQ call failed / timed out (R-places-13).
 *  - `disabled` — the fresh feature is off: the global budget guard tripped
 *    (R-places-14) or the deployment has no FSQ integration (all of v1 —
 *    premium details are MVP-deferred, resolved Gate 2).
 */
export const FRESH_UNAVAILABLE_REASONS = [
  "no_fsq_id",
  "not_entitled",
  "upstream_error",
  "disabled",
] as const;
export const FreshUnavailableReasonSchema = z.enum(FRESH_UNAVAILABLE_REASONS);
export type FreshUnavailableReason = z.infer<typeof FreshUnavailableReasonSchema>;

/**
 * Fetch-fresh premium details (§3.2) — NEVER persisted anywhere: no
 * Postgres, no server cache, no logs, no client store (R-places-11 /
 * R-map-9; licensing). DORMANT in v1: premium details are MVP-deferred
 * (Gate 2), so no server code path produces this shape yet — it is the
 * frozen wire contract the post-MVP FSQ integration fills. Field types are
 * deliberately display-shaped and capped (strings, arrays, AND array
 * elements — the T-7.1 caps landmine; FSQ is an untrusted upstream); the
 * field-exact FSQ mapping is pinned when that integration lands (§3.2).
 */
export const FreshPlaceDetailsSchema = z.object({
  fetched_at: ISODateTimeSchema.max(64),
  /** Foursquare-required attribution — present on EVERY fresh block (R-places-17). */
  attribution: z.object({
    text: z.string().max(300),
    logo_required: z.boolean(),
    url: z.string().max(2048),
  }),
  fields: z.object({
    /** Display-ready hours summary. */
    hours: z.string().max(500).optional(),
    open_now: z.boolean().optional(),
    /** FSQ rating scale 0–10. */
    rating: z.number().min(0).max(10).optional(),
    /** FSQ price tier 1–4. */
    price_level: z.int().min(1).max(4).optional(),
    photos: z.array(z.string().max(2048)).max(20).optional(),
    tips: z
      .array(
        z.object({
          text: z.string().max(2000),
          created_at: ISODateTimeSchema.max(64),
        }),
      )
      .max(20)
      .optional(),
    website: z.string().max(2048).optional(),
    phone: z.string().max(50).optional(),
  }),
});
export type FreshPlaceDetails = z.infer<typeof FreshPlaceDetailsSchema>;

/**
 * `GET /places/:placeId` response (§3.3): spine data always; `fresh` present
 * only when requested AND `source='fsq_os'` AND entitled AND the FSQ call
 * succeeded within budget (never in v1 — dormant seam);
 * `fresh_unavailable_reason` present exactly when `fresh` was requested but
 * is absent. Served with `Cache-Control: no-store` whenever `fresh` was
 * requested (R-places-11).
 */
export const PlaceDetailsSchema = z.object({
  place: PlaceSchema,
  fresh: FreshPlaceDetailsSchema.optional(),
  fresh_unavailable_reason: FreshUnavailableReasonSchema.optional(),
});
export type PlaceDetails = z.infer<typeof PlaceDetailsSchema>;

/**
 * `GET /places/:placeId` query (§3.3): `fresh?` boolean, default false —
 * query-string boolean via `stringbool` (the bookings `unscheduled`
 * precedent; unrecognized values are a 400, never silently false).
 */
export const PlaceDetailsQuerySchema = z.object({
  fresh: z.stringbool().optional(),
});
export type PlaceDetailsQuery = z.infer<typeof PlaceDetailsQuerySchema>;
/** The pre-parse (client-side / query-string) shape. */
export type PlaceDetailsQueryInput = z.input<typeof PlaceDetailsQuerySchema>;

// ---------------------------------------------------------------------------
// Saved-place write/query shapes (§3.3, R-places-15/16 — PL-4)
// ---------------------------------------------------------------------------

/**
 * `POST /trips/:tripId/saved-places` (§3.3): the server sets
 * `created_by = caller`; `place_id` must be visible to the caller (Law #3 —
 * an invisible custom place 404s indistinguishably from an absent one).
 */
export const SavedPlaceCreateSchema = z.object({
  place_id: UuidSchema,
  note: SavedPlaceNoteSchema.optional(),
});
export type SavedPlaceCreate = z.infer<typeof SavedPlaceCreateSchema>;

/** `PATCH /trips/:tripId/saved-places/:savedPlaceId` (§3.3): `null` clears the note. */
export const SavedPlaceUpdateSchema = z.object({
  note: SavedPlaceNoteSchema.nullable(),
});
export type SavedPlaceUpdate = z.infer<typeof SavedPlaceUpdateSchema>;

/**
 * `GET /trips/:tripId/saved-places` query (§3.3): default 100 — the map
 * wants the full pin set in one page for typical trips; the bound here IS
 * the cap (trips convention), larger pin sets paginate.
 */
export const SavedPlacesListQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type SavedPlacesListQuery = z.infer<typeof SavedPlacesListQuerySchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (places spec §3.3; contracts spec §3.6)
// ---------------------------------------------------------------------------

const placeIdParams = z.object({ placeId: UuidSchema });
const savedPlacesTripParams = z.object({ tripId: UuidSchema });
const savedPlaceParams = z.object({ tripId: UuidSchema, savedPlaceId: UuidSchema });

/**
 * Machine-readable mirror of the PL-2 routes (T-6.5). All run behind
 * `requireAuth`. Custom-place VISIBILITY is Law-#3-posture authz: a custom
 * place invisible to the caller 404s indistinguishably from an absent one
 * (R-places-8/10); spine places are globally readable but immutable (403).
 * The details + saved-places descriptors land with PL-3/PL-4.
 */
export const placeEndpoints = {
  /**
   * Spine-only search (R-places-6): text (pg_trgm) / geo (bbox|near) /
   * blend; ranked deterministically for cursor stability. Coverage misses
   * degrade + backfill (R-places-7) — never an error. Scale bounds
   * (config/places.ts): text-ONLY searches need `q` ≥
   * PLACES_SEARCH_TEXT_ONLY_MIN_CHARS (2–3-char typeahead requires a geo
   * bound); bbox spans CLAMP to PLACES_SEARCH_BBOX_MAX_SPAN_DEGREES per
   * axis around the box center (degrade, not reject).
   */
  searchPlaces: {
    method: "GET",
    path: "/places/search",
    query: PlaceSearchQuerySchema,
    response: paginatedSchema(PlaceSchema),
  },
  /** Custom place: `source='custom'`, `created_by = caller` (R-places-9). */
  createPlace: {
    method: "POST",
    path: "/places",
    body: PlaceCreateSchema,
    response: PlaceSchema,
  },
  /**
   * Place details (PL-3): spine read + the dormant fetch-fresh seam
   * (R-places-11..14 — premium details MVP-deferred, so v1 answers
   * `?fresh=true` with spine data + `fresh_unavailable_reason`, under
   * `Cache-Control: no-store`). Invisible custom place → the
   * indistinguishable 404 (R-places-8 posture).
   */
  getPlace: {
    method: "GET",
    path: "/places/:placeId",
    params: placeIdParams,
    query: PlaceDetailsQuerySchema,
    response: PlaceDetailsSchema,
  },
  /** Creator-only; spine places reject mutation for everyone (R-places-10). */
  updatePlace: {
    method: "PATCH",
    path: "/places/:placeId",
    params: placeIdParams,
    body: PlaceUpdateSchema,
    response: PlaceSchema,
  },
  /** Creator-only, unreferenced-only — references → 409 CONFLICT (R-places-10). */
  deletePlace: {
    method: "DELETE",
    path: "/places/:placeId",
    params: placeIdParams,
    response: NoContentSchema,
  },
  /**
   * Saved-places CRUD (PL-4, R-places-15/16). All four run behind
   * `requireAuth` + the trip-membership gate: a non-member's 404 is
   * byte-identical to an absent trip's (F-038 posture); reads are any-role,
   * writes are owner/editor (viewer → 403, server-enforced — the R-ib-24
   * pattern).
   */
  listSavedPlaces: {
    method: "GET",
    path: "/trips/:tripId/saved-places",
    params: savedPlacesTripParams,
    query: SavedPlacesListQuerySchema,
    response: paginatedSchema(SavedPlaceWithPlaceSchema),
  },
  /** Save-once semantics: duplicate `(trip, place)` → 409 CONFLICT (R-places-16). */
  createSavedPlace: {
    method: "POST",
    path: "/trips/:tripId/saved-places",
    params: savedPlacesTripParams,
    body: SavedPlaceCreateSchema,
    response: SavedPlaceWithPlaceSchema,
  },
  /** Note edit; `null` clears (R-places-15). */
  updateSavedPlace: {
    method: "PATCH",
    path: "/trips/:tripId/saved-places/:savedPlaceId",
    params: savedPlaceParams,
    body: SavedPlaceUpdateSchema,
    response: SavedPlaceWithPlaceSchema,
  },
  /** Unsave — no tombstone; a re-save afterwards succeeds (R-places-15). */
  deleteSavedPlace: {
    method: "DELETE",
    path: "/trips/:tripId/saved-places/:savedPlaceId",
    params: savedPlaceParams,
    response: NoContentSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
