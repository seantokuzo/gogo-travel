/**
 * Trip shell (T-6.6 / NAV-3+4; navigation.spec §2.1) — the `[tripId]` layout
 * owns, in order:
 *
 * 1. MEMBERSHIP GUARD (R-nav-20): `GET /trips/:tripId` must succeed before
 *    ANY trip surface renders. A 404 — the server's indistinguishable
 *    nonexistent ≡ non-member ≡ malformed posture (R-trips-1) — renders the
 *    one generic no-access state (R-nav-15) with zero trip data in the UI,
 *    even when a stale cache entry exists (Law #3 client half). Non-404
 *    failures are NOT membership verdicts → retry surface.
 * 2. TRIP CONTEXT (§2.1): the guarded `TripWithRole` provided to all tabs.
 * 3. DEFAULT-TAB RESOLUTION (§2.5): evaluated at tab-navigator mount —
 *    in-session manual choice (R-nav-9) wins, else active → today /
 *    planning-past → itinerary (R-nav-7/8). A trip crossing into active
 *    while open does NOT yank the user (initialRouteName is mount-only by
 *    construction).
 * 4. MOST-RECENTLY-VIEWED STAMP (R-nav-23): mounted = viewed — stamped only
 *    AFTER the guard admits the trip, so a no-access bounce never becomes
 *    "most recently viewed".
 * 5. TRIP SWITCHER (R-nav-23): hosted here, renders only with 2+ active trips.
 *
 * expo-router 57 note: the root `Tabs` export is deprecated —
 * `expo-router/js-tabs` is the sanctioned JS-tabs entry.
 */
import type { TripWithRole } from "@gogo/shared";
import { createStyles } from "@gogo/tokens/react";
import { useLocalSearchParams } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { ApiRequestError } from "@/auth";
import { TabNav } from "@/components";
import { useTrip } from "@/data";
import { stampLastViewedTrip } from "@/navigation/last-viewed-trip";
import { recallTab, rememberTab } from "@/navigation/tab-memory";
import { TripProvider, useTripId } from "@/navigation/trip-context";
import { initialTabFor, localTodayISO } from "@/navigation/trip-defaults";
import { TRIP_TAB_ITEMS } from "@/navigation/trip-tabs";
import { NoAccessState, TripErrorState, TripLoadingState } from "@/navigation/TripGuardStates";
import { TripSwitcherBar } from "@/navigation/TripSwitcher";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    shell: { flex: 1, backgroundColor: t.color.bg.screen },
  }),
);

function TripTabBar({ state, navigation }: BottomTabBarProps) {
  const tripId = useTripId();
  const activeKey = state.routes[state.index]?.name ?? TRIP_TAB_ITEMS[0].key;
  return (
    <TabNav
      items={TRIP_TAB_ITEMS}
      activeKey={activeKey}
      // TabNav already no-ops re-taps on the active tab (§2.8 haptic rule).
      // A tab-bar press is THE manual selection R-nav-9 makes sticky for the
      // session — record it before navigating.
      onSelect={(key) => {
        rememberTab(tripId, key);
        navigation.navigate(key);
      }}
      testID="tab-bar"
    />
  );
}

function TripShell({ trip }: { trip: TripWithRole }) {
  const s = useStyles();

  // Mounted ⇒ viewed (R-nav-23). Runs post-guard only — see layout doc.
  useEffect(() => {
    stampLastViewedTrip(trip.id);
  }, [trip.id]);

  // Mount-time resolution (§2.5): session memory (R-nav-9) beats the status
  // default (R-nav-7/8). Tabs reads initialRouteName once at mount, which is
  // exactly the spec's cold-open semantics — later status flips don't yank.
  const initialRouteName = recallTab(trip.id) ?? initialTabFor(trip, localTodayISO());

  return (
    <TripProvider trip={trip}>
      <View style={s.shell}>
        <TripSwitcherBar currentTrip={trip} />
        <Tabs
          initialRouteName={initialRouteName}
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
      </View>
    </TripProvider>
  );
}

export default function TripLayout() {
  // The layout resolves the [tripId] segment and PROVIDES it to all tabs
  // (§2.1) — tab screens must not read it from local params: routes the tab
  // navigator instantiates itself carry no inherited params in expo-router 57
  // (see src/navigation/trip-context.tsx).
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const tripQuery = useTrip(tripId);

  // 404 FIRST — before data. A stale cache entry plus a fresh 404 means the
  // membership verdict is "no": render no-access and show nothing cached
  // (Law #3 client half; R-nav-15).
  if (tripQuery.error instanceof ApiRequestError && tripQuery.error.status === 404) {
    return <NoAccessState />;
  }
  if (tripQuery.data !== undefined) return <TripShell trip={tripQuery.data} />;
  if (tripQuery.isError) return <TripErrorState onRetry={() => void tripQuery.refetch()} />;
  return <TripLoadingState />;
}
