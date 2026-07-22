/**
 * Auth domain (contracts spec §3.4 `auth.ts`; auth-users spec §3.4.1/§3.7).
 *
 * Server-only material (JWT claims, token hashes, ciphertext) deliberately
 * has NO shared schema — it never crosses the wire.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
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

// ---------------------------------------------------------------------------
// Endpoint descriptors (auth-users spec §3.4.1; contracts spec §3.6)
// ---------------------------------------------------------------------------

/**
 * Machine-readable mirror of the auth routes. `apps/server` types its
 * `@hono/zod-validator` middleware from these; `apps/mobile` generates
 * TanStack Query hooks from them over the injected `ApiClient`.
 *
 * The three sign-in/refresh routes plus the health check are the ENTIRE
 * public allowlist (R-authz-1) — everything else in the app runs behind
 * `requireAuth`.
 */
export const authEndpoints = {
  /** Public (rate-limited). R-auth-1, R-auth-3..8, R-auth-14, R-auth-15. */
  appleSignIn: {
    method: "POST",
    path: "/auth/apple",
    body: AppleSignInRequestSchema,
    response: SignInResponseSchema,
  },
  /** Public (rate-limited). R-auth-2..6, R-auth-8, R-auth-14, R-auth-15. */
  googleSignIn: {
    method: "POST",
    path: "/auth/google",
    body: GoogleSignInRequestSchema,
    response: SignInResponseSchema,
  },
  /** Public — the refresh token IS the credential. R-auth-8..11, R-auth-14. */
  refresh: {
    method: "POST",
    path: "/auth/refresh",
    body: RefreshRequestSchema,
    response: AuthTokensSchema,
  },
  /** Auth required. 204. R-auth-13, R-user-8. */
  logout: {
    method: "POST",
    path: "/auth/logout",
    body: LogoutRequestSchema,
    response: NoContentSchema,
  },
  /** Auth required. Revoked sessions excluded. R-auth-13. */
  listSessions: {
    method: "GET",
    path: "/auth/sessions",
    query: CursorQuerySchema,
    response: paginatedSchema(AuthSessionInfoSchema),
  },
  /**
   * Auth required. 204; absent / already-revoked / foreign session ids are an
   * indistinguishable 404 (R-auth-13). R-auth-12 bounds revocation latency.
   */
  revokeSession: {
    method: "DELETE",
    path: "/auth/sessions/:sessionId",
    params: z.object({ sessionId: UuidSchema }),
    response: NoContentSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
