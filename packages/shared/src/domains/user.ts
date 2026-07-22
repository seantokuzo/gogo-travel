/**
 * Users domain (contracts spec §3.4 `user.ts`; auth-users spec §3.4.2).
 *
 * Read schemas (`User`, `UserProfile`) are deliberately permissive on handle
 * formats — they describe rows as the API returns them. Write schemas
 * (`PaymentHandlesUpdate`, `UserUpdate`) normalize and validate.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { NoContentSchema } from "../api/envelope.js";
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

/**
 * Post-normalization handle constraint. Handles exist to be interpolated
 * into rail deeplinks (venmo/cashapp/paypal.me), so this write schema is the
 * single chokepoint: 1–30 chars of `[A-Za-z0-9_.-]` — no `&`, `=`, `/`,
 * `?`, `#`, whitespace, or full URLs can ever reach storage.
 */
const normalizedHandle = z
  .string()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9_.-]+$/, {
    message: "handle may only contain letters, digits, '_', '.', and '-'",
  });

/**
 * Venmo `recipients=` takes bare usernames — leading `@` is stripped FIRST,
 * then the bare name is validated (normalize-then-validate: a lone `@`
 * strips to empty and fails `min(1)`).
 */
export const VenmoUsernameWriteSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@+/, ""))
  .pipe(normalizedHandle);

/** Cashtags are stored without `$` — leading `$` stripped, THEN validated. */
export const CashtagWriteSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/^\$+/, ""))
  .pipe(normalizedHandle);

/** PayPal.me slug — no prefix to strip; same charset chokepoint. */
export const PaypalMeUsernameWriteSchema = z.string().trim().pipe(normalizedHandle);

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
 * Rail handles normalize THEN validate: leading `@`/`$` prefixes are
 * stripped first, and the stripped result must satisfy the 1–30-char
 * `[A-Za-z0-9_.-]` charset — parameter-injection payloads (`&`, `=`, URLs,
 * whitespace) are unrepresentable in storage. Zelle handles must be
 * email-or-E.164 with a display name in the same payload.
 *
 * NOTE (server — AU-4): `zellePairRule` only sees THIS payload. A partial
 * update like `{ zelle_display_name: null }` can strand a stored
 * `zelle_handle` without a display name; the server must cross-check the
 * MERGED row (stored state + patch) before persisting.
 */
export const PaymentHandlesUpdateSchema = z
  .object({
    venmo_username: VenmoUsernameWriteSchema.nullable().optional(),
    cashtag: CashtagWriteSchema.nullable().optional(),
    paypalme_username: PaypalMeUsernameWriteSchema.nullable().optional(),
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

// ---------------------------------------------------------------------------
// Endpoint descriptors (auth-users spec §3.4.2; contracts spec §3.6)
// ---------------------------------------------------------------------------

/**
 * Machine-readable mirror of the users/profile routes. All run behind
 * `requireAuth` (R-authz-1); `/users/me/*` routes address the token's `sub`
 * only — there is no user parameter to reach another account.
 */
export const userEndpoints = {
  /** The caller's full profile — never another principal's (R-user-1). */
  getMe: {
    method: "GET",
    path: "/users/me",
    response: UserSchema,
  },
  /** Only `display_name`/`prefs`/`avatar_key` are client-writable (R-user-2/3). */
  updateMe: {
    method: "PATCH",
    path: "/users/me",
    body: UserUpdateSchema,
    response: UserSchema,
  },
  /** Presign ticket via the `ObjectStorage` port (R-user-3; rate-limited). */
  requestAvatarUpload: {
    method: "POST",
    path: "/users/me/avatar-upload",
    body: AvatarUploadRequestSchema,
    response: AvatarUploadTicketSchema,
  },
  /** Normalize-then-validate rails; cashtag HEAD check fail-open (R-user-5..7). */
  updatePaymentHandles: {
    method: "PATCH",
    path: "/users/me/payment-handles",
    body: PaymentHandlesUpdateSchema,
    response: PaymentHandlesSchema,
  },
  /**
   * Member-visible view — requires ≥1 shared trip, else 404 indistinguishable
   * from a nonexistent user (R-user-4).
   */
  getUserProfile: {
    method: "GET",
    path: "/users/:userId",
    params: z.object({ userId: UuidSchema }),
    response: UserProfileSchema,
  },
  /** Upsert on the unique `token` — foreign-owned tokens MOVE (R-user-8). */
  registerPushToken: {
    method: "POST",
    path: "/users/me/push-tokens",
    body: PushTokenCreateSchema,
    response: PushTokenSchema,
  },
  /** 204; absent-or-foreign ids are an indistinguishable 404 (R-user-8). */
  deletePushToken: {
    method: "DELETE",
    path: "/users/me/push-tokens/:pushTokenId",
    params: z.object({ pushTokenId: UuidSchema }),
    response: NoContentSchema,
  },
  /** 204. Account deletion — fixed effects + soft-delete disposition (R-user-9). */
  deleteMe: {
    method: "DELETE",
    path: "/users/me",
    response: NoContentSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
