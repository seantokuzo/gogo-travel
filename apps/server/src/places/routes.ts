/**
 * Places routes (T-6.5 / PL-2; places spec §3.3): `GET /places/search`,
 * `POST /places`, `PATCH|DELETE /places/:placeId`. Covers R-places-6..10.
 * The details endpoint (GET /places/:placeId) is PL-3's; saved-places CRUD
 * is PL-4's — deliberately not here.
 *
 * AUTHZ POSTURE: runs behind the app-wide `requireAuth` (R-authz-1).
 * Custom-place visibility is Law-#3-posture authz (R-places-8): a custom
 * place is visible ONLY to its creator, plus — under an explicit,
 * membership-verified `trip_id` search scope — to that trip's members via
 * the trip's references. Visibility NEVER crosses the trip boundary. An
 * INVISIBLE custom place 404s byte-identically to an absent id (the F-038
 * harness proves it); a VISIBLE-but-not-yours one 403s (per R-places-10 —
 * visibility already proved existence, so FORBIDDEN leaks nothing); spine
 * rows are globally visible and immutable for everyone (403). `:placeId`
 * gets the in-handler UUID pre-check folding malformed ids into the same
 * 404 (server rule — a param zValidator 400 would be a distinguishable
 * door), and a non-member `trip_id` answers the same canonical 404.
 *
 * SEARCH is a pure READ (no locks, R-places-6: our spine only); its
 * coverage-miss enqueue (R-places-7) is post-query, best-effort, and can
 * never fail the request. Custom-place writes are single-row and create no
 * membership-adjacent rows — no lock-order/liveness-door obligations (STATE
 * P-6 landmines) — but the enqueue-volume bounds (T-6.4 round-1 defer) DO
 * land here: per-user rate limit on the search surface + per-search cell
 * cap, layered over the queue's per-cell throttle + global budget.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Paginated } from "@gogo/shared/api/envelope";
import { PLACES_SEARCH_TEXT_ONLY_MIN_CHARS } from "@gogo/shared/config/places";
import { placeEndpoints, type Place, type PlaceDetails } from "@gogo/shared/domains/place";
import { regionCellsForBbox } from "@gogo/shared/region-grid";
import {
  PLACES_SEARCH_MISS_MAX_CELLS,
  PLACES_SEARCH_PAGE_SIZE_DEFAULT,
  PLACES_SEARCH_RADIUS_M_DEFAULT,
  RATE_LIMITS,
} from "../config.js";
import { rethrowCoordsCkMapped } from "../db/coords-ck.js";
import type { DbClient } from "../db/create-user.js";
import { isFkViolationCode } from "../db/pg-errors.js";
import * as schema from "../db/schema/index.js";
import { apiError, HttpError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { decodeKeysetCursor, encodeKeysetCursor } from "../http/keyset-cursor.js";
import { rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { PlacesIngestTrigger } from "./ingest-queue.js";
import { intersectBoxes, staleSearchCells } from "./search-coverage.js";
import {
  nearPrefilterBox,
  placesExactTierMatchQuery,
  placesSearchQuery,
  type SearchBox,
} from "./search-query.js";
import { toPlaceWire, type PlaceRow } from "./serialize.js";
import { resolvePlaceAccess } from "./visibility.js";

export interface PlacesRouterDeps {
  db: DbClient;
  /** Clock seam for tests (region freshness in the coverage check). */
  now?: () => Date;
  /**
   * The `GET /places/search` per-user limiter (RATE_LIMITS.placesSearch —
   * T-6.5 enqueue-volume posture). Absent = no limiter (unit/integration
   * tests); prod wiring (`wire.ts`) always supplies it. `now` is
   * MILLISECONDS (the store's clock).
   */
  rateLimit?: {
    store: RateLimitStore;
    now?: () => number;
  };
  /**
   * Search-miss ingest seam (T-6.4, R-places-7): fired post-response with
   * the area's stale cells — best-effort, throttled + budget-bounded inside
   * the queue. Optional: absent (tests/dev without the pipeline) skips the
   * trigger; search NEVER fails because of it.
   */
  placesIngest?: PlacesIngestTrigger;
  /**
   * TEST settle seam (round-1 #9): receives each search's background
   * coverage task — already error-swallowed, resolved when the coverage
   * probe + enqueue have finished. Tests await the collected promises so
   * positive AND negative enqueue assertions are deterministic. Prod
   * wiring leaves it unset: fire-and-forget stays fire-and-forget.
   */
  trackCoverageTask?: (task: Promise<void>) => void;
}

/** FK constraints that RESTRICT custom-place deletion → the §3.3 409 reason
 * (R-places-10 names saved places / itinerary items / bundles). `bookings`
 * and `photos` reference places with SET NULL and can never fire. */
const DELETE_RESTRICT_TABLES = new Set(["saved_places", "itinerary_items", "tour_guide_bundles"]);

/**
 * Postgres FK violation (23503, or 23001 — PG 18's RESTRICT reclassification,
 * see `db/pg-errors.ts` [B-24]), possibly wrapped — walk `cause` (the sign-in
 * 23505 walker's shape). Returns the referencing table.
 *
 * 🔴 DRIVER TRAP (round-1 blocking #1, the Neon-parity family): postgres-js
 * — the TEST driver — exposes the wire field as `table_name`; pg-protocol's
 * `DatabaseError` — what the PROD Neon serverless driver throws — exposes
 * `table`. Reading only one shape means prod answers `by: "unknown"`
 * forever while every test stays green. Accept BOTH; exported so the unit
 * test can pin the prod shape no container ever produces.
 */
export function fkViolationTable(error: unknown): string | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as { code?: unknown; table_name?: unknown; table?: unknown };
    if (isFkViolationCode(candidate.code)) {
      if (typeof candidate.table_name === "string") return candidate.table_name;
      if (typeof candidate.table === "string") return candidate.table;
      return "unknown";
    }
    current = current.cause;
  }
  return null;
}

type CustomPlaceAccess =
  | { kind: "not_found" }
  | { kind: "spine" }
  | { kind: "forbidden" }
  | { kind: "owned"; row: PlaceRow };

export function createPlacesRouter(deps: PlacesRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const nowOf = () => (deps.now ? deps.now() : new Date());

  // ---- search rate limit (config §3.6.3 posture; real limiter iff wired) --
  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rl = deps.rateLimit;
  const searchLimiter = rl
    ? rateLimit(
        [
          {
            name: "places-search-user",
            limit: RATE_LIMITS.placesSearch.limit,
            windowMs: RATE_LIMITS.placesSearch.windowMs,
            keyOf: (c) => c.get("auth")?.userId ?? null,
          },
        ],
        { store: rl.store, ...(rl.now ? { now: rl.now } : {}) },
      )
    : passThrough;

  /**
   * Mutation-side visibility resolution (R-places-8/10) — the shared
   * predicate (`visibility.ts`, round-2 A1) mapped onto THIS surface's
   * branches: "referenced" (visible but not creator) is the 403 arm — the
   * place is referenced (saved / itinerary / booking) in SOME trip the
   * caller belongs to, so those members already see it in trip content and
   * FORBIDDEN reveals nothing new.
   */
  async function customPlaceAccess(placeId: string, userId: string): Promise<CustomPlaceAccess> {
    const access = await resolvePlaceAccess(deps.db, { placeId, userId });
    switch (access.kind) {
      case "not_found":
        return { kind: "not_found" };
      case "spine":
        return { kind: "spine" };
      case "owned":
        return { kind: "owned", row: access.row };
      case "referenced":
        return { kind: "forbidden" };
    }
  }

  // -------------------------------------------------------------------------
  // GET /places/search — text / geo / blend over our spine (R-places-6),
  // custom-place visibility per R-places-8, keyset pagination, coverage-miss
  // backfill (R-places-7).
  // -------------------------------------------------------------------------
  router.get(
    placeEndpoints.searchPlaces.path,
    searchLimiter,
    zValidator("query", placeEndpoints.searchPlaces.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const query = c.req.valid("query");

      // trip_id widens custom visibility — membership-gated with the SAME
      // indistinguishable 404 as `requireTripMember` (the F-038 property):
      // a non-member cannot learn the trip exists via the search door.
      if (query.trip_id !== undefined) {
        const [membership] = await deps.db
          .select({ role: schema.tripMembers.role })
          .from(schema.tripMembers)
          .where(
            and(
              eq(schema.tripMembers.tripId, query.trip_id),
              eq(schema.tripMembers.userId, userId),
            ),
          );
        if (!membership) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      }

      const bbox: SearchBox | undefined = query.bbox
        ? {
            minLat: query.bbox.min_lat,
            minLng: query.bbox.min_lng,
            maxLat: query.bbox.max_lat,
            maxLng: query.bbox.max_lng,
          }
        : undefined;
      const near = query.near
        ? {
            lat: query.near.lat,
            lng: query.near.lng,
            radiusM: query.radius_m ?? PLACES_SEARCH_RADIUS_M_DEFAULT,
          }
        : undefined;

      const pageSize = query.limit ?? PLACES_SEARCH_PAGE_SIZE_DEFAULT;
      // Malformed cursor → page 1 (opaque server-minted token, trips §3.3
      // precedent — no list spec documents a cursor 400).
      const cursor = query.cursor ? decodeKeysetCursor(query.cursor) : null;

      // B-7 follow-up (Sean's ruling, 2026-09-14; R-places-28): a sub-floor
      // TEXT-ONLY query (`q` trimmed shorter than the global floor, no
      // bbox/near) no longer 400s at the validation boundary — it runs the
      // exact-match tier arm instead of the trgm scan `placesSearchQuery`
      // would otherwise drive. A short `q` WITH a geo bound is unaffected
      // (the existing bbox/near-driven arm already bounds the candidate
      // set, so it keeps using `placesSearchQuery` unchanged).
      const rows =
        query.q !== undefined &&
        query.q.length < PLACES_SEARCH_TEXT_ONLY_MIN_CHARS &&
        bbox === undefined &&
        near === undefined
          ? await placesExactTierMatchQuery(deps.db, {
              q: query.q,
              cursor,
              limit: pageSize + 1,
            })
          : await placesSearchQuery(deps.db, {
              userId,
              q: query.q,
              bbox,
              near,
              coarse: query.coarse_category,
              tripId: query.trip_id,
              cursor,
              limit: pageSize + 1,
            });

      const page = rows.slice(0, pageSize);
      const items = page.map((row) => toPlaceWire(row.place));
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeKeysetCursor({ micros: last.rankKey, id: last.place.id })
          : null;

      // R-places-7 secondary trigger — OFF the response path (round-1 #9):
      // the coverage probe is a full DB round trip (~5–15 ms on Neon) and
      // this is the hottest read in the app, so the search answers first
      // and the backfill check runs fire-and-forget behind it. Best-effort
      // by contract: hard-capped per search (center-out cell selection; the
      // queue adds per-cell throttle + global budget), and every failure —
      // including a bad-area RangeError — is swallowed. Never an error,
      // never a block, never response latency.
      if (bbox || near) {
        const nearBox = near ? nearPrefilterBox(near.lat, near.lng, near.radiusM) : undefined;
        const area = bbox && nearBox ? intersectBoxes(bbox, nearBox) : (bbox ?? nearBox ?? null);
        if (area) {
          const task = (async () => {
            const cells = regionCellsForBbox(area, PLACES_SEARCH_MISS_MAX_CELLS);
            const stale = await staleSearchCells(deps.db, cells, nowOf());
            if (stale.length > 0) deps.placesIngest?.enqueueSearchMiss(stale);
          })().catch(() => {
            // Deliberately swallowed (R-places-7): backfill never fails a search.
          });
          deps.trackCoverageTask?.(task);
        }
      }

      const body: Paginated<Place> = { items, nextCursor };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // GET /places/:placeId — details (T-8.1 / PL-3): spine read + the DORMANT
  // fetch-fresh seam (R-places-11..14; premium details MVP-deferred, Gate 2).
  // Registered AFTER /places/search so registration order alone guarantees
  // the static path wins; the `resolvePlaceAccess` UUID pre-check would fold
  // a stray "search" into the canonical 404 anyway (belt and suspenders).
  // Visibility is THE shared predicate (visibility.ts): spine/owned/
  // referenced are readable, anything else 404s indistinguishably from
  // absent (R-places-8 posture — Law #3).
  //
  // v1 `?fresh=true` semantics (PL-3: "spine read + fresh_unavailable_reason
  // plumbing only" — the FSQ client, entitlement read, and per-user/global
  // guards are DEFERRED with the premium feature): `fresh` is never present;
  // the reason is `no_fsq_id` for places with no FSQ id to query (§3.4:
  // only `fsq_os` rows have one) and `disabled` otherwise (the deployment
  // has no FSQ integration — R-places-14's disable semantics, spine-only
  // responses continue).
  // -------------------------------------------------------------------------
  router.get(
    placeEndpoints.getPlace.path,
    zValidator("query", placeEndpoints.getPlace.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const freshRequested = c.req.valid("query").fresh === true;

      // R-places-11: non-cacheable whenever `fresh` was requested — set
      // BEFORE any branch so every outcome (200 AND the 404 arm) carries it
      // uniformly. No oracle: the header depends only on caller-controlled
      // input, never on resource state, so 404 byte-identity within a given
      // `fresh` value is preserved.
      if (freshRequested) c.header("Cache-Control", "no-store");

      const access = await resolvePlaceAccess(deps.db, {
        placeId: c.req.param("placeId"),
        userId,
      });
      if (access.kind === "not_found") return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      const body: PlaceDetails = { place: toPlaceWire(access.row) };
      if (freshRequested) {
        // `fsq_os` ⇒ `source_id` present (DB CHECK: custom ⇔ NULL source_id;
        // spine rows always carry their upstream id) — so source alone
        // decides the no-FSQ-id arm (§3.4).
        body.fresh_unavailable_reason = access.row.source === "fsq_os" ? "disabled" : "no_fsq_id";
      }
      return c.json(body satisfies PlaceDetails);
    },
  );

  // -------------------------------------------------------------------------
  // POST /places — custom place: `source='custom'`, `source_id NULL`,
  // `created_by = caller` (R-places-9; §3.2 matrix: any authenticated user
  // may create). Single-row insert — no transaction, no locks.
  // -------------------------------------------------------------------------
  router.post(
    placeEndpoints.createPlace.path,
    zValidator("json", placeEndpoints.createPlace.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      let inserted: PlaceRow | undefined;
      try {
        [inserted] = await deps.db
          .insert(schema.places)
          .values({
            source: "custom",
            name: body.name,
            // numeric columns are string-mode (db/schema/_shared.ts); range
            // was validated by the shared Lat/Lng schemas. Omitted (B-7 part
            // 3) → NULL — the server never substitutes a placeholder value.
            lat: body.lat === undefined ? null : String(body.lat),
            lng: body.lng === undefined ? null : String(body.lng),
            category: body.category ?? null,
            createdBy: userId,
          })
          .returning();
      } catch (err) {
        // Belt, not the primary guard: PlaceCreateSchema's pair refine
        // already rejects every half-pair at the boundary (B-7 part 3
        // round-1 fix, db/coords-ck.ts) — an escape here is a service/schema
        // drift bug, but the client still gets a 400, never a raw 500.
        rethrowCoordsCkMapped(err);
      }
      if (!inserted) throw new HttpError("INTERNAL", "place insert returned no row");

      return c.json(toPlaceWire(inserted) satisfies Place, 201);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /places/:placeId — creator-only partial edit (R-places-10; §3.2
  // matrix: creator edits, spine immutable for everyone). Row-grain LWW —
  // no precondition field is specced for places.
  // -------------------------------------------------------------------------
  router.patch(
    placeEndpoints.updatePlace.path,
    zValidator("json", placeEndpoints.updatePlace.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { userId } = authContextOf(c);
      const body = c.req.valid("json");

      const access = await customPlaceAccess(c.req.param("placeId"), userId);
      if (access.kind === "not_found") return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      if (access.kind === "spine") {
        // B-7 part 3 round-1 fix — source-aware clearing (`PlaceUpdateSchema`
        // can't see a row's `source`, so the route enforces this half): a
        // spine/tier place's coordinates are a structural fact of its
        // source, never a caller-cleared field (`places_spine_coords_ck`) —
        // that is a 400 (the request is invalid for this resource TYPE,
        // regardless of who's asking), distinct from the blanket
        // ownership/immutability 403 every other spine edit still gets.
        if (body.lat === null && body.lng === null) {
          return apiError(
            c,
            "VALIDATION_FAILED",
            "coordinates cannot be cleared for this place's source",
          );
        }
        return apiError(c, "FORBIDDEN", "spine places cannot be modified");
      }
      if (access.kind === "forbidden") {
        return apiError(c, "FORBIDDEN", "only the creator may modify a custom place");
      }

      const set: Partial<typeof schema.places.$inferInsert> = {};
      if (body.name !== undefined) set.name = body.name;
      // B-7 part 3 round-1 fix: `PlaceUpdateSchema`'s pair refine guarantees
      // lat/lng arrive together (both a number, or both `null` — a clear,
      // legal only for `source='custom'`, which `access.kind === "owned"`
      // already establishes). Never `String(null)` — that would write the
      // literal string "null" into a numeric column.
      if (body.lat !== undefined) set.lat = body.lat === null ? null : String(body.lat);
      if (body.lng !== undefined) set.lng = body.lng === null ? null : String(body.lng);
      if (body.category !== undefined) set.category = body.category;

      // Empty patch: nothing to write — answer the current row without
      // moving `updated_at` (the trips PATCH posture).
      if (Object.keys(set).length === 0) {
        return c.json(toPlaceWire(access.row) satisfies Place);
      }

      let updated: PlaceRow | undefined;
      try {
        [updated] = await deps.db
          .update(schema.places)
          .set(set)
          .where(eq(schema.places.id, access.row.id))
          .returning();
      } catch (err) {
        // Belt, not the primary guard (db/coords-ck.ts): the pair refine
        // above + the source-aware check above it already reject every
        // shape that could trip `places_coords_pair_ck` — an escape here is
        // a service/schema drift bug, but the client still gets a 400.
        rethrowCoordsCkMapped(err);
      }
      // Raced a concurrent delete — converge on the indistinguishable 404.
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      return c.json(toPlaceWire(updated) satisfies Place);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /places/:placeId — creator-only, unreferenced-only (R-places-10).
  // The RESTRICT FKs are the authority: delete-then-map the FK violation
  // (23503, or 23001 on PG 18 — `isFkViolationCode`, db/pg-errors.ts) is
  // race-free where a pre-check would TOCTOU; the 409 names the referencer.
  // -------------------------------------------------------------------------
  router.delete(placeEndpoints.deletePlace.path, async (c) => {
    const { userId } = authContextOf(c);

    const access = await customPlaceAccess(c.req.param("placeId"), userId);
    if (access.kind === "not_found") return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    if (access.kind === "spine") {
      return apiError(c, "FORBIDDEN", "spine places cannot be deleted");
    }
    if (access.kind === "forbidden") {
      return apiError(c, "FORBIDDEN", "only the creator may delete a custom place");
    }

    let deleted: { id: string }[];
    try {
      deleted = await deps.db
        .delete(schema.places)
        .where(eq(schema.places.id, access.row.id))
        .returning({ id: schema.places.id });
    } catch (err) {
      const table = fkViolationTable(err);
      if (table !== null) {
        const by = DELETE_RESTRICT_TABLES.has(table) ? table : "unknown";
        return apiError(c, "CONFLICT", `place is referenced by ${by} and cannot be deleted`, {
          reason: "place_referenced",
          by,
        });
      }
      throw err;
    }
    if (deleted.length === 0) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    return c.body(null, 204);
  });

  return router;
}
