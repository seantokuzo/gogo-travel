/**
 * Destination-zone resolution (B-30; trips spec §3.4 timezone note).
 *
 * A trip's "today" is the calendar day AT ITS DESTINATION (Sean's ruling,
 * 2026-09-19), so every trip needs ONE effective IANA zone. The chain, best
 * rank first — the first hit wins, and `source` says which rung it was:
 *
 *  1. USER     — a zone a person chose (create/PATCH `destination_tz`, source
 *                absent or 'user'; allow-listed + canonicalised by
 *                `zone-canon.ts`, an unlisted one is a 400). Stored. Durable:
 *                a coordinates edit never overwrites it; only an explicit
 *                `destination_tz: null` (reset to automatic) clears it.
 *  2. DERIVED  — from `destination_lat/lng` via `@photostructure/tz-lookup`
 *                (CC0, in-process, no network). Stored at create and
 *                re-derived on PATCH when the coordinates move; derived
 *                lazily at read for a legacy NULL row.
 *  3. BOOKING  — read time only: the best non-cancelled flight/train
 *                booking's `arrives_tz`, else its `departs_tz` (best = booked
 *                before planned before idea, then earliest `starts_at`).
 *                LIMIT: "earliest" can be a CONNECTING leg (SFO->ORD->KIX
 *                picks Chicago) — the chain cannot tell a connection from the
 *                destination; a user zone (rank 1) is the override.
 *  4. DEVICE   — the creator's device-zone HINT for a coordinate-less
 *                destination (the mobile create/settings forms send it with
 *                source 'device'). Stored, but deliberately BELOW a booking
 *                zone so a later flight into the real destination corrects
 *                "today" instead of the creator's home day sticking for life.
 *                An unusable hint (not on the allow-list) is IGNORED, never a
 *                400 — only a 'user' zone is rejected.
 *  5. DEFAULT  — `UTC`.
 *
 * Only ranks 1, 2 and 4 are ever WRITTEN (`trips.destination_tz` +
 * `destination_tz_source`); booking and default are resolved per read, so a
 * booking edit can never be remembered as a stale destination.
 *
 * ONE pure resolver per direction, used everywhere (create, the PATCH write
 * path, list/get, the staleness sweep): `resolveZoneWrite` decides what a
 * write stores; `resolveDestinationTz` decides what a read serves.
 *
 * ACCURACY: tz-lookup is a quadtree approximation of timezone-boundary-builder
 * (the vendor documents ~10% id mismatch vs `geo-tz` on random inhabited
 * points, ~5% counting equal-offset zones as equal). Only the UTC OFFSET at
 * the trip's dates matters to "today", and `destination-tz.accuracy.test.ts`
 * gates it against `geo-tz/all` (dev-only) over every destination-tier row
 * and airport — see that file for the measured counts and the allow-list.
 */
import tzlookup from "@photostructure/tz-lookup";
import { and, asc, inArray, ne, sql } from "drizzle-orm";
import type { DestinationTzInputSource, DestinationTzSource } from "@gogo/shared/domains/trip";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import {
  STORED_DESTINATION_TZ_SOURCES,
  type StoredDestinationTzSource,
} from "../db/schema/trips.js";
import { canonicalizeZone } from "./zone-canon.js";

/** The last-resort zone (rank 5). */
export const DEFAULT_DESTINATION_TZ = "UTC";

/** A zone as the `trips` row stores it. */
export interface StoredZone {
  zone: string;
  source: StoredDestinationTzSource;
}

/** The zone a read serves, with the rung that produced it (the wire pair). */
export interface EffectiveZone {
  zone: string;
  source: DestinationTzSource;
}

export const DEFAULT_EFFECTIVE_ZONE: EffectiveZone = {
  zone: DEFAULT_DESTINATION_TZ,
  source: "default",
};

/** A trip's flight/train zones (`details.arrives_tz` / `details.departs_tz`), best booking first. */
export interface BookingZones {
  arrivesTz: string | null;
  departsTz: string | null;
}

/**
 * Rank 2: the zone for a coordinate pair, or `null` when there are no
 * coordinates, tz-lookup rejects them (it throws `RangeError` on NaN /
 * out-of-range), or the id it returns isn't on the allow-list (never store
 * what a client could not evaluate).
 */
export function deriveZoneFromCoords(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null) return null;
  let zone: string;
  try {
    zone = tzlookup(lat, lng);
  } catch {
    return null;
  }
  return canonicalizeZone(zone);
}

/** The stored pair of a `trips` row, or `null` when nothing (valid) is stored. */
export function storedZoneOf(row: {
  destinationTz: string | null;
  destinationTzSource: string | null;
}): StoredZone | null {
  if (row.destinationTz === null || row.destinationTzSource === null) return null;
  const source = STORED_DESTINATION_TZ_SOURCES.find(
    (candidate) => candidate === row.destinationTzSource,
  );
  return source === undefined ? null : { zone: row.destinationTz, source };
}

export interface ResolveDestinationTzInput {
  /** What the row stores (null = nothing). A corrupt/unlisted stored zone is skipped, never trusted. */
  stored?: StoredZone | null | undefined;
  lat: number | null;
  lng: number | null;
  /** Flight/train zones, best booking first. Only consulted when ranks 1-2 miss. */
  bookings?: ReadonlyArray<BookingZones> | undefined;
}

/**
 * The READ chain (ranks 1-5). Pure: bookings arrive pre-loaded. A stored
 * 'derived' zone is served as stored (stable across a tz-lookup upgrade); a
 * stored 'device' hint only wins when no coordinates derive and no booking
 * zone exists.
 */
export function resolveDestinationTz(input: ResolveDestinationTzInput): EffectiveZone {
  const stored = input.stored ?? null;
  const storedZone = stored === null ? null : canonicalizeZone(stored.zone);

  if (stored?.source === "user" && storedZone !== null) return { zone: storedZone, source: "user" };
  if (stored?.source === "derived" && storedZone !== null) {
    return { zone: storedZone, source: "derived" };
  }
  const derived = deriveZoneFromCoords(input.lat, input.lng);
  if (derived !== null) return { zone: derived, source: "derived" };

  for (const booking of input.bookings ?? []) {
    // arrives_tz first (the destination end); departs_tz only if it's unusable.
    for (const candidate of [booking.arrivesTz, booking.departsTz]) {
      const zone = candidate === null ? null : canonicalizeZone(candidate);
      if (zone !== null) return { zone, source: "booking" };
    }
  }

  if (stored?.source === "device" && storedZone !== null) {
    return { zone: storedZone, source: "device" };
  }
  return DEFAULT_EFFECTIVE_ZONE;
}

// ---------------------------------------------------------------------------
// The WRITE side — one pure function for create and PATCH
// ---------------------------------------------------------------------------

/** What a write does to the stored pair. */
export type ZoneWrite =
  { kind: "untouched" } | { kind: "clear" } | { kind: "set"; zone: StoredZone };

export type ZoneWriteResult = { ok: true; write: ZoneWrite } | { ok: false };

export interface ZoneWriteInput {
  /** What the row stores now — `null` on create and for a row with nothing stored. */
  current: StoredZone | null;
  /**
   * The body's zone fields. `zone`: `undefined` = absent, `null` = RESET to
   * automatic, string = a user choice or (source 'device') a hint.
   */
  body: { zone?: string | null | undefined; source?: DestinationTzInputSource | undefined };
  /** The destination coordinates AFTER this write (create: the body's pair). */
  lat: number | null;
  lng: number | null;
  /** True on create, or when the coordinates changed by VALUE (never by key presence). */
  coordsMoved: boolean;
}

const UNTOUCHED: ZoneWriteResult = { ok: true, write: { kind: "untouched" } };
const CLEAR: ZoneWriteResult = { ok: true, write: { kind: "clear" } };
const set = (zone: string, source: StoredDestinationTzSource): ZoneWriteResult => ({
  ok: true,
  write: { kind: "set", zone: { zone, source } },
});

/**
 * What a create/PATCH stores. Rules (the zone-provenance decision):
 *  - `zone: null` RESETS to automatic: clear, then re-derive from the (new)
 *    coordinates — clears a 'user' zone too (the only way to).
 *  - a string with source absent/'user' is a person's choice: allow-listed
 *    and stored canonical as 'user' — or `ok: false` (a 400) if unlisted.
 *  - a string with source 'device' is a HINT: canonicalised, then used only
 *    if nothing better applies; an unusable one is treated as ABSENT.
 *  - otherwise: a stored 'user' zone is NEVER touched (not by a coordinates
 *    nudge, not by a hint); coordinates that derive store 'derived' when they
 *    moved (and leave an untouched row untouched — a read derives lazily);
 *    no derivable coordinates + a usable hint store 'device'; a
 *    coordinates->coordless move clears a 'derived' zone; everything else is
 *    a no-op.
 */
export function resolveZoneWrite(input: ZoneWriteInput): ZoneWriteResult {
  const { current, body, lat, lng, coordsMoved } = input;

  if (body.zone === null) {
    const derived = deriveZoneFromCoords(lat, lng);
    return derived === null ? CLEAR : set(derived, "derived");
  }

  let hint: string | null = null;
  if (typeof body.zone === "string") {
    const canonical = canonicalizeZone(body.zone);
    if ((body.source ?? "user") === "user") {
      return canonical === null ? { ok: false } : set(canonical, "user");
    }
    hint = canonical;
  }

  if (current?.source === "user") return UNTOUCHED;

  const derived = deriveZoneFromCoords(lat, lng);
  if (derived !== null) return coordsMoved ? set(derived, "derived") : UNTOUCHED;
  if (hint !== null) return set(hint, "device");
  if (coordsMoved && current?.source === "derived") return CLEAR;
  return UNTOUCHED;
}

/** The pair a row holds after `write` is applied to `current`. */
export function applyZoneWrite(current: StoredZone | null, write: ZoneWrite): StoredZone | null {
  switch (write.kind) {
    case "untouched":
      return current;
    case "clear":
      return null;
    case "set":
      return write.zone;
  }
}

// ---------------------------------------------------------------------------
// Reads — batch resolution with the booking fallback
// ---------------------------------------------------------------------------

/** The `trips` columns zone resolution reads (any row or projection qualifies). */
export interface ZoneSourceRow {
  id: string;
  destinationTz: string | null;
  destinationTzSource: string | null;
  /** numeric columns arrive as strings (db/schema/_shared.ts). */
  destinationLat: string | null;
  destinationLng: string | null;
}

const numOrNull = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Flight/train zones for the given trips, best booking first per trip:
 * CANCELLED bookings never count; booked beats planned beats idea; then
 * earliest `starts_at` (NULL starts last), then insertion order. One query;
 * callers only pass the (rare) trips that missed ranks 1-2.
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
        ne(schema.bookings.status, "cancelled"),
      ),
    )
    .orderBy(
      asc(schema.bookings.tripId),
      sql`CASE ${schema.bookings.status} WHEN 'booked' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END`,
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
 * EFFECTIVE zone per trip id for a batch of trip rows (ranks 1-5). A row
 * resolved by a stored user/derived zone or by its coordinates costs nothing;
 * only rows that fall through to the device hint or UTC trigger the single
 * booking query (a booking outranks both). Never writes.
 */
export async function resolveEffectiveZones(
  db: DbClient,
  rows: ReadonlyArray<ZoneSourceRow>,
): Promise<Map<string, EffectiveZone>> {
  const zones = new Map<string, EffectiveZone>();
  const needBookings: ZoneSourceRow[] = [];
  const inputOf = (row: ZoneSourceRow) => ({
    stored: storedZoneOf(row),
    lat: numOrNull(row.destinationLat),
    lng: numOrNull(row.destinationLng),
  });
  for (const row of rows) {
    const resolved = resolveDestinationTz(inputOf(row));
    if (resolved.source === "device" || resolved.source === "default") needBookings.push(row);
    else zones.set(row.id, resolved);
  }
  if (needBookings.length > 0) {
    const bookings = await loadBookingZones(
      db,
      needBookings.map((row) => row.id),
    );
    for (const row of needBookings) {
      zones.set(row.id, resolveDestinationTz({ ...inputOf(row), bookings: bookings.get(row.id) }));
    }
  }
  return zones;
}
