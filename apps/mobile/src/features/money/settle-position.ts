/**
 * Pairwise-position helpers (T-9.7 — R-cmoney-14/23; §2.6). Pure over the
 * B1 document so the settle screen's direction math is testable without a
 * component — the same posture as transfers.ts, whose module doc owns the
 * signed-pair convention (net > 0 = counterparty owes user_id, one row per
 * unordered pair, zero-net pairs omitted).
 */
import { centsToMoneyText, type BalancesRead } from "@gogo/shared";

/**
 * Amount-entry/prefill text — `omitZeroMinor` (the shared formatter's
 * form-prefill posture: `"120"`, not `"120.00"`; JPY stays whole-unit).
 */
export function centsToAmountText(cents: number, currency: string): string {
  return centsToMoneyText(cents, currency, { omitZeroMinor: true });
}

/**
 * The caller's SIGNED pairwise net against one counterparty:
 * positive = the counterparty owes the caller (creditor view),
 * negative = the caller owes (debtor view), 0 = settled (absent pair
 * included — B1 omits zero-net pairs).
 */
export function pairwiseNet(doc: BalancesRead, callerId: string, counterpartyId: string): number {
  const pair = doc.pairwise.find(
    (p) =>
      (p.user_id === callerId && p.counterparty_id === counterpartyId) ||
      (p.user_id === counterpartyId && p.counterparty_id === callerId),
  );
  if (pair === undefined) return 0;
  return pair.user_id === callerId ? pair.net_cents : -pair.net_cents;
}
