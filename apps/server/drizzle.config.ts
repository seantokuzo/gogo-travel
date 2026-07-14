import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit tooling config (generate/migrate). This file runs in the CLI
 * only — never in the app; the app's sole env reader stays `src/env.ts`.
 * `DATABASE_URL` is only needed by `db:migrate`, not `db:generate`.
 *
 * Requires `@gogo/shared`'s package.json `exports` to keep its `"default"`
 * condition: drizzle-kit loads the schema through a CJS loader that resolves
 * `"default"`, not `"import"`. Do NOT "clean up" @gogo/shared to import-only —
 * `db:generate` would fail to resolve the shared types.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
