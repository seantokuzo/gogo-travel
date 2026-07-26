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
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Paginated } from "@gogo/shared/api/envelope";
import { placeEndpoints, type Place } from "@gogo/shared/domains/place";
import { regionCellsForBbox } from "@gogo/shared/region-grid";
import {
  PLACES_SEARCH_MISS_MAX_CELLS,
  PLACES_SEARCH_PAGE_SIZE_DEFAULT,
  PLACES_SEARCH_RADIUS_M_DEFAULT,
  RATE_LIMITS,
} from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, HttpError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { decodeKeysetCursor, encodeKeysetCursor } from "../http/keyset-cursor.js";
import { rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { authContextOf } from "../http/require-auth.js";
import { UUID_RE } from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import type { PlacesIngestTrigger } from "./ingest-queue.js";
import { intersectBoxes, staleSearchCells } from "./search-coverage.js";
import { nearPrefilterBox, placesSearchQuery, type SearchBox } from "./search-query.js";
import { toPlaceWire, type PlaceRow } from "./serialize.js";

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
 * Postgres foreign_key_violation (23503), possibly wrapped — walk `cause`
 * (the sign-in 23505 walker's shape). Returns the referencing table.
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
    if (candidate.code === "23503") {
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
   * Mutation-side visibility resolution (R-places-8/10). "Visible but not
   * creator" — the 403 branch — means the place is referenced (saved /
   * itinerary / booking) in SOME trip the caller belongs to: those members
   * already see it in trip content, so FORBIDDEN reveals nothing new.
   */
  async function customPlaceAccess(placeId: string, userId: string): Promise<CustomPlaceAccess> {
    if (!UUID_RE.test(placeId)) return { kind: "not_found" };

    const [row] = await deps.db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeId));
    if (!row) return { kind: "not_found" };
    if (row.source !== "custom") return { kind: "spine" };
    if (row.createdBy === userId) return { kind: "owned", row };

    const [visible] = await deps.db
      .select({ one: sql<number>`1` })
      .from(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.userId, userId),
          sql`(
            exists (select 1 from saved_places sp where sp.trip_id = ${schema.tripMembers.tripId} and sp.place_id = ${placeId}::uuid)
            or exists (select 1 from itinerary_items ii where ii.trip_id = ${schema.tripMembers.tripId} and ii.place_id = ${placeId}::uuid)
            or exists (select 1 from bookings b where b.trip_id = ${schema.tripMembers.tripId} and b.place_id = ${placeId}::uuid)
          )`,
        ),
      )
      .limit(1);

    return visible ? { kind: "forbidden" } : { kind: "not_found" };
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

      const rows = await placesSearchQuery(deps.db, {
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

      const [inserted] = await deps.db
        .insert(schema.places)
        .values({
          source: "custom",
          name: body.name,
          // numeric columns are string-mode (db/schema/_shared.ts); range
          // was validated by the shared Lat/Lng schemas.
          lat: String(body.lat),
          lng: String(body.lng),
          category: body.category ?? null,
          createdBy: userId,
        })
        .returning();
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
        return apiError(c, "FORBIDDEN", "spine places cannot be modified");
      }
      if (access.kind === "forbidden") {
        return apiError(c, "FORBIDDEN", "only the creator may modify a custom place");
      }

      const set: Partial<typeof schema.places.$inferInsert> = {};
      if (body.name !== undefined) set.name = body.name;
      if (body.lat !== undefined) set.lat = String(body.lat);
      if (body.lng !== undefined) set.lng = String(body.lng);
      if (body.category !== undefined) set.category = body.category;

      // Empty patch: nothing to write — answer the current row without
      // moving `updated_at` (the trips PATCH posture).
      if (Object.keys(set).length === 0) {
        return c.json(toPlaceWire(access.row) satisfies Place);
      }

      const [updated] = await deps.db
        .update(schema.places)
        .set(set)
        .where(eq(schema.places.id, access.row.id))
        .returning();
      // Raced a concurrent delete — converge on the indistinguishable 404.
      if (!updated) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

      return c.json(toPlaceWire(updated) satisfies Place);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /places/:placeId — creator-only, unreferenced-only (R-places-10).
  // The RESTRICT FKs are the authority: delete-then-map-23503 is race-free
  // where a pre-check would TOCTOU; the 409 names the referencer.
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
