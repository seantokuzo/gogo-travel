/**
 * Offline status pill (`map-pill-offline`) — T-8.5 fills the T-8.2 frozen
 * seam (MAP-5 / R-map-18/21/22, map spec §2.5). The screen mounts this slot
 * in its top overlay and passes only the trip id (the seam contract); the
 * trip row itself comes from the `[tripId]` layout's TripProvider — the same
 * context the screen reads.
 *
 * The pill is informational + retry ONLY (R-map-21: pack state never blocks
 * map interaction). What renders is the pure `offlinePillModel`:
 *  - downloading → progress text (R-map-18 "surfacing progress in the map
 *    status pill"),
 *  - failed → a tappable retry pill (R-map-21; the pill IS the retry button —
 *    handler-gated, so the tap is a no-op in any other mode),
 *  - offline (the derived `useTripOffline` signal — composed, never a second
 *    connectivity source) → whether a saved map is in play (R-map-22),
 *  - otherwise hidden.
 *
 * Mounting the slot also mounts the pack CONTROLLER — this surface is one of
 * the two R-map-18 activation-trigger mount points (controller doc).
 */
import { createStyles, useTheme } from "@gogo/tokens/react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/components";
import { useTripOffline } from "@/data";
import { useTripContext } from "@/navigation/trip-context";

import { mapStyleUrlForScheme } from "./map-style";
import { offlinePillModel } from "./offline-packs";
import { startPackDownload, useOfflinePackController } from "./offline-pack-controller";

export interface MapOfflinePillSlotProps {
  tripId: string;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    pill: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: t.space[3],
      paddingVertical: t.space[1],
      borderRadius: t.radius.full,
      backgroundColor: t.color.bg.surface,
      borderWidth: 1,
      borderColor: t.color.border.subtle,
    },
    pressed: { opacity: 0.7 },
  }),
);

export function MapOfflinePillSlot({ tripId }: MapOfflinePillSlotProps) {
  const s = useStyles();
  const { scheme } = useTheme();
  const trip = useTripContext();
  const state = useOfflinePackController(trip);
  const offline = useTripOffline(tripId);
  const model = offlinePillModel(state, offline);

  if (model.kind === "hidden") return null;

  const onPress = () => {
    // Handler-gated (mobile.md: never rely on `disabled` for a guard) — the
    // pill is a live retry control ONLY in the failed state.
    if (model.kind !== "retry") return;
    startPackDownload({
      tripId: trip.id,
      destinationLat: trip.destination_lat,
      destinationLng: trip.destination_lng,
      styleUrl: mapStyleUrlForScheme(scheme),
    });
  };

  if (model.kind === "retry") {
    return (
      <Pressable
        style={({ pressed }) => [s.pill, pressed ? s.pressed : null]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={model.label}
        testID="map-pill-offline"
      >
        <AppText role="caption" color="secondary">
          {model.label}
        </AppText>
      </Pressable>
    );
  }

  return (
    <View style={s.pill} testID="map-pill-offline">
      <AppText role="caption" color="secondary">
        {model.label}
      </AppText>
    </View>
  );
}
