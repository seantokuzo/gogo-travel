/**
 * Header trip-switcher affordance (T-6.6 / NAV-3; R-nav-23, spec §2.1),
 * widened by B-25 from "switch between concurrently-active trips" to
 * "orientation + EGRESS".
 *
 * WHY (B-25, device QA): `[tripId]/_layout` is a tab navigator and entering a
 * trip REPLACES the stack, so no back affordance exists — this bar is the
 * only way out. It used to render nothing below two *active* trips and to
 * list only the active set, so the common case (one active trip, or a set
 * that is all planning/past) was a navigation DEAD END with no route back to
 * `(trips)`. Hence, deliberately:
 *
 *  1. The bar renders on EVERY trip screen. Its job is not only switching; it
 *     names where you are and shows how to leave. With a single trip it is a
 *     labelled way out.
 *  2. The sheet's FIRST row is "All trips" → the trip list. That row is the
 *     exit and never depends on the trips query: a pending/failed list still
 *     leaves it pressable.
 *  3. The sheet lists EVERY trip, grouped by `groupTripsIntoSections` — the
 *     same helper (and therefore the same order + labels) the trip list
 *     screen uses, so the two surfaces can never disagree.
 *
 * Navigation primitive: `router.replace`, matching the pre-existing
 * `switchTo`. A push would stack a second trip list behind the trip you just
 * left (back would re-enter it), and on the R-nav-6/23 cold-launch-into-trip
 * path there is no trip list underneath to return to at all — replace is the
 * only primitive that reaches the list in BOTH entry shapes.
 *
 * B-19 (mobile.md 🔴 "never push a `presentation: modal` route in the same
 * handler that closes a DS Sheet") does NOT apply: `(trips)/_layout` declares
 * `presentation: "modal"` for `new` and `capture/onboarding` ONLY — the trip
 * list (`(trips)/index`) is a plain card route, pinned by
 * `__tests__/modal-presentation.test.ts` (its `toHaveLength(2)` fails the
 * moment another `(trips)` screen is declared modal). With no modal in the
 * destination, `RNSScreenStackView.setModalViewControllers` compares two
 * empty arrays and returns at `isEqualToArray` before `_updatingModals` is
 * ever latched — the same reasoning `MapPlaceSheet.handleDetails` documents
 * for its undeferred same-tab push. So both rows navigate straight from the
 * press handler and pay no ~200 ms exit-deferral tax.
 *
 * Data: the same `useTrips` query key the entry redirect warms — no second
 * fetch on the launch path, and the sheet's contents only mount while the RN
 * `Modal` is presented, so the always-on cost is the bar's one row of chrome.
 * That query is a single page (`TRIPS_PAGE_LIMIT`), so a >100-trip account
 * sees a truncated set here; "All trips" is the paginated surface.
 */
import type { TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter, type Href } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, Icon, ListItem, Sheet } from "@/components";
import { useTrips } from "@/data";
import { groupTripsIntoSections } from "@/features/trips";

const useStyles = createStyles((t) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: t.space[2],
      paddingHorizontal: t.space[4],
      paddingVertical: t.space[2],
      backgroundColor: t.color.bg.surface,
      borderBottomWidth: 1,
      borderBottomColor: t.color.border.subtle,
      minHeight: t.touchTarget,
    },
    name: { flex: 1 },
    divider: {
      borderBottomWidth: 1,
      borderBottomColor: t.color.border.subtle,
      marginVertical: t.space[1],
    },
    sectionHeader: {
      paddingHorizontal: t.space[4],
      paddingTop: t.space[3],
      paddingBottom: t.space[1],
    },
    note: { paddingHorizontal: t.space[4], paddingVertical: t.space[3] },
  }),
);

export function TripSwitcherBar({ currentTrip }: { currentTrip: TripWithRole }) {
  const s = useStyles();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const tripsQuery = useTrips();

  const items = tripsQuery.data?.items;
  // Same grouping + ordering + labels as the trip list (R-tripui-1): active →
  // upcoming → past, so the switcher can never present a different trip set
  // from the screen it links to.
  const sections = useMemo(() => groupTripsIntoSections(items ?? []), [items]);

  const switchTo = (tripId: string) => {
    setOpen(false);
    if (tripId !== currentTrip.id) {
      // Bare trip root — the [tripId] layout owns default-tab resolution.
      router.replace(`/${tripId}` as Href);
    }
  };

  // B-25 egress. Deliberately independent of `tripsQuery`: the way out must
  // survive an offline/failed trips read.
  const goToTripList = () => {
    setOpen(false);
    router.replace("/(trips)");
  };

  return (
    <>
      <Pressable
        style={[s.bar, { paddingTop: insets.top + theme.space[2] }]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Current trip: ${currentTrip.name}. Switch trips or go to all trips.`}
        testID="trip-switcher-button"
      >
        <Icon name="airplane-outline" size={18} />
        <AppText role="label" color="secondary" style={s.name} numberOfLines={1}>
          {currentTrip.name}
        </AppText>
        <Icon name="chevron-down-outline" size={16} />
      </Pressable>
      <Sheet
        visible={open}
        onDismiss={() => setOpen(false)}
        title="Trips"
        testID="trip-switcher-sheet"
      >
        <ScrollView>
          <ListItem
            title="All trips"
            subtitle="Back to your trip list"
            leading={<Icon name="list-outline" size={20} color={theme.color.text.secondary} />}
            onPress={goToTripList}
            testID="trip-switcher-list-item-all-trips"
          />
          <View style={s.divider} />
          {tripsQuery.isPending || tripsQuery.isError ? (
            <AppText role="caption" color="secondary" style={s.note}>
              {tripsQuery.isPending
                ? "Loading your trips…"
                : "Couldn't load your other trips — open the trip list to try again."}
            </AppText>
          ) : null}
          {sections.map((section) => (
            <View key={section.status}>
              <AppText role="label" color="secondary" style={s.sectionHeader}>
                {section.title}
              </AppText>
              {section.data.map((trip) => (
                <ListItem
                  key={trip.id}
                  title={trip.name}
                  subtitle={trip.destination_name}
                  trailing={
                    trip.id === currentTrip.id ? (
                      // Derived non-interactive id (§2.7 rule 4) — the
                      // "you are here" marker, assertable per row.
                      <Icon
                        name="checkmark"
                        size={18}
                        testID={`trip-switcher-list-item-${trip.id}-check`}
                      />
                    ) : undefined
                  }
                  onPress={() => switchTo(trip.id)}
                  testID={`trip-switcher-list-item-${trip.id}`}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
}
