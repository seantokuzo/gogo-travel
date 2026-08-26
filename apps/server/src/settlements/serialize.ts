/**
 * Row → wire serialization for the settlements surface (T-9.3 / MON-4).
 * Responses are shaped, never raw DB rows (server rule). Column-type
 * conventions (`db/schema/_shared.ts`): timestamps are `Date` → ISO strings;
 * `bigint` cents are number-mode. Settlements are immutable ledger entries
 * (schema spec §3.3.14 — no `updated_at` on the row or the wire).
 */
import type { Settlement } from "@gogo/shared/domains/money";
import type * as schema from "../db/schema/index.js";

export type SettlementRow = typeof schema.settlements.$inferSelect;
export type SettlementRequestRow = typeof schema.settlementRequests.$inferSelect;

export function toSettlementWire(row: SettlementRow): Settlement {
  return {
    id: row.id,
    trip_id: row.tripId,
    from_user_id: row.fromUserId,
    to_user_id: row.toUserId,
    amount_cents: row.amountCents,
    currency: row.currency,
    method: row.method,
    note: row.note,
    settled_at: row.settledAt.toISOString(),
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  };
}
