/**
 * Root auth gate (T-5.7 / NAV-2; navigation.spec §2.1/§2.2). Wraps the root
 * Stack: kicks boot hydration, holds the splash until it finishes (R-nav-3),
 * then drives the R-nav-1..4 redirects off the real session store — never
 * gating on state nothing sets (mobile landmine). The decision itself is the
 * pure `resolveGate`; this component only performs its side effects.
 *
 * Redirects run in an effect via `router.replace` (post-commit, navigator
 * ready) rather than rendering a `<Redirect>`, because the resume branch must
 * consume the stash exactly once. The Stack stays mounted the whole time so
 * the navigator is always available to replace into.
 */
import { createStyles } from "@gogo/tokens/react";
import { SplashScreen, useRouter, useSegments, usePathname } from "expo-router";
import type { Href } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";

import { resolveGate } from "./auth-gate";

// Keep the native splash up from launch; the gate hides it after hydration.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const useStyles = createStyles((t) =>
  StyleSheet.create({
    splash: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.color.bg.screen,
    },
  }),
);

function SplashHold() {
  const s = useStyles();
  return (
    <View style={s.splash} testID="sign-in-splash">
      <ActivityIndicator />
    </View>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const hydrated = useSessionStore((s) => s.hydrated);
  const authed = useSessionStore((s) => s.user !== null);
  const firstRun = useSessionStore((s) => s.firstRun);
  const resetting = useSessionStore((s) => s.resetting);
  // Typed routes narrow each segment to a literal union; the gate only does
  // string comparisons, so widen to string[] for `includes`.
  const segments = useSegments() as string[];
  const pathname = usePathname();
  const router = useRouter();

  const inAuthGroup = segments[0] === "(auth)";
  const onOnboarding = inAuthGroup && segments.includes("onboarding");

  // Boot hydration — once (idempotent in the store).
  useEffect(() => {
    void useSessionStore.getState().hydrate();
  }, []);

  // Splash-hold: reveal the app only once hydration resolves (R-nav-3).
  useEffect(() => {
    if (hydrated) void SplashScreen.hideAsync().catch(() => undefined);
  }, [hydrated]);

  // Perform the gate's redirects. Depends on primitives (not the freshly
  // built action object) so it fires only on a real state/route change.
  useEffect(() => {
    if (!hydrated) return;
    const action = resolveGate({
      hydrated,
      authed,
      firstRun,
      resetting,
      inAuthGroup,
      onOnboarding,
      pathname,
    });
    const store = useSessionStore.getState();
    switch (action.type) {
      case "sign-in":
        if (action.stash) store.stashDestination(action.stash);
        router.replace("/(auth)/sign-in");
        break;
      case "onboarding":
        router.replace("/(auth)/onboarding");
        break;
      case "resume": {
        const dest = store.consumeDestination();
        router.replace((dest as Href | null) ?? "/");
        break;
      }
      case "render":
        // Landed back on sign-in after a sign-out reset — release the guard.
        if (inAuthGroup && !authed && resetting) {
          useSessionStore.setState({ resetting: false });
        }
        break;
    }
  }, [hydrated, authed, firstRun, resetting, inAuthGroup, onOnboarding, pathname, router]);

  if (!hydrated) return <SplashHold />;
  return <>{children}</>;
}
