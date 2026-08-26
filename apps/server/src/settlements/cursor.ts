/**
 * Opaque keyset cursor for the settlements list ordering
 * `settled_at DESC, id DESC` (money spec §3.2 S2; `id DESC` is the
 * deterministic tiebreaker — `settled_at` is user-writable and not unique).
 *
 * The shared `http/keyset-cursor.ts` codec covers the server-minted
 * `(created_at DESC, id DESC)` family, whose UNSIGNED micros RE is safe only
 * because `created_at` is always post-1970. `settled_at` is CLIENT-supplied
 * (backdatable, R-money-11 record-only ledger): a pre-1970 instant mints
 * negative epoch-micros, which the shared decoder rejects → silent page-1
 * loop (the bookings-cursor round-1 A2 bug, re-stepped). So this ordering
 * gets its own codec in the same discipline: micros ride as OPTIONALLY-SIGNED
 * integers, malformed cursors decode to `null` → page 1 (opaque server-minted
 * token; no cursor 400 is documented, and validation keeps crafted values out
 * of the `::bigint`/`::uuid` casts — no 500 vector).
 */
import { sql, type SQL } from "drizzle-orm";
import * as schema from "../db/schema/index.js";
import { epochMicrosExpr } from "../http/keyset-cursor.js";
import { UUID_RE } from "../http/require-trip-member.js";

export interface SettlementKeysetCursor {
  /** `settled_at` as exact (possibly negative) microseconds since the epoch. */
  settledMicros: string;
  id: string;
}

/**
 * Optionally-signed ≤ 18 digits ⇒ always a valid, non-overflowing bigint
 * (int64 max is 19 digits). The sign admits pre-1970 `settled_at` instants —
 * without it a legitimate historic settlement mints a cursor its own decoder
 * rejects (see module doc).
 */
const MICROS_RE = /^-?\d{1,18}$/;

export function encodeSettlementCursor(cursor: SettlementKeysetCursor): string {
  return Buffer.from(`${cursor.settledMicros}|${cursor.id}`, "utf8").toString("base64url");
}

/** Decode a client cursor; malformed → `null` (treated as page 1). */
export function decodeSettlementCursor(raw: string): SettlementKeysetCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const settledMicros = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!MICROS_RE.test(settledMicros) || !UUID_RE.test(id)) return null;
  return { settledMicros, id };
}

/**
 * Row-value predicate for the strictly-older page under
 * `settled_at DESC, id DESC`, compared in epoch-micros space (full
 * timestamptz precision — no sub-millisecond row skipped; the shared
 * `epochMicrosExpr` is the ONE formula home, round-1 A4 discipline). Both
 * operands are pre-validated by `decodeSettlementCursor`, so the casts are
 * crash-proof.
 */
export function settlementCursorPredicate(cursor: SettlementKeysetCursor): SQL {
  return sql`(${epochMicrosExpr(schema.settlements.settledAt)}, ${schema.settlements.id}) < (${cursor.settledMicros}::bigint, ${cursor.id}::uuid)`;
}
