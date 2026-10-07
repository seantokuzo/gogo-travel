/**
 * Destination-zone resolution (B-30; trips spec §3.4 timezone note).
 *
 * A trip's "today" is the calendar day AT ITS DESTINATION (Sean's ruling,
 * 2026-09-19), so every trip needs ONE effective IANA zone. The chain, in
 * order — first hit wins:
 *
 *  1. EXPLICIT — a `destination_tz` the caller sent (validated IANA; the
 *     routes 400 an unknown one BEFORE it can be stored). Stored as given.
 *  2. DERIVED — from `destination_lat/lng` via `@photostructure/tz-lookup`
 *     (CC0, ~88 KB, no network, no account). Stored at create and re-derived
 *     on PATCH when the coordinates move and the body carries no explicit
 *     zone. For a legacy NULL-stored row it is derived lazily at read.
 *  3. BOOKING — read time only, for a trip with nothing stored/derivable
 *     (a coordinate-less custom destination nobody gave a zone): the
 *     earliest flight/train booking's `arrives_tz` (else `departs_tz`) that
 *     passes `isValidTimeZone`. (The outbound flight lands AT the destination.)
 *  4. UTC — the deterministic last resort.
 *
 * STEPS 3 AND 4 NEVER WRITE. Only steps 1–2 ever put a value in
 * `trips.destination_tz`, so the column holds user-entered or
 * coordinate-derived zones only — a booking edit can never be "remembered"
 * as a stale destination.
 *
 * ACCURACY: tz-lookup is a quadtree approximation of timezone-boundary-builder
 * (the vendor documents ~10% id mismatch vs `geo-tz` on random inhabited
 * points, ~5% counting equal-offset zones as equal). Only the UTC OFFSET at
 * the trip's dates matters to "today", and `destination-tz.accuracy.test.ts`
 * gates it against `geo-tz/all` (dev-only) over every destination-tier row
 * and airport — see that file for the measured counts and the allow-list.
 */
import tzlookup from "@photostructure/tz-lookup";
import { and, asc, inArray, sql } from "drizzle-orm";
import { isValidTimeZone } from "@gogo/shared/time";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";

/** The last-resort zone (chain step 4). */
export const DEFAULT_DESTINATION_TZ = "UTC";

export type DestinationTzSource = "explicit" | "derived" | "booking" | "default";

/** A trip's flight/train zones (`details.arrives_tz` / `details.departs_tz`), earliest booking first. */
export interface BookingZones {
  arrivesTz: string | null;
  departsTz: string | null;
}

export interface ResolveDestinationTzInput {
  /** Caller-supplied (create/PATCH body) or the STORED column value. Invalid → skipped. */
  explicit?: string | null | undefined;
  lat: number | null;
  lng: number | null;
  /** Flight/train zones ordered earliest-first. Only consulted when steps 1–2 miss. */
  bookings?: ReadonlyArray<BookingZones> | undefined;
}

/**
 * Chain step 2: the zone for a coordinate pair, or `null` when there are no
 * coordinates, tz-lookup rejects them (it throws `RangeError` on NaN /
 * out-of-range), or the id it returns isn't one this runtime's `Intl`
 * resolves (never store what a client could not evaluate).
 */
export function deriveZoneFromCoords(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  let zone: string;
  try {
    zone = tzlookup(lat, lng);
  } catch {
    return null;
  }
  return isValidTimeZone(zone) ? zone : null;
}

/**
 * The zone to STORE for a write (chain steps 1–2): the explicit value, else
 * the coordinate derivation, else `null` (nothing storable — reads fall to
 * steps 3–4). The caller has already 400'd an invalid explicit zone.
 */
export function storedDestinationTz(input: {
  explicit?: string | null | undefined;
  lat: number | null;
  lng: number | null;
}): string | null {
  if (input.explicit !== undefined && input.explicit !== null) return input.explicit;
  return deriveZoneFromCoords(input.lat, input.lng);
}

/** The full chain (steps 1–4). Pure: bookings arrive pre-loaded. */
export function resolveDestinationTz(input: ResolveDestinationTzInput): {
  zone: string;
  source: DestinationTzSource;
} {
  if (input.explicit !== undefined && input.explicit !== null && isValidTimeZone(input.explicit)) {
    return { zone: input.explicit, source: "explicit" };
  }
  const derived = deriveZoneFromCoords(input.lat, input.lng);
  if (derived !== null) return { zone: derived, source: "derived" };
  for (const booking of input.bookings ?? []) {
    // arrives_tz first (the destination end); departs_tz only if it's unusable.
    for (const candidate of [booking.arrivesTz, booking.departsTz]) {
      if (candidate !== null && isValidTimeZone(candidate)) {
        return { zone: candidate, source: "booking" };
      }
    }
  }
  return { zone: DEFAULT_DESTINATION_TZ, source: "default" };
}

/** The `trips` columns zone resolution reads (any row or projection qualifies). */
export interface ZoneSourceRow {
  id: string;
  destinationTz: string | null;
  /** numeric columns arrive as strings (db/schema/_shared.ts). */
  destinationLat: string | null;
  destinationLng: string | null;
}

const numOrNull = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Flight/train zones for the given trips, earliest booking first per trip
 * (`starts_at` ascending, NULL starts last, then insertion order). One
 * query; callers only pass the (rare) trips that missed steps 1–2.
 */
async function loadBookingZones(
  db: DbClient,
  tripIds: readonly string[],
): Promise<Map<string, BookingZones[]>> {
  const byTrip = new Map<string, BookingZones[]>();
  if (tripIds.length === 0) return byTrip;
  const rows = await db
    .select({
      tripId: schema.bookings.tripId,
      arrivesTz: sql<string | null>`${schema.bookings.details}->>'arrives_tz'`,
      departsTz: sql<string | null>`${schema.bookings.details}->>'departs_tz'`,
    })
    .from(schema.bookings)
    .where(
      and(
        inArray(schema.bookings.tripId, [...tripIds]),
        inArray(schema.bookings.category, ["flight", "train"]),
      ),
    )
    .orderBy(
      asc(schema.bookings.tripId),
      sql`${schema.bookings.startsAt} ASC NULLS LAST`,
      asc(schema.bookings.createdAt),
      asc(schema.bookings.id),
    );
  for (const row of rows) {
    const list = byTrip.get(row.tripId) ?? [];
    list.push({ arrivesTz: row.arrivesTz, departsTz: row.departsTz });
    byTrip.set(row.tripId, list);
  }
  return byTrip;
}

/**
 * EFFECTIVE zone per trip id for a batch of trip rows (chain steps 1–4).
 * A row whose stored zone is valid costs nothing; only rows that miss both
 * the stored value and the coordinate derivation trigger the single booking
 * query. Never writes.
 */
export async function resolveEffectiveZones(
  db: DbClient,
  rows: ReadonlyArray<ZoneSourceRow>,
): Promise<Map<string, string>> {
  const zones = new Map<string, string>();
  const needBookings: ZoneSourceRow[] = [];
  for (const row of rows) {
    const lat = numOrNull(row.destinationLat);
    const lng = numOrNull(row.destinationLng);
    const resolved = resolveDestinationTz({ explicit: row.destinationTz, lat, lng });
    if (resolved.source === "default") needBookings.push(row);
    else zones.set(row.id, resolved.zone);
  }
  if (needBookings.length > 0) {
    const bookings = await loadBookingZones(
      db,
      needBookings.map((row) => row.id),
    );
    for (const row of needBookings) {
      zones.set(
        row.id,
        resolveDestinationTz({
          explicit: row.destinationTz,
          lat: numOrNull(row.destinationLat),
          lng: numOrNull(row.destinationLng),
          bookings: bookings.get(row.id),
        }).zone,
      );
    }
  }
  return zones;
}
