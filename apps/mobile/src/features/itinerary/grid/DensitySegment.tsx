/**
 * Calendar density control (T-7.13 — R-itin-33, §2.5b): the segmented
 * "Day · 3-day · Month · Trip-span" switch that sits beside the R-itin-9
 * list/grid toggle in the PageHeader trailing slot (grid mode only — the
 * screen, T-7.16, owns the mount and the visibility rule).
 *
 * A thin, PURE, controlled wrapper over the DS `SegmentedControl`
 * (StyleSheet + `@gogo/tokens`, `bg.inset` track ≥44pt, `tablist`/`tab` roles,
 * `accessibilityState.selected`, `selection` haptic on a real change only,
 * per-segment testIDs `{testID}-{key}`) — so it inherits the DS a11y contract
 * instead of re-deriving it. What it adds:
 * - the §2.9 testIDs: root `itinerary-density-segment`, segments
 *   `itinerary-density-segment-{day|3-day|month|trip-span}` (the `Density`
 *   string IS the key);
 * - a narrowing guard, so a key the union doesn't contain is dropped.
 *
 * PERSISTENCE IS THE SCREEN'S, NOT THIS CONTROL'S (T-7.16 contract). Like the
 * R-itin-9 view-mode toggle and the DS control itself, this component only
 * reports a choice. Density is also set PROGRAMMATICALLY — T-7.14's Month
 * day-cell tap switches to Day — and a store living inside the control would
 * be silently skipped on that path. The screen owns ONE
 * `changeDensity(next)` = `setDensity(next)` + `storeGridDensity(tripId, next)`
 * and routes both this control and the Month tap through it; restore is its
 * `useState(() => readGridDensity(tripId))` (`grid-density.ts`).
 *
 * `options` defaults to ALL four R-itin-33 densities in spec order; pass a
 * subset to offer fewer. The default deliberately does NOT omit Month: whether
 * Month is routable is the screen's knowledge, and a control that hid it by
 * default would silently ship 3-of-4 to a screen that forgot the prop.
 */
import { SegmentedControl } from "@/components";

import { DENSITIES, isDensity, type Density } from "./grid-density";

const DENSITY_LABELS: Record<Density, string> = {
  day: "Day",
  "3-day": "3-day",
  month: "Month",
  "trip-span": "Trip-span",
};

export interface DensitySegmentProps {
  /** The current density (controlled) — typically seeded from `readGridDensity(tripId)`. */
  value: Density;
  /** Called with the newly chosen density. The caller persists it (see above). */
  onChange(density: Density): void;
  /** Which densities to offer, in order. Default: all four (`DENSITIES`). */
  options?: readonly Density[];
}

export function DensitySegment({ value, onChange, options = DENSITIES }: DensitySegmentProps) {
  return (
    <SegmentedControl
      testID="itinerary-density-segment"
      segments={options.map((key) => ({ key, label: DENSITY_LABELS[key] }))}
      selectedKey={value}
      onChange={(key) => {
        if (!isDensity(key)) return;
        onChange(key);
      }}
    />
  );
}
