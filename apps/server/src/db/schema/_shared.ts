/**
 * Column helpers for the global conventions (schema spec §1):
 * `timestamptz` UTC timestamps; `created_at` on every table; mutable tables
 * add `updated_at` maintained via Drizzle `$onUpdate` (no triggers).
 *
 * Two column-type conventions to know before you consume a row (documented
 * here, the shared conventions home, because they bite at the API boundary):
 *
 *  • `numeric(...)` (coordinates `lat/lng/*_lat/*_lng`, `fx_rate`) is
 *    STRING-mode in Drizzle: `SELECT` returns `"35.689500"`, not `35.6895`.
 *    This is deliberate — string preserves exact precision. Convert at the
 *    API boundary via the shared scalar (never `parseFloat` ad hoc), and
 *    remember contracts typed as numbers will receive strings from the DB.
 *  • `bigint(..., { mode: "number" })` (all `*_cents`, token counters) returns
 *    a JS `number`. Safe because every app write boundary validates cents with
 *    the shared `CentsSchema` (`z.int()`, safe-int-bounded) — values can't
 *    exceed 2^53. Do NOT switch to `mode: "bigint"` without a boundary reason.
 */
import { timestamp } from "drizzle-orm/pg-core";

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * 🔴 Landmine: `$onUpdate` fires on Drizzle `.update(...)` calls ONLY — it does
 * NOT fire through `insert().onConflictDoUpdate()` (upsert). Any upsert set-
 * clause that mutates a row must set `updatedAt: sql`now()`` by hand, or the
 * row's `updated_at` freezes at first insert. See the `ai_usage` upsert
 * exemplar in `constraints.test.ts`.
 */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** `created_at` + `updated_at` for mutable tables. */
export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
