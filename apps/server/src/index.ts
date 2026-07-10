import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console -- boot banner is the one allowed log
  console.log(`gogo-travel server listening on http://localhost:${info.port}`);
});
