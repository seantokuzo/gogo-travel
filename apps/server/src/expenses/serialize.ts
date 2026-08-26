/**
 * Row → wire serialization for the expenses surface (MON-2). Responses are
 * shaped, never raw DB rows (server rule). Column-type conventions
 * (`db/schema/_shared.ts`): `date` columns cross as `YYYY-MM-DD` strings
 * (passed through — the wire type, R-shared-11); `numeric` (`fx_rate`)
 * comes back as a STRING and the wire's `FxRate` IS a decimal string
 * (Law #2 — never a float), so it passes through untouched; timestamps are
 * `Date` → ISO strings; `bigint` cents are number-mode.
 */
import type { Expense, ExpenseShare } from "@gogo/shared/domains/money";
import type * as schema from "../db/schema/index.js";

export type ExpenseRow = typeof schema.expenses.$inferSelect;

/**
 * Shares travel sorted ascending by `user_id` — the money spec's canonical
 * ordering ("all ordering in this spec means this", §3.3); deterministic
 * across reads regardless of source order (insert returning, json_agg).
 */
export function toShareWire(rows: readonly ExpenseShare[]): ExpenseShare[] {
  return [...rows]
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))
    .map((row) => ({ user_id: row.user_id, share_cents: row.share_cents }));
}

/** The `Expense` document: row + embedded shares + computed effective base (§3.2). */
export function toExpenseWire(row: ExpenseRow, shares: readonly ExpenseShare[]): Expense {
  return {
    id: row.id,
    trip_id: row.tripId,
    description: row.description,
    category: row.category,
    paid_by: row.paidBy,
    amount_cents: row.amountCents,
    currency: row.currency,
    fx_rate: row.fxRate,
    base_amount_cents: row.baseAmountCents,
    booking_id: row.bookingId,
    spent_at: row.spentAt,
    created_by: row.createdBy,
    deleted_at: row.deletedAt ? row.deletedAt.toISOString() : null,
    deleted_by: row.deletedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    shares: toShareWire(shares),
    // §3.4 step 1: B = base_amount_cents ?? amount_cents (equal iff
    // currency = base_currency).
    effective_base_cents: row.baseAmountCents ?? row.amountCents,
  };
}
