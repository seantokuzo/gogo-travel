/**
 * Transport reference routes (B-9): `GET /airports/search`,
 * `GET /airlines/search`, `GET /airlines/flight-lookup`.
 *
 * AUTHZ POSTURE: behind the app-wide `requireAuth` (R-authz-1) like every
 * other read — reference rows aren't user data, but the API surface stays
 * uniform (no second door to reason about). No trip gate, no visibility
 * logic: the tables are GLOBAL, read-only, migration-seeded (schema
 * `reference.ts`); nothing here writes.
 *
 * SEARCH is a pure bounded read: ranked ILIKE over a ~4k-row seeded table —
 * no trgm index, no pagination machinery (responses use the `Paginated<T>`
 * envelope with `nextCursor` always `null`; the shared query schema has no
 * cursor param). One per-user limiter bucket spans all three routes
 * (RATE_LIMITS.referenceSearch — the places-search posture).
 *
 * LIKE-pattern inputs are escaped (`escapeLikePattern`) so `%`/`_` in user
 * text match literally — parameterization already rules out injection; the
 * escape is semantic (a bare "%" query must not rank the whole table).
 */
import { zValidator } from "@hono/zod-validator";
import { asc, like, ilike, or, sql, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Paginated } from "@gogo/shared/api/envelope";
import {
  airportEndpoints,
  parseFlightNumber,
  type Airline,
  type Airport,
  type FlightAirlineLookupResponse,
} from "@gogo/shared/domains/airport";
import { REFERENCE_SEARCH_PAGE_SIZE_DEFAULT, RATE_LIMITS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import type { RequestVars } from "../http/errors.js";
import { rateLimit, type RateLimitStore } from "../http/rate-limit.js";
import { rejectInvalidBody } from "../http/validation.js";
import { toAirlineWire, toAirportWire } from "./serialize.js";

export interface ReferenceRouterDeps {
  db: DbClient;
  /**
   * The per-user reference-surface limiter (RATE_LIMITS.referenceSearch).
   * Absent = no limiter (unit/integration tests); prod wiring (`wire.ts`)
   * always supplies it. `now` is MILLISECONDS (the store's clock).
   */
  rateLimit?: {
    store: RateLimitStore;
    now?: () => number;
  };
}

/** Escape `%`/`_`/`\` so they match literally (Postgres default `\` escape). */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

export function createReferenceRouter(deps: ReferenceRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();

  const passThrough = createMiddleware<RequestVars>(async (_c, next) => {
    await next();
  });
  const rl = deps.rateLimit;
  const searchLimiter = rl
    ? rateLimit(
        [
          {
            name: "reference-search-user",
            limit: RATE_LIMITS.referenceSearch.limit,
            windowMs: RATE_LIMITS.referenceSearch.windowMs,
            keyOf: (c) => c.get("auth")?.userId ?? null,
          },
        ],
        { store: rl.store, ...(rl.now ? { now: rl.now } : {}) },
      )
    : passThrough;

  // -------------------------------------------------------------------------
  // GET /airports/search — ranked typeahead over IATA / name / city.
  // Rank: IATA exact (0) → IATA prefix (1) → name prefix (2) → city prefix
  // (3) → name substring (4) → city substring (5); ties break on name then
  // IATA so the order is total and stable across requests.
  // -------------------------------------------------------------------------
  router.get(
    airportEndpoints.searchAirports.path,
    searchLimiter,
    zValidator("query", airportEndpoints.searchAirports.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const limit = query.limit ?? REFERENCE_SEARCH_PAGE_SIZE_DEFAULT;

      const escaped = escapeLikePattern(query.q);
      const codePrefix = `${escapeLikePattern(query.q.toUpperCase())}%`;
      const namePrefix = `${escaped}%`;
      const anywhere = `%${escaped}%`;
      const upper = query.q.toUpperCase();

      const rank = sql<number>`case
        when ${schema.airports.iata} = ${upper} then 0
        when ${schema.airports.iata} like ${codePrefix} then 1
        when ${schema.airports.name} ilike ${namePrefix} then 2
        when ${schema.airports.city} ilike ${namePrefix} then 3
        when ${schema.airports.name} ilike ${anywhere} then 4
        else 5
      end`;

      const rows = await deps.db
        .select()
        .from(schema.airports)
        .where(
          or(
            like(schema.airports.iata, codePrefix),
            ilike(schema.airports.name, anywhere),
            ilike(schema.airports.city, anywhere),
          ),
        )
        .orderBy(rank, asc(schema.airports.name), asc(schema.airports.iata))
        .limit(limit);

      const body: Paginated<Airport> = {
        items: rows.map(toAirportWire),
        // Bounded typeahead — never pages (descriptor contract).
        nextCursor: null,
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // GET /airlines/search — same shape: IATA exact (0) → IATA prefix (1) →
  // name prefix (2) → name substring (3).
  // -------------------------------------------------------------------------
  router.get(
    airportEndpoints.searchAirlines.path,
    searchLimiter,
    zValidator("query", airportEndpoints.searchAirlines.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const query = c.req.valid("query");
      const limit = query.limit ?? REFERENCE_SEARCH_PAGE_SIZE_DEFAULT;

      const escaped = escapeLikePattern(query.q);
      const codePrefix = `${escapeLikePattern(query.q.toUpperCase())}%`;
      const namePrefix = `${escaped}%`;
      const anywhere = `%${escaped}%`;
      const upper = query.q.toUpperCase();

      const rank = sql<number>`case
        when ${schema.airlines.iata} = ${upper} then 0
        when ${schema.airlines.iata} like ${codePrefix} then 1
        when ${schema.airlines.name} ilike ${namePrefix} then 2
        else 3
      end`;

      const rows = await deps.db
        .select()
        .from(schema.airlines)
        .where(
          or(like(schema.airlines.iata, codePrefix), ilike(schema.airlines.name, anywhere)),
        )
        .orderBy(rank, asc(schema.airlines.name), asc(schema.airlines.iata))
        .limit(limit);

      const body: Paginated<Airline> = { items: rows.map(toAirlineWire), nextCursor: null };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // GET /airlines/flight-lookup — the inference endpoint. SOFT by contract
  // (descriptor doc): unparseable input and unknown designators are 200s
  // with nulls, never errors — a keystroke must not produce an error state.
  // The parse is the SHARED `parseFlightNumber`, so client-side prefill and
  // this endpoint can never disagree about what a flight number is.
  // -------------------------------------------------------------------------
  router.get(
    airportEndpoints.lookupFlightAirline.path,
    searchLimiter,
    zValidator("query", airportEndpoints.lookupFlightAirline.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    async (c) => {
      const { flight_number } = c.req.valid("query");

      const flight = parseFlightNumber(flight_number);
      if (flight === null) {
        const miss: FlightAirlineLookupResponse = { flight: null, airline: null };
        return c.json(miss);
      }

      const [airline] = await deps.db
        .select()
        .from(schema.airlines)
        .where(eq(schema.airlines.iata, flight.airline_iata));

      const body: FlightAirlineLookupResponse = {
        flight,
        airline: airline ? toAirlineWire(airline) : null,
      };
      return c.json(body);
    },
  );

  return router;
}
