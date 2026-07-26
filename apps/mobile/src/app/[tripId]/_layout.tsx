/**
 * Trip shell (T-6.6 / NAV-3+4; navigation.spec §2.1) — the `[tripId]` layout
 * owns, in order:
 *
 * 1. MEMBERSHIP GUARD (R-nav-20): every mount re-verifies membership before
 *    ANY trip surface renders — `useTrip` pins `staleTime: 0` +
 *    `refetchOnMount: "always"`, and the shell mounts only once
 *    `isFetchedAfterMount` proves THIS mount's verdict settled (round-1
 *    review: without that gate, a cached "member" verdict — revocable
 *    server-side at any time — rendered the full shell with no request, and
 *    a stale entry showed for the whole refetch RTT). Precise contract:
 *    - live network: the hold is shown until the fresh verdict lands; a 404
 *      (nonexistent ≡ non-member ≡ malformed, R-trips-1) renders the one
 *      generic no-access state with zero trip data in UI, cached or not
 *      (Law #3 client half), then scrubs the dead trip from the cache;
 *    - failed refetch (offline/5xx/timeout): NOT a membership verdict — the
 *      settle flips `isFetchedAfterMount`, so retained cached data mounts
 *      the shell (the offline cache-mount posture) and no-cache renders the
 *      retry surface. A cached shell can therefore appear ONLY after this
 *      mount's verification attempt has actually settled, never before.
 * 2. TRIP CONTEXT (§2.1): the guarded `TripWithRole` provided to all tabs.
 * 3. DEFAULT-TAB RESOLUTION (§2.5): evaluated at tab-navigator mount —
 *    in-session manual choice (R-nav-9) wins, else active → today /
 *    planning-past → itinerary (R-nav-7/8). A trip crossing into active
 *    while open does NOT yank the user (initialRouteName is mount-only by
 *    construction).
 * 4. MOST-RECENTLY-VIEWED STAMP (R-nav-23): stamped ONLY on this mount's
 *    verified success (fresh 200 verdict) — a no-access bounce, an
 *    in-flight hold, or an offline cached mount never move the stamp. The
 *    gate lives on the stamp itself (not just shell placement) so a future
 *    shell refactor can't silently regress it.
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
import { queryClient, queryKeys, useTrip } from "@/data";
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

  const is404 = tripQuery.error instanceof ApiRequestError && tripQuery.error.status === 404;

  // R-nav-23 stamp — VERIFIED SUCCESS only (fresh 200 on this mount): the
  // hold, no-access, and offline cached mounts never move recency.
  const verifiedTripId =
    !is404 && tripQuery.isSuccess && tripQuery.isFetchedAfterMount ? tripQuery.data.id : null;
  useEffect(() => {
    if (verifiedTripId !== null) stampLastViewedTrip(verifiedTripId);
  }, [verifiedTripId]);

  // Post-404 scrub (Law #3): the trips LIST goes stale immediately so a
  // revoked/deleted trip drops out of the switcher/entry active set. The
  // trip's own cache entry is removed on LEAVING the 404 branch — removing
  // an actively-observed query re-creates and refetches it (a 404 loop), so
  // the scrub rides the effect teardown instead.
  useEffect(() => {
    if (!is404) return;
    // exact: the list key ["trips"] is a PREFIX of every ["trips", id] detail
    // key — a non-exact invalidate matches the guard's own query and
    // refetch-loops it (caught live: 121 requests before the test timed out).
    void queryClient.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    return () => {
      queryClient.removeQueries({ queryKey: queryKeys.trip(tripId) });
    };
  }, [is404, tripId]);

  // 404 FIRST — before data. A stale cache entry plus a fresh 404 means the
  // membership verdict is "no": render no-access and show nothing cached
  // (Law #3 client half; R-nav-15).
  if (is404) return <NoAccessState />;
  // Fresh-verdict gate: cached data renders NOTHING until this mount's
  // verification attempt settles (see the layout doc for the full contract).
  if (tripQuery.data !== undefined && tripQuery.isFetchedAfterMount) {
    return <TripShell trip={tripQuery.data} />;
  }
  if (tripQuery.isError) return <TripErrorState onRetry={() => void tripQuery.refetch()} />;
  return <TripLoadingState />;
}
