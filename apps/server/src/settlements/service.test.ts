/**
 * T-9.3 unit suite — `assembleBalancesDoc` against the money spec §3.4/§3.5
 * fixtures (R-money-8/9/10): multi-expense multi-payer, settlement offset,
 * zero-share rows, the FX prime-÷-3 largest-remainder allocation (no
 * per-share rounding drift), the [I-1] ex-member membership rule, the [I-10]
 * degenerate-row guards, Σ-nets-zero everywhere, and full determinism across
 * row orderings. The MATH under test is the shared `@gogo/shared` module
 * (Law #2) — these fixtures pin this module's assembly on top of it.
 *
 * DB-backed behavior (soft-delete filtering at the query, authz, S1–S3) is
 * routes.db.test.ts's.
 */
import { describe, expect, it } from "vitest";
import { BalancesReadSchema } from "@gogo/shared/domains/money";
import { assembleBalancesDoc, SETTLEMENT_DELETE_WINDOW_MS } from "./service.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
/** Pinned, canonically ascending participant ids (money spec §3.3 order). */
const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U2 = "aaaaaaaa-0000-4000-8000-000000000002";
const U3 = "aaaaaaaa-0000-4000-8000-000000000003";

const netOf = (doc: { members: { user_id: string; net_cents: number }[] }, id: string) =>
  doc.members.find((m) => m.user_id === id)?.net_cents;

const sumNets = (doc: { members: { net_cents: number }[] }) =>
  doc.members.reduce((acc, m) => acc + m.net_cents, 0);

describe("assembleBalancesDoc (B1 — R-money-8/9/10)", () => {
  it("multi-expense, multi-payer, settlement offset — §3.4 fixture; Σ nets = 0", () => {
    const doc = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U1, U2, U3],
      ledger: {
        expenses: [
          {
            // U1 paid 3000, split equally: U2 and U3 each owe U1 1000.
            paid_by: U1,
            amount_cents: 3000,
            shares: [
              { user_id: U1, share_cents: 1000 },
              { user_id: U2, share_cents: 1000 },
              { user_id: U3, share_cents: 1000 },
            ],
          },
          {
            // U2 paid 900, shared with U1 only: U1 owes U2 450.
            paid_by: U2,
            amount_cents: 900,
            shares: [
              { user_id: U1, share_cents: 450 },
              { user_id: U2, share_cents: 450 },
            ],
          },
        ],
        // U3 paid U1 back 500 → offsets U3's 1000 debt down to 500.
        settlements: [{ from_user_id: U3, to_user_id: U1, amount_cents: 500 }],
      },
    });

    expect(BalancesReadSchema.parse(doc)).toEqual(doc);
    expect(doc.currency).toBe("USD");
    expect(doc.members).toEqual([
      { user_id: U1, net_cents: 1050 },
      { user_id: U2, net_cents: -550 },
      { user_id: U3, net_cents: -500 },
    ]);
    expect(sumNets(doc)).toBe(0);
    // One row per unordered pair, zero-net pairs omitted ((U2,U3) never met).
    expect(doc.pairwise).toEqual([
      { trip_id: TRIP, user_id: U1, counterparty_id: U2, net_cents: 550 },
      { trip_id: TRIP, user_id: U1, counterparty_id: U3, net_cents: 500 },
    ]);
    // Simplified: ≤ members − 1 transfers, nets preserved exactly (§3.5).
    expect(doc.simplified).toEqual([
      { from_user_id: U2, to_user_id: U1, amount_cents: 550 },
      { from_user_id: U3, to_user_id: U1, amount_cents: 500 },
    ]);
    expect(doc.simplified.length).toBeLessThanOrEqual(doc.members.length - 1);
  });

  it("FX expense allocates base_amount_cents by largest remainder — prime 1097 over 334/333/333 (R-money-9)", () => {
    const doc = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U1, U2, U3],
      ledger: {
        expenses: [
          {
            // €10.00 at 1.097 → $10.97 base. Quotas: 366.398 / 365.301 /
            // 365.301 → bases 366/365/365, leftover 1¢ → largest remainder
            // (U1, .398) → 367/365/365. Per-share independent rounding would
            // sum to 1096 — the drift R-money-9 forbids.
            paid_by: U1,
            amount_cents: 1000,
            base_amount_cents: 1097,
            shares: [
              { user_id: U1, share_cents: 334 },
              { user_id: U2, share_cents: 333 },
              { user_id: U3, share_cents: 333 },
            ],
          },
        ],
        settlements: [],
      },
    });

    expect(netOf(doc, U1)).toBe(730); // 1097 − own 367
    expect(netOf(doc, U2)).toBe(-365);
    expect(netOf(doc, U3)).toBe(-365);
    expect(sumNets(doc)).toBe(0);
  });

  it("zero-cent shares are legal; a zero-share current member appears at net 0", () => {
    const doc = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U1, U2, U3],
      ledger: {
        expenses: [
          {
            paid_by: U1,
            amount_cents: 500,
            shares: [
              { user_id: U1, share_cents: 0 },
              { user_id: U2, share_cents: 500 },
              { user_id: U3, share_cents: 0 },
            ],
          },
        ],
        settlements: [],
      },
    });

    expect(doc.members).toEqual([
      { user_id: U1, net_cents: 500 },
      { user_id: U2, net_cents: -500 },
      { user_id: U3, net_cents: 0 },
    ]);
    expect(doc.pairwise).toEqual([
      { trip_id: TRIP, user_id: U1, counterparty_id: U2, net_cents: 500 },
    ]);
  });

  it("soft-deleted expenses are excluded from the math (R-db-21 posture on the pure path)", () => {
    const doc = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U1, U2],
      ledger: {
        expenses: [
          {
            paid_by: U1,
            amount_cents: 800,
            deleted_at: "2026-08-20T00:00:00Z",
            shares: [{ user_id: U2, share_cents: 800 }],
          },
        ],
        settlements: [],
      },
    });

    expect(doc.members).toEqual([
      { user_id: U1, net_cents: 0 },
      { user_id: U2, net_cents: 0 },
    ]);
    expect(doc.pairwise).toEqual([]);
    expect(doc.simplified).toEqual([]);
  });

  describe("[I-1] ex-member membership rule (R-money-8/28)", () => {
    it("an ex-member still appears while their balance is outstanding", () => {
      const doc = assembleBalancesDoc({
        tripId: TRIP,
        baseCurrency: "USD",
        // U3 has left the trip.
        currentMemberIds: [U1, U2],
        ledger: {
          expenses: [
            {
              paid_by: U1,
              amount_cents: 1000,
              shares: [{ user_id: U3, share_cents: 1000 }],
            },
          ],
          settlements: [],
        },
      });

      expect(netOf(doc, U3)).toBe(-1000);
      expect(sumNets(doc)).toBe(0);
    });

    it("an ex-member with net 0 but offsetting nonzero edges still appears", () => {
      const doc = assembleBalancesDoc({
        tripId: TRIP,
        baseCurrency: "USD",
        currentMemberIds: [U1, U2],
        ledger: {
          expenses: [
            // U3 owes U1 10 …
            { paid_by: U1, amount_cents: 10, shares: [{ user_id: U3, share_cents: 10 }] },
            // … and U2 owes U3 10 → U3 nets 0 with two live edges.
            { paid_by: U3, amount_cents: 10, shares: [{ user_id: U2, share_cents: 10 }] },
          ],
          settlements: [],
        },
      });

      expect(netOf(doc, U3)).toBe(0);
      expect(doc.pairwise).toEqual([
        { trip_id: TRIP, user_id: U1, counterparty_id: U3, net_cents: 10 },
        { trip_id: TRIP, user_id: U2, counterparty_id: U3, net_cents: -10 },
      ]);
    });

    it("a fully-settled ex-member drops out; a history-less current member appears at 0", () => {
      const doc = assembleBalancesDoc({
        tripId: TRIP,
        baseCurrency: "USD",
        currentMemberIds: [U1, U2],
        ledger: {
          expenses: [
            { paid_by: U1, amount_cents: 100, shares: [{ user_id: U3, share_cents: 100 }] },
          ],
          settlements: [{ from_user_id: U3, to_user_id: U1, amount_cents: 100 }],
        },
      });

      expect(doc.members).toEqual([
        { user_id: U1, net_cents: 0 },
        { user_id: U2, net_cents: 0 },
      ]);
      expect(doc.pairwise).toEqual([]);
      expect(doc.simplified).toEqual([]);
    });
  });

  describe("[I-10] degenerate-row guards (unreachable via R-money-2; must not throw)", () => {
    it("an expense with zero share rows is ignored", () => {
      const doc = assembleBalancesDoc({
        tripId: TRIP,
        baseCurrency: "USD",
        currentMemberIds: [U1],
        ledger: {
          expenses: [{ paid_by: U1, amount_cents: 999, shares: [] }],
          settlements: [],
        },
      });
      expect(doc.members).toEqual([{ user_id: U1, net_cents: 0 }]);
    });

    it("an FX expense whose shares sum to zero is ignored (allocateProportional would throw)", () => {
      const doc = assembleBalancesDoc({
        tripId: TRIP,
        baseCurrency: "USD",
        currentMemberIds: [U1, U2],
        ledger: {
          expenses: [
            {
              paid_by: U1,
              amount_cents: 100,
              base_amount_cents: 110,
              shares: [
                { user_id: U1, share_cents: 0 },
                { user_id: U2, share_cents: 0 },
              ],
            },
          ],
          settlements: [],
        },
      });
      expect(doc.members).toEqual([
        { user_id: U1, net_cents: 0 },
        { user_id: U2, net_cents: 0 },
      ]);
    });
  });

  it("deterministic across row orderings (R-money-10 posture)", () => {
    const expenses = [
      {
        paid_by: U1,
        amount_cents: 3000,
        shares: [
          { user_id: U3, share_cents: 1000 },
          { user_id: U1, share_cents: 1000 },
          { user_id: U2, share_cents: 1000 },
        ],
      },
      {
        paid_by: U2,
        amount_cents: 900,
        shares: [
          { user_id: U2, share_cents: 450 },
          { user_id: U1, share_cents: 450 },
        ],
      },
      {
        paid_by: U3,
        amount_cents: 1000,
        base_amount_cents: 1097,
        shares: [
          { user_id: U2, share_cents: 333 },
          { user_id: U1, share_cents: 334 },
          { user_id: U3, share_cents: 333 },
        ],
      },
    ];
    const settlements = [
      { from_user_id: U3, to_user_id: U1, amount_cents: 500 },
      { from_user_id: U2, to_user_id: U1, amount_cents: 250 },
    ];

    const forward = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U1, U2, U3],
      ledger: { expenses, settlements },
    });
    const permuted = assembleBalancesDoc({
      tripId: TRIP,
      baseCurrency: "USD",
      currentMemberIds: [U3, U1, U2],
      ledger: {
        expenses: [...expenses].reverse().map((e) => ({
          ...e,
          shares: [...e.shares].reverse(),
        })),
        settlements: [...settlements].reverse(),
      },
    });

    expect(permuted).toEqual(forward);
    expect(sumNets(forward)).toBe(0);
  });
});

describe("SETTLEMENT_DELETE_WINDOW_MS (R-money-15)", () => {
  it("is exactly 24 hours", () => {
    expect(SETTLEMENT_DELETE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
