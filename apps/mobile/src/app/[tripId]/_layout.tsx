import { useLocalSearchParams } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import type { BottomTabBarProps } from "expo-router/js-tabs";

import { TabNav } from "@/components";
import { TripIdProvider } from "@/navigation/trip-context";
import { TRIP_TAB_ITEMS } from "@/navigation/trip-tabs";

/**
 * Trip tab shell (navigation.spec §2.1) — five tab-local Stacks under the
 * design-system TabNav (§2.9). expo-router 57 note: the root `Tabs` export
 * is deprecated — `expo-router/js-tabs` is the sanctioned JS-tabs entry.
 *
 * Skeleton state (no trip data or session exists yet — landmine: never gate
 * on state nothing sets). NAV-3/NAV-4 own these seams:
 * - default-tab resolution from trip status (R-nav-7/8): `initialRouteName`
 *   is pinned to the planning default `itinerary`; NAV-3 swaps in
 *   `tripIsActive(trip) ? "today" : "itinerary"` (§2.5) + in-session tab
 *   memory (R-nav-9) + the MMKV most-recently-viewed stamp (R-nav-23);
 * - membership guard + trip context provider + no-access state
 *   (R-nav-15/R-nav-20) wrap the navigator here;
 * - header trip-switcher affordance when 2+ trips are active (R-nav-23).
 */
function TripTabBar({ state, navigation }: BottomTabBarProps) {
  const activeKey = state.routes[state.index]?.name ?? TRIP_TAB_ITEMS[0].key;
  return (
    <TabNav
      items={TRIP_TAB_ITEMS}
      activeKey={activeKey}
      // TabNav already no-ops re-taps on the active tab (§2.8 haptic rule).
      onSelect={(key) => navigation.navigate(key)}
      testID="tab-bar"
    />
  );
}

export default function TripLayout() {
  // The layout resolves the [tripId] segment and PROVIDES it to all tabs
  // (§2.1: the layout owns trip context) — tab screens must not read it from
  // local params: routes the tab navigator instantiates itself (bare
  // /[tripId] open, tab-bar switches) carry no inherited params in
  // expo-router 57 (see src/navigation/trip-context.tsx).
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  return (
    <TripIdProvider tripId={tripId}>
      <Tabs
        initialRouteName="itinerary"
        screenOptions={{ headerShown: false }}
        tabBar={(props) => <TripTabBar {...props} />}
      >
        {/* Declared in spec order — the §2.1 tab bar is today · itinerary ·
            map · money · more; TRIP_TAB_ITEMS mirrors it. */}
        <Tabs.Screen name="today" />
        <Tabs.Screen name="itinerary" />
        <Tabs.Screen name="map" />
        <Tabs.Screen name="money" />
        <Tabs.Screen name="more" />
      </Tabs>
    </TripIdProvider>
  );
}
