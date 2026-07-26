import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildAuthDepsFromEnv } from "./auth/wire.js";
import { buildPlacesIngest } from "./places/wire.js";
import { buildTripsDeps } from "./trips/wire.js";
import { buildUsersDepsFromEnv } from "./users/wire.js";
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

// Users surface (T-5.5) mounts iff auth does — its routes are Auth: Required
// and sit behind the app-wide requireAuth guard. Object storage has no
// provider yet (parked escalation): avatar presign 500s, avatar commit 400s,
// everything else on the surface is live.
if (authDeps) {
  console.warn("[boot] object storage not configured — avatar presign is unavailable");
}

const app = createApp(
  authDeps
    ? {
        auth: authDeps,
        users: await buildUsersDepsFromEnv(env),
        // Places ingest rides the trips deps: trip create / destination
        // change fire the post-commit region-ingest trigger (T-6.4,
        // R-places-1) — async, fire-and-forget, never blocks a request.
        trips: { ...buildTripsDeps(), placesIngest: buildPlacesIngest(env) },
      }
    : {},
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
