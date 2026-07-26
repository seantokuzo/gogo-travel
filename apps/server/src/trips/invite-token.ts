/**
 * Invite token generation + lifecycle-state derivation (API-TRIPS-3;
 * R-trips-13/16/17, R-db-9).
 *
 * Token: `INVITE_TOKEN_BYTES` (32) bytes from the platform CSPRNG
 * (`node:crypto.randomBytes`), base64url-encoded — 256 bits of entropy,
 * double the R-db-9 ≥128-bit floor, URL-safe by construction. Uniqueness is
 * the DB's (`invites.token UNIQUE`); at 256 bits a collision is not a real
 * event, so there is no retry loop — a unique-violation would surface as the
 * 500 it deserves.
 *
 * State: computed, never stored (the row's `expires_at`/`revoked_at`/
 * `use_count` are the truth). Precedence when multiple conditions hold is
 * fixed here so every surface (list `state`, preview `state`, accept
 * `details.reason`) answers identically:
 *
 *   revoked > expired > max_uses_reached > active
 *
 * Revocation is an explicit human action and stays the answer even after the
 * expiry date passes (a revoked invite never "relaxes" into merely-expired).
 * The spec fixes the value set (R-trips-16), not the precedence — this
 * ordering is the pinned implementation choice.
 */
import { randomBytes } from "node:crypto";
import type { InviteState } from "@gogo/shared/domains/member";
import { INVITE_TOKEN_BYTES } from "../config.js";
import type * as schema from "../db/schema/index.js";

/** URL-safe, unique, ≥128-bit (R-db-9): 32 CSPRNG bytes → 43 base64url chars. */
export function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
}

/**
 * Shape gate for `:token` route params: base64url charset, bounded length.
 * Anything else can't be a server-minted token → the SAME indistinguishable
 * 404 an unknown token gets (no malformed-vs-unknown oracle), and crafted
 * values never reach the DB lookup.
 */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

type InviteRow = Pick<
  typeof schema.invites.$inferSelect,
  "expiresAt" | "revokedAt" | "maxUses" | "useCount"
>;

/** Derive the lifecycle state at `now` (precedence: module doc). */
export function inviteState(row: InviteRow, now: Date): InviteState {
  if (row.revokedAt !== null) return "revoked";
  // "expires AT": the row is dead from the expiry instant onward.
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.maxUses !== null && row.useCount >= row.maxUses) return "max_uses_reached";
  return "active";
}
