/**
 * Pure adjacency derivation (T-7.3 / IB-3; itinerary-bookings spec §3.5
 * step 2, R-ib-20): per day — order the day's chain by `sort_order`, resolve
 * each item's location, filter to located, take consecutive pairs. No I/O,
 * no Date, no DB — the recompute job feeds it plain rows; tests feed it the
 * matrix directly.
 *
 * CHAIN MEMBERSHIP (§3.6, resolved Branch A): an item participates in the
 * chain of its `day` AND — for spanning items — its `end_day` (a lodging row
 * sits in both the check-in and check-out days' chains; days BETWEEN are not
 * chain days — mirror of the booking service's `itemDays`). Within a chain,
 * order is `(sort_order, id)` — the same total order the itinerary read and
 * the booking service use; a spanning item slots into its end-day chain by
 * the same `sort_order` value (the spec pins "participates in the `day`
 * chain by `sort_order`" and no more — documented interpretation).
 *
 * LOCATION RESOLUTION (R-ib-20): `booking`-kind → parent `bookings.place_id`;
 * else the item's own `place_id`; no place ⇒ unlocated. Unlocated items are
 * TRANSPARENT — the chain connects across them. The resolved place id is
 * attached by the caller (recompute owns the row joins).
 */

export interface ChainItem {
  id: string;
  /** Trip-local wall-date `YYYY-MM-DD`. */
  day: string;
  endDay: string | null;
  sortOrder: number;
  /** Resolved location (R-ib-20 precedence applied by the caller); null = unlocated. */
  placeId: string | null;
  /** Coordinates of `placeId`; null iff unlocated. */
  lat: number | null;
  lng: number | null;
  /**
   * Freshness stamp for the diff rule (§3.5 step 4): the latest instant this
   * item's location/times could have changed — `max(item.updated_at, parent
   * booking.updated_at)`. Deliberately CONSERVATIVE (any row touch counts):
   * correctness over minimal provider calls; the debounce window bounds the
   * per-session cost (§3.5 step 6 posture).
   */
  changedAt: Date;
}

/** The days whose chains an item participates in (§3.6 — day + end_day only). */
export function itemChainDays(item: { day: string; endDay: string | null }): string[] {
  return item.endDay !== null && item.endDay !== item.day ? [item.day, item.endDay] : [item.day];
}

/** Co-chain days of a pair — the days on which a leg between them can be valid. */
export function coChainDays(
  a: { day: string; endDay: string | null },
  b: { day: string; endDay: string | null },
): string[] {
  const bDays = new Set(itemChainDays(b));
  return itemChainDays(a).filter((day) => bDays.has(day));
}

/** The day's chain: participants ordered `(sort_order, id)`. */
export function chainForDay(items: readonly ChainItem[], day: string): ChainItem[] {
  return items
    .filter((item) => itemChainDays(item).includes(day))
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface LegPair {
  from: ChainItem;
  to: ChainItem;
  /**
   * Identical resolved `place_id` (§3.5 step 2): zero-duration/zero-distance
   * legs per mode, no provider call.
   */
  samePlace: boolean;
}

/**
 * Consecutive located pairs of one day's chain (R-ib-20): unlocated items
 * are dropped BEFORE pairing, so the chain connects across them. Legs never
 * span days — pairing runs per chain only.
 */
export function locatedPairs(chain: readonly ChainItem[]): LegPair[] {
  const located = chain.filter(
    (item) => item.placeId !== null && item.lat !== null && item.lng !== null,
  );
  const pairs: LegPair[] = [];
  for (let i = 0; i + 1 < located.length; i += 1) {
    const from = located[i];
    const to = located[i + 1];
    if (!from || !to) continue; // index-bounded; TS narrowing only
    pairs.push({ from, to, samePlace: from.placeId === to.placeId });
  }
  return pairs;
}
