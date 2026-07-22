/**
 * Row → wire serialization for the auth surface (T-5.2). Responses are
 * shaped, never raw DB rows (server rule) — camelCase columns become the
 * shared contract's snake_case, timestamps become ISO-8601 strings
 * (R-shared-11), and `prefs` re-parses through the shared schema so unknown
 * keys can never leak outward.
 */
import { UserPrefsSchema, type User } from "@gogo/shared/domains/user";
import type * as schema from "../db/schema/index.js";

type UserRow = typeof schema.users.$inferSelect;

/** The full own-profile `User` shape (`SignInResponse.user`, `GET /users/me`). */
export function toUserWire(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    display_name: row.displayName,
    avatar_key: row.avatarKey,
    prefs: UserPrefsSchema.parse(row.prefs),
    venmo_username: row.venmoUsername,
    cashtag: row.cashtag,
    paypalme_username: row.paypalmeUsername,
    zelle_handle: row.zelleHandle,
    zelle_display_name: row.zelleDisplayName,
    forward_email_slug: row.forwardEmailSlug,
    created_at: row.createdAt.toISOString(),
  };
}
