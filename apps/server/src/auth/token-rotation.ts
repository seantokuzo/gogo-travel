/**
 * Refresh-token rotation + reuse-theft detection (T-5.3 / AU-4 —
 * R-auth-10/11). The security spine of the session model.
 *
 * `/auth/refresh` presents an opaque refresh token; we look it up by SHA-256
 * hash (never raw storage, R-auth-9) and branch:
 *
 *   unknown hash                    → 401, no family effect (R-auth-11)
 *   session revoked OR already      → REUSE/THEFT: revoke the whole session
 *     rotated (rotated_at set)        (family) + 401 (R-auth-11 headline)
 *   expired, never rotated          → 401, session NOT revoked (R-auth-11 tail)
 *   otherwise                       → ROTATE atomically (R-auth-10):
 *                                       stamp presented token `rotated_at`,
 *                                       insert its replacement, bump the
 *                                       session's `last_used_at`, mint a fresh
 *                                       access + refresh pair
 *
 * One-time-use is enforced by the conditional stamp
 * (`WHERE id = ? AND rotated_at IS NULL`): it is the atomic compare-and-swap
 * that serializes concurrent presentations of the SAME token. Exactly one
 * caller stamps it; any loser sees 0 rows updated and is treated as theft —
 * the family dies (concurrent refreshes are self-defeating by design, §3.6.1).
 *
 * The whole rotation is ONE transaction on a transaction-capable driver
 * (landmine #1: the Neon HTTP driver would throw — prod runs the WebSocket
 * `Pool`, tests run postgres-js). A partial rotation (old token dead, no
 * replacement) would sign the legitimate device out — atomicity forbids it.
 *
 * Failure posture: all rejections are `RefreshRejectedError`; the route emits
 * one undifferentiated 401 `UNAUTHENTICATED` (no oracle for which branch
 * fired, §3.6.4). No token material rides on any error or log line.
 */
import { and, eq, isNull } from "drizzle-orm";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_MS } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { mintRefreshToken, sha256Hex } from "./crypto.js";
import { revokeSession } from "./session-service.js";
import { signAccessToken, type AccessTokenSigner, type IssuedTokens } from "./token-issuer.js";

export type RefreshRejectionReason =
  | "unknown" // no row for this hash — never issued, or already pruned
  | "expired" // past `expires_at`, never rotated — plain 401, no family revoke
  | "reuse"; // rotated-token replay or revoked-session token — family revoked

export class RefreshRejectedError extends Error {
  readonly reason: RefreshRejectionReason;

  constructor(reason: RefreshRejectionReason) {
    // Fixed message — the wire body never varies (spec §3.6.4).
    super("refresh rejected");
    this.name = "RefreshRejectedError";
    this.reason = reason;
  }
}

/** Internal sentinel: the conditional stamp lost the race → treat as reuse. */
class ConcurrentRotationError extends Error {}

export interface RotateInput {
  presentedToken: string;
  signer: AccessTokenSigner;
  now?: Date;
}

/**
 * Rotate a presented refresh token into a fresh pair, or reject. See the
 * module header for the branch table; `RefreshRejectedError.reason` is for
 * internal logs only — every reason is the same 401 on the wire.
 */
export async function rotateRefreshToken(db: DbClient, input: RotateInput): Promise<IssuedTokens> {
  const now = input.now ?? new Date();
  const presentedHash = sha256Hex(input.presentedToken);

  const [row] = await db
    .select({
      tokenId: schema.refreshTokens.id,
      rotatedAt: schema.refreshTokens.rotatedAt,
      expiresAt: schema.refreshTokens.expiresAt,
      sessionId: schema.authSessions.id,
      userId: schema.authSessions.userId,
      sessionRevokedAt: schema.authSessions.revokedAt,
    })
    .from(schema.refreshTokens)
    .innerJoin(schema.authSessions, eq(schema.authSessions.id, schema.refreshTokens.sessionId))
    .where(eq(schema.refreshTokens.tokenHash, presentedHash))
    .limit(1);

  // Unknown token — no family to revoke (R-auth-11); could be an attacker
  // grinding random strings, or a token we already pruned.
  if (!row) throw new RefreshRejectedError("unknown");

  // Reuse = theft (R-auth-11): a token whose session is already revoked, or a
  // token that was already rotated (its replacement is live). Either way the
  // presenter is not the legitimate holder of the current token → burn the
  // whole family, forcing every device on this session to re-authenticate.
  if (row.sessionRevokedAt !== null || row.rotatedAt !== null) {
    await revokeSession(db, row.sessionId, now);
    throw new RefreshRejectedError("reuse");
  }

  // Expired but never rotated (R-auth-11 tail): the legitimate device simply
  // went idle past the 30-day TTL. Plain 401, session left intact — this is
  // NOT a theft signal.
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new RefreshRejectedError("expired");
  }

  const newRefreshToken = mintRefreshToken();

  let issued: { sessionId: string; userId: string };
  try {
    issued = await db.transaction(async (tx) => {
      // Atomic compare-and-swap: only the caller that flips rotated_at from
      // NULL proceeds. A concurrent presentation of the same token updates
      // 0 rows here → theft-shaped → abort and revoke the family below.
      const stamped = await tx
        .update(schema.refreshTokens)
        .set({ rotatedAt: now })
        .where(
          and(eq(schema.refreshTokens.id, row.tokenId), isNull(schema.refreshTokens.rotatedAt)),
        )
        .returning({ id: schema.refreshTokens.id });
      if (stamped.length === 0) throw new ConcurrentRotationError();

      await tx.insert(schema.refreshTokens).values({
        sessionId: row.sessionId,
        tokenHash: sha256Hex(newRefreshToken),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      });

      // Sliding session (spec §3.2): activity bumps `last_used_at`.
      await tx
        .update(schema.authSessions)
        .set({ lastUsedAt: now })
        .where(eq(schema.authSessions.id, row.sessionId));

      return { sessionId: row.sessionId, userId: row.userId };
    });
  } catch (error) {
    if (error instanceof ConcurrentRotationError) {
      await revokeSession(db, row.sessionId, now);
      throw new RefreshRejectedError("reuse");
    }
    throw error;
  }

  return {
    accessToken: await signAccessToken(input.signer, issued.userId, issued.sessionId, now),
    refreshToken: newRefreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    sessionId: issued.sessionId,
  };
}
