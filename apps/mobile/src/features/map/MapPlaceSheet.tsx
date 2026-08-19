/**
 * Place sheet (T-8.3 / MAP-2 — R-map-4, map spec §2.3): the small
 * Sheet-over-map presentation for a selected pin or search result. Spine
 * data only — name, coarse-category icon + category line, distance from
 * user when a position is known (§2.3/§2.6, computed on-device) — cheap and
 * offline-capable; the detail screen owns the `?fresh=true` lane (T-8.4).
 *
 * ACTIONS — the full §2.3 row since the T-8.7 rider closed escalation E5
 * (T-8.3 shipped Navigate + Details only; the rest waited on T-8.4's
 * hooks): save toggle (R-map-11 — `useSavePlace`/`useUnsavePlace`, the
 * detail screen's optimistic layer; viewers see STATE, a badge, never the
 * control), Add to day (R-map-12 — tab jump then the `item/new` modal
 * prefilled `place_visit` + place, T-8.4's `?placeId=` contract), Navigate
 * (R-map-8), View in itinerary (R-map-23 — itinerary pins only:
 * `itineraryItemId` is the pressed pin's item, and the destination is
 * per-kind — item-kind → `item/[itemId]`, booking-kind →
 * `booking/[bookingId]` directly — MATCHING T-8.4's rerouted convention,
 * MAP-6 bullet 386 / PR #25 interp 17), Details (the §2.3 "full detail
 * PUSH", same-tab). Cross-tab actions dismiss the sheet FIRST, then jump
 * the tab, then push (mobile.md landmine — order pinned).
 *
 * NAVIGATE-OFFLINE POSTURE (T-8.7 reconciliation of PR #25 interp 15 +
 * A7): Navigate stays ENABLED offline on BOTH R-map-8 surfaces — Google
 * Maps' own offline navigation exists, and offline-inside-a-downloaded-
 * pack is the headline use case; a dead tap here would break the R-map-8
 * pair's consistency the other way. The detail screen's disable was
 * removed in the same diff.
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
import { useNavigation, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { AppText, Badge, Button, ErrorBanner, Icon, Sheet } from "@/components";
import type { IconName } from "@/components";
import {
  findSavedPlace,
  isOptimisticSavedPlaceId,
  useItinerary,
  useSavedPlaces,
  useSavePlace,
  useUnsavePlace,
} from "@/data";
import { jumpToTripTab } from "@/navigation/tab-jump";
import { useTripContext } from "@/navigation/trip-context";

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
  /** The itinerary item the selection came from — itinerary-pin taps only
   *  (R-map-23 "View in itinerary" context; null hides the action). */
  itineraryItemId: string | null;
  onDismiss(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    body: { gap: t.space[3], paddingBottom: t.space[4] },
    categoryRow: { flexDirection: "row", alignItems: "center", gap: t.space[2] },
    saveRow: { flexDirection: "row" },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: t.space[2] },
    action: { flexGrow: 1, flexBasis: "45%" },
  }),
);

export function MapPlaceSheet({ tripId, place, itineraryItemId, onDismiss }: MapPlaceSheetProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const trip = useTripContext();
  const position = useMapLocationStore((state) => state.position);
  const [openFailed, setOpenFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // R-map-11 state + mutations (E5) — the detail screen's exact layer:
  // optimistic save/unsave, 409 ≡ success, hook-level seams only.
  const editor = trip.role !== "viewer";
  const savedQuery = useSavedPlaces(tripId);
  const itineraryQuery = useItinerary(tripId);
  const save = useSavePlace(tripId, {
    onMutationError: () => setActionError("Couldn't save this place. Try again."),
    onMutationSuccess: () => setActionError(null),
  });
  const unsave = useUnsavePlace(tripId, {
    onMutationError: () => setActionError("Couldn't remove this place. Try again."),
    onMutationSuccess: () => setActionError(null),
  });
  const savedRow = place === null ? undefined : findSavedPlace(savedQuery.data, place.id);
  const saved = savedRow !== undefined;
  // Unsave needs the REAL row id — the optimistic placeholder would 404
  // (data-layer doc); the save success / 409-refetch settles it.
  const savedRowSettled = savedRow !== undefined && !isOptimisticSavedPlaceId(savedRow.id);
  const busy = save.isPending || unsave.isPending;
  // R-map-23: the action exists ONLY for a resolvable itinerary-pin origin.
  const linkedItem =
    itineraryItemId === null
      ? undefined
      : itineraryQuery.data?.items.find((item) => item.id === itineraryItemId);

  const dismiss = (): void => {
    setOpenFailed(false);
    setActionError(null);
    onDismiss();
  };

  const toggleSave = (target: Place): void => {
    if (busy) return;
    setActionError(null);
    if (!saved) {
      save.mutate({ place: target });
      return;
    }
    if (savedRowSettled) unsave.mutate(savedRow.id);
  };

  /** R-map-12: dismiss → tab jump → prefilled item/new (module doc order). */
  const handleAddToDay = (target: Place): void => {
    dismiss();
    if (!jumpToTripTab(navigation, tripId, "itinerary")) return;
    router.push({
      pathname: "/[tripId]/itinerary/item/new",
      params: {
        tripId,
        category: "place_visit",
        placeId: target.id,
        placeName: target.name,
      },
    });
  };

  /** R-map-23: per-kind destination (module doc — T-8.4's convention). */
  const handleViewInItinerary = (): void => {
    if (linkedItem === undefined) return;
    dismiss();
    if (!jumpToTripTab(navigation, tripId, "itinerary")) return;
    if (linkedItem.kind === "booking" && linkedItem.booking_id !== null) {
      router.push({
        pathname: "/[tripId]/itinerary/booking/[bookingId]",
        params: { tripId, bookingId: linkedItem.booking_id },
      });
      return;
    }
    router.push({
      pathname: "/[tripId]/itinerary/item/[itemId]",
      params: { tripId, itemId: linkedItem.id },
    });
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
          {/* R-map-11 (E5): viewers see STATE, not the control. */}
          {editor ? (
            <View style={s.saveRow}>
              <Button
                title={saved ? "Saved" : "Save place"}
                variant={saved ? "secondary" : "primary"}
                size="sm"
                icon={saved ? "bookmark" : "bookmark-outline"}
                disabled={busy || (saved && !savedRowSettled)}
                onPress={() => toggleSave(place)}
                testID="map-sheet-place-button-save"
              />
            </View>
          ) : saved ? (
            <View style={s.saveRow}>
              <Badge label="Saved" tone="neutral" testID="map-sheet-place-badge-saved" />
            </View>
          ) : null}
          {actionError !== null ? (
            <ErrorBanner
              message={actionError}
              onDismiss={() => setActionError(null)}
              testID="map-sheet-place-action-error"
            />
          ) : null}
          {openFailed ? (
            <ErrorBanner message="Couldn't open Maps — try again." testID="map-sheet-place-error" />
          ) : null}
          {/* §2.3 action order: Add to day · Navigate · View in itinerary
              (itinerary pins only) · Details. Add-to-day is a write —
              editors only (R-ib-24 client half, the detail's posture). */}
          <View style={s.actions}>
            {editor ? (
              <View style={s.action}>
                <Button
                  title="Add to day"
                  variant="secondary"
                  icon="calendar-outline"
                  disabled={busy}
                  onPress={() => handleAddToDay(place)}
                  testID="map-sheet-place-button-add-to-day"
                />
              </View>
            ) : null}
            <View style={s.action}>
              <Button
                title="Navigate"
                variant="secondary"
                icon="navigate-outline"
                onPress={() => handleNavigate(place)}
                testID="map-sheet-place-button-navigate"
              />
            </View>
            {linkedItem !== undefined ? (
              <View style={s.action}>
                <Button
                  title="View in itinerary"
                  variant="secondary"
                  icon="list-outline"
                  onPress={handleViewInItinerary}
                  testID="map-sheet-place-button-view-itinerary"
                />
              </View>
            ) : null}
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
