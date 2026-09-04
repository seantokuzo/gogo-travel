import { createRequire } from "node:module";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authEndpoints } from "@gogo/shared/domains/auth";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";
import { createBookingsRouter, type BookingsRouterDeps } from "./bookings/routes.js";
import { createBudgetsRouter, type BudgetsRouterDeps } from "./budgets/routes.js";
import { createExpensesRouter, type ExpensesRouterDeps } from "./expenses/routes.js";
import { createFxRouter, type FxRouterDeps } from "./fx/routes.js";
import { createItineraryRouter, type ItineraryRouterDeps } from "./itinerary/routes.js";
import { createPlacesRouter, type PlacesRouterDeps } from "./places/routes.js";
import { createSavedPlacesRouter } from "./places/saved-places-routes.js";
import { createSettleRequestsRouter } from "./settlements/requests-routes.js";
import { createSettlementsRouter, type SettlementsRouterDeps } from "./settlements/routes.js";
import { createInvitesRouter } from "./trips/invites-routes.js";
import { createMembersRouter } from "./trips/members-routes.js";
import { createTravelLegsRouter, type TravelLegsRouterDeps } from "./travel-legs/routes.js";
import { createTripsRouter, type TripsRouterDeps } from "./trips/routes.js";
import { createUsersRouter, type UsersRouterDeps } from "./users/routes.js";
import { BODY_LIMIT_MAX_BYTES } from "./config.js";
import { createErrorHandler, requestIdMiddleware } from "./http/app-middleware.js";
import { createDevRequestLog } from "./http/dev-request-log.js";
import { createRequireAuth } from "./http/require-auth.js";
import { apiError, type RequestVars } from "./http/errors.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * The base every router (and the health check) mounts under — the mobile
 * `ApiClient`'s base URL ends in `/api`. The public allowlist is expressed as
 * fully-qualified paths against this base.
 */
const API_BASE = "/api";

/**
 * The ENTIRE public allowlist (R-authz-1): the health check plus the three
 * sign-in/refresh routes. Built from the shared `authEndpoints` descriptors so
 * the guard's allowlist can never drift from the routes it fronts. Every other
 * route in the app runs behind `requireAuth`.
 */
export const PUBLIC_ALLOWLIST: ReadonlySet<string> = new Set([
  `GET ${API_BASE}/health`,
  // Hono auto-serves HEAD for the GET health route; allowlist it too so LB /
  // uptime probes (which commonly use HEAD) aren't 401'd into "unhealthy".
  `HEAD ${API_BASE}/health`,
  `${authEndpoints.appleSignIn.method} ${API_BASE}${authEndpoints.appleSignIn.path}`,
  `${authEndpoints.googleSignIn.method} ${API_BASE}${authEndpoints.googleSignIn.path}`,
  `${authEndpoints.refresh.method} ${API_BASE}${authEndpoints.refresh.path}`,
]);

export interface CreateAppOptions {
  /**
   * Mount the development request log (`http/dev-request-log.ts`). Passed in
   * rather than read here so `loadEnv()` stays the only `process.env` reader
   * (`.claude/rules/server.md`). `src/index.ts` sets it from
   * `NODE_ENV === "development"`; tests and production leave it off, so their
   * output is unchanged.
   */
  devRequestLog?: boolean;
  /**
   * Auth router dependencies (T-5.2+). Absent = the auth surface is not
   * mounted (health-only boot — dev/tests); prod wiring (src/index.ts)
   * refuses to start without it. When present, the app-wide `requireAuth`
   * guard mounts too.
   */
  auth?: AuthRouterDeps;
  /**
   * Users/entitlements router dependencies (T-5.5). Every route on that
   * surface is Auth: Required, so mounting it without `auth` (no
   * `requireAuth` guard, no verifier) is a wiring bug — rejected loudly at
   * construction, never a silently-unguarded surface.
   */
  users?: UsersRouterDeps;
  /**
   * Trips-surface dependencies (T-6.1 trips CRUD; T-6.2 members + invites —
   * one dep set, three routers). Same pairing rule as `users`: every route
   * is Auth: Required (and the `/:tripId` routes additionally sit behind the
   * trip-membership gate), so trips-without-auth is a wiring bug.
   */
  trips?: TripsRouterDeps;
  /**
   * Places-surface dependencies (T-6.5 search + custom places). Same
   * pairing rule: every route is Auth: Required, and custom-place
   * visibility (Law #3 posture) assumes the authenticated identity exists —
   * places-without-auth is a wiring bug.
   */
  places?: PlacesRouterDeps;
  /**
   * Bookings-surface dependencies (T-7.1 booking service + router). Same
   * pairing rule: every route is Auth: Required AND sits behind the
   * trip-membership gate (R-ib-24) — bookings-without-auth is a wiring bug.
   */
  bookings?: BookingsRouterDeps;
  /**
   * Itinerary-surface dependencies (T-7.2 items + reorder + composite read).
   * Same pairing rule: every route is Auth: Required AND sits behind the
   * trip-membership gate (R-ib-24) — itinerary-without-auth is a wiring bug.
   */
  itinerary?: ItineraryRouterDeps;
  /**
   * Travel-legs surface dependencies (T-7.3 refresh-legs + the leg worker's
   * marker). Same pairing rule: the route is Auth: Required AND sits behind
   * the trip-membership gate (R-ib-24) — travel-legs-without-auth is a
   * wiring bug.
   */
  travelLegs?: TravelLegsRouterDeps;
  /**
   * Expenses-surface dependencies (T-9.2 expense service + router). Same
   * pairing rule: every route is Auth: Required AND sits behind the
   * trip-membership gate (R-money-25) — expenses-without-auth is a wiring
   * bug.
   */
  expenses?: ExpensesRouterDeps;
  /**
   * Settlements-surface dependencies (T-9.3 balances + settlements; T-9.4
   * settle-requests — ONE dep set, two routers, per the settlements barrel).
   * Mounted by the T-9.4 wiring closer (the module shipped UNMOUNTED from W2
   * by ownership design; the R-trips-22 settlements-probe lock extension
   * merged with PR #30, so exposure is safe). Same pairing rule: every route
   * is Auth: Required behind the trip-membership gate (R-money-25).
   */
  settlements?: SettlementsRouterDeps;
  /**
   * Budgets-surface dependencies (T-9.4 budgets service + router). Same
   * pairing rule: both routes are Auth: Required behind the trip-membership
   * gate (R-money-25/26) — budgets-without-auth is a wiring bug.
   */
  budgets?: BudgetsRouterDeps;
  /**
   * FX-proxy dependencies (T-9.4; P-9 ruling ③). The ONE non-trip-scoped
   * money route — still Auth: Required (the shared `getFxRate` descriptor's
   * JSDoc pin: never an unauthenticated open proxy), so fx-without-auth is a
   * wiring bug like every other surface.
   */
  fx?: FxRouterDeps;
}

export function createApp(options: CreateAppOptions = {}): Hono<RequestVars> {
  if (options.users && !options.auth) {
    throw new Error("users router requires auth deps — it must sit behind requireAuth");
  }
  if (options.trips && !options.auth) {
    throw new Error("trips router requires auth deps — it must sit behind requireAuth");
  }
  if (options.places && !options.auth) {
    throw new Error("places router requires auth deps — it must sit behind requireAuth");
  }
  if (options.bookings && !options.auth) {
    throw new Error("bookings router requires auth deps — it must sit behind requireAuth");
  }
  if (options.itinerary && !options.auth) {
    throw new Error("itinerary router requires auth deps — it must sit behind requireAuth");
  }
  if (options.travelLegs && !options.auth) {
    throw new Error("travel-legs router requires auth deps — it must sit behind requireAuth");
  }
  if (options.expenses && !options.auth) {
    throw new Error("expenses router requires auth deps — it must sit behind requireAuth");
  }
  if (options.settlements && !options.auth) {
    throw new Error("settlements router requires auth deps — it must sit behind requireAuth");
  }
  if (options.budgets && !options.auth) {
    throw new Error("budgets router requires auth deps — it must sit behind requireAuth");
  }
  if (options.fx && !options.auth) {
    throw new Error("fx router requires auth deps — it must sit behind requireAuth");
  }

  const app = new Hono<RequestVars>();
  const logger = options.auth?.logger;

  // App-wide, in order (R-authz-4): correlation id → auth guard → routers, all
  // errors serialized by the one `onError`. Promoted from the AU-3 sub-router
  // so every future domain router inherits them (§3.4/§3.6.4).
  app.use("*", requestIdMiddleware);
  // Dev only, and deliberately BEFORE the auth guard so a 401 still prints —
  // "rejected at the door" and "never arrived" must be distinguishable.
  if (options.devRequestLog) app.use("*", createDevRequestLog(logger ?? console));
  app.onError(createErrorHandler(logger ?? console));

  if (options.auth) {
    app.use(
      "*",
      createRequireAuth({
        verifier: options.auth.accessVerify,
        allowlist: PUBLIC_ALLOWLIST,
        ...(logger ? { logger } : {}),
      }),
    );
  }

  // App-wide body cap (PR #11 R1 security defer): ONE bodyLimit in front of
  // every router — including the PUBLIC sign-in routes (prime DoS surface).
  // Deliberately AFTER the auth guard so an unauthenticated oversized probe
  // still gets the uniform 401 (authn first); Content-Length is checked at
  // middleware time and chunked bodies are counted as they stream, so no
  // handler ever buffers past the cap. Error is the shared envelope's
  // PAYLOAD_TOO_LARGE (413), never Hono's default text body.
  app.use(
    "*",
    bodyLimit({
      maxSize: BODY_LIMIT_MAX_BYTES,
      onError: (c) => apiError(c, "PAYLOAD_TOO_LARGE", "request body too large"),
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true, version }));

  if (options.auth) {
    // Descriptor paths (`/auth/apple`, …) mount under the same `/api` base
    // as the health check — the mobile ApiClient's base URL ends in `/api`.
    app.route(API_BASE, createAuthRouter(options.auth));
  }

  if (options.users) {
    app.route(API_BASE, createUsersRouter(options.users));
  }

  if (options.trips) {
    app.route(API_BASE, createTripsRouter(options.trips));
    app.route(API_BASE, createMembersRouter(options.trips));
    // Also carries the non-trip-scoped `/invites/:token*` capability routes.
    app.route(API_BASE, createInvitesRouter(options.trips));
  }

  if (options.places) {
    app.route(API_BASE, createPlacesRouter(options.places));
    // Saved-places CRUD (T-8.1/PL-4) rides the places dep set: same DB, and
    // every route sits behind requireAuth + the trip-membership gate.
    app.route(API_BASE, createSavedPlacesRouter({ db: options.places.db }));
  }

  if (options.bookings) {
    app.route(API_BASE, createBookingsRouter(options.bookings));
  }

  if (options.itinerary) {
    app.route(API_BASE, createItineraryRouter(options.itinerary));
  }

  if (options.travelLegs) {
    app.route(API_BASE, createTravelLegsRouter(options.travelLegs));
  }

  if (options.expenses) {
    app.route(API_BASE, createExpensesRouter(options.expenses));
  }

  if (options.settlements) {
    app.route(API_BASE, createSettlementsRouter(options.settlements));
    // Settle-requests (T-9.4 / MON-5) ride the same dep set: same DB, same
    // requireAuth + trip-membership posture (the saved-places precedent).
    app.route(API_BASE, createSettleRequestsRouter(options.settlements));
  }

  if (options.budgets) {
    app.route(API_BASE, createBudgetsRouter(options.budgets));
  }

  if (options.fx) {
    app.route(API_BASE, createFxRouter(options.fx));
  }

  return app;
}

export const app = createApp();
