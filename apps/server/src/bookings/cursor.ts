/**
 * Opaque keyset cursor for the bookings list ordering
 * `starts_at ASC NULLS LAST, updated_at DESC, id DESC` (§3.4 GET bookings;
 * `id DESC` is the deterministic tiebreaker — `updated_at` alone is not
 * unique under bulk writes).
 *
 * The shared `http/keyset-cursor.ts` codec covers the one-timestamp
 * `(created_at DESC, id DESC)` family; this ordering needs a THREE-part key
 * with a NULLABLE leading column, so it gets its own codec in the same
 * discipline: timestamps ride as integer epoch-MICROSECONDS (a JS-Date ISO
 * round-trip truncates the microsecond `timestamptz` — µs landmine), the
 * NULLS-LAST tail is encoded as a literal `-` sentinel, and a malformed
 * cursor decodes to `null` → page 1 (opaque server-minted token; no cursor
 * 400 is documented, and validation keeps crafted values out of the
 * `::bigint`/`::uuid` casts — no 500 vector).
 */
import { sql, type SQL } from "drizzle-orm";
import { UUID_RE } from "../http/require-trip-member.js";
import { epochMicrosExpr } from "../http/keyset-cursor.js";
import * as schema from "../db/schema/index.js";

export interface BookingKeysetCursor {
  /** `starts_at` epoch-micros, or `null` — the row sat in the NULLS LAST tail. */
  startsMicros: string | null;
  /** `updated_at` epoch-micros. */
  updatedMicros: string;
  id: string;
}

/** ≤ 18 digits ⇒ always a valid, non-overflowing bigint (int64 max is 19 digits). */
const MICROS_RE = /^\d{1,18}$/;
/** The encoded NULL sentinel for the `starts_at` part. */
const NULL_SENTINEL = "-";

export function encodeBookingCursor(cursor: BookingKeysetCursor): string {
  const starts = cursor.startsMicros ?? NULL_SENTINEL;
  return Buffer.from(`${starts}|${cursor.updatedMicros}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/** Decode a client cursor; malformed → `null` (treated as page 1). */
export function decodeBookingCursor(raw: string): BookingKeysetCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split("|");
  if (parts.length !== 3) return null;
  const [starts, updatedMicros, id] = parts as [string, string, string];
  if (starts !== NULL_SENTINEL && !MICROS_RE.test(starts)) return null;
  if (!MICROS_RE.test(updatedMicros) || !UUID_RE.test(id)) return null;
  return {
    startsMicros: starts === NULL_SENTINEL ? null : starts,
    updatedMicros,
    id,
  };
}

/**
 * Predicate for the strictly-later page under
 * `starts_at ASC NULLS LAST, updated_at DESC, id DESC`, compared in
 * epoch-micros space (full timestamptz precision — no sub-millisecond row
 * skipped). Two regions:
 *
 *  - cursor in the timed region: later rows have a LATER `starts_at`, or the
 *    SAME `starts_at` with a smaller `(updated_at, id)`, or sit in the NULL
 *    tail entirely;
 *  - cursor in the NULL tail: later rows are NULL-tail rows with a smaller
 *    `(updated_at, id)`.
 *
 * All operands are pre-validated by `decodeBookingCursor` — casts are
 * crash-proof.
 */
export function bookingCursorPredicate(cursor: BookingKeysetCursor): SQL {
  const startsMicros = epochMicrosExpr(schema.bookings.startsAt);
  const updatedMicros = epochMicrosExpr(schema.bookings.updatedAt);
  const updatedIdTail = sql`(${updatedMicros}, ${schema.bookings.id}) < (${cursor.updatedMicros}::bigint, ${cursor.id}::uuid)`;

  if (cursor.startsMicros === null) {
    return sql`(${schema.bookings.startsAt} IS NULL AND ${updatedIdTail})`;
  }
  return sql`((${schema.bookings.startsAt} IS NOT NULL AND (${startsMicros} > ${cursor.startsMicros}::bigint OR (${startsMicros} = ${cursor.startsMicros}::bigint AND ${updatedIdTail}))) OR ${schema.bookings.startsAt} IS NULL)`;
}
