/**
 * Entry redirect (T-6.6 / NAV-3; navigation.spec §2.2) — the launch decision:
 *
 *   exactly one active trip → its today tab                     (R-nav-6)
 *   2+ active               → most-recently-viewed active trip's
 *                             today tab; never viewed → trips   (R-nav-23)
 *   otherwise               → trip list                         (R-nav-5)
 *
 * The AuthGate upstream already holds the splash through hydration (R-nav-3)
 * and owns the unauthenticated redirect (R-nav-1) — this screen only ever
 * DECIDES for an authenticated user, and holds the same splash surface while
 * the trips read is in flight (no-flash posture; never guess a landing).
 *
 * A failed trips read falls to the R-nav-5 default: the trip list is the
 * landing route whenever no active trip can be established, and it owns
 * surfacing its own load error (T-6.7).
 */
import { createStyles } from "@gogo/tokens/react";
import { Redirect, type Href } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useSessionStore } from "@/auth";
import { useTrips } from "@/data";
import { resolveEntryTarget } from "@/navigation/entry-redirect";
import { readLastViewedTrip } from "@/navigation/last-viewed-trip";
import { localTodayISO } from "@/navigation/trip-defaults";

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

function EntryHold() {
  const s = useStyles();
  return (
    <View style={s.splash} testID="entry-splash">
      <ActivityIndicator />
    </View>
  );
}

export default function Entry() {
  const hydrated = useSessionStore((s) => s.hydrated);
  const authed = useSessionStore((s) => s.user !== null);
  // Never fire an authed read without a session — the AuthGate is about to
  // redirect this mount away (R-nav-1); a 401 here would just burn a refresh.
  const tripsQuery = useTrips({ enabled: hydrated && authed });

  if (!hydrated || !authed) return <EntryHold />;
  if (tripsQuery.status === "pending") return <EntryHold />;

  const target =
    tripsQuery.status === "error"
      ? "/(trips)"
      : resolveEntryTarget(tripsQuery.data.items, readLastViewedTrip(), localTodayISO());

  // Dynamic trip targets aren't representable in the typed-route union —
  // same documented cast as the navigation-skeleton walkthrough.
  return <Redirect href={target as Href} />;
}
