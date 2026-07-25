/**
 * Apple Sign In flow (T-5.7 / NAV-2; auth-users spec §3.1, R-auth-3/5).
 *
 * Nonce contract (the load-bearing cross-workspace detail): the SERVER checks
 * that the identity token's `nonce` claim equals `sha256Hex(raw_nonce)` —
 * lowercase hex (server `auth/crypto.ts`). So we generate a RAW nonce, hand
 * Apple its SHA-256 (Apple embeds that verbatim in the token), and POST the
 * RAW nonce. Hashing to uppercase hex (or sending the hash) fails every Apple
 * sign-in.
 *
 * `expo-apple-authentication` is the native ASAuthorization presentation
 * (App-Review-favored, iOS-only). Tests mock this module + `expo-crypto`.
 */
import type { AppleSignInRequest } from "@gogo/shared";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";

const NONCE_BYTES = 32;

/** Native availability — true on iOS 13+, false on Android/unsupported. */
export function isAppleAuthAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync();
}

/**
 * Run the native Apple sign-in and build the `/auth/apple` request payload.
 * Returns `null` when the user dismisses the sheet (a cancel, not an error).
 */
export async function signInWithApple(): Promise<AppleSignInRequest | null> {
  const rawNonce = await randomNonceHex();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (err) {
    if (isCanceled(err)) return null;
    throw err;
  }

  if (!credential.identityToken || !credential.authorizationCode) {
    throw new Error("Apple sign-in did not return a credential");
  }

  return {
    identity_token: credential.identityToken,
    authorization_code: credential.authorizationCode,
    raw_nonce: rawNonce,
    device: { platform: "ios", device_name: Device.deviceName ?? undefined },
    // First-authorization-only name fields — forward them or they are gone
    // forever (R-auth-5). Undefined on every subsequent sign-in.
    given_name: credential.fullName?.givenName ?? undefined,
    family_name: credential.fullName?.familyName ?? undefined,
  };
}

async function randomNonceHex(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(NONCE_BYTES);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isCanceled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_REQUEST_CANCELED"
  );
}
