import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit tooling config (generate/migrate). This file runs in the CLI
 * only — never in the app; the app's sole env reader stays `src/env.ts`.
 * `DATABASE_URL` is only needed by `db:migrate`, not `db:generate`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
