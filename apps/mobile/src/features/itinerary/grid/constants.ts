/**
 * Calendar-grid layout constants (T-7.7 / IT-6 — itinerary spec §2.5).
 * One home so GridSurface, the header strip, and the day columns can never
 * disagree about geometry (the two horizontal FlatLists must share widths).
 */

/** Width of the shared hour gutter (§2.5 "shared hour gutter"). */
export const GUTTER_WIDTH = 48;

/**
 * Day-column width as a fraction of the remaining window width — "one full
 * day per page on phones; peek of neighbors" (§2.5). 0.92 leaves an 8% peek.
 */
export const COLUMN_FRACTION = 0.92;

/**
 * R-itin-17: the 08:00–20:00 band is initially visible — 12 hour rows fill
 * the viewport, so the hour height derives from the measured body height
 * (clamped for usability on very short/tall viewports; the band goal yields
 * to the clamp on tiny screens).
 */
export const FIRST_VISIBLE_HOUR = 8;
export const VISIBLE_HOURS = 12;
export const MIN_HOUR_HEIGHT = 44;
export const MAX_HOUR_HEIGHT = 96;
/** Pre-layout fallback (before the body `onLayout` fires). */
export const DEFAULT_HOUR_HEIGHT = 60;

/** Tiny events stay tappable/readable even when their true span is shorter. */
export const MIN_BLOCK_HEIGHT = 22;

/** Header strip geometry — every cell is the same height (strip alignment). */
export const HEADER_LABEL_HEIGHT = 24;
export const SPAN_LANE_HEIGHT = 26;
export const ALL_DAY_ROW_HEIGHT = 30;
