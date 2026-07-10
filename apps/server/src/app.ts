import { createRequire } from "node:module";
import { Hono } from "hono";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function createApp(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true, version }));

  return app;
}

export const app = createApp();
