/**
 * Row → wire serialization for the transport reference surface (B-9).
 * Responses are shaped, never raw DB rows (server rule): `created_at` is a
 * DB-side bookkeeping column that never crosses the wire (reference rows are
 * immutable — the timestamp is the migration's, not the resource's), and
 * `numeric` coordinates arrive as STRINGS (db/schema/_shared.ts) and convert
 * here.
 */
import type { Airline, Airport } from "@gogo/shared/domains/airport";
import type * as schema from "../db/schema/index.js";

export type AirportRow = typeof schema.airports.$inferSelect;
export type AirlineRow = typeof schema.airlines.$inferSelect;

export function toAirportWire(row: AirportRow): Airport {
  return {
    iata: row.iata,
    icao: row.icao,
    name: row.name,
    city: row.city,
    country: row.country,
    lat: Number(row.lat),
    lng: Number(row.lng),
    tz: row.tz,
  };
}

export function toAirlineWire(row: AirlineRow): Airline {
  return {
    iata: row.iata,
    name: row.name,
  };
}
