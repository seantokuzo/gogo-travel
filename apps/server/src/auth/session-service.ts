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
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  epochMicrosExpr,
  keysetCursorPredicate,
} from "../http/keyset-cursor.js";

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

// Keyset cursor: the shared `http/keyset-cursor.ts` codec (micros + id,
// malformed → page-1 fallback — the endpoint's only documented error is 401,
// spec §3.4.1 lists no 400 for cursors). Extracted at T-6.2; behavior
// unchanged.

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
  const decoded = cursor ? decodeKeysetCursor(cursor) : null;

  const predicates = [
    eq(schema.authSessions.userId, userId),
    isNull(schema.authSessions.revokedAt),
  ];
  if (decoded) {
    predicates.push(
      keysetCursorPredicate(schema.authSessions.createdAt, schema.authSessions.id, decoded),
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
      cursorMicros: epochMicrosExpr(schema.authSessions.createdAt),
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
      ? encodeKeysetCursor({ micros: last.cursorMicros, id: last.id })
      : null;

  return { items, nextCursor };
}
