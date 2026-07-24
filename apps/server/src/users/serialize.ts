/**
 * Row → wire serialization for the users surface (AU-6). Responses are
 * shaped, never raw DB rows (server rule). The full own-profile `User` shape
 * lives in `auth/serialize.ts` (`toUserWire`, shared with sign-in); these are
 * the AU-6 additions.
 */
import type { PaymentHandles, PushToken, UserProfile } from "@gogo/shared/domains/user";
import type * as schema from "../db/schema/index.js";

type UserRow = typeof schema.users.$inferSelect;
type PushTokenRow = typeof schema.pushTokens.$inferSelect;

/**
 * The member-visible `UserProfile` view (`GET /users/:userId`, R-user-4).
 * Handles are deliberately member-visible; `email`, `prefs`, and
 * `forward_email_slug` NEVER appear here — enforced by construction (the
 * shape simply has no such fields).
 */
export function toUserProfileWire(row: UserRow): UserProfile {
  return {
    id: row.id,
    display_name: row.displayName,
    avatar_key: row.avatarKey,
    venmo_username: row.venmoUsername,
    cashtag: row.cashtag,
    paypalme_username: row.paypalmeUsername,
    zelle_handle: row.zelleHandle,
    zelle_display_name: row.zelleDisplayName,
  };
}

/** Current stored handle state (`PATCH /users/me/payment-handles` response). */
export function toPaymentHandlesWire(row: UserRow): PaymentHandles {
  return {
    venmo_username: row.venmoUsername,
    cashtag: row.cashtag,
    paypalme_username: row.paypalmeUsername,
    zelle_handle: row.zelleHandle,
    zelle_display_name: row.zelleDisplayName,
  };
}

/** `PushToken` wire shape (`POST /users/me/push-tokens` response, R-user-8). */
export function toPushTokenWire(row: PushTokenRow): PushToken {
  return {
    id: row.id,
    token: row.token,
    platform: row.platform,
    last_seen_at: row.lastSeenAt.toISOString(),
  };
}
