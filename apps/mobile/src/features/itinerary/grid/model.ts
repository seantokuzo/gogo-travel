/**
 * Calendar-grid projection (T-7.7 / IT-6 — itinerary spec §2.5–§2.6,
 * R-itin-13..17, R-itin-31 grid half). Pure: `{trip dates, items, bookings}`
 * → per-day-column render data. The LIST half of R-itin-31 (check-in/
 * check-out synthesis) shipped in T-7.4's `../model` — this module REUSES
 * `projectItem` for entry metadata (titles, icons, status, day-lock
 * enrichment fallbacks) so the two views can never disagree about what an
 * item is, and only adds the grid-specific geometry:
 *
 * - timed item        → positioned block (`start_time`/`end_time`, R-itin-13)
 * - untimed item      → all-day chip (R-itin-16)
 * - spanning lodging  → lane segments across covered day columns, labeled at
 *                       the check-in/check-out edges — NEVER a full-height
 *                       band (R-itin-31, §2.6)
 * - other spans       → one block on `day` clipped at midnight + "+1" tail
 *                       (§2.6 cross-midnight rule)
 *
 * Day columns reuse `buildDaySet` (trip range ∪ item render days — sparse
 * outside the range, the T-7.4 precedent). All date/time math is tz-free
 * wall-value arithmetic per the wire contract (§3.3 time model).
 */
import type { Booking, BookingStatus, ISODate, ItineraryItem } from "@gogo/shared";

import type { IconName } from "@/components";

import { buildDaySet, projectItem } from "../model";
import { assignOverlapColumns, type ColumnAssignment } from "./layout";

export const MINUTES_PER_DAY = 24 * 60;
/** Render duration for a timed item with no `end_time` (§2.5 is silent — 1h). */
export const DEFAULT_BLOCK_MINUTES = 60;

// ---------------------------------------------------------------------------
// Time helpers (pure, tz-free)
// ---------------------------------------------------------------------------

/** `HH:MM` (ISOTime scalar) → minutes from midnight. */
export function parseISOTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * R-itin-14 gap-tap prefill: the slot's time rounded to 30 min. `fraction`
 * is the tap position within the hour row (0..1); floor-to-half-hour (the
 * tapped region IS the slot — calendar convention), so the top half prefills
 * `HH:00` and the bottom half `HH:30`.
 */
export function slotPrefillTime(hour: number, fraction: number): string {
  const clamped = Math.min(23, Math.max(0, Math.trunc(hour)));
  const half = fraction >= 0.5 ? "30" : "00";
  return `${String(clamped).padStart(2, "0")}:${half}`;
}

/**
 * R-itin-17 landing column: today's column when it exists (trip active and
 * today in range — including a sparse out-of-range item day that IS today),
 * else the trip's first day.
 */
export function initialDayIndex(dates: readonly ISODate[], today: ISODate): number {
  const index = dates.indexOf(today);
  return index >= 0 ? index : 0;
}

// ---------------------------------------------------------------------------
// Grid model shapes
// ---------------------------------------------------------------------------

interface GridEntryMeta {
  itemId: string;
  /** Booking-kind rows route to booking-detail (R-itin-27); others to item. */
  bookingId: string | null;
  title: string;
  icon: IconName;
  /** `planned` = accent edge, `booked` = success edge (§2.5); null otherwise. */
  status: BookingStatus | null;
}

export interface GridTimedBlock extends GridEntryMeta, ColumnAssignment {
  startMinutes: number;
  /** Clipped at midnight for cross-day spans (`plusOne` marks the tail). */
  endMinutes: number;
  /** §2.6 "+1" tail — the block continues onto the next wall date. */
  plusOne: boolean;
}

export interface GridAllDayChip extends GridEntryMeta {
  plusOne: boolean;
}

export interface GridSpanSegment extends GridEntryMeta {
  /** Lane row inside the all-day strip (stacked spans get distinct lanes). */
  lane: number;
  /** Check-in edge column — carries the label (§2.6). */
  isStart: boolean;
  /** Check-out edge column — carries the label (§2.6). */
  isEnd: boolean;
}

export interface GridDay {
  date: ISODate;
  blocks: GridTimedBlock[];
  allDay: GridAllDayChip[];
  spans: GridSpanSegment[];
}

export interface GridModel {
  days: GridDay[];
  /** Global span-lane row count — sizes the header strip uniformly. */
  laneCount: number;
  /** Max all-day chips on any single day — 0 hides the chip row entirely. */
  maxAllDayCount: number;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

interface RawBlock extends GridEntryMeta {
  startMinutes: number;
  endMinutes: number;
  plusOne: boolean;
}

interface RawSpan {
  meta: GridEntryMeta;
  startDay: ISODate;
  endDay: ISODate;
}

export function buildGridDays(
  trip: { start_date: ISODate; end_date: ISODate },
  items: readonly ItineraryItem[],
  bookingsById: ReadonlyMap<string, Booking>,
): GridModel {
  const renderDays = new Set<ISODate>();
  const blocksByDay = new Map<ISODate, RawBlock[]>();
  const allDayByDay = new Map<ISODate, GridAllDayChip[]>();
  const rawSpans: RawSpan[] = [];

  for (const item of items) {
    const entries = projectItem(item, bookingsById);
    const first = entries[0];
    if (first === undefined) continue;
    const meta: GridEntryMeta = {
      itemId: first.itemId,
      bookingId: first.bookingId,
      title: first.title,
      icon: first.icon,
      status: first.status,
    };

    // `projectItem` emits two entries ⟺ spanning lodging (R-itin-31): the
    // grid renders those as an all-day lane, never a full-height band.
    if (entries.length === 2 && item.end_day !== null) {
      rawSpans.push({ meta, startDay: item.day, endDay: item.end_day });
      renderDays.add(item.day);
      renderDays.add(item.end_day);
      continue;
    }

    renderDays.add(item.day);
    if (item.start_time === null) {
      // R-itin-16: untimed → compact all-day chip above the column.
      const chip: GridAllDayChip = { ...meta, plusOne: first.plusOne };
      const bucket = allDayByDay.get(item.day);
      if (bucket === undefined) allDayByDay.set(item.day, [chip]);
      else bucket.push(chip);
      continue;
    }

    const startMinutes = parseISOTime(item.start_time);
    let endMinutes: number;
    if (first.plusOne) {
      // §2.6 cross-midnight: clip at midnight, "+1" tail marks continuation.
      endMinutes = MINUTES_PER_DAY;
    } else if (item.end_time === null) {
      endMinutes = Math.min(startMinutes + DEFAULT_BLOCK_MINUTES, MINUTES_PER_DAY);
    } else {
      // Wire-invalid end<start never leaves the server; floor defensively.
      endMinutes = Math.max(parseISOTime(item.end_time), startMinutes);
    }
    const block: RawBlock = { ...meta, startMinutes, endMinutes, plusOne: first.plusOne };
    const bucket = blocksByDay.get(item.day);
    if (bucket === undefined) blocksByDay.set(item.day, [block]);
    else bucket.push(block);
  }

  const dates = buildDaySet(trip, renderDays);
  const dayIndex = new Map<ISODate, number>(dates.map((date, index) => [date, index]));

  // Span lanes: greedy interval assignment over day-column indices. Sorted
  // by (start, end, itemId) so stacking is deterministic.
  const spansByDay = new Map<ISODate, GridSpanSegment[]>();
  const laneEnds: number[] = [];
  const orderedSpans = [...rawSpans].sort((a, b) => {
    if (a.startDay !== b.startDay) return a.startDay < b.startDay ? -1 : 1;
    if (a.endDay !== b.endDay) return a.endDay < b.endDay ? -1 : 1;
    return a.meta.itemId < b.meta.itemId ? -1 : 1;
  });
  for (const span of orderedSpans) {
    const startIdx = dayIndex.get(span.startDay);
    const endIdx = dayIndex.get(span.endDay);
    if (startIdx === undefined || endIdx === undefined) continue;
    let lane = laneEnds.findIndex((end) => end < startIdx);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(endIdx);
    } else {
      laneEnds[lane] = endIdx;
    }
    // Dates are sorted, so every column index in [startIdx, endIdx] is a
    // covered day — sparse day sets slice correctly by index.
    for (let i = startIdx; i <= endIdx; i += 1) {
      const date = dates[i];
      if (date === undefined) continue;
      const segment: GridSpanSegment = {
        ...span.meta,
        lane,
        isStart: i === startIdx,
        isEnd: i === endIdx,
      };
      const bucket = spansByDay.get(date);
      if (bucket === undefined) spansByDay.set(date, [segment]);
      else bucket.push(segment);
    }
  }

  let maxAllDayCount = 0;
  for (const chips of allDayByDay.values()) {
    maxAllDayCount = Math.max(maxAllDayCount, chips.length);
  }

  const days: GridDay[] = dates.map((date) => ({
    date,
    blocks: assignOverlapColumns(blocksByDay.get(date) ?? []),
    allDay: allDayByDay.get(date) ?? [],
    spans: spansByDay.get(date) ?? [],
  }));

  return { days, laneCount: laneEnds.length, maxAllDayCount };
}
