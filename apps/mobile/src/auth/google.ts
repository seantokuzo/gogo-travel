/**
 * Google Sign In flow (T-5.7 / NAV-2; auth-users spec §3.1, R-auth-3).
 *
 * Mechanism: the sanctioned `expo-auth-session` Google provider (auth code +
 * PKCE → ID token) — navigation.spec §2.1 ("Apple + Google (AuthSession)").
 * Google echoes the request nonce VERBATIM into the token's `nonce` claim,
 * which is exactly what the server compares `raw_nonce` against (R-auth-3:
 * Google = raw match, no hashing).
 *
 * 🔴 WE supply the nonce — the provider does NOT, on native (B-4, device QA
 * 2026-08-29). `GoogleAuthRequest.getAuthRequestConfigAsync`
 * (`providers/Google.js:66`) generates one ONLY under
 * `responseType === ResponseType.IdToken`, and on any installed app
 * `useIdTokenAuthRequest` leaves `responseType` undefined so `useAuthRequest`
 * resolves it to `ResponseType.Code` (`Google.js:137` — code + PKCE + auto
 * exchange). So on iOS/Android `request.nonce` is ALWAYS `undefined`, the
 * builder below bailed, and sign-in died client-side without ever reaching
 * the server. Passing `extraParams.nonce` puts it in the authorize URL
 * (`AuthRequest.js:195` iterates `extraParams`) and OIDC requires the
 * provider to echo it into the ID token for the code flow too.
 *
 * One nonce per mounted hook, not per prompt press: `promptAsync` uses the
 * already-loaded request, so regenerating on press would race the async
 * request rebuild and prompt with a stale URL. This mirrors the library's own
 * lifetime for `this.nonce` (generated once per request instance).
 *
 * Device sign-in needs a provisioned Google OAuth client id (config.ts /
 * `EXPO_PUBLIC_GOOGLE_*`). Tests mock this module.
 */
import type { GoogleSignInRequest } from "@gogo/shared";
import * as Google from "expo-auth-session/providers/google";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { useMemo } from "react";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { googleClientIds } from "./config";

/** Matches the Apple rail's raw-nonce strength (`apple.ts`). */
const NONCE_BYTES = 32;

// Closes the auth popup on web (the only platform that opens one). Native
// (our target) never needs it, so it stays off the module-load path there.
if (Platform.OS === "web") {
  WebBrowser.maybeCompleteAuthSession();
}

/** Structural views so the request builder is a pure, testable function. */
type GoogleResponseLike = { type: string; params?: Record<string, string> } | null | undefined;
type GoogleRequestLike =
  { nonce?: string; extraParams?: Record<string, string> } | null | undefined;

/** Hex-encoded CSPRNG nonce. Sync so it can seed a `useMemo` initializer. */
function randomNonceHex(): string {
  return Array.from(Crypto.getRandomBytes(NONCE_BYTES), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

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
  // Stable identity: a new object each render would rebuild the auth request
  // (and mint a new nonce) on every re-render of the sign-in screen.
  const extraParams = useMemo(() => ({ nonce: randomNonceHex() }), []);
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: googleClientIds.iosClientId,
    webClientId: googleClientIds.webClientId,
    extraParams,
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
  // `nonce` is the instance field the provider sets on the WEB implicit path;
  // `extraParams.nonce` is the one we supply, which is the only one present on
  // native. Read both, instance field first — if a future provider version
  // starts minting its own on native, that is the value actually sent.
  const rawNonce = request?.nonce ?? request?.extraParams?.nonce;
  if (!idToken || !rawNonce) {
    // B-6, one level down: a silent `null` is as opaque as a swallowed error.
    // The caller can only report "missing google id token", which is a LIE
    // half the time — a missing nonce lands here too and reads identically.
    // That exact ambiguity sent us chasing the wrong half of this function.
    if (__DEV__) {
      console.warn(
        `[auth] google payload incomplete — idToken=${Boolean(idToken)} ` +
          `rawNonce=${Boolean(rawNonce)} (request.nonce=${Boolean(request?.nonce)}, ` +
          `extraParams.nonce=${Boolean(request?.extraParams?.nonce)}) ` +
          `responseParams=${JSON.stringify(Object.keys(response.params ?? {}))}`,
      );
    }
    return null;
  }

  return {
    id_token: idToken,
    raw_nonce: rawNonce,
    device: {
      platform: Platform.OS === "android" ? "android" : "ios",
      device_name: Device.deviceName ?? undefined,
    },
  };
}
