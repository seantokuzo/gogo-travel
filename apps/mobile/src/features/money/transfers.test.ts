/**
 * Transfer-row model (T-9.5 / CMON-4 — R-cmoney-6, §2.7 step 5). Pure pins:
 * signed-pair direction resolution, caller-seat action resolution, and the
 * open-request annotation matcher (each exclusion gets a control arm — the
 * ungated-negative rule).
 */
import { MEMBER_B_ID, MEMBER_C_ID } from "@/test-utils/ids";
import { makeBalancesRead, makeSettleRequest } from "@/test-utils/money-fixtures";
import { TEST_USER } from "@/test-utils/session-fixtures";

import { buildTransferRows } from "./transfers";

const ME = TEST_USER.id;

describe("pairwise direction (signed unordered pairs → directed rows)", () => {
  it("net > 0: counterparty owes user_id — row is counterparty → user_id", () => {
    const rows = buildTransferRows(makeBalancesRead(), "pairwise", ME);
    // Fixture pair (me, B, +2550): B owes me.
    expect(rows[0]).toMatchObject({
      from_user_id: MEMBER_B_ID,
      to_user_id: ME,
      amount_cents: 2550,
    });
  });

  it("net < 0: user_id owes counterparty — row flips, amount is |net|", () => {
    const balances = makeBalancesRead({
      pairwise: [
        {
          trip_id: makeBalancesRead().pairwise[0]!.trip_id,
          user_id: ME,
          counterparty_id: MEMBER_B_ID,
          net_cents: -2550,
        },
      ],
      simplified: [{ from_user_id: ME, to_user_id: MEMBER_B_ID, amount_cents: 2550 }],
      members: [
        { user_id: ME, net_cents: -2550 },
        { user_id: MEMBER_B_ID, net_cents: 2550 },
      ],
    });
    const rows = buildTransferRows(balances, "pairwise", ME);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_user_id: ME,
      to_user_id: MEMBER_B_ID,
      amount_cents: 2550,
    });
  });

  it("simplified view maps the API array verbatim (already directed)", () => {
    const rows = buildTransferRows(makeBalancesRead(), "simplified", ME);
    expect(rows.map((r) => [r.from_user_id, r.to_user_id, r.amount_cents])).toEqual([
      [MEMBER_C_ID, ME, 2450],
      [MEMBER_B_ID, ME, 100],
    ]);
  });
});

describe("caller-seat action resolution (R-cmoney-6)", () => {
  it("caller creditor → counterparty is the debtor; caller uninvolved → null", () => {
    const rows = buildTransferRows(makeBalancesRead(), "pairwise", ME);
    // B → me: caller in the creditor seat.
    expect(rows[0]?.counterpartyId).toBe(MEMBER_B_ID);
    // C → B: caller in neither seat — no action affordance.
    expect(rows[1]?.counterpartyId).toBeNull();
  });

  it("caller debtor → counterparty is the creditor", () => {
    const rows = buildTransferRows(makeBalancesRead(), "simplified", MEMBER_C_ID);
    // C → me from C's perspective: C owes me.
    expect(rows[0]?.counterpartyId).toBe(ME);
  });
});

describe("open-request annotations (§2.7 step 5 seam)", () => {
  const request = makeSettleRequest(); // B billed by me (creditor=creator=me), open, 2550

  it("an OPEN unresolved request the caller sent annotates its debtor→creditor row", () => {
    const rows = buildTransferRows(makeBalancesRead(), "pairwise", ME, [request]);
    expect(rows[0]?.annotation).toEqual({
      amount_cents: 2550,
      created_at: request.created_at,
    });
    // Control arm within the same universe: the unrelated C→B row stays bare.
    expect(rows[1]?.annotation).toBeNull();
  });

  it("non-open, resolved, other-sender, and pair-mismatched requests all annotate NOTHING", () => {
    const cancelled = makeSettleRequest({ status: "cancelled" });
    const resolved = makeSettleRequest({ resolved: true, status: "open" });
    const notMine = makeSettleRequest({ created_by: MEMBER_C_ID });
    const otherPair = makeSettleRequest({ from_user_id: MEMBER_C_ID });
    for (const dud of [cancelled, resolved, notMine, otherPair]) {
      const rows = buildTransferRows(makeBalancesRead(), "pairwise", ME, [dud]);
      expect(rows[0]?.annotation).toBeNull();
    }
    // Ungated control: the SAME call with the live request does annotate.
    const control = buildTransferRows(makeBalancesRead(), "pairwise", ME, [request]);
    expect(control[0]?.annotation).not.toBeNull();
  });
});
