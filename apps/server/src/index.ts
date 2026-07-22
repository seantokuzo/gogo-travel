import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildAuthDepsFromEnv } from "./auth/wire.js";
import { loadEnv } from "./env.js";

// A local .env is loaded natively via `--env-file-if-exists=.env` (Node >=22.9,
// passed through by tsx) on the dev/start scripts — no dotenv dependency, and
// boot doesn't fail when the file is absent (CI/prod inject real env vars).
const env = loadEnv();

// Auth wiring (T-5.2): all-or-nothing from env. Wholly unconfigured → dev
// boots health-only with a loud note; production NEVER boots without auth.
const authDeps = await buildAuthDepsFromEnv(env);
if (!authDeps && env.NODE_ENV === "production") {
  throw new Error("auth env not configured — refusing to boot production without /auth routes");
}
if (!authDeps) {
  console.warn("[boot] auth env not configured — /auth routes NOT mounted (health-only boot)");
}

const app = createApp(authDeps ? { auth: authDeps } : {});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
