/**
 * Auth runtime config (T-5.7 / NAV-2) — env-driven, no secrets.
 *
 * `EXPO_PUBLIC_*` vars are inlined by Metro at build time and are PUBLIC by
 * design: the API base URL is not a secret, and the Google OAuth *client id*
 * is a public identifier (the id token is verified server-side — the secret
 * is the server's, never shipped here). No refresh/access token or provider
 * secret ever lives in this module.
 */
import Constants from "expo-constants";

/** apps/server dev port (server `env.ts` `PORT` default). */
export const DEV_SERVER_PORT = 3000;

/** Every server route is mounted under `/api` (contracts spec §3.6 / T-5.4). */
const API_BASE_PATH = "/api";

function withApiSuffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(API_BASE_PATH) ? trimmed : `${trimmed}${API_BASE_PATH}`;
}

/**
 * Resolve the API base URL (always normalized to end in `/api`). Priority:
 * 1. `EXPO_PUBLIC_API_URL` — explicit override (staging/prod/tunnel).
 * 2. Derived from the Metro dev host (`Constants.expoConfig.hostUri` =
 *    `<lan-ip>:8081`) → `http://<lan-ip>:3000/api`, so a physical device on
 *    the same LAN reaches the dev server with zero config.
 * 3. `http://localhost:3000/api` — simulator fallback (no dev host).
 */
export function resolveApiBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit && explicit.length > 0) return withApiSuffix(explicit);

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host) return `http://${host}:${DEV_SERVER_PORT}${API_BASE_PATH}`;
  }
  return `http://localhost:${DEV_SERVER_PORT}${API_BASE_PATH}`;
}

/**
 * Google OAuth client ids (public identifiers). Empty until Sean provisions a
 * Google OAuth client — device Google sign-in is a phase-close dependency
 * (T-5.7 report). Apple needs no client id here: the app bundle id IS the
 * token audience the server verifies against (`APPLE_CLIENT_ID`, server-side).
 */
export const googleClientIds = {
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
} as const;

/** Google sign-in can only run on-device once a client id is provisioned. */
export function isGoogleConfigured(): boolean {
  return Boolean(googleClientIds.iosClientId ?? googleClientIds.webClientId);
}
