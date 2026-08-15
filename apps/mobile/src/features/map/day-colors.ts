/**
 * Day-color mapping (T-8.2 / MAP-1 — map spec §2.2, R-map-3/R-map-7).
 *
 * Pure module: itinerary pin day index = `(day - trip.start_date)` in whole
 * wall-days, color = `mapDayColors(theme)[euclid(dayIndex)]`.
 *
 * THE BINDING RULING (P-8 W1, recorded in the tokens doc comments): the
 * color lookup MUST use the Euclidean modulo `((dayIndex % 8) + 8) % 8`,
 * NOT §2.2's literal `dayIndex % 8`. R-itin-1 unions item days OUTSIDE the
 * trip range into the itinerary, so `dayIndex` can be negative — and JS `%`
 * yields a NEGATIVE remainder for negative operands, which indexes the
 * 8-tuple as `undefined` and lands an invalid paint value on the Mapbox
 * layer. Pinned by day-colors.test.ts (negative-index arm + naive-modulo
 * control).
 */
import type { ISODate } from "@gogo/shared";
import type { MapDayColors } from "@gogo/tokens";

/** The day-color cycle length — `MapDayColors` is an 8-tuple (§2.2). */
export const DAY_COLOR_COUNT = 8;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` → UTC ms, no tz round trip (itinerary model.ts precedent). */
function utcMs(iso: ISODate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/**
 * Wall-date day index (§2.2): `day - trip.start_date` in whole days.
 * 0 = the trip's first day; NEGATIVE when the item day precedes the trip
 * (legal — R-itin-1). Pure calendar math on UTC-anchored dates, so DST can
 * never produce a fractional day.
 */
export function dayIndexFor(day: ISODate, tripStart: ISODate): number {
  return Math.round((utcMs(day) - utcMs(tripStart)) / MS_PER_DAY);
}

/** Euclidean modulo into the 8-color cycle — always `0..7`, ruling above. */
export function dayColorIndex(dayIndex: number): number {
  return ((dayIndex % DAY_COLOR_COUNT) + DAY_COLOR_COUNT) % DAY_COLOR_COUNT;
}

/** Day color for an arbitrary (possibly negative) day index — never undefined. */
export function dayColorFor(colors: MapDayColors, dayIndex: number): string {
  return colors[dayColorIndex(dayIndex)];
}

/**
 * The pin glyph's day number (§2.2: "the pin glyph carries the day number so
 * color is never the only signal") — 1-based for in-range days. Out-of-range
 * days carry their arithmetic number (0, -1, …): honest about being outside
 * the trip window, and stable under the same index the color derives from.
 */
export function dayNumberLabel(dayIndex: number): string {
  return String(dayIndex + 1);
}
