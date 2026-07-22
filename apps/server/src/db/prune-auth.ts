/**
 * Auth housekeeping — the prune job pinned by auth-users spec §3.3.2:
 * delete refresh tokens `expires_at < now() - 30d`, and revoked sessions
 * older than 90d (measured from `revoked_at` — retention is "how long we
 * keep the record after it stopped mattering", pairing with the schema
 * spec's stale push-token prune).
 *
 * Callable core only: the scheduling wire-up joins the same housekeeping
 * job family as the push-token (schema spec §3.3.3) and capture-sender
 * (§3.3.27) prunes when that infra lands — nothing here assumes a scheduler.
 *
 * Live rows are untouched by construction: an unexpired token can't match
 * the first delete; a session with `revoked_at IS NULL` can't match the
 * second, no matter how old it is (age alone never signs a device out —
 * idle expiry is the refresh token's 30-day TTL, spec §3.2).
 */
import { and, isNotNull, lt } from "drizzle-orm";
import type { DbClient } from "./create-user.js";
import * as schema from "./schema/index.js";

/** Days past `expires_at` before a refresh-token row is pruned (spec §3.3.2). */
export const EXPIRED_REFRESH_TOKEN_RETENTION_DAYS = 30;
/** Days past `revoked_at` before a revoked session row is pruned (spec §3.3.2). */
export const REVOKED_SESSION_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuthPruneResult {
  /**
   * Rows deleted by the expiry rule only — tokens removed via the
   * session-delete cascade are not counted.
   */
  refreshTokensDeleted: number;
  sessionsDeleted: number;
}

export async function pruneAuthRows(
  db: DbClient,
  now: Date = new Date(),
): Promise<AuthPruneResult> {
  const tokenCutoff = new Date(now.getTime() - EXPIRED_REFRESH_TOKEN_RETENTION_DAYS * DAY_MS);
  const sessionCutoff = new Date(now.getTime() - REVOKED_SESSION_RETENTION_DAYS * DAY_MS);

  const tokens = await db
    .delete(schema.refreshTokens)
    .where(lt(schema.refreshTokens.expiresAt, tokenCutoff))
    .returning({ id: schema.refreshTokens.id });

  // Revoked-session delete cascades the session's remaining refresh tokens
  // (FK ON DELETE CASCADE) — no orphan sweep needed.
  const sessions = await db
    .delete(schema.authSessions)
    .where(
      and(
        isNotNull(schema.authSessions.revokedAt),
        lt(schema.authSessions.revokedAt, sessionCutoff),
      ),
    )
    .returning({ id: schema.authSessions.id });

  return { refreshTokensDeleted: tokens.length, sessionsDeleted: sessions.length };
}
