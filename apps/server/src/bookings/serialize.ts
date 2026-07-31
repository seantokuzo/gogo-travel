/**
 * Row → wire serialization for the bookings surface (IB-1). Responses are
 * shaped, never raw DB rows (server rule). Column-type conventions
 * (`db/schema/_shared.ts`): `date` columns cross as `YYYY-MM-DD` strings
 * (passed through — the wire type, R-shared-11); `time` columns come back as
 * `HH:MM:SS` and the wire's `ISOTime` is `HH:MM` (§3.7) — trimmed here, the
 * API boundary; timestamps are `Date` → ISO strings; `bigint` cents are
 * number-mode.
 */
import type { Booking, BookingWithItems } from "@gogo/shared/domains/booking";
import type { ItineraryItem } from "@gogo/shared/domains/itinerary";
import type * as schema from "../db/schema/index.js";

export type BookingRow = typeof schema.bookings.$inferSelect;
export type ItineraryItemRow = typeof schema.itineraryItems.$inferSelect;

/** `HH:MM:SS[.ffffff]` (Postgres `time`) → wire `HH:MM` (§3.7 ISOTime). */
function toWireTime(value: string | null): string | null {
  return value === null ? null : value.slice(0, 5);
}

export function toBookingWire(row: BookingRow): Booking {
  return {
    id: row.id,
    trip_id: row.tripId,
    category: row.category,
    status: row.status,
    title: row.title,
    details: row.details,
    starts_at: row.startsAt ? row.startsAt.toISOString() : null,
    ends_at: row.endsAt ? row.endsAt.toISOString() : null,
    price_cents: row.priceCents,
    currency: row.currency,
    confirmation_code: row.confirmationCode,
    source: row.source,
    capture_id: row.captureId,
    place_id: row.placeId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function toItineraryItemWire(row: ItineraryItemRow): ItineraryItem {
  return {
    id: row.id,
    trip_id: row.tripId,
    kind: row.kind,
    booking_id: row.bookingId,
    place_id: row.placeId,
    title: row.title,
    notes: row.notes,
    day: row.day,
    end_day: row.endDay,
    start_time: toWireTime(row.startTime),
    end_time: toWireTime(row.endTime),
    sort_order: row.sortOrder,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `Booking` + calendar presence — GET detail + mutation post-state (R-ib-18). */
export function toBookingWithItemsWire(
  row: BookingRow,
  items: readonly ItineraryItemRow[],
): BookingWithItems {
  return { ...toBookingWire(row), items: items.map(toItineraryItemWire) };
}
