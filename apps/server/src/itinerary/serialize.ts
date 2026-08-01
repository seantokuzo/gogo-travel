/**
 * Row → wire serialization for the itinerary surface (IB-2). Item rows reuse
 * the T-7.1 serializer (`bookings/serialize.ts` — one wire shape, one
 * serializer); this module adds the travel-leg mapping the composite read
 * needs. Conventions (`db/schema/_shared.ts`): timestamps are `Date` → ISO
 * strings; `date` columns pass through as `YYYY-MM-DD`.
 */
import type { TravelLeg } from "@gogo/shared/domains/itinerary";
import type * as schema from "../db/schema/index.js";

export type TravelLegRow = typeof schema.travelLegs.$inferSelect;

export function toTravelLegWire(row: TravelLegRow): TravelLeg {
  return {
    id: row.id,
    trip_id: row.tripId,
    from_item_id: row.fromItemId,
    to_item_id: row.toItemId,
    mode: row.mode,
    duration_seconds: row.durationSeconds,
    distance_meters: row.distanceMeters,
    provider: row.provider,
    computed_at: row.computedAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}
