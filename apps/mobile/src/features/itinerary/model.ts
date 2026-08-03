/**
 * Plan-mode day-list model (T-7.4 / IT-1 — itinerary spec §2.2, R-itin-1/8/31).
 * Pure projection: `{trip dates, items, bookings}` → the FLAT row array the
 * reorderable list renders. Flat on purpose (one virtualized list, headers as
 * rows): cross-day drag is then a plain index move over one array, and the
 * reorder resolver (`reorder.ts`) derives the target day from row positions.
 *
 * Date handling is tz-free throughout (the trips sections.ts precedent):
 * wire dates are ISO calendar dates, never instants — rendering through
 * `Date` would shift the day west of UTC. The only `Date` use is
 * `Date.UTC → getUTCDay` for the weekday name, which is calendar math.
 *
 * TRAVEL-TIME SEAM (T-7.5 — FILLED): legs from the composite read arrive
 * through `buildDayRows`' options and emit the `leg` DayListRow variant,
 * keyed `(from_item_id, to_item_id)` per §2.2. Conflict state (R-itin-7)
 * rides the same options object as pure DATA (`conflicts.ts` computes it) —
 * importing that module here would cycle through `grid/model`, which already
 * imports this one.
 */
import type {
  Booking,
  BookingCategory,
  BookingDetails,
  BookingStatus,
  ISODate,
  ItineraryItem,
  ItineraryItemKind,
  TravelLeg,
} from "@gogo/shared";

import type { IconName } from "@/components";

import {
  indexLegsByPair,
  legPairKey,
  pickDefaultMode,
  type DayLeg,
  type LegOption,
} from "./legs/legs-model";

// ---------------------------------------------------------------------------
// Date helpers (tz-free)
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** `YYYY-MM-DD` → parts, no Date/tz round trip (sections.ts precedent). */
function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y ?? 0, m: m ?? 1, d: d ?? 1 };
}

/** ISO date + day offset → ISO date (UTC calendar math, no tz drift). */
export function addDays(iso: ISODate, days: number): ISODate {
  const { y, m, d } = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const yy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Day-header label (§2.2): weekday + date — "Wed, Mar 4". */
export function formatDayHeader(iso: ISODate): string {
  const { y, m, d } = parts(iso);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return `${weekday}, ${MONTHS[m - 1] ?? ""} ${d}`;
}

/** Jump-strip chip label — "Mar 4" (weekday lives in the header). */
export function formatDayChip(iso: ISODate): string {
  const { m, d } = parts(iso);
  return `${MONTHS[m - 1] ?? ""} ${d}`;
}

// ---------------------------------------------------------------------------
// Entry projection
// ---------------------------------------------------------------------------

/**
 * Leading glyph per §2.2: category icon (booking) or place/custom glyph.
 * Exported (T-7.6): the Ideas bucket's cards carry the same category icons.
 */
export const CATEGORY_ICONS: Record<BookingCategory, IconName> = {
  lodging: "bed-outline",
  flight: "airplane-outline",
  train: "train-outline",
  car_rental: "car-outline",
  moped_rental: "bicycle-outline",
  activity: "ticket-outline",
  restaurant: "restaurant-outline",
  other: "briefcase-outline",
};

const KIND_ICONS: Record<Exclude<ItineraryItemKind, "booking">, IconName> = {
  place_visit: "location-outline",
  custom: "create-outline",
};

/** R-itin-8 status → Badge tone: `planned` = accent, `booked` = success. */
export function statusBadgeTone(status: BookingStatus): "accent" | "success" | "neutral" {
  if (status === "planned") return "accent";
  if (status === "booked") return "success";
  return "neutral";
}

/**
 * One renderable card row. A spanning lodging item projects to TWO entries
 * (check-in + check-out, R-itin-31) — `renderDay` is where the row shows,
 * `homeDay` stays `item.day` (the day whose order owns the item).
 */
export interface DayEntry {
  /** Row identity — `itemId`, or `itemId-check-in`/`itemId-check-out`. */
  rowKey: string;
  itemId: string;
  /** Set on `booking`-kind rows — both synthesized rows carry the SAME id, routing to one detail (R-itin-31). */
  bookingId: string | null;
  kind: ItineraryItemKind;
  /** The day this row renders under. */
  renderDay: ISODate;
  /** `item.day` — the day whose sort_order owns the item (= renderDay except check-out rows). */
  homeDay: ISODate;
  sortOrder: number;
  title: string;
  icon: IconName;
  /** "09:00 – 11:30" · "09:00" · "No time" (§2.2 card anatomy). */
  timeLabel: string;
  /** Check-in / Check-out marker caption on synthesized rows. */
  checkpoint: "check-in" | "check-out" | null;
  /** Cross-midnight chip (§2.6): spanning non-lodging renders once with "+1". */
  plusOne: boolean;
  /** `planned`/`booked` Badge on booking rows (R-itin-8); null on others. */
  status: BookingStatus | null;
  /**
   * R-itin-3 day lock: the parent booking's times are fixed
   * (`starts_at !== null`) — cross-day drops are refused client-side (the
   * server 400s them anyway, R-ib-16). Unknown parent (enrichment gap) fails
   * safe to locked.
   */
  dayLocked: boolean;
  /** Check-out rows are render-only: listing their id in `end_day`'s order PUT would REASSIGN the item's day. */
  draggable: boolean;
}

function timeLabel(start: string | null, end: string | null): string {
  if (start === null && end === null) return "No time";
  if (start !== null && end !== null) return `${start} – ${end}`;
  return start ?? `Until ${end ?? ""}`;
}

function entryBase(item: ItineraryItem, bookingsById: ReadonlyMap<string, Booking>) {
  const booking = item.booking_id !== null ? bookingsById.get(item.booking_id) : undefined;
  if (item.kind === "booking") {
    return {
      // Booking titles derive at render time (item.title is null by §3.3.10);
      // an unknown parent (enrichment gap — see useItineraryBookings) falls
      // back generic and LOCKED (fail-safe: the server re-checks anyway).
      title: booking?.title ?? "Booking",
      icon: booking !== undefined ? CATEGORY_ICONS[booking.category] : ("bookmark-outline" as IconName),
      status: booking?.status ?? null,
      dayLocked: booking === undefined ? true : booking.starts_at !== null,
      category: booking?.category ?? null,
    };
  }
  return {
    // place_visit titles derive from the place; the composite read carries no
    // place names (spec gap, batched) — generic label until a place source
    // exists (maps spine seam).
    title: item.title ?? (item.kind === "place_visit" ? "Place visit" : "Untitled"),
    icon: KIND_ICONS[item.kind],
    status: null,
    dayLocked: false,
    category: null,
  };
}

/**
 * Project one item to its render entries:
 * - spanning LODGING booking (`end_day > day`) → check-in + check-out point
 *   rows (R-itin-31; §2.6 — nights between render nothing);
 * - any other spanning item → ONE row on `day` with a "+1" chip (§2.6
 *   cross-midnight rule, generalized to every non-lodging span);
 * - everything else → one row.
 */
export function projectItem(
  item: ItineraryItem,
  bookingsById: ReadonlyMap<string, Booking>,
): DayEntry[] {
  const base = entryBase(item, bookingsById);
  const spanning = item.end_day !== null && item.end_day > item.day;
  const common = {
    itemId: item.id,
    bookingId: item.booking_id,
    kind: item.kind,
    homeDay: item.day,
    sortOrder: item.sort_order,
    title: base.title,
    icon: base.icon,
    status: base.status,
    dayLocked: base.dayLocked,
  };

  if (spanning && base.category === "lodging" && item.end_day !== null) {
    return [
      {
        ...common,
        rowKey: `${item.id}-check-in`,
        renderDay: item.day,
        timeLabel: item.start_time ?? "No time",
        checkpoint: "check-in",
        plusOne: false,
        draggable: true,
      },
      {
        ...common,
        rowKey: `${item.id}-check-out`,
        renderDay: item.end_day,
        timeLabel: item.end_time ?? "No time",
        checkpoint: "check-out",
        plusOne: false,
        draggable: false,
      },
    ];
  }

  return [
    {
      ...common,
      rowKey: item.id,
      renderDay: item.day,
      timeLabel: timeLabel(item.start_time, item.end_time),
      checkpoint: null,
      plusOne: spanning,
      draggable: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Flat row model
// ---------------------------------------------------------------------------

export type DayListRow =
  | {
      type: "day";
      key: string;
      date: ISODate;
      count: number;
      /** R-itin-7: this day's row order disagrees with its start times. */
      unsorted: boolean;
    }
  | {
      type: "entry";
      key: string;
      entry: DayEntry;
      /** R-itin-7: this item's timed span directly overlaps another's. */
      overlapping: boolean;
    }
  /** R-itin-4: travel-time chip between two located entries of a day. */
  | { type: "leg"; key: string; leg: DayLeg }
  /** R-itin-1: an empty day renders a slim "Add to this day" row, never a blank section. */
  | { type: "empty-day"; key: string; date: ISODate };

/**
 * The R-itin-7 analysis `buildDayRows` consumes. Structural on purpose —
 * `conflicts.ts` produces it; this module never imports that module (module
 * doc: the cycle through `grid/model`).
 */
export interface DayRowConflicts {
  overlappingItemIds: ReadonlySet<string>;
  unsortedDays: ReadonlySet<ISODate>;
}

export interface BuildDayRowsOptions {
  /** Composite-read legs (R-ib-13). Absent/partial ⇒ fewer chips, never an error (R-itin-6). */
  legs?: readonly TravelLeg[];
  /** R-itin-7 state; omitted ⇒ no overlap chips and no sort affordances. */
  conflicts?: DayRowConflicts;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Best free-text label for a maps query (R-itin-4 directions handoff).
 * A booking's `details.address` beats its title when present — "1-2-3
 * Nishi-Shinjuku" resolves where "Park Hyatt Tokyo" may not. An unnamed
 * `place_visit` yields null: the composite read carries no place names yet
 * (T-7.4's documented gap), and "Place visit" is not a location.
 */
function detailsAddress(details: BookingDetails | undefined): string | null {
  if (details === undefined) return null;
  const address = (details as unknown as Record<string, unknown>)["address"];
  return typeof address === "string" && address.trim() !== "" ? address.trim() : null;
}

function locationQueryOf(
  item: ItineraryItem,
  bookingsById: ReadonlyMap<string, Booking>,
): string | null {
  if (item.kind === "booking") {
    const booking = item.booking_id !== null ? bookingsById.get(item.booking_id) : undefined;
    return detailsAddress(booking?.details) ?? booking?.title ?? null;
  }
  return item.title;
}

/**
 * The first leg starting at `own[position]`, scanning forward.
 *
 * The scan (rather than a strict next-neighbour lookup) is R-ib-20's
 * "unlocated items are transparent — the chain connects across them": with
 * an unlocated item between two located ones the server stores the leg for
 * the OUTER pair. INTERPRETATION (spec-uncovered): that chip is emitted
 * directly after its FROM row, not after the unlocated row that visually
 * separates them — the leg's anchor is the item you are leaving, and putting
 * it lower would read as travel time out of the unlocated item, which is the
 * one thing it is not. Both endpoint titles ride the accessibility label so
 * the pairing is never ambiguous to a screen reader.
 */
function findLegFrom(
  own: readonly DayEntry[],
  position: number,
  legIndex: ReadonlyMap<string, LegOption[]>,
  queries: ReadonlyMap<string, string | null>,
): DayLeg | null {
  const from = own[position];
  if (from === undefined) return null;
  for (let j = position + 1; j < own.length; j += 1) {
    const to = own[j];
    if (to === undefined) continue;
    const options = legIndex.get(legPairKey(from.itemId, to.itemId));
    if (options === undefined) continue;
    const defaultMode = pickDefaultMode(options);
    if (defaultMode === null) continue;
    return {
      fromItemId: from.itemId,
      toItemId: to.itemId,
      fromTitle: from.title,
      toTitle: to.title,
      options,
      defaultMode,
      fromQuery: queries.get(from.itemId) ?? null,
      toQuery: queries.get(to.itemId) ?? null,
    };
  }
  return null;
}

/**
 * The section date set (R-itin-1): every day of the trip's date range
 * (continuous — in-range empty days are real, they get add rows) UNIONED
 * with the distinct render-days of items outside it (SPARSE — an item three
 * weeks post-trip adds ONE section, not weeks of empty filler; the
 * continuous-fill reading is batched as a spec question). Sorted ascending.
 */
export function buildDaySet(
  trip: { start_date: ISODate; end_date: ISODate },
  renderDays: Iterable<ISODate>,
): ISODate[] {
  const days = new Set<ISODate>();
  for (let day = trip.start_date; day <= trip.end_date; day = addDays(day, 1)) days.add(day);
  for (const day of renderDays) days.add(day);
  return [...days].sort();
}

/**
 * The flat list model. Per day: header row, then that day's entries —
 * synthesized check-out rows FIRST (no sort_order on their render day;
 * check-out-is-morning heuristic, deterministic), then the day's own items
 * by `(sort_order, id)`, with a travel-time chip after any entry that starts
 * a computed leg. Days with no entries emit the empty-day add row.
 *
 * Leg endpoints are the day's OWN items only (`homeDay === date`): the
 * server maintains legs within `item.day` (R-ib-20), so a synthesized
 * check-out row — which renders on `end_day` and belongs to another day's
 * order — is never a leg endpoint.
 */
export function buildDayRows(
  trip: { start_date: ISODate; end_date: ISODate },
  items: readonly ItineraryItem[],
  bookingsById: ReadonlyMap<string, Booking>,
  options?: BuildDayRowsOptions,
): DayListRow[] {
  const byDay = new Map<ISODate, DayEntry[]>();
  for (const item of items) {
    for (const entry of projectItem(item, bookingsById)) {
      const bucket = byDay.get(entry.renderDay);
      if (bucket === undefined) byDay.set(entry.renderDay, [entry]);
      else bucket.push(entry);
    }
  }

  const legIndex = indexLegsByPair(options?.legs ?? []);
  const queries = new Map<string, string | null>(
    items.map((item) => [item.id, locationQueryOf(item, bookingsById)]),
  );
  const overlappingItemIds = options?.conflicts?.overlappingItemIds ?? NO_IDS;
  const unsortedDays = options?.conflicts?.unsortedDays ?? NO_IDS;

  const rows: DayListRow[] = [];
  for (const date of buildDaySet(trip, byDay.keys())) {
    const entries = (byDay.get(date) ?? []).sort((a, b) => {
      const aOut = a.checkpoint === "check-out" ? 0 : 1;
      const bOut = b.checkpoint === "check-out" ? 0 : 1;
      if (aOut !== bOut) return aOut - bOut;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0;
    });
    rows.push({
      type: "day",
      key: `day-${date}`,
      date,
      count: entries.length,
      unsorted: unsortedDays.has(date),
    });
    if (entries.length === 0) {
      rows.push({ type: "empty-day", key: `empty-${date}`, date });
      continue;
    }

    const own = entries.filter((entry) => entry.homeDay === date);
    const ownPosition = new Map(own.map((entry, index) => [entry.rowKey, index]));
    for (const entry of entries) {
      rows.push({
        type: "entry",
        key: entry.rowKey,
        entry,
        overlapping: overlappingItemIds.has(entry.itemId),
      });
      const position = ownPosition.get(entry.rowKey);
      if (position === undefined) continue;
      const leg = findLegFrom(own, position, legIndex, queries);
      // Absent leg ⇒ nothing rendered (R-itin-6's "no chip" arm — never a
      // spinner, never an inline error, never a retry prompt).
      if (leg !== null) {
        rows.push({ type: "leg", key: `leg-${leg.fromItemId}-${leg.toItemId}`, leg });
      }
    }
  }
  return rows;
}
