import { ThemeProvider, useTheme } from "@gogo/tokens/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { queryClient, useAppForegroundRefetch } from "@/data";
import { AuthGate } from "@/navigation/AuthGate";
import { useStackScreenOptions } from "@/navigation/stack-options";
import { systemAppearance, themeStorage } from "@/theme";

/**
 * Root layout (navigation.spec §2.1) — owns providers, the root Stack, and the
 * NAV-2 auth gate.
 *
 * `AuthGate` (T-5.7) wires the seams T-4.4 left documented: splash-hold until
 * session hydration (R-nav-3); redirect gate — unauthed → /(auth)/sign-in with
 * stashed destination (R-nav-1), first-run → onboarding (R-nav-2), sign-out
 * reset (R-nav-4) — all off the real `useSessionStore`.
 *
 * Modal presentation (R-nav-21) is registered in each modal's OWNING stack
 * layout — expo-router configures `presentation` where the screen is a direct
 * child, so the "root modal group" of the spec is distributed: `(trips)`
 * declares `new` + `capture/onboarding`; the itinerary/money tab stacks
 * declare `item/new` / `expense/new`.
 *
 * Navigator chrome lives INSIDE the provider so useTheme re-skins the status
 * bar and scene backgrounds on scheme/accent changes (R-ds-3 / R-ds-6).
 */
function ThemedShell() {
  const { scheme } = useTheme();
  // Collab v1 foreground leg (R-tripui-3, T-6.9): AppState → active refetches
  // the trip-scoped queries. Lives here (inside the QueryClientProvider) so it
  // mounts exactly once for the whole app.
  useAppForegroundRefetch();
  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* PageHeader owns all screen chrome (§2.9) — native headers stay off. */}
      <AuthGate>
        <Stack screenOptions={useStackScreenOptions()} />
      </AuthGate>
    </>
  );
}

export default function RootLayout() {
  // Both adapters are module-level singletons (src/theme) — referentially
  // stable across renders, per the ThemeProviderProps contract.
  //
  // QueryClientProvider (T-5.8) wraps the whole app so every screen shares the
  // one `queryClient`; sign-out clears it via the session store's `onSignedOut`
  // seam (navigation.spec §2.2).
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        <ThemedShell />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
