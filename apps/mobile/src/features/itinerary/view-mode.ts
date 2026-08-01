/**
 * Per-trip list ↔ grid persistence (T-7.4 / IT-1 — R-itin-9): the toggle
 * choice is stored locally PER TRIP and restored on next open. MMKV default
 * instance, same adapter pattern as `navigation/last-viewed-trip.ts` (sync
 * reads — the restored mode renders on first frame, no flash; jest gets the
 * package's in-memory mock automatically).
 *
 * Not cleared on sign-out by design: a view preference is not account data
 * (unlike the recency stamp) — worst case a future account on this device
 * opens a trip in grid mode.
 */
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV();

export type ItineraryViewMode = "list" | "grid";

const keyFor = (tripId: string): string => `gogo.itineraryView.${tripId}`;

/** The persisted mode for this trip; default (or corrupt value) = `list`. */
export function readItineraryViewMode(tripId: string): ItineraryViewMode {
  return storage.getString(keyFor(tripId)) === "grid" ? "grid" : "list";
}

export function storeItineraryViewMode(tripId: string, mode: ItineraryViewMode): void {
  storage.set(keyFor(tripId), mode);
}
