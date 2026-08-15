/**
 * FROZEN SEAM (a) — place-sheet mount slot (T-8.2 / MAP-1; filled by
 * **T-8.3**, MAP-2 / R-map-4, map spec §2.3).
 *
 * The map screen owns pin SELECTION (its `onPinSelect(placeId)` handler
 * feeds `selectedPlaceId` here); this slot owns pin PRESENTATION. T-8.3
 * replaces the null render with the design-system Sheet (`map-sheet-place`,
 * snap `content`) — spine data, save toggle, actions row — WITHOUT touching
 * the screen: the props below are the whole contract.
 *
 * Contract:
 * - `selectedPlaceId !== null` ⇔ a saved/itinerary pin is selected; the
 *   sheet presents for it. `null` ⇔ nothing selected, render nothing.
 * - `onClose` clears the screen's selection state — wire it to every sheet
 *   dismissal route. (Map-tap dismissal is already wired screen-side:
 *   MapView presses call it, the §2.3 "tapping the map dismisses" rule.)
 * - Photo pins never route here (they open the photo viewer, R-map-4) —
 *   the screen's press handler is where T-8.3 adds that routing.
 */

export interface MapPlaceSheetSlotProps {
  tripId: string;
  selectedPlaceId: string | null;
  onClose(): void;
}

export function MapPlaceSheetSlot(_props: MapPlaceSheetSlotProps): null {
  return null;
}
