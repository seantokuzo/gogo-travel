/**
 * Opaque keyset cursor for the expenses list ordering
 * `spent_at DESC, created_at DESC, id DESC` (money spec §3.2 GET expenses;
 * `id DESC` is the deterministic tiebreaker — `created_at` alone is not
 * unique under bulk writes; matches the `(trip_id, spent_at)` index).
 *
 * The shared `http/keyset-cursor.ts` codec covers the one-timestamp
 * `(created_at DESC, id DESC)` family; this ordering needs a THREE-part key
 * with a leading `date` column, so it gets its own codec in the same
 * discipline (the bookings-cursor precedent): the timestamp rides as integer
 * epoch-MICROSECONDS (a JS-Date ISO round-trip truncates the microsecond
 * `timestamptz` — µs landmine), the date part rides as its `YYYY-MM-DD`
 * wire string, and a malformed cursor decodes to `null` → page 1 (opaque
 * server-minted token; no cursor 400 is documented, and validation keeps
 * crafted values out of the `::date`/`::bigint`/`::uuid` casts — no 500
 * vector). `spent_at` is NOT NULL, so no NULL sentinel exists here.
 */
import { sql, type SQL } from "drizzle-orm";
import { UUID_RE } from "../http/require-trip-member.js";
import { epochMicrosExpr } from "../http/keyset-cursor.js";
import * as schema from "../db/schema/index.js";

export interface ExpenseKeysetCursor {
  /** `spent_at` as the `YYYY-MM-DD` wire string (Postgres `date`). */
  spentAt: string;
  /** `created_at` epoch-micros. */
  createdMicros: string;
  id: string;
}

/**
 * Optionally-signed ≤ 18 digits ⇒ always a valid, non-overflowing bigint
 * (int64 max is 19 digits; the sign admits pre-1970 instants — the
 * bookings-cursor round-1 A2 lesson).
 */
const MICROS_RE = /^-?\d{1,18}$/;
/** First-pass shape gate; `isCalendarDate` below does the real validation. */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * CALENDAR-exact, not just calendar-shaped (round-1 blocking, two lanes
 * convergent): `2026-02-31` passes the shape RE, binds `::date`, and
 * Postgres answers 22008 → an unhandled 500 on an authed surface. A
 * `Date.UTC` round-trip only equals its inputs when the y/m/d name a real
 * day (JS date rollover turns Feb 31 into Mar 3) — so impossible dates fold
 * to `null`/page-1 exactly as the module doc promises, and nothing
 * non-calendar ever reaches the cast.
 */
function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

export function encodeExpenseCursor(cursor: ExpenseKeysetCursor): string {
  return Buffer.from(`${cursor.spentAt}|${cursor.createdMicros}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/** Decode a client cursor; malformed → `null` (treated as page 1). */
export function decodeExpenseCursor(raw: string): ExpenseKeysetCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;
  const [spentAt, createdMicros, id] = parts as [string, string, string];
  if (!isCalendarDate(spentAt) || !MICROS_RE.test(createdMicros) || !UUID_RE.test(id)) return null;
  return { spentAt, createdMicros, id };
}

/**
 * Row-value predicate for the strictly-older page under
 * `spent_at DESC, created_at DESC, id DESC`, with `created_at` compared in
 * epoch-micros space (full timestamptz precision — no sub-millisecond row
 * skipped). All operands are pre-validated by `decodeExpenseCursor` — the
 * casts are crash-proof.
 */
export function expenseCursorPredicate(cursor: ExpenseKeysetCursor): SQL {
  const createdMicros = epochMicrosExpr(schema.expenses.createdAt);
  return sql`(${schema.expenses.spentAt}, ${createdMicros}, ${schema.expenses.id}) < (${cursor.spentAt}::date, ${cursor.createdMicros}::bigint, ${cursor.id}::uuid)`;
}
