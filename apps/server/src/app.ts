import { createRequire } from "node:module";
import { Hono } from "hono";
import { createAuthRouter, type AuthRouterDeps } from "./auth/routes.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export interface CreateAppOptions {
  /**
   * Auth router dependencies (T-5.2). Absent = the auth surface is not
   * mounted (health-only boot — dev/tests); prod wiring (src/index.ts)
   * refuses to start without it.
   */
  auth?: AuthRouterDeps;
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, version }));

  if (options.auth) {
    // Descriptor paths (`/auth/apple`, …) mount under the same `/api` base
    // as the health check — the mobile ApiClient's base URL ends in `/api`.
    app.route("/api", createAuthRouter(options.auth));
  }

  return app;
}

export const app = createApp();
