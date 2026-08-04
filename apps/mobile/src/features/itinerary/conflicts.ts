/**
 * Conflict analysis (T-7.5 / IT-4 — itinerary spec §2.2, R-itin-7/R-itin-20).
 * Pure: the day's items → (a) which items' timed spans directly overlap
 * another's, (b) which days list their items out of time order, (c) the
 * id order a "Sort day by time" PUT should send, and (d) whether a
 * not-yet-saved form placement would land on top of something (R-itin-20).
 *
 * ONE overlap rule, seen twice. The grid already surfaces overlaps as
 * side-by-side blocks + a Badge (R-itin-15, T-7.7); the list surfaces the
 * SAME fact as a warning chip (R-itin-7). Both therefore run
 * `assignOverlapColumns` (grid/layout.ts — the one home for the interval
 * math) over spans derived by the SAME ladder the grid uses, and
 * `conflicts.test.ts` pins list ≡ grid on shared fixtures so the two can
 * never drift apart silently.
 *
 * Two span notions, deliberately different:
 *  - OVERLAP span (`timedSpanOf`): null for untimed items AND for spanning
 *    lodging, because the grid renders those in the all-day lane, never as
 *    blocks — a hotel stay is ambient, not a conflict with dinner.
 *  - SORT key (`startMinutesOf`): any item with a `start_time`, spanning
 *    lodging included, because the LIST does render its check-in row inline
 *    among the day's items (R-itin-31), so it absolutely participates in
 *    "is this day in time order".
 */
import type { ISODate, ItineraryItem, Booking } from "@gogo/shared";

import { assignOverlapColumns, type TimedSpan } from "./grid/layout";
import { DEFAULT_BLOCK_MINUTES, MINUTES_PER_DAY, parseISOTime } from "./grid/model";
import { projectItem } from "./model";

/** A candidate calendar placement — the wire-derived shape (`DerivedItemPlacement`). */
export interface PlacementCandidate {
  day: ISODate;
  end_day: ISODate | null;
  start_time: string | null;
  end_time: string | null;
  /**
   * Spanning lodging (check-in day ≠ check-out day) — the all-day-lane case,
   * excluded from overlap exactly like an existing spanning item.
   */
  spanning: boolean;
}

/**
 * The GRID's block ladder (grid/model.ts `buildGridDays`), expressed once for
 * both surfaces: cross-wall-date items clip at midnight ("+1" tail),
 * end-less items get the default block, and a wire-invalid end<start floors
 * to a zero-length span (widened internally by `assignOverlapColumns`).
 */
function spanOfPlacement(placement: {
  day: ISODate;
  end_day: ISODate | null;
  start_time: string | null;
  end_time: string | null;
}): TimedSpan | null {
  if (placement.start_time === null) return null;
  const startMinutes = parseISOTime(placement.start_time);
  const crossesMidnight = placement.end_day !== null && placement.end_day > placement.day;
  let endMinutes: number;
  if (crossesMidnight) {
    endMinutes = MINUTES_PER_DAY;
  } else if (placement.end_time === null) {
    endMinutes = Math.min(startMinutes + DEFAULT_BLOCK_MINUTES, MINUTES_PER_DAY);
  } else {
    endMinutes = Math.max(parseISOTime(placement.end_time), startMinutes);
  }
  return { startMinutes, endMinutes };
}

/** True ⟺ `projectItem` emits two rows, i.e. spanning lodging (R-itin-31). */
function isSpanningLodging(
  item: ItineraryItem,
  bookingsById: ReadonlyMap<string, Booking>,
): boolean {
  return projectItem(item, bookingsById).length === 2;
}

/** Overlap span of an existing item on its own `day` column (module doc). */
export function timedSpanOf(
  item: ItineraryItem,
  bookingsById: ReadonlyMap<string, Booking>,
): TimedSpan | null {
  if (isSpanningLodging(item, bookingsById)) return null;
  return spanOfPlacement(item);
}

/** Sort key half (module doc): any `start_time`, spanning lodging included. */
export function startMinutesOf(item: ItineraryItem): number | null {
  return item.start_time === null ? null : parseISOTime(item.start_time);
}

/** `(sort_order, id)` — the R-ib-13/R-ib-15 read order within a day. */
function byDayOrder(a: ItineraryItem, b: ItineraryItem): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface DayConflicts {
  /** R-itin-7: items whose span directly overlaps another's on the same day. */
  overlappingItemIds: ReadonlySet<string>;
  /** R-itin-7: days whose `sort_order` disagrees with `start_time` order. */
  unsortedDays: ReadonlySet<ISODate>;
  /** `date → the id order a "Sort day by time" PUT sends` (R-ib-15 payload). */
  sortedDayOrders: ReadonlyMap<ISODate, string[]>;
}

const EMPTY_CONFLICTS: DayConflicts = {
  overlappingItemIds: new Set(),
  unsortedDays: new Set(),
  sortedDayOrders: new Map(),
};

/**
 * "Sort day by time" order (R-itin-7).
 *
 * INTERPRETATION (spec-uncovered): the spec names the affordance but not
 * where untimed items land. They DON'T MOVE — each untimed item keeps its
 * exact slot and only the timed items are permuted among the slots they
 * already occupy. Sorting is meant to fix the one thing that's wrong (times
 * out of order); shunting every untimed item to the end would silently
 * rewrite a hand-built running order the user never complained about, and
 * "never auto-resort" is the rule's whole spirit.
 */
export function sortDayByTime(ordered: readonly ItineraryItem[]): string[] {
  const timedSlots = ordered.flatMap((item, index) =>
    startMinutesOf(item) === null ? [] : [index],
  );
  const byTime = [...timedSlots].sort((a, b) => {
    const itemA = ordered[a];
    const itemB = ordered[b];
    if (itemA === undefined || itemB === undefined) return a - b;
    const startA = startMinutesOf(itemA) ?? 0;
    const startB = startMinutesOf(itemB) ?? 0;
    if (startA !== startB) return startA - startB;
    // Ties keep their current relative order (stable) — a same-minute pair
    // is not "out of order", so sorting must not shuffle it.
    return a - b;
  });

  const ids = ordered.map((item) => item.id);
  timedSlots.forEach((slot, position) => {
    const source = byTime[position];
    const item = source === undefined ? undefined : ordered[source];
    if (item !== undefined) ids[slot] = item.id;
  });
  return ids;
}

/**
 * Whole-trip analysis. Items are grouped by their HOME day (`item.day`) —
 * that is the day whose `sort_order` owns them and the only day a day-order
 * PUT may list them under (a synthesized check-out row belongs to its
 * check-in day, T-7.4's model).
 */
export function analyzeDayConflicts(
  items: readonly ItineraryItem[],
  bookingsById: ReadonlyMap<string, Booking>,
): DayConflicts {
  if (items.length === 0) return EMPTY_CONFLICTS;

  const byDay = new Map<ISODate, ItineraryItem[]>();
  for (const item of items) {
    const bucket = byDay.get(item.day);
    if (bucket === undefined) byDay.set(item.day, [item]);
    else bucket.push(item);
  }

  const overlappingItemIds = new Set<string>();
  const unsortedDays = new Set<ISODate>();
  const sortedDayOrders = new Map<ISODate, string[]>();

  for (const [day, dayItems] of byDay) {
    const ordered = [...dayItems].sort(byDayOrder);

    // (a) R-itin-7 overlap chips — grid-identical interval math.
    const spans = ordered.flatMap((item) => {
      const span = timedSpanOf(item, bookingsById);
      return span === null ? [] : [{ ...span, itemId: item.id }];
    });
    for (const assigned of assignOverlapColumns(spans)) {
      if (assigned.overlapping) overlappingItemIds.add(assigned.itemId);
    }

    // (b) R-itin-7 sort affordance — start times non-decreasing in row order.
    let previous = -1;
    let monotonic = true;
    for (const item of ordered) {
      const start = startMinutesOf(item);
      if (start === null) continue;
      if (start < previous) {
        monotonic = false;
        break;
      }
      previous = start;
    }
    if (!monotonic) {
      unsortedDays.add(day);
      sortedDayOrders.set(day, sortDayByTime(ordered));
    }
  }

  return { overlappingItemIds, unsortedDays, sortedDayOrders };
}

// ---------------------------------------------------------------------------
// R-itin-20 — the FORM's inline conflict notice
// ---------------------------------------------------------------------------

/** One existing item a pending form placement would land on top of. */
export interface ConflictHit {
  itemId: string;
  title: string;
  /** "09:00 – 11:30" / "09:00" — the same caption the list card shows. */
  timeLabel: string;
}

export interface PlacementConflictContext {
  items: readonly ItineraryItem[];
  bookingsById: ReadonlyMap<string, Booking>;
  /** Edit mode: the item(s) being edited never conflict with themselves. */
  excludeItemIds?: readonly string[];
  /** Booking edit: every auto-item of THIS booking is excluded (R-ib-5). */
  excludeBookingId?: string | null;
}

/**
 * R-itin-20: which existing items the pending placement(s) overlap. Empty ⇒
 * no notice. Never blocks a save — the caller renders this as information
 * (overlaps are legal, API R-ib-17).
 *
 * Hits are de-duplicated by item id and returned in the day's read order, so
 * a two-placement booking (car pickup + dropoff) reads as one list.
 */
export function findPlacementConflicts(
  placements: readonly PlacementCandidate[],
  context: PlacementConflictContext,
): ConflictHit[] {
  const excludedIds = new Set(context.excludeItemIds ?? []);
  const hits = new Map<string, ConflictHit>();

  for (const placement of placements) {
    if (placement.spanning) continue;
    const candidate = spanOfPlacement(placement);
    if (candidate === null) continue;

    const sameDay = context.items
      .filter((item) => {
        if (item.day !== placement.day) return false;
        if (excludedIds.has(item.id)) return false;
        if (
          context.excludeBookingId !== undefined &&
          context.excludeBookingId !== null &&
          item.booking_id === context.excludeBookingId
        ) {
          return false;
        }
        return true;
      })
      .sort(byDayOrder);

    for (const item of sameDay) {
      const span = timedSpanOf(item, context.bookingsById);
      if (span === null) continue;
      // Same strict intersection `assignOverlapColumns` badges with, incl.
      // its zero-length widening (two identical point events DO collide).
      const candidateEnd = Math.max(candidate.endMinutes, candidate.startMinutes + 1);
      const itemEnd = Math.max(span.endMinutes, span.startMinutes + 1);
      if (candidate.startMinutes >= itemEnd || span.startMinutes >= candidateEnd) continue;
      if (hits.has(item.id)) continue;
      const entry = projectItem(item, context.bookingsById)[0];
      hits.set(item.id, {
        itemId: item.id,
        title: entry?.title ?? "Untitled",
        timeLabel: entry?.timeLabel ?? "",
      });
    }
  }

  return [...hits.values()];
}
