/**
 * THE one place-visibility predicate (round-2 A1 — the places router and the
 * booking service carried byte-identical private copies; IB-2's item writes
 * would have minted a third). Law #3 / R-places-8, the rule verbatim:
 *
 *  - spine/open-data rows are globally visible;
 *  - a CUSTOM row is visible to its creator, plus — via the trip-content
 *    widening rule (`places/search-query.ts`) — to members of any trip that
 *    references it (saved place / itinerary item / booking), evaluated at
 *    call time so a revoked membership revokes the grant;
 *  - anything else is INVISIBLE, and invisible ≡ absent (`not_found` — the
 *    indistinguishable-404 posture).
 *
 * Callers map the access kind to their own surface: the places router keeps
 * its 403/404 branches (mutating a visible-but-not-yours place reveals
 * nothing new — R-places-10), the booking service folds everything it does
 * not accept into its canonical 404. The malformed-id pre-check lives HERE
 * (it also keeps the `::uuid` casts crash-proof), folding bad ids into the
 * same `not_found`.
 *
 * Takes any reader — the bare client or a transaction scope — so write paths
 * can evaluate the grant inside their own transaction.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { UUID_RE } from "../http/require-trip-member.js";
import type { PlaceRow } from "./serialize.js";

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type PlaceReader = DbClient | Tx;

export type PlaceAccess =
  | { kind: "not_found" }
  | { kind: "spine"; row: PlaceRow }
  | { kind: "owned"; row: PlaceRow }
  | { kind: "referenced"; row: PlaceRow };

export async function resolvePlaceAccess(
  reader: PlaceReader,
  args: { placeId: string; userId: string },
): Promise<PlaceAccess> {
  const { placeId, userId } = args;
  if (!UUID_RE.test(placeId)) return { kind: "not_found" };

  const [row] = await reader.select().from(schema.places).where(eq(schema.places.id, placeId));
  if (!row) return { kind: "not_found" };
  if (row.source !== "custom") return { kind: "spine", row };
  if (row.createdBy === userId) return { kind: "owned", row };

  const [visible] = await reader
    .select({ one: sql<number>`1` })
    .from(schema.tripMembers)
    .where(
      and(
        eq(schema.tripMembers.userId, userId),
        sql`(
          exists (select 1 from saved_places sp where sp.trip_id = ${schema.tripMembers.tripId} and sp.place_id = ${placeId}::uuid)
          or exists (select 1 from itinerary_items ii where ii.trip_id = ${schema.tripMembers.tripId} and ii.place_id = ${placeId}::uuid)
          or exists (select 1 from bookings b where b.trip_id = ${schema.tripMembers.tripId} and b.place_id = ${placeId}::uuid)
        )`,
      ),
    )
    .limit(1);

  return visible ? { kind: "referenced", row } : { kind: "not_found" };
}
