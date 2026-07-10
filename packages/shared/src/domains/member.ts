/**
 * Trip members & invites (contracts spec §3.4; schema spec §3.3.5/§3.3.6;
 * trips spec §3.3).
 */
import { z } from "zod";
import { TripMemberRoleSchema } from "../enums.js";
import { ISODateTimeSchema, UuidSchema } from "../scalars.js";

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
 * now + 7 days; `max_uses` defaults to unlimited.
 */
export const InviteCreateSchema = z.object({
  role: InviteGrantableRoleSchema,
  expires_at: ISODateTimeSchema.optional(),
  max_uses: z.int().positive().optional(),
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
