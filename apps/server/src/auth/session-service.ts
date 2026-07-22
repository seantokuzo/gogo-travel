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

/** Opaque keyset cursor over `(created_at, id)` — the page's last row. */
interface SessionCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

/** Decode a client cursor; a malformed cursor yields `null` (treated as page 1). */
function decodeCursor(cursor: string): SessionCursor | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const sep = decoded.indexOf("|");
  if (sep === -1) return null;
  const createdAt = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
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
    // Row-value keyset: strictly older page. Types pinned via casts so param
    // inference can't drift (uuid vs text, timestamptz vs unknown-literal).
    predicates.push(
      sql`(${schema.authSessions.createdAt}, ${schema.authSessions.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: schema.authSessions.id,
      deviceName: schema.authSessions.deviceName,
      platform: schema.authSessions.platform,
      createdAt: schema.authSessions.createdAt,
      lastUsedAt: schema.authSessions.lastUsedAt,
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
  const nextCursor = rows.length === SESSIONS_PAGE_SIZE && last ? encodeCursor(last) : null;

  return { items, nextCursor };
}
