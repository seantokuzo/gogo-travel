/**
 * Sign-in (navigation.spec §2.4; auth-users spec §3.1) — Apple + Google wired
 * to the API. On success the session store is populated and the root AuthGate
 * redirects (onboarding for a new user, else the stashed destination). NAV-2.
 *
 * Apple uses the native ASAuthorization button (App-Review-favored, required
 * on iOS); Google uses the sanctioned expo-auth-session provider. The nonce
 * mechanics that satisfy the server (Apple: SHA-256(raw_nonce); Google: raw
 * match) live in `@/auth/apple` + `@/auth/google`.
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
  signInWithApple,
  useGoogleSignIn,
  useSessionStore,
} from "@/auth";
import { AppText, Button, ErrorBanner, PageHeader } from "@/components";

type Provider = "apple" | "google";
const GENERIC_ERROR = "Sign-in failed. Please try again.";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.color.bg.screen },
    body: { flex: 1, justifyContent: "center", padding: t.space[4], gap: t.space[4] },
    actions: { gap: t.space[3] },
    appleButton: { height: t.touchTarget },
    legal: { textAlign: "center" },
  }),
);

export default function SignInScreen() {
  const s = useStyles();
  const { scheme } = useTheme();
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  // iOS 13+ effectively always supports Apple sign-in — show optimistically so
  // the button is there on the first frame, then correct via the native check.
  const [appleAvailable, setAppleAvailable] = useState(Platform.OS === "ios");

  const { request: googleRequest, response: googleResponse, promptAsync } = useGoogleSignIn();

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

  // Handle a resolved Google auth-session result (success → POST; error →
  // banner; cancel/dismiss → just clear busy). Extracted from the effect so
  // the state updates live in a callback, not the effect body
  // (react-hooks/set-state-in-effect).
  const finishGoogle = useCallback(
    (
      response: { type: string; params?: Record<string, string> },
      request: { nonce?: string } | null | undefined,
    ) => {
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

  // Google's result arrives asynchronously through the auth-session hook. The
  // hook surfaces the outcome as a VALUE (not a subscription), so reacting to
  // it in an effect is the documented Expo Google pattern — the eventual
  // setState (success → POST, error → banner) lives in `finishGoogle`.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above: auth-session result is a hook value, not a subscription callback
    if (googleResponse) finishGoogle(googleResponse, googleRequest);
  }, [googleResponse, googleRequest, finishGoogle]);

  const onApple = useCallback(
    () =>
      void submit("apple", async () => {
        const payload = await signInWithApple();
        if (!payload) return null; // cancelled
        return apiClient.request(authEndpoints.appleSignIn, { body: payload });
      }),
    [submit],
  );

  const onGoogle = useCallback(() => {
    setError(null);
    setBusy("google");
    void promptAsync();
  }, [promptAsync]);

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

          <Button
            title="Continue with Google"
            variant="secondary"
            fullWidth
            onPress={onGoogle}
            loading={busy === "google"}
            disabled={busy !== null || !googleRequest}
            testID="sign-in-button-google"
          />
        </View>

        <AppText role="caption" color="muted" style={s.legal}>
          By continuing you agree to the Terms of Service and Privacy Policy.
        </AppText>
      </View>
    </View>
  );
}
