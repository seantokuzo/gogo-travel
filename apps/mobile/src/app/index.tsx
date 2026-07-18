import { Redirect } from "expo-router";

/**
 * Entry redirect (navigation.spec §2.1 / §2.2).
 *
 * Skeleton resolution: no session store or trip data exists yet, so every
 * launch lands on the trip list — the R-nav-5 default. NAV-2/NAV-3 replace
 * this with the full ladder:
 *   hydration splash (R-nav-3) → auth gate (R-nav-1/2) →
 *   single active trip → its today tab (R-nav-6) →
 *   2+ active trips → most-recently-viewed's today tab (R-nav-23, MMKV stamp).
 */
export default function Entry() {
  return <Redirect href="/(trips)" />;
}
