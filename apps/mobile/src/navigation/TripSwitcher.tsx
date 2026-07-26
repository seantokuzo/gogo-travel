/**
 * Header trip-switcher affordance (T-6.6 / NAV-3; R-nav-23, spec §2.1).
 *
 * `[tripId]/_layout` hosts it: when TWO OR MORE trips are concurrently
 * active, a compact bar above the tab shell names the current trip and opens
 * a Sheet listing the active set — moving between active trips without
 * returning to the list. With fewer than two active trips it renders
 * nothing (the common case pays zero chrome).
 *
 * Switching uses `router.replace` into the target trip's root: the `[tripId]`
 * layout re-resolves the default tab (R-nav-7/8) / in-session memory
 * (R-nav-9) for the trip being entered, and the trip stack doesn't pile up
 * behind back gestures.
 *
 * Data: the same `useTrips` query key the entry redirect warms — no second
 * fetch on the launch path. A failed/absent list simply renders no switcher:
 * the affordance is additive chrome, never a blocker.
 */
import type { TripListItem, TripWithRole } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useRouter, type Href } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, Icon, ListItem, Sheet } from "@/components";
import { useTrips } from "@/data";

import { isTripActive, localTodayISO } from "./trip-defaults";

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
  const activeTrips = useMemo<TripListItem[]>(() => {
    if (items === undefined) return [];
    const today = localTodayISO();
    return items.filter((trip) => isTripActive(trip, today));
  }, [items]);

  if (activeTrips.length < 2) return null;

  const switchTo = (tripId: string) => {
    setOpen(false);
    if (tripId !== currentTrip.id) {
      // Bare trip root — the [tripId] layout owns default-tab resolution.
      router.replace(`/${tripId}` as Href);
    }
  };

  return (
    <>
      <Pressable
        style={[s.bar, { paddingTop: insets.top + theme.space[2] }]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Switch active trip. Current: ${currentTrip.name}`}
        testID="trip-switcher-button"
      >
        <Icon name="swap-horizontal-outline" size={18} />
        <AppText role="label" color="secondary" style={s.name} numberOfLines={1}>
          {currentTrip.name}
        </AppText>
        <Icon name="chevron-down-outline" size={16} />
      </Pressable>
      <Sheet
        visible={open}
        onDismiss={() => setOpen(false)}
        title="Active trips"
        testID="trip-switcher-sheet"
      >
        <View>
          {activeTrips.map((trip) => (
            <ListItem
              key={trip.id}
              title={trip.name}
              subtitle={trip.destination_name}
              trailing={trip.id === currentTrip.id ? <Icon name="checkmark" size={18} /> : undefined}
              onPress={() => switchTo(trip.id)}
              testID={`trip-switcher-list-item-${trip.id}`}
            />
          ))}
        </View>
      </Sheet>
    </>
  );
}
