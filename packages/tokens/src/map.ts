/**
 * mapColors / mapDayColors — map-layer color tokens (map spec §2.2, the ONE
 * home tokens spec §2.10 delegates map colors to).
 *
 * Pure functions of a frozen Theme, memoized per Theme reference: `getTheme`
 * is referentially stable per (accent, scheme), so outputs are too — safe to
 * hand to Mapbox style-expression props without re-render churn.
 *
 * Day-color construction (T-8.6 interpretation, pinned by map.test.ts):
 * the 8-hue cycle draws ONLY from the four shared status ramps
 * (info/success/warning/danger) at two scheme-tuned stops — mid stops for
 * days 1–4, deep (light scheme) / soft (dark scheme) stops for days 5–8.
 * The accent, primary, and neutral families are deliberately excluded:
 * §2.2 reserves accent for saved pins, primary backs the cluster bubble and
 * selected ring, and neutral backs photo-pin rings — reusing them as day
 * colors would make a day pin impersonate a reserved pin family. Status
 * ramps are shared across palettes (ramps.ts), so day identity is also
 * stable across accent-theme switches, and adding a palette (R-ds-5
 * data-only) can never degrade map legibility.
 */
import type { MapColors, MapDayColors, RampStep, Theme } from "./types.js";

const mapColorCache = new WeakMap<Theme, MapColors>();

/** Map-layer color set for a resolved Theme (map spec §2.2). */
export function mapColors(theme: Theme): MapColors {
  let colors = mapColorCache.get(theme);
  if (!colors) {
    const light = theme.scheme === "light";
    colors = Object.freeze<MapColors>({
      pinSaved: theme.color.accent.solid,
      pinPhotoRing: light ? theme.ramp.neutral[50] : theme.ramp.neutral[100],
      pinSelectedRing: theme.color.border.focus,
      clusterFill: theme.color.primary.solid,
      clusterText: theme.color.primary.onSolid,
      routeLine: light ? theme.ramp.info[600] : theme.ramp.info[500],
      dimOpacity: 0.35,
    });
    mapColorCache.set(theme, colors);
  }
  return colors;
}

const dayColorCache = new WeakMap<Theme, MapDayColors>();

/**
 * Ordered, scheme-tuned 8-hue day-color cycle (map spec §2.2). Consumers
 * index with the Euclidean modulo `dayColors[((dayIndex % 8) + 8) % 8]` —
 * R-itin-1 unions item days outside the trip range, so `dayIndex` can be
 * negative, and JS `%` yields a negative remainder (undefined lookup).
 */
export function mapDayColors(theme: Theme): MapDayColors {
  let colors = dayColorCache.get(theme);
  if (!colors) {
    const { info, success, warning, danger } = theme.ramp;
    // Mid stops carry days 1–4; the second four are deepened (light scheme)
    // or softened (dark scheme) so adjacent days always differ in hue and
    // day N / day N+4 differ in depth.
    const [mid, alt]: readonly [RampStep, RampStep] =
      theme.scheme === "light" ? [500, 800] : [400, 200];
    colors = Object.freeze([
      info[mid],
      success[mid],
      warning[mid],
      danger[mid],
      info[alt],
      success[alt],
      warning[alt],
      danger[alt],
    ]);
    dayColorCache.set(theme, colors);
  }
  return colors;
}
