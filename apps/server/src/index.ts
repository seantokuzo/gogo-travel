import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildAuthDepsFromEnv } from "./auth/wire.js";
import { buildBookingsDeps } from "./bookings/wire.js";
import { buildExpensesDeps } from "./expenses/wire.js";
import { buildItineraryDeps } from "./itinerary/wire.js";
import { buildPlacesIngest, buildPlacesRouterDeps } from "./places/wire.js";
import { buildTravelLegs } from "./travel-legs/wire.js";
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
  // Travel-leg job (T-7.3): ONE worker per process; every mutation surface's
  // dirty-day marks funnel into it. No Mapbox token ⇒ driving/walking/
  // cycling legs degrade to absent (R-ib-19/21) — warned HERE (wire modules
  // stay silent, the T-5.5 precedent); transit rides the keyless Transitous
  // default.
  const travelLegs = buildTravelLegs(env);
  if (!travelLegs.mapboxConfigured) {
    console.warn(
      "[boot] MAPBOX_ACCESS_TOKEN not configured — driving/walking/cycling travel legs " +
        "will be absent until it is set (transit via Transitous still computes)",
    );
  }
  appOptions = {
    auth: authDeps,
    users: await buildUsersDepsFromEnv(env),
    trips: { ...buildTripsDeps(), placesIngest: placesIngest.trigger },
    // Same queue instance as trips: destination + search-miss triggers feed
    // one serial drain (T-6.5).
    places: buildPlacesRouterDeps(placesIngest.trigger),
    // Booking service + router (T-7.1); mutations mark the LIVE leg worker
    // (T-7.3) post-commit.
    bookings: buildBookingsDeps(travelLegs.marker),
    // Itinerary router (T-7.2): item CRUD + day reorder + composite read;
    // mutations mark the same LIVE leg worker (T-7.3) post-commit.
    itinerary: buildItineraryDeps(travelLegs.marker),
    // Refresh-legs endpoint (T-7.3) + the staleness sweep below.
    travelLegs: travelLegs.routerDeps,
    // Expenses CRUD + FX validation (T-9.2 / MON-2). Settlements (T-9.3)
    // mount with T-9.4's wiring closer — deliberately NOT pre-wired here.
    expenses: buildExpensesDeps(),
  };
  travelLegs.startStalenessJob();
}
// Dev-only request log — the only `NODE_ENV` read for it, so `createApp`
// itself stays env-free (health-only boots get it too, which is exactly when
// "did the request even arrive?" is hardest to answer).
const app = createApp({ ...appOptions, devRequestLog: env.NODE_ENV === "development" });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
