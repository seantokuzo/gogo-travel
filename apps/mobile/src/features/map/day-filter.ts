/**
 * Day-filter model (T-8.2 / MAP-1 — R-map-3, map spec §2.2).
 *
 * Pure module: chip derivation + the visibility predicate. The filter value
 * is a wall-day index from trip start (`"all"` default per R-map-3).
 *
 * CHIP RANGE (PR interpretation): chips span the TRIP's date range only
 * (dayIndex `0..N-1`). R-itin-1 items outside the range still pin under
 * "All" (with their Euclidean-modulo color), but get no chip of their own —
 * a negative-index chip id (`map-day-filter-chip--2`) would fork the §2.7
 * kebab grammar, and the day filter's spec surface ("selects a day") reads
 * as the trip's days.
 *
 * FILTERING happens on the FEATURE DATA, not via a layer `filter`
 * expression: the itinerary ShapeSource clusters at the source level, so a
 * layer-side filter would leave hidden pins inflating cluster counts.
 */
import type { ISODate } from "@gogo/shared";
import type { MapDayColors } from "@gogo/tokens";

import { dayColorFor, dayIndexFor, dayNumberLabel } from "./day-colors";
import type { PinFeatureCollection } from "./pin-features";

/** `"all"` (default) or a trip-relative day index (0-based). */
export type MapDayFilter = "all" | number;

export interface DayFilterChip {
  dayIndex: number;
  day: ISODate;
  /** Chip glyph — the day number, matching the pin glyphs (§2.2). */
  label: string;
  /** Chip color — "the same mapping colors the day-filter chips" (§2.2). */
  color: string;
}

/**
 * One chip per trip day, in order. `end_date >= start_date` is
 * schema-guaranteed; the count is clamped non-negative anyway so a malformed
 * row renders no chips instead of looping.
 */
export function dayFilterChips(
  trip: { start_date: ISODate; end_date: ISODate },
  dayColors: MapDayColors,
): DayFilterChip[] {
  const count = Math.max(0, dayIndexFor(trip.end_date, trip.start_date) + 1);
  const chips: DayFilterChip[] = [];
  for (let dayIndex = 0; dayIndex < count; dayIndex += 1) {
    chips.push({
      dayIndex,
      day: addDaysISO(trip.start_date, dayIndex),
      label: dayNumberLabel(dayIndex),
      color: dayColorFor(dayColors, dayIndex),
    });
  }
  return chips;
}

/** `YYYY-MM-DD` + offset (UTC calendar math — itinerary model.ts precedent). */
function addDaysISO(iso: ISODate, days: number): ISODate {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  const yy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * R-map-3: a selected day shows ONLY that day's itinerary pins. Applied to
 * the source data so cluster counts stay truthful (module doc).
 *
 * SPAN-AWARE (R1 review): a spanning item (`endDayIndex` from `end_day`,
 * check-out date) matches EVERY covered day — `dayIndex ≤ filter ≤
 * endDayIndex` — mirroring the itinerary grid, which renders the stay on
 * both end days. Point items (`endDayIndex` null) match their day only.
 * The end index is clamped to ≥ dayIndex so a malformed inverted span
 * degrades to point behavior, never to an always-hidden pin. "all" returns
 * the collection UNCHANGED BY IDENTITY (perf: the source's shape identity
 * gates native re-diffs).
 */
export function itineraryFeaturesForFilter(
  collection: PinFeatureCollection,
  filter: MapDayFilter,
): PinFeatureCollection {
  if (filter === "all") return collection;
  return {
    type: "FeatureCollection",
    features: collection.features.filter((feature) => {
      const { dayIndex, endDayIndex } = feature.properties;
      if (dayIndex === null) return false;
      const end = Math.max(dayIndex, endDayIndex ?? dayIndex);
      return dayIndex <= filter && filter <= end;
    }),
  };
}

/**
 * R-map-3: saved and photo pins REMAIN under a day filter, dimmed. Opacity
 * for those families: 1 under "All", the token dim under a selected day.
 */
export function contextPinOpacity(filter: MapDayFilter, dimOpacity: number): number {
  return filter === "all" ? 1 : dimOpacity;
}
