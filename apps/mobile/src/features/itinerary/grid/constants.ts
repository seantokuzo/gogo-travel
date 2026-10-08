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
 * R-itin-34 (T-7.13) — the density mechanism varies ONLY the simultaneous
 * day-column count/width; the hour timeline below is untouched.
 *
 * - Day:       one column at `COLUMN_FRACTION` of the window (the peek above).
 * - 3-day:     exactly this many columns share the window, no snap-peek.
 * - Trip-span: every trip day at once, each at least `MIN_COLUMN_WIDTH`; a
 *              trip too long for that floor scrolls horizontally, continuously.
 *
 * `MIN_COLUMN_WIDTH` is the 44pt touch-target floor (the same 44 as
 * `MIN_HOUR_HEIGHT`): a 7-day trip still fits a 360pt-wide phone
 * ((360 - GUTTER_WIDTH) / 7 = 44.6), longer trips scroll.
 */
export const THREE_DAY_COLUMNS = 3;
export const MIN_COLUMN_WIDTH = 44;

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
