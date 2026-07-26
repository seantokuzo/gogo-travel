import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildAuthDepsFromEnv } from "./auth/wire.js";
import { buildPlacesIngest, buildPlacesRouterDeps } from "./places/wire.js";
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

let appOptions: Parameters<typeof createApp>[0] = {};
if (authDeps) {
  // Places ingest rides the trips deps: trip create / destination change
  // fire the post-commit region-ingest trigger (T-6.4, R-places-1) — async,
  // fire-and-forget, never blocks a request. Unconfigured dataset URLs are
  // warned HERE (wire modules stay silent — T-5.5 object-storage precedent);
  // affected region ingests record `failed` visibly instead of running.
  const placesIngest = buildPlacesIngest(env);
  if (placesIngest.unconfiguredSources.length > 0) {
    console.warn(
      `[boot] places ingest dataset URL(s) not configured (${placesIngest.unconfiguredSources.join(
        ", ",
      )}) — those region ingests will record 'failed' until PLACES_*_PARQUET_URL are set`,
    );
  }
  appOptions = {
    auth: authDeps,
    users: await buildUsersDepsFromEnv(env),
    trips: { ...buildTripsDeps(), placesIngest: placesIngest.trigger },
    // Same queue instance as trips: destination + search-miss triggers feed
    // one serial drain (T-6.5).
    places: buildPlacesRouterDeps(placesIngest.trigger),
  };
}
const app = createApp(appOptions);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
