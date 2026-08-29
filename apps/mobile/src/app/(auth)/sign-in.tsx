/**
 * Sign-in (navigation.spec §2.4; auth-users spec §3.1) — Apple + Google wired
 * to the API. On success the session store is populated and the root AuthGate
 * redirects (onboarding for a new user, else the stashed destination). NAV-2.
 *
 * Apple uses the native ASAuthorization button (App-Review-favored, required
 * on iOS); Google uses the sanctioned expo-auth-session provider. The nonce
 * mechanics that satisfy the server (Apple: SHA-256(raw_nonce); Google: raw
 * match) live in `@/auth/apple` + `@/auth/google`.
 *
 * Google render-gate (T-5.7 r1 blocker): `useGoogleSignIn` calls
 * expo-auth-session's `useIdTokenAuthRequest`, which THROWS during render when
 * no client id is provisioned (`EXPO_PUBLIC_GOOGLE_*` unset — the phase-close
 * state). A thrown hook takes the WHOLE screen down (Apple button included).
 * React forbids calling a hook conditionally, but rendering a COMPONENT
 * conditionally is legal — so the hook lives in `GoogleSignInButton`, mounted
 * only when `isGoogleConfigured()`. Unconfigured, a disabled placeholder holds
 * its place so the gate is visible and Apple always works.
 */
import { authEndpoints, type SignInResponse } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as AppleAuthentication from "expo-apple-authentication";
import { useCallback, useEffect, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";

import {
  apiClient,
  buildGoogleSignInRequest,
  isAppleAuthAvailable,
  isGoogleConfigured,
  signInWithApple,
  useGoogleSignIn,
  useSessionStore,
} from "@/auth";
import { AppText, Button, ErrorBanner, PageHeader } from "@/components";

type Provider = "apple" | "google";
const GENERIC_ERROR = "Sign-in failed. Please try again.";

/** Required `onPress` for the disabled Google placeholder (never invoked). */
const noop = (): void => undefined;

// Structural views of the auth-session hook result (kept in sync with
// `@/auth/google`) so this route never imports expo-auth-session directly.
type GoogleResult = { type: string; params?: Record<string, string> };
// `extraParams.nonce` is where the raw nonce actually lives on native — see
// the nonce note in `@/auth/google`. Typing only `nonce` here still compiled
// (structurally assignable to the builder's wider param), which is part of why
// the missing-nonce bug was invisible.
type GoogleRequestLike =
  { nonce?: string; extraParams?: Record<string, string> } | null | undefined;

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { flex: 1, justifyContent: "center", padding: t.space[4], gap: t.space[4] },
    actions: { gap: t.space[3] },
    appleButton: { height: t.touchTarget },
    legal: { textAlign: "center" },
  }),
);

/**
 * The Google button — isolated so `useGoogleSignIn()` (which throws at render
 * when unconfigured) is only ever called once the caller has confirmed
 * `isGoogleConfigured()`. `onStart` clears error + marks busy before the
 * prompt; `onResult` handles the resolved auth-session outcome.
 */
function GoogleSignInButton({
  busy,
  onStart,
  onResult,
}: {
  busy: Provider | null;
  onStart: () => void;
  onResult: (response: GoogleResult, request: GoogleRequestLike) => void;
}) {
  const { request, response, promptAsync } = useGoogleSignIn();

  // The auth-session result arrives as a VALUE, not a subscription — reacting
  // to it in an effect is the documented Expo Google pattern; the setState
  // lives in the parent's `onResult`, not this effect body.
  useEffect(() => {
    if (response) onResult(response, request);
  }, [response, request, onResult]);

  const onPress = useCallback(() => {
    onStart();
    void promptAsync();
  }, [onStart, promptAsync]);

  return (
    <Button
      title="Continue with Google"
      variant="secondary"
      fullWidth
      onPress={onPress}
      loading={busy === "google"}
      disabled={busy !== null || !request}
      testID="sign-in-button-google"
    />
  );
}

export default function SignInScreen() {
  const s = useStyles();
  const { scheme } = useTheme();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // iOS 13+ effectively always supports Apple sign-in — show optimistically so
  // the button is there on the first frame, then correct via the native check.
  const [appleAvailable, setAppleAvailable] = useState(Platform.OS === "ios");

  useEffect(() => {
    let active = true;
    isAppleAuthAvailable()
      .then((available) => {
        if (active) setAppleAvailable(available);
      })
      .catch(() => {
        if (active) setAppleAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = useCallback(
    async (provider: Provider, task: () => Promise<SignInResponse | null>) => {
      setError(null);
      setBusy(provider);
      try {
        const response = await task();
        if (!response) {
          setBusy(null); // user dismissed the provider sheet — not an error
          return;
        }
        await useSessionStore.getState().applySignIn(response);
        // Authenticated: the root gate takes over navigation. Leave `busy` set
        // so the spinner holds until this screen unmounts.
      } catch {
        setError(GENERIC_ERROR);
        setBusy(null);
      }
    },
    [],
  );

  // Google's resolved auth-session outcome (success → POST; error → banner;
  // cancel/dismiss → clear busy). Handed to `GoogleSignInButton` as `onResult`.
  const finishGoogle = useCallback(
    (response: GoogleResult, request: GoogleRequestLike) => {
      if (response.type !== "success") {
        if (response.type === "error") setError(GENERIC_ERROR);
        setBusy(null);
        return;
      }
      const payload = buildGoogleSignInRequest(response, request);
      void submit("google", async () => {
        if (!payload) throw new Error("missing google id token");
        return apiClient.request(authEndpoints.googleSignIn, { body: payload });
      });
    },
    [submit],
  );

  // Clear error + mark busy the instant the Google prompt opens (`onStart`).
  const startGoogle = useCallback(() => {
    setError(null);
    setBusy("google");
  }, []);

  const onApple = useCallback(
    () =>
      void submit("apple", async () => {
        const payload = await signInWithApple();
        if (!payload) return null; // cancelled
        return apiClient.request(authEndpoints.appleSignIn, { body: payload });
      }),
    [submit],
  );

  const appleStyle =
    scheme === "dark"
      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK;

  return (
    <View style={s.screen} testID="sign-in-screen">
      <PageHeader
        title="Sign in"
        subtitle="Plan and travel together."
        large
        testID="sign-in-header"
      />
      <View style={s.body}>
        {error !== null ? (
          <ErrorBanner message={error} onDismiss={() => setError(null)} testID="sign-in-error" />
        ) : null}

        <View style={s.actions}>
          {appleAvailable ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={appleStyle}
              cornerRadius={12}
              style={s.appleButton}
              onPress={onApple}
              testID="sign-in-button-apple"
            />
          ) : null}

          {isGoogleConfigured() ? (
            <GoogleSignInButton busy={busy} onStart={startGoogle} onResult={finishGoogle} />
          ) : (
            // Unconfigured (no Google client id yet): a visible, disabled gate.
            // Rendering the placeholder — rather than the hook-bearing button —
            // is what keeps the unprovisioned build from crashing on render.
            <Button
              title="Continue with Google"
              variant="secondary"
              fullWidth
              disabled
              onPress={noop}
              testID="sign-in-button-google"
              accessibilityLabel="Google sign-in unavailable"
            />
          )}
        </View>

        <AppText role="caption" color="muted" style={s.legal}>
          By continuing you agree to the Terms of Service and Privacy Policy.
        </AppText>
      </View>
    </View>
  );
}
