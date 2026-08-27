/**
 * Transfer-row model (T-9.5 / CMON-4 — R-cmoney-6, §2.2 "Balances").
 * Pure over the B1 document so the direction math is testable without a
 * component: pairwise rows arrive as SIGNED unordered pairs (net > 0 =
 * counterparty owes user_id — the one documented signed-cents exception),
 * and the view renders directed "{debtor} → {creditor}" rows; the
 * simplified array is directed already.
 *
 * OPEN-REQUEST ANNOTATIONS (§2.7 step 5): rows matching an OPEN,
 * unresolved settle-request the CALLER sent carry a subdued "requested X
 * on <date>" annotation. The wire has no settle-request LIST endpoint
 * (T-9.1 froze Q1–Q3 only), so in T-9.5 this is a SEAM — fixture-tested,
 * empty-in-prod (the P-8 photo-pin precedent) — flagged for the spec-pass
 * batch; T-9.7 (send-the-bill) owns wiring a real source + cancel.
 */
import type { BalancesRead, SettleRequest } from "@gogo/shared";

export type TransferView = "pairwise" | "simplified";

export interface TransferAnnotation {
  amount_cents: number;
  /** Request creation instant (ISO) — rendered as a local date. */
  created_at: string;
}

export interface TransferRow {
  /** Debtor. */
  from_user_id: string;
  /** Creditor. */
  to_user_id: string;
  amount_cents: number;
  /**
   * The OTHER party when the caller sits in either seat — the settle-screen
   * navigation target (§2.6 step 1). `null` = caller uninvolved: the row
   * renders without an action affordance (R-cmoney-6).
   */
  counterpartyId: string | null;
  /** Open-request annotation (module doc) — `null` when none matches. */
  annotation: TransferAnnotation | null;
}

export function buildTransferRows(
  balances: BalancesRead,
  view: TransferView,
  callerId: string,
  openRequests: readonly SettleRequest[] = [],
): TransferRow[] {
  const directed =
    view === "simplified"
      ? balances.simplified.map((t) => ({
          from: t.from_user_id,
          to: t.to_user_id,
          amount: t.amount_cents,
        }))
      : balances.pairwise.map((pair) =>
          pair.net_cents > 0
            ? { from: pair.counterparty_id, to: pair.user_id, amount: pair.net_cents }
            : { from: pair.user_id, to: pair.counterparty_id, amount: -pair.net_cents },
        );
  return directed.map(({ from, to, amount }) => {
    const counterpartyId = from === callerId ? to : to === callerId ? from : null;
    // §2.7 step 5 is scoped to requests the CALLER sent (creditor = creator),
    // matched onto the debtor→creditor row they bill.
    const request =
      openRequests.find(
        (r) =>
          r.status === "open" &&
          !r.resolved &&
          r.created_by === callerId &&
          r.from_user_id === from &&
          r.to_user_id === to,
      ) ?? null;
    return {
      from_user_id: from,
      to_user_id: to,
      amount_cents: amount,
      counterpartyId,
      annotation:
        request === null
          ? null
          : { amount_cents: request.amount_cents, created_at: request.created_at },
    };
  });
}
