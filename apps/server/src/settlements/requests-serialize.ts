/**
 * Row → wire serialization for the settle-requests surface (T-9.4 / MON-5).
 * Responses are shaped, never raw DB rows (server rule). The row type comes
 * from serialize.ts (T-9.3 owns the settlements-domain row aliases).
 *
 * LINK CONSTRUCTION (R-money-16; P-9 ruling 2026-08-25): the wire `link` is
 * the universal `https://<LINK_DOMAIN>/t/<tripId>/request/<requestId>` form,
 * built by the SHARED template `settleRequestUrl` in
 * `@gogo/shared/config/links` (T-9.7 hoist — the W4 obligation): one home
 * for the path, beside the invite pair, swapped for the real domain at P-14
 * as a one-config change. The `gogo://` mirror (`settleRequestDeepLink`,
 * same shared template) is the client share flow's "primary" half of the
 * ruling ([I-4] in the module-doc numbering, requests-service.ts) — deriving
 * both forms from one template is what keeps a drifted dead-end share link
 * unrepresentable.
 */
import { settleRequestUrl } from "@gogo/shared/config/links";
import type { SettleRequest } from "@gogo/shared/domains/money";
import type { SettlementRequestRow } from "./serialize.js";

/**
 * The universal settle-request link — HOISTED to the shared template
 * (T-9.7 W4 obligation 1): `@gogo/shared/config/links` is the ONE home for
 * the path, consumed here for the wire `link` and by the client's gogo://
 * share composition. Re-exported so server consumers keep one import site.
 */
export { settleRequestUrl };

/**
 * `resolved` is DERIVED per read (R-money-18/19) — the caller computes it
 * against the live pairwise debt (requests-service.ts) and passes it in;
 * `created_by` serializes from `to_user_id` ([I-3]: creditor = creator is the
 * R-money-16 invariant and §3.3.25 carries no separate column).
 */
export function toSettleRequestWire(row: SettlementRequestRow, resolved: boolean): SettleRequest {
  return {
    id: row.id,
    trip_id: row.tripId,
    from_user_id: row.fromUserId,
    to_user_id: row.toUserId,
    amount_cents: row.amountCents,
    currency: row.currency,
    note: row.note,
    status: row.status,
    resolved,
    settlement_id: row.settlementId,
    created_by: row.toUserId,
    created_at: row.createdAt.toISOString(),
    link: settleRequestUrl(row.tripId, row.id),
  };
}
