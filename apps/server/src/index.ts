import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { loadEnv } from "./env.js";

// A local .env is loaded natively via `--env-file-if-exists=.env` (Node >=22.9,
// passed through by tsx) on the dev/start scripts — no dotenv dependency, and
// boot doesn't fail when the file is absent (CI/prod inject real env vars).
const env = loadEnv();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
