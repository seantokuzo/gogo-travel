/**
 * Google Sign In flow (T-5.7 / NAV-2; auth-users spec §3.1, R-auth-3).
 *
 * Mechanism: the sanctioned `expo-auth-session` Google provider (auth code +
 * PKCE → ID token) — navigation.spec §2.1 ("Apple + Google (AuthSession)").
 * The provider hook generates the nonce and binds it into the ID-token
 * request; Google echoes it VERBATIM into the token's `nonce` claim, which is
 * exactly what the server compares `raw_nonce` against (R-auth-3: Google = raw
 * match, no hashing). So `raw_nonce = request.nonce`.
 *
 * Device sign-in needs a provisioned Google OAuth client id (config.ts /
 * `EXPO_PUBLIC_GOOGLE_*`) — a phase-close dependency. Tests mock this module.
 */
import type { GoogleSignInRequest } from "@gogo/shared";
import * as Google from "expo-auth-session/providers/google";
import * as Device from "expo-device";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { googleClientIds } from "./config";

// Closes the auth popup on web (the only platform that opens one). Native
// (our target) never needs it, so it stays off the module-load path there.
if (Platform.OS === "web") {
  WebBrowser.maybeCompleteAuthSession();
}

/** Structural views so the request builder is a pure, testable function. */
type GoogleResponseLike = { type: string; params?: Record<string, string> } | null | undefined;
type GoogleRequestLike = { nonce?: string } | null | undefined;

/**
 * The Google id-token auth hook. `request` is `null` until it finishes
 * loading (button stays disabled); `promptAsync` opens the account chooser;
 * `response` fulfils after the prompt resolves. Kept here so the
 * `expo-auth-session` import stays behind this seam.
 */
export function useGoogleSignIn(): {
  request: GoogleRequestLike;
  response: GoogleResponseLike;
  promptAsync: () => Promise<unknown>;
} {
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: googleClientIds.iosClientId,
    webClientId: googleClientIds.webClientId,
  });
  return { request, response, promptAsync };
}

/**
 * Build the `/auth/google` payload from a resolved hook response. Returns
 * `null` for a non-success response or a missing id-token/nonce (cancel /
 * error / not-yet-loaded).
 */
export function buildGoogleSignInRequest(
  response: GoogleResponseLike,
  request: GoogleRequestLike,
): GoogleSignInRequest | null {
  if (!response || response.type !== "success") return null;
  const idToken = response.params?.id_token;
  const rawNonce = request?.nonce;
  if (!idToken || !rawNonce) return null;

  return {
    id_token: idToken,
    raw_nonce: rawNonce,
    device: {
      platform: Platform.OS === "android" ? "android" : "ios",
      device_name: Device.deviceName ?? undefined,
    },
  };
}
