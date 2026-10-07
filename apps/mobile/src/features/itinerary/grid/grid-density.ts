/**
 * Per-trip calendar-density persistence (T-7.13 — R-itin-33, §2.5b): the
 * Day / 3-day / Month / Trip-span choice is stored locally PER TRIP and
 * restored on next open. MMKV default instance, same adapter pattern as
 * `../view-mode.ts` (sync reads — the restored density renders on the first
 * frame, no flash; jest gets the package's in-memory mock automatically).
 *
 * The key is INDEPENDENT of the R-itin-9 list/grid key
 * (`gogo.itineraryView.{tripId}`): switching list ↔ grid never resets
 * density, and vice versa (§2.5b).
 *
 * CONSUMERS (cross-task contract — T-7.14 Month, T-7.16 screen wiring):
 * `Density`, `DENSITIES`, `isDensity`, `DEFAULT_DENSITY`, `readGridDensity`,
 * `storeGridDensity`, `gridDensityKey`. The persisted type is the FULL
 * four-value R-itin-33 set so the Month surface can persist/restore without
 * re-opening this file; `GridSurface` only renders the three it can
 * (`GridSurfaceDensity` — Month is its own surface, R-itin-35).
 *
 * Not cleared on sign-out by design: a view preference is not account data
 * (same call as `view-mode.ts`).
 */
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV();

/**
 * Every R-itin-33 option, in segment order. The string values double as the
 * §2.9 testID suffixes (`itinerary-density-segment-{day|3-day|month|trip-span}`)
 * and as the persisted value.
 */
export const DENSITIES = ["day", "3-day", "month", "trip-span"] as const;
export type Density = (typeof DENSITIES)[number];

/** R-itin-33: Day (existing R-itin-13..17 behavior) is the default. */
export const DEFAULT_DENSITY: Density = "day";

/**
 * The subset the shared hour-timeline `GridSurface` renders (R-itin-34).
 * Month is a separate component (R-itin-35), so it is NOT a grid density.
 */
export const GRID_SURFACE_DENSITIES = ["day", "3-day", "trip-span"] as const;
export type GridSurfaceDensity = (typeof GRID_SURFACE_DENSITIES)[number];

/**
 * Narrow an arbitrary string (the DS SegmentedControl's `key`, a persisted
 * value) back to the union — the drift-proof alternative to an `as Density`
 * cast: a value the tuple doesn't contain is dropped, never smuggled into state.
 */
export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && (DENSITIES as readonly string[]).includes(value);
}

/** Narrow to the three densities `GridSurface` can render. */
export function isGridSurfaceDensity(value: unknown): value is GridSurfaceDensity {
  return typeof value === "string" && (GRID_SURFACE_DENSITIES as readonly string[]).includes(value);
}

/** The MMKV key for one trip — `gogo.itineraryGridDensity.{tripId}` (§2.5b). */
export const gridDensityKey = (tripId: string): string => `gogo.itineraryGridDensity.${tripId}`;

/**
 * The persisted density for this trip; absent, empty, or any value the union
 * doesn't contain (corrupt / written by a future build) = `day`.
 */
export function readGridDensity(tripId: string): Density {
  const stored = storage.getString(gridDensityKey(tripId));
  return isDensity(stored) ? stored : DEFAULT_DENSITY;
}

export function storeGridDensity(tripId: string, density: Density): void {
  storage.set(gridDensityKey(tripId), density);
}
