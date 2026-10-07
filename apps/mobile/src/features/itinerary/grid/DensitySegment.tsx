/**
 * Calendar density control (T-7.13 — R-itin-33, §2.5b): the segmented
 * "Day · 3-day · Month · Trip-span" switch that sits beside the R-itin-9
 * list/grid toggle in the PageHeader trailing slot (grid mode only — the
 * screen, T-7.16, owns the mount and the visibility rule).
 *
 * A thin, controlled wrapper over the DS `SegmentedControl` (StyleSheet +
 * `@gogo/tokens`, `bg.inset` track ≥44pt, `tablist`/`tab` roles,
 * `accessibilityState.selected`, `selection` haptic on a real change only,
 * per-segment testIDs `{testID}-{key}`) — so it inherits the DS a11y contract
 * instead of re-deriving it. What it adds:
 * - the §2.9 testIDs: root `itinerary-density-segment`, segments
 *   `itinerary-density-segment-{day|3-day|month|trip-span}` (the `Density`
 *   string IS the key);
 * - persistence: a selection is written to the per-trip density key
 *   (`grid-density.ts`) BEFORE the callback fires, so a handler that re-reads
 *   storage already sees the new choice;
 * - a narrowing guard, so a key the union doesn't contain is dropped.
 *
 * `options` defaults to the three densities the shared hour-timeline
 * `GridSurface` renders. Month is its own surface (R-itin-35, T-7.14) and is
 * only offered once the screen can route it: T-7.16 passes `DENSITIES`.
 * Restoring the persisted choice is the screen's `useState(() =>
 * readGridDensity(tripId))` — this control is controlled by `value`.
 */
import { SegmentedControl } from "@/components";

import { GRID_SURFACE_DENSITIES, isDensity, storeGridDensity, type Density } from "./grid-density";

const DENSITY_LABELS: Record<Density, string> = {
  day: "Day",
  "3-day": "3-day",
  month: "Month",
  "trip-span": "Trip-span",
};

export interface DensitySegmentProps {
  /** The trip whose density key a selection is persisted under. */
  tripId: string;
  /** The current density (controlled) — typically `readGridDensity(tripId)` on mount. */
  value: Density;
  /** Called with the newly chosen density, after it has been persisted. */
  onChange(density: Density): void;
  /** Which densities to offer, in order. Default: the three `GridSurface` renders. */
  options?: readonly Density[];
}

export function DensitySegment({
  tripId,
  value,
  onChange,
  options = GRID_SURFACE_DENSITIES,
}: DensitySegmentProps) {
  return (
    <SegmentedControl
      testID="itinerary-density-segment"
      segments={options.map((key) => ({ key, label: DENSITY_LABELS[key] }))}
      selectedKey={value}
      onChange={(key) => {
        if (!isDensity(key)) return;
        storeGridDensity(tripId, key);
        onChange(key);
      }}
    />
  );
}
