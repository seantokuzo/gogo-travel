/**
 * The device-zone HINT a COORDINATE-LESS destination ships with (B-30; Sean
 * ruling 2026-09-19 — "custom destinations without a known zone: use a known
 * zone already on the trip, else the user enters one, with a default
 * fallback"; round-1 zone-provenance decision).
 *
 * A picked custom place with no coordinates gives the server nothing to
 * derive a zone from. Until the zone picker lands (T-7.17), the creator's
 * device zone is the best available GUESS — so it is sent with source
 * `'device'`, NOT as a user's explicit choice: the server ranks a device hint
 * BELOW a booking zone (a later flight into the real destination corrects the
 * trip's "today" instead of the creator's home day sticking for life) and
 * silently ignores one it can't use. T-7.17's picker will send `'user'`.
 *
 * Returns `undefined` — omit the keys — when the runtime can't name a usable
 * IANA-shaped zone (`deviceTimeZone()` falls back to "UTC" itself; a
 * non-IANA-shaped id is pointless to send).
 *
 * Callers send it ONLY for a destination that carries no coordinates: a pick
 * WITH coordinates derives its own zone server-side and ignores any hint.
 */
import { DestinationTzSchema } from "@gogo/shared";

import { deviceTimeZone } from "@/features/itinerary/add-edit/zoned-time";

export interface DeviceZoneHint {
  destination_tz: string;
  destination_tz_source: "device";
}

export function deviceZoneHint(): DeviceZoneHint | undefined {
  const zone = deviceTimeZone();
  return DestinationTzSchema.safeParse(zone).success
    ? { destination_tz: zone, destination_tz_source: "device" }
    : undefined;
}
