/**
 * Trip members & invites (contracts spec §3.4; schema spec §3.3.5/§3.3.6;
 * trips spec §3.3). This module is the canonical home for the members/invites
 * wire family (contracts §3.1: `member.ts` — TripMember, Invite,
 * InviteCreate/Accept); the T-6.2 companion-spec additions (`InvitePreview`,
 * `OwnershipTransfer`, list shapes, descriptors) land here for the same
 * reason — trips spec §3.3 assigns them to `domains/{trip,member}` and the
 * member/invite family lives in `member.ts`.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
import { TripMemberRoleSchema } from "../enums.js";
import { ISODateSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";
import { UserProfileSchema } from "./user.js";

export const TripMemberSchema = z.object({
  trip_id: UuidSchema,
  user_id: UuidSchema,
  role: TripMemberRoleSchema,
  joined_at: ISODateTimeSchema,
});
export type TripMember = z.infer<typeof TripMemberSchema>;

/** Invites grant editor/viewer only — `CHECK (role <> 'owner')` mirror. */
export const INVITE_GRANTABLE_ROLES = ["editor", "viewer"] as const;
export const InviteGrantableRoleSchema = z.enum(INVITE_GRANTABLE_ROLES);
export type InviteGrantableRole = z.infer<typeof InviteGrantableRoleSchema>;

/** The `invites` row. Shareable multi-use group links (Gate 2). */
export const InviteSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  /** ≥128-bit entropy, URL-safe, unique (R-db-9). */
  token: z.string().min(1),
  role: InviteGrantableRoleSchema,
  created_by: UuidSchema,
  expires_at: ISODateTimeSchema,
  revoked_at: ISODateTimeSchema.nullable(),
  /** null = unlimited until expiry (the default). */
  max_uses: z.int().positive().nullable(),
  use_count: z.int().nonnegative(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

/**
 * `POST /trips/:tripId/invites` — `expires_at` defaults server-side to
 * now + 7 days; `max_uses` defaults to unlimited. `max_uses` is capped at
 * int32 max — a purely technical bound (the column is a Postgres `integer`;
 * an uncapped `z.int()` admits 2^53 and turns into a driver overflow 500):
 * client-writable inputs get explicit caps (T-6.1 round-1 convention).
 */
export const InviteCreateSchema = z.object({
  role: InviteGrantableRoleSchema,
  expires_at: ISODateTimeSchema.optional(),
  max_uses: z.int().positive().max(2_147_483_647).optional(),
});
export type InviteCreate = z.infer<typeof InviteCreateSchema>;

/** `POST /invites/:token/accept` response (trips spec §3.3). */
export const InviteAcceptSchema = z.object({
  trip_id: UuidSchema,
  role: TripMemberRoleSchema,
  joined_at: ISODateTimeSchema,
  already_member: z.boolean(),
});
export type InviteAccept = z.infer<typeof InviteAcceptSchema>;

// ---------------------------------------------------------------------------
// T-6.2 additions (trips spec §3.3 companion shapes — API-TRIPS-2/3)
// ---------------------------------------------------------------------------

/**
 * Invite lifecycle state (trips spec §3.3 `GET /trips/:tripId/invites` +
 * `GET /invites/:token`; R-trips-16's `details.reason` values are the dead
 * subset). Wire-only enum — the state is computed, never stored.
 */
export const INVITE_STATES = ["active", "expired", "revoked", "max_uses_reached"] as const;
export const InviteStateSchema = z.enum(INVITE_STATES);
export type InviteState = z.infer<typeof InviteStateSchema>;

/**
 * `GET /trips/:tripId/members` item (trips spec §3.3): the member-visible
 * `UserProfile` (payment handles deliberately member-visible — settle-up),
 * plus role + joined_at.
 */
export const MemberListItemSchema = z.object({
  user: UserProfileSchema,
  role: TripMemberRoleSchema,
  joined_at: ISODateTimeSchema,
});
export type MemberListItem = z.infer<typeof MemberListItemSchema>;

/**
 * `GET /trips/:tripId/members` response — a plain `{ items }` per spec §3.3
 * (deliberately NOT `Paginated<T>`: the spec shape carries no cursor; trip
 * groups are small, §3.5 rule 5).
 */
export const MemberListSchema = z.object({
  items: z.array(MemberListItemSchema),
});
export type MemberList = z.infer<typeof MemberListSchema>;

/**
 * `PATCH /trips/:tripId/members/:userId` body — editor ↔ viewer only.
 * `'owner'` is unrepresentable here (R-trips-9: ownership moves ONLY through
 * the transfer endpoint), reusing the same grantable-role tuple the invites
 * CHECK mirrors.
 */
export const MemberRoleUpdateSchema = z.object({
  role: InviteGrantableRoleSchema,
});
export type MemberRoleUpdate = z.infer<typeof MemberRoleUpdateSchema>;

/** `POST /trips/:tripId/transfer-ownership` body (R-trips-10). */
export const OwnershipTransferSchema = z.object({
  to_user_id: UuidSchema,
});
export type OwnershipTransfer = z.infer<typeof OwnershipTransferSchema>;

/**
 * Transfer response: BOTH updated member rows (demoted old owner + promoted
 * new owner) — mutations return rows (R-trips-19).
 */
export const OwnershipTransferResultSchema = z.object({
  items: z.array(TripMemberSchema),
});
export type OwnershipTransferResult = z.infer<typeof OwnershipTransferResultSchema>;

/** `POST /trips/:tripId/invites` response — the row plus its shareable link. */
export const InviteWithUrlSchema = InviteSchema.extend({
  /** `https://<LINK_DOMAIN>/invite/<token>` (nav §2.3 registry; config/links). */
  url: z.url(),
});
export type InviteWithUrl = z.infer<typeof InviteWithUrlSchema>;

/**
 * `GET /trips/:tripId/invites` item — active and dead invites, flagged.
 * The raw bearer `token` is DROPPED from the list envelope (T-6.8 security
 * defer, landed with T-7.1): every list row carried a live capability the
 * UI never uses — id/role/expiry/counts suffice to render and revoke. The
 * CREATE response (`InviteWithUrl`) keeps token+url: that one-shot answer
 * is what feeds the share sheet.
 */
export const InviteListItemSchema = InviteSchema.omit({ token: true }).extend({
  state: InviteStateSchema,
});
export type InviteListItem = z.infer<typeof InviteListItemSchema>;

/**
 * `GET /invites/:token` — the join-screen preview (trips spec §3.3).
 * Deliberately excludes `trip_id`, the member list, and ALL trip content
 * until acceptance: the token holder learns only what the join screen shows.
 * Optionality mirrors the spec shape; the server always sends dates (trips
 * require them at creation, Gate 2) and a nullable `avatar_key`.
 */
export const InvitePreviewSchema = z.object({
  trip: z.object({
    name: z.string(),
    destination_name: z.string(),
    start_date: ISODateSchema.optional(),
    end_date: ISODateSchema.optional(),
  }),
  inviter: z.object({
    display_name: z.string(),
    avatar_key: z.string().nullable().optional(),
  }),
  role: InviteGrantableRoleSchema,
  state: InviteStateSchema,
  already_member: z.boolean(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (trips spec §3.3; contracts spec §3.6)
// ---------------------------------------------------------------------------

const tripIdParams = z.object({ tripId: UuidSchema });
const memberParams = z.object({ tripId: UuidSchema, userId: UuidSchema });

/**
 * Members surface (API-TRIPS-2). All `/trips/:tripId/*` routes sit behind the
 * membership gate — a non-member's 404 is indistinguishable from an absent
 * trip (R-trips-1, IDOR posture); §3.2 rows tighten per route.
 */
export const memberEndpoints = {
  /** All members with roles + member-visible profiles (§3.2 "View member list"). */
  listMembers: {
    method: "GET",
    path: "/trips/:tripId/members",
    params: tripIdParams,
    response: MemberListSchema,
  },
  /** Owner-only editor↔viewer flip; never grants/revokes `owner` (R-trips-9). */
  updateMemberRole: {
    method: "PATCH",
    path: "/trips/:tripId/members/:userId",
    params: memberParams,
    body: MemberRoleUpdateSchema,
    response: TripMemberSchema,
  },
  /** Owner removes others; any member leaves self; owner leave → 409 (R-trips-11). */
  removeMember: {
    method: "DELETE",
    path: "/trips/:tripId/members/:userId",
    params: memberParams,
    response: NoContentSchema,
  },
  /** Demote + promote in ONE transaction (R-trips-10); owner-only. */
  transferOwnership: {
    method: "POST",
    path: "/trips/:tripId/transfer-ownership",
    params: tripIdParams,
    body: OwnershipTransferSchema,
    response: OwnershipTransferResultSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;

/**
 * Invites surface (API-TRIPS-3). Trip-scoped routes are membership-gated;
 * the token routes are capability-addressed (any authenticated holder) and
 * rate-limited (token-guessing guard, §3.3).
 */
export const inviteEndpoints = {
  /** Owner/editor; grantable role ≤ own, never `owner` (R-trips-13). */
  createInvite: {
    method: "POST",
    path: "/trips/:tripId/invites",
    params: tripIdParams,
    body: InviteCreateSchema,
    response: InviteWithUrlSchema,
  },
  /** Active and dead invites, flagged with computed `state` (R-trips-13/17). */
  listInvites: {
    method: "GET",
    path: "/trips/:tripId/invites",
    params: tripIdParams,
    query: CursorQuerySchema,
    response: paginatedSchema(InviteListItemSchema),
  },
  /** Sets `revoked_at`; rows are never deleted as a revocation path (R-trips-17). */
  revokeInvite: {
    method: "DELETE",
    path: "/trips/:tripId/invites/:inviteId",
    params: z.object({ tripId: UuidSchema, inviteId: UuidSchema }),
    response: NoContentSchema,
  },
  /** Join-screen preview; token is the capability (R-trips-16). */
  previewInvite: {
    method: "GET",
    path: "/invites/:token",
    params: z.object({ token: z.string().min(1).max(128) }),
    response: InvitePreviewSchema,
  },
  /** Race-safe acceptance transaction (R-trips-14/15/16). */
  acceptInvite: {
    method: "POST",
    path: "/invites/:token/accept",
    params: z.object({ token: z.string().min(1).max(128) }),
    response: InviteAcceptSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
