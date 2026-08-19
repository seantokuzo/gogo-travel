/**
 * Place sheet (T-8.3 / MAP-2 — R-map-4, map spec §2.3): the small
 * Sheet-over-map presentation for a selected pin or search result. Spine
 * data only — name, coarse-category icon + category line, distance from
 * user when a position is known (§2.3/§2.6, computed on-device) — cheap and
 * offline-capable; the detail screen owns the `?fresh=true` lane (T-8.4).
 *
 * ACTIONS this PR: Navigate (R-map-8 — MY row) and Details (the §2.3 "full
 * detail PUSH" into the map stack's own `place/[placeId]` route — same-tab,
 * so no cross-tab landmine). The §2.3 anatomy's OTHER actions are
 * DELIBERATELY absent, not forgotten: save toggle (R-map-11) and
 * add-to-day (R-map-12) are MAP-3 rows riding T-8.4's concurrent
 * `data/places.ts` mutations, and view-in-itinerary (R-map-23) is MAP-6
 * riding T-8.4's focus mechanics — rendering them today would mean dead
 * controls or a duplicated mutation layer against files T-8.3 must not
 * touch (PR scope table + escalation list; wired post-merge on this file).
 *
 * Dismissal: DS Sheet routes (close button, scrim, swipe, Android back) all
 * land on `onDismiss` — the slot clears BOTH selection sources there. §2.3
 * "tapping the map dismisses": while the Modal sheet is up, a map tap IS a
 * scrim tap; with no sheet up, the screen's MapView press → `onClose` seam
 * covers it (slot doc).
 */
import type { CoarseCategory, Place } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Button, ErrorBanner, Icon, Sheet } from "@/components";
import type { IconName } from "@/components";

import { distanceLabelFor } from "./distance";
import { useMapLocationStore } from "./location";
import { navHandoffUrlFor } from "./nav-handoff";

/**
 * Coarse category → Ionicons glyph (§2.3 "coarse-category icon"). Compile-
 * checked against the icon seam's glyph map — a bad name is a type error,
 * not a runtime blank.
 */
export const COARSE_CATEGORY_ICONS: Readonly<Record<CoarseCategory, IconName>> = {
  food: "restaurant-outline",
  drink: "cafe-outline",
  lodging: "bed-outline",
  attraction: "star-outline",
  culture: "library-outline",
  outdoors: "leaf-outline",
  shopping: "cart-outline",
  nightlife: "moon-outline",
  transport: "train-outline",
  other: "location-outline",
};

/** "food" → "Food" — the fallback line when the source taxonomy is null. */
function coarseCategoryLabel(category: CoarseCategory): string {
  return category.charAt(0).toUpperCase() + category.slice(1);
}

export interface MapPlaceSheetProps {
  tripId: string;
  /** Null ⇒ hidden — the LegModeSheet always-mounted pattern. */
  place: Place | null;
  onDismiss(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[4] },
    categoryRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
    actions: { flexDirection: "row", gap: t.space[3] },
    action: { flex: 1 },
  }),
);

export function MapPlaceSheet({ tripId, place, onDismiss }: MapPlaceSheetProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();
  const position = useMapLocationStore((state) => state.position);
  const [openFailed, setOpenFailed] = useState(false);

  const dismiss = (): void => {
    setOpenFailed(false);
    onDismiss();
  };

  const handleNavigate = (target: Place): void => {
    setOpenFailed(false);
    Linking.openURL(navHandoffUrlFor(target)).catch(() => {
      // The hop never happened (no handler / OS refusal) — say so inline;
      // the button stays live for a retry (DeeplinkPanel posture).
      setOpenFailed(true);
    });
  };

  const handleDetails = (target: Place): void => {
    dismiss();
    router.push({
      pathname: "/[tripId]/map/place/[placeId]",
      params: { tripId, placeId: target.id },
    });
  };

  const distance = place === null ? null : distanceLabelFor(position, place);

  return (
    <Sheet
      visible={place !== null}
      onDismiss={dismiss}
      {...(place !== null ? { title: place.name } : null)}
      testID="map-sheet-place"
    >
      {place !== null ? (
        <View style={s.body}>
          <View style={s.categoryRow}>
            <Icon
              name={COARSE_CATEGORY_ICONS[place.coarse_category]}
              size={18}
              color={theme.color.text.secondary}
            />
            <AppText role="caption" color="secondary">
              {place.category ?? coarseCategoryLabel(place.coarse_category)}
            </AppText>
          </View>
          {distance !== null ? (
            <AppText role="caption" color="muted" testID="map-sheet-place-distance">
              {distance}
            </AppText>
          ) : null}
          {openFailed ? (
            <ErrorBanner message="Couldn't open Maps — try again." testID="map-sheet-place-error" />
          ) : null}
          <View style={s.actions}>
            <View style={s.action}>
              <Button
                title="Navigate"
                variant="secondary"
                icon="navigate-outline"
                onPress={() => handleNavigate(place)}
                testID="map-sheet-place-button-navigate"
              />
            </View>
            <View style={s.action}>
              <Button
                title="Details"
                icon="chevron-forward-outline"
                iconPosition="trailing"
                onPress={() => handleDetails(place)}
                testID="map-sheet-place-button-details"
              />
            </View>
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}
