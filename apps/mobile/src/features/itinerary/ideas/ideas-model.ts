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
 * "$ if known" caption (§2.3) — Law #2: integer-cents math only, no float
 * formatting. v1 renders every currency at two minor-unit digits.
 */
export function formatIdeaPrice(priceCents: number, currency: string): string {
  const major = Math.floor(priceCents / 100);
  const minor = String(priceCents % 100).padStart(2, "0");
  return `${currency} ${major}.${minor}`;
}

/** The flat row list the bucket's FlatList renders (groups flattened). */
export type IdeasRow =
  | { type: "group"; key: string; label: string }
  | { type: "card"; key: string; card: IdeaCard; cancelled: boolean };

export function buildIdeasRows(
  groups: readonly IdeasGroup[],
  cancelled: readonly Booking[],
  showCancelled: boolean,
): IdeasRow[] {
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
  if (showCancelled && cancelled.length > 0) {
    rows.push({ type: "group", key: "group-cancelled", label: "Cancelled" });
    for (const booking of cancelled) {
      rows.push({
        type: "card",
        key: booking.id,
        card: { booking, needsDay: false },
        cancelled: true,
      });
    }
  }
  return rows;
}
