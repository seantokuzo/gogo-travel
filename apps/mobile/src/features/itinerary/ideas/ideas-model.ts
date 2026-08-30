/**
 * Ideas-bucket model (T-7.6 / IT-5 — itinerary spec §2.3, R-itin-10..12).
 * Pure projection: `{bookings, items}` → the grouped card rows the bucket
 * renders. Bucket membership is the API's R-ib-10 rule computed client-side
 * from data both screens already hold: a booking is UNSCHEDULED iff it has
 * zero itinerary items (the default booking list already excludes
 * `cancelled`; those arrive via the separate R-itin-12 list).
 */
import {
  BOOKING_CATEGORIES,
  centsToMoneyText,
  type Booking,
  type BookingCategory,
  type ItineraryItem,
} from "@gogo/shared";

/** Group headers, in the shared category-tuple order (stable, spec-neutral). */
export const CATEGORY_GROUP_LABELS: Readonly<Record<BookingCategory, string>> = {
  lodging: "Lodging",
  flight: "Flights",
  train: "Trains",
  car_rental: "Car rentals",
  moped_rental: "Moped rentals",
  activity: "Activities",
  restaurant: "Restaurants",
  other: "Other",
};

export interface IdeaCard {
  booking: Booking;
  /**
   * R-itin-12: a `planned`/`booked` booking that is timeless (in the bucket)
   * is flagged "needs a day" — visually distinct from `idea` cards.
   */
  needsDay: boolean;
}

export interface IdeasGroup {
  category: BookingCategory;
  cards: IdeaCard[];
}

/**
 * R-ib-10 computed client-side: exactly the bookings with zero
 * `itinerary_items` rows. `items` is the composite read's full item list —
 * every scheduled booking has at least one row there by I-2/I-3.
 */
export function unscheduledBookings(
  bookings: readonly Booking[],
  items: readonly ItineraryItem[],
): Booking[] {
  const scheduled = new Set<string>();
  for (const item of items) {
    if (item.booking_id !== null) scheduled.add(item.booking_id);
  }
  return bookings.filter((booking) => !scheduled.has(booking.id));
}

/**
 * §2.3 grouping: cards grouped by category (shared tuple order; empty
 * groups dropped), ordered `updated_at DESC` within a group (R-itin-10).
 */
export function buildIdeasGroups(unscheduled: readonly Booking[]): IdeasGroup[] {
  const byCategory = new Map<BookingCategory, IdeaCard[]>();
  for (const booking of unscheduled) {
    const card: IdeaCard = { booking, needsDay: booking.status !== "idea" };
    const bucket = byCategory.get(booking.category);
    if (bucket === undefined) byCategory.set(booking.category, [card]);
    else bucket.push(card);
  }
  const groups: IdeasGroup[] = [];
  for (const category of BOOKING_CATEGORIES) {
    const cards = byCategory.get(category);
    if (cards === undefined) continue;
    cards.sort((a, b) =>
      a.booking.updated_at === b.booking.updated_at
        ? a.booking.id < b.booking.id
          ? -1
          : 1
        : a.booking.updated_at < b.booking.updated_at
          ? 1
          : -1,
    );
    groups.push({ category, cards });
  }
  return groups;
}

/**
 * "$ if known" caption (§2.3) — Law #2: the shared ISO-4217 minor-unit
 * formatter (T-9.1 R1 swap — this was the last 2dp-blind money renderer,
 * and it float-divided). 2-decimal currencies render byte-identical to the
 * pre-swap output ("USD 1234.56", fixed digits); zero-decimal currencies
 * now render whole ("JPY 1500" — was "15.00", 100× off). Also the booking
 * detail screen's price line.
 */
export function formatIdeaPrice(priceCents: number, currency: string): string {
  return `${currency} ${centsToMoneyText(priceCents, currency)}`;
}

/** The flat row list a bin's FlatList renders (groups flattened). */
export type IdeasRow =
  | { type: "group"; key: string; label: string }
  | { type: "card"; key: string; card: IdeaCard; cancelled: boolean };

/**
 * B-13: the Ideas BIN's rows — unscheduled groups only. Cancelled bookings
 * moved out to their own peer bin (`buildCancelledRows`); the pre-B-13
 * shape appended them here behind a foot toggle, which made showing
 * cancelled surface the Ideas box with zero ideas in it.
 */
export function buildIdeasRows(groups: readonly IdeasGroup[]): IdeasRow[] {
  const rows: IdeasRow[] = [];
  for (const group of groups) {
    rows.push({
      type: "group",
      key: `group-${group.category}`,
      label: CATEGORY_GROUP_LABELS[group.category],
    });
    for (const card of group.cards) {
      rows.push({ type: "card", key: card.booking.id, card, cancelled: false });
    }
  }
  return rows;
}

/**
 * B-13: the Cancelled BIN's rows — flat cancelled cards, no group label
 * (the bin's own header already says "Cancelled"). Same row vocabulary as
 * the Ideas bin: the two bins are peers of the same shape.
 */
export function buildCancelledRows(cancelled: readonly Booking[]): IdeasRow[] {
  return cancelled.map((booking) => ({
    type: "card",
    key: booking.id,
    card: { booking, needsDay: false },
    cancelled: true,
  }));
}
