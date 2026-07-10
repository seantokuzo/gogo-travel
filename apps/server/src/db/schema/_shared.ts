/**
 * Column helpers for the global conventions (schema spec §1):
 * `timestamptz` UTC timestamps; `created_at` on every table; mutable tables
 * add `updated_at` maintained via Drizzle `$onUpdate` (no triggers).
 */
import { timestamp } from "drizzle-orm/pg-core";

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

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
