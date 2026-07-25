/**
 * Row → wire serialization for the trips surface (API-TRIPS-1). Responses are
 * shaped, never raw DB rows (server rule). Column-type conventions from
 * `db/schema/_shared.ts`: `numeric` coordinates arrive as STRINGS (converted
 * here, the API boundary), `date` columns as `YYYY-MM-DD` strings (passed
 * through — the wire type, R-shared-11), timestamps as `Date` → ISO strings.
 */
import type { Trip, TripListItem, TripWithRole } from "@gogo/shared/domains/trip";
import type { TripMemberRole } from "@gogo/shared/enums";
import type * as schema from "../db/schema/index.js";

type TripRow = typeof schema.trips.$inferSelect;

/**
 * The full `Trip` wire shape. `status` serializes the row's stored value —
 * routes reconcile stored → effective (trips/status.ts) BEFORE serializing,
 * so what crosses the wire is always the §3.4 effective status.
 */
export function toTripWire(row: TripRow): Trip {
  return {
    id: row.id,
    name: row.name,
    destination_name: row.destinationName,
    destination_lat: Number(row.destinationLat),
    destination_lng: Number(row.destinationLng),
    start_date: row.startDate,
    end_date: row.endDate,
    status: row.status,
    status_override: row.statusOverride,
    base_currency: row.baseCurrency,
    budget_cap_cents: row.budgetCapCents,
    theme: row.theme,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `Trip & { role }` — POST /trips and GET /trips/:tripId responses. */
export function toTripWithRoleWire(row: TripRow, role: TripMemberRole): TripWithRole {
  return { ...toTripWire(row), role };
}

/** `GET /trips` list item: `Trip & { role, member_count }` (R-trips-4). */
export function toTripListItemWire(
  row: TripRow,
  role: TripMemberRole,
  memberCount: number,
): TripListItem {
  return { ...toTripWire(row), role, member_count: memberCount };
}
