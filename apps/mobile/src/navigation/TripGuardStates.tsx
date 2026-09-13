/**
 * `[tripId]` guard surfaces (T-6.6 / NAV-4; R-nav-15/20).
 *
 * NoAccessState is THE one screen every 404 renders — the server already
 * makes nonexistent ≡ non-member ≡ malformed indistinguishable (R-trips-1),
 * and this surface keeps the client half of that boundary: generic copy, no
 * trip field, no cached data, no oracle (Law #3). Loading holds the R-nav-3
 * no-flash posture; a NON-404 failure (network/5xx) is NOT a membership
 * verdict, so it gets a retry surface instead of a false "no access" — the
 * distinction matters offline (offline spec: cached active trips must mount).
 *
 * B-25 (round 1): BOTH failure surfaces carry an exit. They render OUTSIDE
 * `TripShell`, so the switcher bar — the only way out of a trip — is not
 * mounted behind them, and on the cold-launch path (`app/index` redirects
 * straight into the last-viewed trip) there is no route underneath and no
 * back gesture either. Without a "Back to trips" action a 5xx/timeout on
 * `GET /trips/:tripId` is the B-25 dead end verbatim. The primitive is
 * `dismissTo` for the same reason the switcher uses it — see the navigation
 * primitive section of `TripSwitcher.tsx`.
 */
import { createStyles } from "@gogo/tokens/react";
import { useRouter } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { Button, EmptyState, ErrorBanner } from "@/components";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: t.color.bg.screen,
      justifyContent: "center",
    },
    errorScreen: {
      flex: 1,
      backgroundColor: t.color.bg.screen,
      padding: t.space[4],
      gap: t.space[4],
    },
  }),
);

/** R-nav-15: generic not-found/no-access — reveals nothing about existence. */
export function NoAccessState() {
  const s = useStyles();
  const router = useRouter();
  return (
    <View style={s.screen} testID="no-access-screen">
      <EmptyState
        icon="lock-closed-outline"
        title="Trip unavailable"
        body="This trip doesn't exist or you don't have access to it."
        action={{
          label: "Back to trips",
          onPress: () => router.dismissTo("/(trips)"),
          testID: "no-access-button-trips",
        }}
      />
    </View>
  );
}

/** Membership check in flight — hold, never flash a guess (R-nav-3 posture). */
export function TripLoadingState() {
  const s = useStyles();
  return (
    <View style={s.screen} testID="trip-loading">
      <ActivityIndicator />
    </View>
  );
}

/**
 * Transport/server failure — retryable, and NOT a membership verdict.
 * Retry is the primary action; "Back to trips" is the B-25 egress (see the
 * module doc) — a failing trip read must never be a one-way door.
 */
export function TripErrorState({ onRetry }: { onRetry(): void }) {
  const s = useStyles();
  const router = useRouter();
  return (
    <View style={s.errorScreen} testID="trip-error-screen">
      <ErrorBanner
        message="Couldn't load this trip."
        onRetry={onRetry}
        testID="trip-error-banner"
      />
      <Button
        title="Back to trips"
        variant="secondary"
        onPress={() => router.dismissTo("/(trips)")}
        testID="trip-error-button-trips"
      />
    </View>
  );
}
