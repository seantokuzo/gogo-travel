import { createRequire } from "node:module";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authEndpoints } from "@gogo/shared/domains/auth";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";
import { createBookingsRouter, type BookingsRouterDeps } from "./bookings/routes.js";
import { createItineraryRouter, type ItineraryRouterDeps } from "./itinerary/routes.js";
import { createPlacesRouter, type PlacesRouterDeps } from "./places/routes.js";
import { createInvitesRouter } from "./trips/invites-routes.js";
import { createMembersRouter } from "./trips/members-routes.js";
import { createTravelLegsRouter, type TravelLegsRouterDeps } from "./travel-legs/routes.js";
import { createTripsRouter, type TripsRouterDeps } from "./trips/routes.js";
import { createUsersRouter, type UsersRouterDeps } from "./users/routes.js";
import { BODY_LIMIT_MAX_BYTES } from "./config.js";
import { createErrorHandler, requestIdMiddleware } from "./http/app-middleware.js";
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

  const app = new Hono<RequestVars>();
  const logger = options.auth?.logger;

  // App-wide, in order (R-authz-4): correlation id → auth guard → routers, all
  // errors serialized by the one `onError`. Promoted from the AU-3 sub-router
  // so every future domain router inherits them (§3.4/§3.6.4).
  app.use("*", requestIdMiddleware);
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

  return app;
}

export const app = createApp();
