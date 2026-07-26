/**
 * Opaque keyset cursor over `(created_at DESC, id DESC)` — THE one codec for
 * every list endpoint (extracted at T-6.2 from `auth/session-service.ts` and
 * `trips/routes.ts`, which carried identical copies; the invites list is the
 * third consumer).
 *
 * The timestamp rides as integer epoch-MICROSECONDS, not a JS-Date ISO
 * string: a `Date` is millisecond-precision, so an ISO round-trip truncates
 * the microsecond `timestamptz` and the next-page predicate could skip a row
 * whose true `created_at` falls in the sub-millisecond gap. Micros preserves
 * full precision (and is a plain integer → the `::bigint` cast can never 500).
 *
 * A malformed cursor decodes to `null` and callers fall back to page 1: the
 * cursor is an opaque, server-minted token — bad base64, tampering, or
 * corruption is not a distinct error (no list spec documents a cursor 400).
 * Validating both parts here is also what keeps the `::bigint`/`::uuid` casts
 * in the predicate from ever throwing `invalid input syntax` on a crafted
 * cursor — no 500 vector.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { UUID_RE } from "./require-trip-member.js";

export interface KeysetCursor {
  /** `created_at` as exact microseconds since the Unix epoch. */
  micros: string;
  id: string;
}

/** ≤ 18 digits ⇒ always a valid, non-overflowing bigint (int64 max is 19 digits). */
const MICROS_RE = /^\d{1,18}$/;

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  return Buffer.from(`${cursor.micros}|${cursor.id}`, "utf8").toString("base64url");
}

/** Decode a client cursor; malformed → `null` (treated as page 1). */
export function decodeKeysetCursor(raw: string): KeysetCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const micros = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!MICROS_RE.test(micros) || !UUID_RE.test(id)) return null;
  return { micros, id };
}

/**
 * Row-value predicate for the strictly-older page, compared in epoch-micros
 * space (Postgres 14+ `extract` returns numeric, so ×1e6 → bigint is
 * lossless). Mirrors the `created_at DESC, id DESC` ordering — micros is
 * monotonic in created_at — while carrying full timestamptz precision so no
 * sub-millisecond row is skipped. Both operands are pre-validated (integer /
 * uuid) by `decodeKeysetCursor`, so the casts are crash-proof.
 */
export function keysetCursorPredicate(
  createdAtColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  cursor: KeysetCursor,
): SQL {
  return sql`((extract(epoch from ${createdAtColumn}) * 1000000)::bigint, ${idColumn}) < (${cursor.micros}::bigint, ${cursor.id}::uuid)`;
}

/**
 * Select expression for a row's exact epoch-microseconds — the cursor's
 * full-precision sort key. postgres-js returns a bigint column as a string.
 */
export function epochMicrosExpr(createdAtColumn: AnyPgColumn): SQL<string> {
  return sql<string>`(extract(epoch from ${createdAtColumn}) * 1000000)::bigint`;
}
