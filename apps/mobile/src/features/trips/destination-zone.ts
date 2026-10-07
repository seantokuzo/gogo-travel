/**
 * The zone a COORDINATE-LESS destination ships with (B-30; Sean ruling
 * 2026-09-19 — "custom destinations without a known zone: use a known zone
 * already on the trip, else the user enters one, with a default fallback").
 *
 * A picked custom place with no coordinates gives the server nothing to
 * derive a zone from. Until the zone picker lands (T-7.17), the creator's
 * device zone is the best available explicit value: it is stored as the
 * trip's `destination_tz`, so the trip's "today" is at least the creator's
 * own day rather than UTC's. Returns `undefined` — omit the key — when the
 * runtime can't name a usable IANA-shaped zone (`deviceTimeZone()` falls back
 * to "UTC" itself; a non-IANA-shaped id would 400 the whole create), letting
 * the server's chain (booking zone → UTC) answer instead.
 *
 * Callers send it ONLY for a destination that carries no coordinates: a pick
 * with coordinates must NOT send it, or it would override the zone the server
 * derives from them.
 */
import { DestinationTzSchema } from "@gogo/shared";

import { deviceTimeZone } from "@/features/itinerary/add-edit/zoned-time";

export function coordinateLessDestinationZone(): string | undefined {
  const zone = deviceTimeZone();
  return DestinationTzSchema.safeParse(zone).success ? zone : undefined;
}
