/**
 * Seam (a) — FILLED (T-8.3 / MAP-2+MAP-4; was the T-8.2 null stub), then
 * EXTENDED by the T-8.7 integration rider (the sanctioned screen edit).
 * The screen owns ALL selection state; this slot presents: the place sheet
 * (R-map-4), the search bar + result list (R-map-25), and the locate
 * button + its dialogs (R-map-16/17).
 *
 * TWO SELECTION SOURCES, ONE SHEET (R-map-25 "tapping a result opens the
 * standard place sheet"). The search selection was slot state while the
 * screen was frozen; T-8.7 LIFTED it to the screen (`searchPlace` +
 * `onSelectSearchPlace`) so a search-PIN tap on the map — which only the
 * screen can observe — lands on the same state as a result-list tap here.
 * Precedence + lifecycle keep exactly one active (unchanged):
 *  - pin tap → screen sets `selectedPlaceId` (clearing `searchPlace`) → it
 *    WINS over any search selection;
 *  - result tap → `onClose()` clears the screen's pin source, then
 *    `onSelectSearchPlace(row)` makes the row the selection;
 *  - every sheet dismissal route (close button, scrim — which IS the
 *    map-tap surface while the Modal sheet is up — swipe, Android back)
 *    clears BOTH (`onSelectSearchPlace(null)` + `onClose()`). With no
 *    sheet up, the screen's own MapView-press → `onClose` wiring covers
 *    §2.3 map-tap dismissal.
 *
 * `onSearchResultsChange` reports the rows the result list currently shows
 * — the screen's temp-pin feed (R-map-25, rider E1). `selectedItemId`
 * carries the itinerary-pin item context through to the sheet's per-kind
 * "View in itinerary" (R-map-23, rider E5).
 *
 * Screen-selected ids resolve through the TQ-cached saved-places rows
 * (`place-lookup.ts`); unresolved ⇒ no sheet (interim-limited pin coverage
 * ruling — no improvised row source). The sheet is ALWAYS mounted with a
 * nullable place (the LegModeSheet pattern — ref-retention tricks for exit
 * animation are a react-hooks/refs violation).
 *
 * LAYOUT: the screen renders this slot LAST in the root view, so absolute
 * children stack above the map. The search overlay pins to the top under
 * the day-filter strip — `DAY_FILTER_CLEARANCE` allowances the strip's
 * fixed-recipe height (caption line + 2×space[1] padding + borders ≈ 40 pt
 * + space[2] gap; a measured layout needs the frozen screen — PR
 * interpretation). The locate button composes with the (i) stack
 * bottom-right (MapLocateButton doc).
 */
import type { Place } from "@gogo/shared";
import { createStyles, useTheme } from "@gogo/tokens/react";
import { useCallback } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSavedPlaces } from "@/data";
import { useTripContext } from "@/navigation/trip-context";

import { MapLocateButton } from "./MapLocateButton";
import { MapPlaceSheet } from "./MapPlaceSheet";
import { MapSearch } from "./MapSearch";
import { savedPlaceRowFor } from "./place-lookup";

/** Day-filter strip allowance (module doc) — chip box ≈40 pt + space[2]. */
const DAY_FILTER_CLEARANCE = 48;

export interface MapPlaceSheetSlotProps {
  tripId: string;
  selectedPlaceId: string | null;
  /** Itinerary-pin item context (screen press classification) — null for
   *  every other selection origin. Feeds the sheet's per-kind
   *  view-in-itinerary (R-map-23, T-8.7). */
  selectedItemId: string | null;
  /** The search-selection source, screen-owned since T-8.7 (module doc). */
  searchPlace: Place | null;
  onSelectSearchPlace(place: Place | null): void;
  /** Temp-pin feed: the rows the result list currently shows (rider E1). */
  onSearchResultsChange(places: readonly Place[]): void;
  onClose(): void;
}

const useStyles = createStyles((t) =>
  StyleSheet.create({
    searchOverlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      paddingHorizontal: t.space[4],
    },
  }),
);

export function MapPlaceSheetSlot({
  tripId,
  selectedPlaceId,
  selectedItemId,
  searchPlace,
  onSelectSearchPlace,
  onSearchResultsChange,
  onClose,
}: MapPlaceSheetSlotProps) {
  const s = useStyles();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  // The slot mounts under the [tripId] layout's TripProvider by contract
  // (the screen renders it) — destination coords are schema-guaranteed.
  const trip = useTripContext();

  const savedQuery = useSavedPlaces(tripId);

  const screenPlace =
    selectedPlaceId === null
      ? null
      : savedPlaceRowFor(savedQuery.data?.items, selectedPlaceId);
  // Precedence: the screen's pin selection wins (module doc).
  const sheetPlace = selectedPlaceId !== null ? screenPlace : searchPlace;

  const handleSelectResult = useCallback(
    (place: Place) => {
      // Clear the screen's pin source first so the result's row presents.
      onClose();
      onSelectSearchPlace(place);
    },
    [onClose, onSelectSearchPlace],
  );

  const handleDismiss = useCallback(() => {
    onSelectSearchPlace(null);
    onClose();
  }, [onSelectSearchPlace, onClose]);

  return (
    <>
      <View
        style={[s.searchOverlay, { paddingTop: insets.top + theme.space[2] + DAY_FILTER_CLEARANCE }]}
        pointerEvents="box-none"
      >
        <MapSearch
          tripId={tripId}
          destination={{ lat: trip.destination_lat, lng: trip.destination_lng }}
          onSelectResult={handleSelectResult}
          onResultsChange={onSearchResultsChange}
        />
      </View>

      <MapLocateButton />

      <MapPlaceSheet
        tripId={tripId}
        place={sheetPlace}
        itineraryItemId={selectedPlaceId !== null ? selectedItemId : null}
        onDismiss={handleDismiss}
      />
    </>
  );
}
