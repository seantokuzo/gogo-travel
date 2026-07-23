/**
 * Session lifecycle (T-5.3 / AU-4 — R-auth-11/13).
 *
 * The auth_session IS the family: a device's refresh tokens all hang off one
 * `auth_sessions` row (FK `session_id`). Revoking the session (stamping
 * `revoked_at`) is the family kill — every refresh token under it is
 * thereafter rejected at the refresh boundary (token-rotation.ts checks the
 * session's `revoked_at` first). There is no per-token `revoked_at` column by
 * design (§3.3.2): the session flag + the refresh-time check together satisfy
 * "revoke ... all its refresh tokens" (R-auth-11) without touching each row.
 *
 * All revocation is idempotent (`revoked_at IS NULL` guard) — a re-revoke of
 * an already-dead session is a no-op, never an error.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthSessionInfo } from "@gogo/shared/domains/auth";
import { SESSIONS_PAGE_SIZE } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";

/**
 * Kill a session unconditionally (reuse-theft response, logout, account
 * deletion). Idempotent: already-revoked → 0 rows, still a success. Returns
 * whether this call is the one that flipped it (useful for logging only).
 */
export async function revokeSession(db: DbClient, sessionId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(schema.authSessions)
    .set({ revokedAt: now })
    .where(and(eq(schema.authSessions.id, sessionId), isNull(schema.authSessions.revokedAt)))
    .returning({ id: schema.authSessions.id });
  return rows.length > 0;
}

/**
 * Revoke a session the CALLER owns (remote sign-out; `DELETE
 * /auth/sessions/:id`). The ownership + liveness predicate is the whole
 * security check: a foreign, absent, or already-revoked id all match 0 rows —
 * indistinguishable, so the caller learns nothing about sessions that aren't
 * theirs (R-auth-13 / IDOR posture). Returns false → the route 404s.
 */
export async function revokeOwnedSession(
  db: DbClient,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(schema.authSessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.authSessions.id, sessionId),
        eq(schema.authSessions.userId, userId),
        isNull(schema.authSessions.revokedAt),
      ),
    )
    .returning({ id: schema.authSessions.id });
  return rows.length > 0;
}

/**
 * Opaque keyset cursor over `(created_at, id)` — the page's last row. The
 * timestamp rides as integer epoch-MICROSECONDS, not a JS-Date ISO string: a
 * `Date` is millisecond-precision, so an ISO round-trip truncates the
 * microsecond `timestamptz` and the next-page predicate could skip a row whose
 * true `created_at` falls in the sub-millisecond gap. Micros preserves full
 * precision (and is a plain integer → the `::bigint` cast can never 500).
 */
interface SessionCursor {
  /** `created_at` as exact microseconds since the Unix epoch (see encodeCursor). */
  micros: string;
  id: string;
}

/** Canonical hyphenated UUID — what `defaultRandom()` mints and `::uuid` accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ≤ 18 digits ⇒ always a valid, non-overflowing bigint (int64 max is 19 digits). */
const MICROS_RE = /^\d{1,18}$/;

function encodeCursor(row: { micros: string; id: string }): string {
  return Buffer.from(`${row.micros}|${row.id}`, "utf8").toString("base64url");
}

/**
 * Decode a client cursor; a malformed cursor yields `null` (treated as page 1).
 * The cursor is an opaque, server-minted token — a non-integer `micros` or
 * non-UUID `id` (bad base64, tampering, corruption) is not a distinct error but
 * a fall-back to the first page (the endpoint's only documented error is 401 —
 * spec §3.4.1 lists no 400 for cursors). Validating both parts here is also
 * what keeps the `::bigint`/`::uuid` casts in listUserSessions from ever
 * throwing an `invalid input syntax` 500 on a crafted cursor.
 */
function decodeCursor(cursor: string): SessionCursor | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const micros = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!MICROS_RE.test(micros) || !UUID_RE.test(id)) return null;
  return { micros, id };
}

export interface SessionPage {
  items: AuthSessionInfo[];
  nextCursor: string | null;
}

/**
 * List the caller's live (non-revoked) sessions, newest first, keyset-
 * paginated on `(created_at, id)`. `current` marks the row whose id equals the
 * caller's `sid` claim (spec §3.4.1). Revoked sessions are excluded.
 */
export async function listUserSessions(
  db: DbClient,
  userId: string,
  currentSessionId: string,
  cursor: string | undefined,
): Promise<SessionPage> {
  const decoded = cursor ? decodeCursor(cursor) : null;

  const predicates = [
    eq(schema.authSessions.userId, userId),
    isNull(schema.authSessions.revokedAt),
  ];
  if (decoded) {
    // Row-value keyset for the strictly-older page, compared in epoch-micros
    // space (Postgres 14+ `extract` returns numeric, so ×1e6 → bigint is
    // lossless). This mirrors the `created_at DESC, id DESC` ordering — micros
    // is monotonic in created_at — while carrying full timestamptz precision so
    // no sub-millisecond row is skipped. Both operands are pre-validated
    // (integer / uuid) so the casts are crash-proof, not a 500 vector.
    predicates.push(
      sql`((extract(epoch from ${schema.authSessions.createdAt}) * 1000000)::bigint, ${schema.authSessions.id}) < (${decoded.micros}::bigint, ${decoded.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: schema.authSessions.id,
      deviceName: schema.authSessions.deviceName,
      platform: schema.authSessions.platform,
      createdAt: schema.authSessions.createdAt,
      lastUsedAt: schema.authSessions.lastUsedAt,
      // Exact epoch-microseconds of created_at — the cursor's full-precision
      // sort key. postgres-js returns a bigint column as a string.
      cursorMicros: sql<string>`(extract(epoch from ${schema.authSessions.createdAt}) * 1000000)::bigint`,
    })
    .from(schema.authSessions)
    .where(and(...predicates))
    .orderBy(sql`${schema.authSessions.createdAt} DESC, ${schema.authSessions.id} DESC`)
    .limit(SESSIONS_PAGE_SIZE);

  const items: AuthSessionInfo[] = rows.map((row) => ({
    id: row.id,
    device_name: row.deviceName,
    platform: row.platform,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt.toISOString(),
    current: row.id === currentSessionId,
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === SESSIONS_PAGE_SIZE && last
      ? encodeCursor({ micros: last.cursorMicros, id: last.id })
      : null;

  return { items, nextCursor };
}
