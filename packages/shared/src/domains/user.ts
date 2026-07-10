/**
 * Users domain (contracts spec §3.4 `user.ts`; auth-users spec §3.4.2).
 *
 * Read schemas (`User`, `UserProfile`) are deliberately permissive on handle
 * formats — they describe rows as the API returns them. Write schemas
 * (`PaymentHandlesUpdate`, `UserUpdate`) normalize and validate.
 */
import { z } from "zod";
import { CurrencyCodeSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";
import {
  NotificationCategorySchema,
  PushPlatformSchema,
  TravelStyleSchema,
  type TravelStyle,
} from "../enums.js";

export const UNITS = ["metric", "imperial"] as const;
export const UnitsSchema = z.enum(UNITS);
export type Units = z.infer<typeof UnitsSchema>;

// ---------------------------------------------------------------------------
// Preferences (users.prefs JSONB — schema spec §3.4.6)
// ---------------------------------------------------------------------------

/**
 * `travel_style` is multi-tag from the fixed, append-only `TRAVEL_STYLES`
 * tuple. `notifications`: an absent key means enabled (notifications spec
 * §3.2). Unknown keys are stripped on parse (R-shared-10 / R-db-17).
 */
export const UserPrefsSchema = z.object({
  travel_style: z.array(TravelStyleSchema).optional(),
  home_currency: CurrencyCodeSchema.optional(),
  units: UnitsSchema.optional(),
  notifications: z.partialRecord(NotificationCategorySchema, z.boolean()).optional(),
});
export type UserPrefs = z.infer<typeof UserPrefsSchema>;

/**
 * Canonical AI-cache-key serialization of `travel_style` (contracts spec
 * §3.4, Gate 2): sorted unique tags joined with `+`; empty/unset → `'any'`
 * — tag order can never fork the cache.
 */
export function canonicalizeTravelStyles(tags: readonly TravelStyle[] | undefined): string {
  if (!tags || tags.length === 0) return "any";
  return [...new Set(tags)].sort().join("+");
}

// ---------------------------------------------------------------------------
// Payment handles (the settle-up spine)
// ---------------------------------------------------------------------------

const trimmedString = z.string().trim().min(1);

/** Venmo `recipients=` takes bare usernames — leading `@` stripped on write. */
export const VenmoUsernameWriteSchema = trimmedString.transform((v) => v.replace(/^@+/, ""));

/** Cashtags are stored without `$`. */
export const CashtagWriteSchema = trimmedString.transform((v) => v.replace(/^\$+/, ""));

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/** Zelle has no deeplink — the handle is an email or US phone (E.164). */
export const ZelleHandleWriteSchema = z.union([z.email(), z.string().regex(E164_REGEX)]);

const zellePairRule = (
  val: {
    zelle_handle?: string | null | undefined;
    zelle_display_name?: string | null | undefined;
  },
  ctx: z.core.$RefinementCtx,
): void => {
  if (typeof val.zelle_handle === "string" && typeof val.zelle_display_name !== "string") {
    ctx.addIssue({
      code: "custom",
      message: "zelle_display_name is required when zelle_handle is set",
      path: ["zelle_display_name"],
    });
  }
};

/** Stored state, as returned by `PATCH /users/me/payment-handles`. */
export const PaymentHandlesSchema = z
  .object({
    venmo_username: z.string().nullable(),
    cashtag: z.string().nullable(),
    paypalme_username: z.string().nullable(),
    zelle_handle: z.string().nullable(),
    zelle_display_name: z.string().nullable(),
  })
  .superRefine(zellePairRule);
export type PaymentHandles = z.infer<typeof PaymentHandlesSchema>;

/**
 * Write shape: absent = untouched, `null` = clear (auth-users spec §3.4.2).
 * Normalization runs here — `@`/`$` prefixes are stripped before validation
 * and storage; Zelle handles must be email-or-E.164 with a display name in
 * the same payload.
 */
export const PaymentHandlesUpdateSchema = z
  .object({
    venmo_username: VenmoUsernameWriteSchema.nullable().optional(),
    cashtag: CashtagWriteSchema.nullable().optional(),
    paypalme_username: trimmedString.nullable().optional(),
    zelle_handle: ZelleHandleWriteSchema.nullable().optional(),
    zelle_display_name: trimmedString.nullable().optional(),
  })
  .superRefine(zellePairRule);
export type PaymentHandlesUpdate = z.infer<typeof PaymentHandlesUpdateSchema>;

// ---------------------------------------------------------------------------
// User (own profile) & UserProfile (member-visible view)
// ---------------------------------------------------------------------------

/** The caller's full profile — `GET /users/me`. */
export const UserSchema = z.object({
  id: UuidSchema,
  email: z.string(),
  display_name: z.string(),
  avatar_key: z.string().nullable(),
  prefs: UserPrefsSchema,
  venmo_username: z.string().nullable(),
  cashtag: z.string().nullable(),
  paypalme_username: z.string().nullable(),
  zelle_handle: z.string().nullable(),
  zelle_display_name: z.string().nullable(),
  forward_email_slug: z.string().nullable(),
  created_at: ISODateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

/**
 * What other trip members see (`GET /users/:userId`). Payment handles are
 * deliberately member-visible — settle-up renders the payee's buttons from
 * them. NEVER includes `email`, `prefs`, or `forward_email_slug`.
 */
export const UserProfileSchema = z.object({
  id: UuidSchema,
  display_name: z.string(),
  avatar_key: z.string().nullable(),
  venmo_username: z.string().nullable(),
  cashtag: z.string().nullable(),
  paypalme_username: z.string().nullable(),
  zelle_handle: z.string().nullable(),
  zelle_display_name: z.string().nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ---------------------------------------------------------------------------
// Profile writes (auth-users spec §3.4.2)
// ---------------------------------------------------------------------------

const CONTROL_CHARS_REGEX = /[\p{Cc}]/u;

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((v) => !CONTROL_CHARS_REGEX.test(v), { message: "control characters are not allowed" });

/** `PATCH /users/me` — `prefs` is a whole-object replace, unknown keys stripped. */
export const UserUpdateSchema = z.object({
  display_name: DisplayNameSchema.optional(),
  prefs: UserPrefsSchema.optional(),
  /** Server-issued key only (R-user-3); `null` clears. */
  avatar_key: z.string().min(1).nullable().optional(),
});
export type UserUpdate = z.infer<typeof UserUpdateSchema>;

// ---------------------------------------------------------------------------
// Avatar upload (provider-agnostic presign contract)
// ---------------------------------------------------------------------------

export const AVATAR_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AvatarContentTypeSchema = z.enum(AVATAR_CONTENT_TYPES);
export type AvatarContentType = z.infer<typeof AvatarContentTypeSchema>;

/** 5 MB — `byte_size` above this is 413 `PAYLOAD_TOO_LARGE` (auth spec §3.4.2). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const AvatarUploadRequestSchema = z.object({
  content_type: AvatarContentTypeSchema,
  byte_size: z.int().positive(),
});
export type AvatarUploadRequest = z.infer<typeof AvatarUploadRequestSchema>;

export const AvatarUploadTicketSchema = z.object({
  upload_url: z.url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  storage_key: z.string().min(1),
  expires_at: ISODateTimeSchema,
});
export type AvatarUploadTicket = z.infer<typeof AvatarUploadTicketSchema>;

// ---------------------------------------------------------------------------
// Push tokens (auth-users spec §3.4.2)
// ---------------------------------------------------------------------------

export const PushTokenCreateSchema = z.object({
  token: z.string().min(1),
  platform: PushPlatformSchema,
});
export type PushTokenCreate = z.infer<typeof PushTokenCreateSchema>;

export const PushTokenSchema = z.object({
  id: UuidSchema,
  token: z.string(),
  platform: PushPlatformSchema,
  last_seen_at: ISODateTimeSchema,
});
export type PushToken = z.infer<typeof PushTokenSchema>;
