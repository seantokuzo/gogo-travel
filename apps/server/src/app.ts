import { createRequire } from "node:module";
import { Hono } from "hono";
import { authEndpoints } from "@gogo/shared/domains/auth";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";
import { createTripsRouter, type TripsRouterDeps } from "./trips/routes.js";
import { createUsersRouter, type UsersRouterDeps } from "./users/routes.js";
import { createErrorHandler, requestIdMiddleware } from "./http/app-middleware.js";
import { createRequireAuth } from "./http/require-auth.js";
import type { RequestVars } from "./http/errors.js";

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
   * Trips router dependencies (T-6.1). Same pairing rule as `users`: every
   * trip route is Auth: Required (and `/:tripId` routes additionally sit
   * behind the trip-membership gate), so trips-without-auth is a wiring bug.
   */
  trips?: TripsRouterDeps;
}

export function createApp(options: CreateAppOptions = {}): Hono<RequestVars> {
  if (options.users && !options.auth) {
    throw new Error("users router requires auth deps — it must sit behind requireAuth");
  }
  if (options.trips && !options.auth) {
    throw new Error("trips router requires auth deps — it must sit behind requireAuth");
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
  }

  return app;
}

export const app = createApp();
