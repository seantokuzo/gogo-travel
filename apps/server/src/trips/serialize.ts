/**
 * Row → wire serialization for the trips surface (API-TRIPS-1). Responses are
 * shaped, never raw DB rows (server rule). Column-type conventions from
 * `db/schema/_shared.ts`: `numeric` coordinates arrive as STRINGS (converted
 * here, the API boundary), `date` columns as `YYYY-MM-DD` strings (passed
 * through — the wire type, R-shared-11), timestamps as `Date` → ISO strings.
 */
import { inviteUrl } from "@gogo/shared/config/links";
import type {
  Invite,
  InviteListItem,
  InvitePreview,
  InviteState,
  InviteWithUrl,
  MemberListItem,
  TripMember,
} from "@gogo/shared/domains/member";
import type { Trip, TripListItem, TripWithRole } from "@gogo/shared/domains/trip";
import type { TripMemberRole } from "@gogo/shared/enums";
import type * as schema from "../db/schema/index.js";
import { toUserProfileWire } from "../users/serialize.js";

type TripRow = typeof schema.trips.$inferSelect;
type TripMemberRow = typeof schema.tripMembers.$inferSelect;
type InviteRow = typeof schema.invites.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

/**
 * The full `Trip` wire shape. `status` serializes the row's stored value —
 * routes reconcile stored → effective (trips/status.ts) BEFORE serializing,
 * so what crosses the wire is always the §3.4 effective status.
 */
export function toTripWire(row: TripRow): Trip {
  return {
    id: row.id,
    name: row.name,
    destination_name: row.destinationName,
    destination_lat: Number(row.destinationLat),
    destination_lng: Number(row.destinationLng),
    start_date: row.startDate,
    end_date: row.endDate,
    status: row.status,
    status_override: row.statusOverride,
    base_currency: row.baseCurrency,
    budget_cap_cents: row.budgetCapCents,
    theme: row.theme,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `Trip & { role }` — POST /trips and GET /trips/:tripId responses. */
export function toTripWithRoleWire(row: TripRow, role: TripMemberRole): TripWithRole {
  return { ...toTripWire(row), role };
}

/** `GET /trips` list item: `Trip & { role, member_count }` (R-trips-4). */
export function toTripListItemWire(
  row: TripRow,
  role: TripMemberRole,
  memberCount: number,
): TripListItem {
  return { ...toTripWire(row), role, member_count: memberCount };
}

// ---------------------------------------------------------------------------
// Members & invites (API-TRIPS-2/3)
// ---------------------------------------------------------------------------

/** The bare membership row — PATCH role + transfer responses (§3.3). */
export function toTripMemberWire(row: TripMemberRow): TripMember {
  return {
    trip_id: row.tripId,
    user_id: row.userId,
    role: row.role,
    joined_at: row.joinedAt.toISOString(),
  };
}

/**
 * `GET /trips/:tripId/members` item: the member-visible `UserProfile`
 * (payment handles included by design — §3.2 member-list row) + role +
 * joined_at.
 */
export function toMemberListItemWire(member: TripMemberRow, user: UserRow): MemberListItem {
  return {
    user: toUserProfileWire(user),
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
  };
}

/**
 * The `Invite` wire shape. The role narrowing is backed by the DB CHECK
 * (`invites_role_not_owner_ck`) — an owner-granting invite row cannot exist;
 * the throw is a corruption tripwire, not a reachable branch.
 */
export function toInviteWire(row: InviteRow): Invite {
  if (row.role === "owner") {
    throw new Error("invite row grants 'owner' — invites_role_not_owner_ck violated");
  }
  return {
    id: row.id,
    trip_id: row.tripId,
    token: row.token,
    role: row.role,
    created_by: row.createdBy,
    expires_at: row.expiresAt.toISOString(),
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    max_uses: row.maxUses,
    use_count: row.useCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `POST /trips/:tripId/invites` response: `Invite & { url }` (§3.3). */
export function toInviteWithUrlWire(row: InviteRow): InviteWithUrl {
  return { ...toInviteWire(row), url: inviteUrl(row.token) };
}

/**
 * `GET /trips/:tripId/invites` item: `Omit<Invite, "token"> & { state }` —
 * the raw bearer `token` never rides the LIST envelope (T-6.8 security
 * defer): every row carried a live capability the UI never uses. The CREATE
 * response above keeps token+url (the one-shot share-sheet answer).
 */
export function toInviteListItemWire(row: InviteRow, state: InviteState): InviteListItem {
  const { token: _token, ...rest } = toInviteWire(row);
  return { ...rest, state };
}

/**
 * `GET /invites/:token` preview (§3.3): deliberately narrow — NO `trip_id`,
 * no member list, no trip content beyond the join-screen fields. Enforced by
 * construction: the shape has no key that could carry them.
 */
export function toInvitePreviewWire(
  invite: InviteRow,
  trip: TripRow,
  inviter: UserRow,
  state: InviteState,
  alreadyMember: boolean,
): InvitePreview {
  if (invite.role === "owner") {
    throw new Error("invite row grants 'owner' — invites_role_not_owner_ck violated");
  }
  return {
    trip: {
      name: trip.name,
      destination_name: trip.destinationName,
      start_date: trip.startDate,
      end_date: trip.endDate,
    },
    inviter: {
      display_name: inviter.displayName,
      avatar_key: inviter.avatarKey,
    },
    role: invite.role,
    state,
    already_member: alreadyMember,
  };
}
