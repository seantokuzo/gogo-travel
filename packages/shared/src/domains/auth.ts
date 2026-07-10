/**
 * Auth domain (contracts spec §3.4 `auth.ts`; auth-users spec §3.4.1/§3.7).
 *
 * Server-only material (JWT claims, token hashes, ciphertext) deliberately
 * has NO shared schema — it never crosses the wire.
 */
import { z } from "zod";
import { PushPlatformSchema } from "../enums.js";
import { ISODateTimeSchema, UuidSchema } from "../scalars.js";
import { UserSchema } from "./user.js";

export const DeviceInfoSchema = z.object({
  device_name: z.string().optional(),
  platform: PushPlatformSchema,
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/**
 * `POST /auth/apple`. Name fields arrive on first Apple authorization only —
 * the client forwards them or they're gone (R-auth-5).
 */
export const AppleSignInRequestSchema = z.object({
  identity_token: z.string().min(1),
  authorization_code: z.string().min(1),
  raw_nonce: z.string().min(1),
  device: DeviceInfoSchema,
  given_name: z.string().optional(),
  family_name: z.string().optional(),
});
export type AppleSignInRequest = z.infer<typeof AppleSignInRequestSchema>;

/** `POST /auth/google`. */
export const GoogleSignInRequestSchema = z.object({
  id_token: z.string().min(1),
  raw_nonce: z.string().min(1),
  device: DeviceInfoSchema,
});
export type GoogleSignInRequest = z.infer<typeof GoogleSignInRequestSchema>;

/** `POST /auth/refresh` — the refresh token IS the credential. */
export const RefreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** `expires_in` is seconds (= `ACCESS_TOKEN_TTL`). */
export const AuthTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.int().positive(),
});
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

export const SignInResponseSchema = z.object({
  user: UserSchema,
  tokens: AuthTokensSchema,
  is_new_user: z.boolean(),
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

/** `POST /auth/logout` — optionally deregisters this device's push token. */
export const LogoutRequestSchema = z.object({
  push_token_id: UuidSchema.optional(),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

/** `GET /auth/sessions` item — `current` = matches the caller's `sid`. */
export const AuthSessionInfoSchema = z.object({
  id: UuidSchema,
  device_name: z.string().nullable(),
  platform: PushPlatformSchema,
  created_at: ISODateTimeSchema,
  last_used_at: ISODateTimeSchema,
  current: z.boolean(),
});
export type AuthSessionInfo = z.infer<typeof AuthSessionInfoSchema>;
