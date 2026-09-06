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
 *
 * The first post-hydration decision is deferred by one effect cycle (B-14
 * latch): a cold boot's deep-linked landing commits in the same render that
 * mounts the children, so the flip-time route read can still be the boot
 * default — see the redirect effect.
 */
import { createStyles } from "@gogo/tokens/react";
import { SplashScreen, useRouter, useSegments, usePathname } from "expo-router";
import type { Href } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
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

  // B-14 latch: the gate's FIRST post-hydration route read can predate the
  // navigator's committed cold-boot landing (see the redirect effect below).
  const [routeReadSettled, setRouteReadSettled] = useState(false);

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
    // B-14 (cold-boot deeplink race): on the hydration flip, this effect's
    // segments/pathname were captured in the render that MOUNTED the children
    // — before the navigator's deep-linked initial route was observable to
    // these hooks (expo-router syncs its route info when a leaf route renders
    // or on the container's next state change, both AFTER this closure was
    // built). Deciding off that stale boot-default read ("/") sent a
    // signed-out cold boot of gogo://diagnostics — an unauthed-reachable
    // (auth) route this gate's contract says to render — to sign-in,
    // stomping the already-committed panel. Arm a one-shot latch instead of
    // deciding: the state flip re-runs this effect in a render whose route
    // read reflects every navigation committed at mount, and THAT run
    // decides. Costs one effect cycle exactly once per app boot.
    if (!routeReadSettled) {
      // The extra render this rule guards against IS the fix: the latch must
      // flip post-commit so the re-run reads the committed route — a
      // render-phase flip would re-read the same pre-commit snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRouteReadSettled(true);
      return;
    }
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
  }, [
    hydrated,
    authed,
    firstRun,
    resetting,
    inAuthGroup,
    onOnboarding,
    pathname,
    router,
    routeReadSettled,
  ]);

  if (!hydrated) return <SplashHold />;
  return <>{children}</>;
}
