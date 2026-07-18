import { Stack } from "expo-router";

import { useStackScreenOptions } from "@/navigation/stack-options";

/**
 * (auth) group (navigation.spec §2.1) — sign-in + first-run onboarding.
 * NAV-2 seam: this layout will redirect AUTHED users out (R-nav-1/2
 * machinery). No session store exists yet — the skeleton renders the stack
 * unguarded (landmine: never gate screens on state nothing sets).
 */
export default function AuthLayout() {
  return <Stack screenOptions={useStackScreenOptions()} />;
}
