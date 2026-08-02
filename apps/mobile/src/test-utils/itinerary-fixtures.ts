/**
 * Itinerary/booking fixtures (T-7.4) — wire-faithful rows for the plan
 * surface plus the descriptor-routed responders the suites hand to
 * `mockNavApi`'s `overrides` (same `METHOD path` convention). Lives outside
 * `__tests__/` so jest never treats it as a suite.
 *
 * Dates are FIXED (2027-03-01..03, a Mon–Wed) — the day list is pure
 * calendar math over wire dates, so deterministic labels beat today-relative
 * fixtures here.
 */
import type { Booking, ISODate, ItineraryItem, TravelLeg } from "@gogo/shared";

import { TEST_TRIP_ID } from "./ids";
import { TEST_USER } from "./session-fixtures";

export const TRIP_START: ISODate = "2027-03-01";
export const TRIP_DAY_2: ISODate = "2027-03-02";
export const TRIP_END: ISODate = "2027-03-03";

export const ITEM_A_ID = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const ITEM_B_ID = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const ITEM_C_ID = "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
export const ITEM_LODGING_ID = "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
export const BOOKING_FLIGHT_ID = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const BOOKING_LODGING_ID = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
export const BOOKING_IDEA_ID = "bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3";

export function makeItineraryItem(
  overrides: Partial<ItineraryItem> & { id: string },
): ItineraryItem {
  return {
    trip_id: TEST_TRIP_ID,
    kind: "custom",
    booking_id: null,
    place_id: null,
    title: "Custom block",
    notes: null,
    day: TRIP_START,
    end_day: null,
    start_time: null,
    end_time: null,
    sort_order: 1024,
    created_by: TEST_USER.id,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeBooking(overrides: Partial<Booking> & { id: string }): Booking {
  return {
    trip_id: TEST_TRIP_ID,
    category: "flight",
    status: "booked",
    title: "UA 837 SFO→NRT",
    details: { category: "flight" },
    starts_at: "2027-03-01T18:00:00.000Z",
    ends_at: null,
    price_cents: null,
    currency: null,
    confirmation_code: null,
    source: "manual",
    capture_id: null,
    place_id: null,
    created_by: TEST_USER.id,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The default plan universe:
 * - day 1: a timed-booking flight item (day-locked) + a custom item
 * - day 1→3: ONE spanning lodging item (check-in day 1, check-out day 3)
 * - day 2: empty (add-row day)
 * - a place_visit on day 3
 */
export function defaultItineraryItems(): ItineraryItem[] {
  return [
    makeItineraryItem({
      id: ITEM_A_ID,
      kind: "booking",
      booking_id: BOOKING_FLIGHT_ID,
      title: null,
      start_time: "10:00",
      end_time: "12:30",
      sort_order: 1024,
    }),
    makeItineraryItem({ id: ITEM_B_ID, title: "Walk Shibuya", sort_order: 2048 }),
    makeItineraryItem({
      id: ITEM_LODGING_ID,
      kind: "booking",
      booking_id: BOOKING_LODGING_ID,
      title: null,
      day: TRIP_START,
      end_day: TRIP_END,
      start_time: "15:00",
      end_time: "11:00",
      sort_order: 3072,
    }),
    makeItineraryItem({
      id: ITEM_C_ID,
      kind: "place_visit",
      place_id: "44444444-4444-4444-8444-444444444444",
      title: null,
      day: TRIP_END,
      sort_order: 1024,
    }),
  ];
}

export function defaultBookings(): Booking[] {
  return [
    makeBooking({ id: BOOKING_FLIGHT_ID }),
    makeBooking({
      id: BOOKING_LODGING_ID,
      category: "lodging",
      status: "planned",
      title: "Park Hyatt Tokyo",
      details: { category: "lodging" },
      starts_at: "2027-03-01T06:00:00.000Z",
      ends_at: "2027-03-03T02:00:00.000Z",
    }),
  ];
}

export interface ItineraryApiOptions {
  items?: ItineraryItem[];
  legs?: TravelLeg[];
  bookings?: Booking[];
  /** `status=cancelled` list (T-7.6 Ideas bucket, R-itin-12). Default: none. */
  cancelled?: Booking[];
  /** Replaces the reorder responder (failure/divergent-post-state seams). */
  putDayOrder?: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Responders for `mockNavApi({ overrides })` — the itinerary tab's three
 * routes. The default PUT responder is wire-faithful to R-ib-15/18: it
 * returns the day's FULL post-state built from the requested ids at
 * `1024 × position`, deriving rows from the CURRENT items fixture.
 */
export function itineraryApiOverrides(
  opts: ItineraryApiOptions = {},
): Record<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const items = opts.items ?? defaultItineraryItems();
  const bookings = opts.bookings ?? defaultBookings();
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    "GET /trips/:tripId/itinerary": () =>
      Promise.resolve({ items, legs: opts.legs ?? [] }),
    "GET /trips/:tripId/bookings": (input) => {
      // Query-aware (T-7.6): the cancelled list rides the same route with
      // `status=cancelled` (R-ib-10 excludes cancelled from the default).
      const query = input.query as { status?: string } | undefined;
      if (query?.status === "cancelled") {
        return Promise.resolve({ items: opts.cancelled ?? [], nextCursor: null });
      }
      return Promise.resolve({ items: bookings, nextCursor: null });
    },
    "PUT /trips/:tripId/itinerary/days/:day/order":
      opts.putDayOrder ??
      ((input) => {
        const params = input.params as { day: ISODate } | undefined;
        const body = input.body as { item_ids: string[] } | undefined;
        const day = params?.day ?? TRIP_START;
        const ordered = (body?.item_ids ?? []).flatMap((id, index) => {
          const item = byId.get(id);
          return item === undefined
            ? [] // LWW-ignore, R-ib-15
            : [{ ...item, day, sort_order: 1024 * (index + 1) }];
        });
        return Promise.resolve({ items: ordered });
      }),
  };
}
