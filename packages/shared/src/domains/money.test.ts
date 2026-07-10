import { describe, expect, it } from "vitest";
import {
  allocateProportional,
  computeBalances,
  computeShares,
  ExpenseCreateSchema,
  ExpenseUpdateSchema,
  FxRateSchema,
  SettlementCreateSchema,
  simplifyDebts,
  type ExpenseForBalance,
  type MemberNet,
} from "./money.js";

const U = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`;
const ALICE = "alice";
const BOB = "bob";
const CARA = "cara";
const DAVE = "dave";

const sum = (shares: ReadonlyArray<{ share_cents: number }>): number =>
  shares.reduce((acc, s) => acc + s.share_cents, 0);

// ---------------------------------------------------------------------------
// computeShares — the pinned §3.3 algorithm
// ---------------------------------------------------------------------------

describe("computeShares · equal", () => {
  it("splits evenly when divisible", () => {
    expect(computeShares(900, { type: "equal", participants: [BOB, ALICE, CARA] })).toEqual([
      { user_id: ALICE, share_cents: 300 },
      { user_id: BOB, share_cents: 300 },
      { user_id: CARA, share_cents: 300 },
    ]);
  });

  it("assigns remainder cents +1 each to the FIRST r participants in user_id order", () => {
    // 1000 / 3 = 333 r 1 → alice gets the extra cent
    expect(computeShares(1000, { type: "equal", participants: [CARA, BOB, ALICE] })).toEqual([
      { user_id: ALICE, share_cents: 334 },
      { user_id: BOB, share_cents: 333 },
      { user_id: CARA, share_cents: 333 },
    ]);
    // 1001 / 3 → r 2 → alice and bob
    expect(computeShares(1001, { type: "equal", participants: [ALICE, BOB, CARA] })).toEqual([
      { user_id: ALICE, share_cents: 334 },
      { user_id: BOB, share_cents: 334 },
      { user_id: CARA, share_cents: 333 },
    ]);
  });

  it("orders by canonical LOWERCASE user_id", () => {
    const shares = computeShares(101, { type: "equal", participants: ["Bob", "alice"] });
    expect(shares.map((s) => s.user_id)).toEqual(["alice", "Bob"]);
    expect(shares[0]?.share_cents).toBe(51);
  });

  it("dedupes equal participants", () => {
    expect(computeShares(100, { type: "equal", participants: [ALICE, ALICE, BOB] })).toEqual([
      { user_id: ALICE, share_cents: 50 },
      { user_id: BOB, share_cents: 50 },
    ]);
  });

  it("Σ = amount for adversarial amounts and party sizes (invariant sweep)", () => {
    const participants = [ALICE, BOB, CARA, DAVE, "erin", "frank", "grace"];
    for (const amount of [1, 2, 3, 7, 97, 100, 101, 999, 12345, 99999991]) {
      for (let n = 1; n <= participants.length; n += 1) {
        const shares = computeShares(amount, {
          type: "equal",
          participants: participants.slice(0, n),
        });
        expect(sum(shares)).toBe(amount);
        // max spread between shares is 1 cent
        const values = shares.map((s) => s.share_cents);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("rejects invalid inputs", () => {
    expect(() => computeShares(0, { type: "equal", participants: [ALICE] })).toThrow(RangeError);
    expect(() => computeShares(-5, { type: "equal", participants: [ALICE] })).toThrow(RangeError);
    expect(() => computeShares(10.5, { type: "equal", participants: [ALICE] })).toThrow(RangeError);
    expect(() => computeShares(100, { type: "equal", participants: [] })).toThrow(RangeError);
  });
});

describe("computeShares · percent (integer basis points)", () => {
  it("allocates by bp with largest-remainder distribution", () => {
    // 1000 × 33.33%/33.33%/33.34%
    expect(
      computeShares(1000, {
        type: "percent",
        participants: [
          { user_id: ALICE, percent_bp: 3333 },
          { user_id: BOB, percent_bp: 3333 },
          { user_id: CARA, percent_bp: 3334 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 333 },
      { user_id: BOB, share_cents: 333 },
      { user_id: CARA, share_cents: 334 },
    ]);
  });

  it("largest fractional remainder wins the leftover cent", () => {
    // A=101: alice 50.5 (rem .5), bob 50.5 (rem .5)? — use asymmetric bps:
    // alice 2500bp → 25.25 (rem .25); bob 7500bp → 75.75 (rem .75) ⇒ bob +1
    expect(
      computeShares(101, {
        type: "percent",
        participants: [
          { user_id: ALICE, percent_bp: 2500 },
          { user_id: BOB, percent_bp: 7500 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 25 },
      { user_id: BOB, share_cents: 76 },
    ]);
  });

  it("breaks remainder TIES by user_id ascending", () => {
    // A=101, 50/50: both remainders .5 → alice (asc) gets the cent
    expect(
      computeShares(101, {
        type: "percent",
        participants: [
          { user_id: BOB, percent_bp: 5000 },
          { user_id: ALICE, percent_bp: 5000 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 51 },
      { user_id: BOB, share_cents: 50 },
    ]);
  });

  it("rejects Σbp ≠ 10000, non-integer bp, duplicates", () => {
    expect(() =>
      computeShares(100, {
        type: "percent",
        participants: [{ user_id: ALICE, percent_bp: 9999 }],
      }),
    ).toThrow(/10000/);
    expect(() =>
      computeShares(100, {
        type: "percent",
        participants: [
          { user_id: ALICE, percent_bp: 5000.5 },
          { user_id: BOB, percent_bp: 4999.5 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeShares(100, {
        type: "percent",
        participants: [
          { user_id: ALICE, percent_bp: 5000 },
          { user_id: "ALICE", percent_bp: 5000 },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("Σ = amount across a bp fuzz sweep", () => {
    const bpSplits = [
      [1, 9999],
      [3333, 3333, 3334],
      [1234, 8766],
      [10, 20, 30, 9940],
      [2000, 2000, 2000, 2000, 2000],
    ];
    for (const bps of bpSplits) {
      for (const amount of [1, 13, 101, 9999, 123457]) {
        const shares = computeShares(amount, {
          type: "percent",
          participants: bps.map((bp, i) => ({ user_id: `u${i}`, percent_bp: bp })),
        });
        expect(sum(shares)).toBe(amount);
      }
    }
  });
});

describe("computeShares · shares (weights)", () => {
  it("allocates by weight", () => {
    expect(
      computeShares(700, {
        type: "shares",
        participants: [
          { user_id: ALICE, weight: 2 },
          { user_id: BOB, weight: 5 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 200 },
      { user_id: BOB, share_cents: 500 },
    ]);
  });

  it("distributes remainders by largest fraction, ties by user_id", () => {
    // A=100, weights 1/1/1: 33.33... each, all ties → alice, bob get +1
    expect(
      computeShares(100, {
        type: "shares",
        participants: [
          { user_id: CARA, weight: 1 },
          { user_id: ALICE, weight: 1 },
          { user_id: BOB, weight: 1 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 34 },
      { user_id: BOB, share_cents: 33 },
      { user_id: CARA, share_cents: 33 },
    ]);
  });

  it("rejects weights < 1 and non-integer weights", () => {
    expect(() =>
      computeShares(100, { type: "shares", participants: [{ user_id: ALICE, weight: 0 }] }),
    ).toThrow(RangeError);
    expect(() =>
      computeShares(100, { type: "shares", participants: [{ user_id: ALICE, weight: 1.5 }] }),
    ).toThrow(RangeError);
  });

  it("Σ = amount across weight fuzz sweep", () => {
    const weightSets = [[1, 1, 1], [1, 2, 3, 4], [7, 11, 13], [1, 999], [5]];
    for (const weights of weightSets) {
      for (const amount of [1, 13, 101, 9999, 1000003]) {
        const shares = computeShares(amount, {
          type: "shares",
          participants: weights.map((w, i) => ({ user_id: `u${i}`, weight: w })),
        });
        expect(sum(shares)).toBe(amount);
      }
    }
  });
});

describe("computeShares · exact", () => {
  it("passes through when Σ = amount, sorted canonically", () => {
    expect(
      computeShares(500, {
        type: "exact",
        participants: [
          { user_id: BOB, share_cents: 400 },
          { user_id: ALICE, share_cents: 100 },
        ],
      }),
    ).toEqual([
      { user_id: ALICE, share_cents: 100 },
      { user_id: BOB, share_cents: 400 },
    ]);
  });

  it("zero shares are legal (payer covered someone entirely)", () => {
    expect(
      computeShares(500, {
        type: "exact",
        participants: [
          { user_id: ALICE, share_cents: 0 },
          { user_id: BOB, share_cents: 500 },
        ],
      }),
    ).toHaveLength(2);
  });

  it("rejects Σ ≠ amount and negative shares", () => {
    expect(() =>
      computeShares(500, {
        type: "exact",
        participants: [{ user_id: ALICE, share_cents: 499 }],
      }),
    ).toThrow(/sum/);
    expect(() =>
      computeShares(500, {
        type: "exact",
        participants: [
          { user_id: ALICE, share_cents: -100 },
          { user_id: BOB, share_cents: 600 },
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe("allocateProportional (base-currency allocation, §3.4 step 2)", () => {
  it("prime amount ÷ 3 equal shares: no rounding drift (money spec fixture)", () => {
    // B=1009 (prime) allocated over three equal shares of a 900-cent expense
    const allocated = allocateProportional(1009, [
      { user_id: ALICE, weight: 300 },
      { user_id: BOB, weight: 300 },
      { user_id: CARA, weight: 300 },
    ]);
    expect(sum(allocated)).toBe(1009);
    const values = allocated.map((s) => s.share_cents).sort((a, b) => a - b);
    expect(values).toEqual([336, 336, 337]);
  });

  it("zero weights are legal and get zero", () => {
    const allocated = allocateProportional(1000, [
      { user_id: ALICE, weight: 0 },
      { user_id: BOB, weight: 500 },
    ]);
    expect(allocated).toEqual([
      { user_id: ALICE, share_cents: 0 },
      { user_id: BOB, share_cents: 1000 },
    ]);
  });

  it("rejects all-zero weights", () => {
    expect(() => allocateProportional(100, [{ user_id: ALICE, weight: 0 }])).toThrow(RangeError);
  });

  it("handles large totals without float drift (BigInt internals)", () => {
    const total = 9_007_199_254_740; // ~$90B in cents
    const allocated = allocateProportional(total, [
      { user_id: ALICE, weight: 1 },
      { user_id: BOB, weight: 3 },
      { user_id: CARA, weight: 7 },
    ]);
    expect(sum(allocated)).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// computeBalances — §3.4
// ---------------------------------------------------------------------------

const expense = (
  paid_by: string,
  amount: number,
  shares: Array<[string, number]>,
  extra?: Partial<ExpenseForBalance>,
): ExpenseForBalance => ({
  paid_by,
  amount_cents: amount,
  shares: shares.map(([user_id, share_cents]) => ({ user_id, share_cents })),
  ...extra,
});

const netsSumToZero = (members: readonly MemberNet[]): void => {
  expect(members.reduce((acc, m) => acc + m.net_cents, 0)).toBe(0);
};

describe("computeBalances", () => {
  it("single expense: share-holders owe the payer", () => {
    const { members, pairwise } = computeBalances(
      [
        expense(ALICE, 900, [
          [ALICE, 300],
          [BOB, 300],
          [CARA, 300],
        ]),
      ],
      [],
    );
    expect(members).toEqual([
      { user_id: ALICE, net_cents: 600 },
      { user_id: BOB, net_cents: -300 },
      { user_id: CARA, net_cents: -300 },
    ]);
    // alice < bob: + = counterparty owes user → bob owes alice 300
    expect(pairwise).toEqual([
      { user_id: ALICE, counterparty_id: BOB, net_cents: 300 },
      { user_id: ALICE, counterparty_id: CARA, net_cents: 300 },
    ]);
    netsSumToZero(members);
  });

  it("multi-expense, multi-payer fixture nets pairwise debts", () => {
    const { members, pairwise } = computeBalances(
      [
        expense(ALICE, 1000, [
          [ALICE, 500],
          [BOB, 500],
        ]),
        expense(BOB, 300, [
          [ALICE, 150],
          [BOB, 150],
        ]),
      ],
      [],
    );
    // bob owes alice 500; alice owes bob 150 → net bob owes alice 350
    expect(pairwise).toEqual([{ user_id: ALICE, counterparty_id: BOB, net_cents: 350 }]);
    netsSumToZero(members);
  });

  it("settlements offset debt (record-only ledger)", () => {
    const { members, pairwise } = computeBalances(
      [
        expense(ALICE, 1000, [
          [ALICE, 500],
          [BOB, 500],
        ]),
      ],
      [{ from_user_id: BOB, to_user_id: ALICE, amount_cents: 500 }],
    );
    expect(pairwise).toEqual([]); // zero-net pairs omitted
    expect(members).toEqual([
      { user_id: ALICE, net_cents: 0 },
      { user_id: BOB, net_cents: 0 },
    ]);
  });

  it("overpayment flips the pair sign", () => {
    const { pairwise } = computeBalances(
      [
        expense(ALICE, 1000, [
          [ALICE, 500],
          [BOB, 500],
        ]),
      ],
      [{ from_user_id: BOB, to_user_id: ALICE, amount_cents: 800 }],
    );
    expect(pairwise).toEqual([{ user_id: ALICE, counterparty_id: BOB, net_cents: -300 }]);
  });

  it("zero-share participants appear with net 0", () => {
    const { members } = computeBalances(
      [
        expense(ALICE, 500, [
          [BOB, 500],
          [CARA, 0],
        ]),
      ],
      [],
    );
    expect(members).toContainEqual({ user_id: CARA, net_cents: 0 });
    netsSumToZero(members);
  });

  it("FX expense allocates base_amount_cents proportionally (no per-share drift)", () => {
    // ¥900 expense (prime base 1009¢) split three ways equally
    const { members } = computeBalances(
      [
        expense(
          ALICE,
          900,
          [
            [ALICE, 300],
            [BOB, 300],
            [CARA, 300],
          ],
          { base_amount_cents: 1009 },
        ),
      ],
      [],
    );
    netsSumToZero(members);
    // bob/cara owe base shares (336/337 or 337/336 by remainder ties → equal
    // remainders, alice<bob<cara: alice +1 → alice 337, bob 336, cara 336;
    // alice's own share isn't a debt, so bob and cara owe 336 each.
    expect(members).toEqual([
      { user_id: ALICE, net_cents: 672 },
      { user_id: BOB, net_cents: -336 },
      { user_id: CARA, net_cents: -336 },
    ]);
  });

  it("soft-deleted expenses are excluded (R-db-21)", () => {
    const { members } = computeBalances(
      [
        expense(
          ALICE,
          1000,
          [
            [ALICE, 500],
            [BOB, 500],
          ],
          { deleted_at: "2026-07-10T00:00:00Z" },
        ),
      ],
      [],
    );
    expect(members.every((m) => m.net_cents === 0)).toBe(true);
  });

  it("is deterministic across row orderings", () => {
    const e1 = expense(ALICE, 999, [
      [ALICE, 333],
      [BOB, 333],
      [CARA, 333],
    ]);
    const e2 = expense(BOB, 501, [
      [ALICE, 167],
      [BOB, 167],
      [CARA, 167],
    ]);
    const s = [{ from_user_id: CARA, to_user_id: ALICE, amount_cents: 100 }];
    expect(computeBalances([e1, e2], s)).toEqual(computeBalances([e2, e1], s));
  });

  it("ex-members with history still appear (R-money-8)", () => {
    const { members } = computeBalances(
      [
        expense(DAVE, 400, [
          [ALICE, 200],
          [DAVE, 200],
        ]),
      ],
      [],
    );
    expect(members.map((m) => m.user_id)).toContain(DAVE);
  });
});

// ---------------------------------------------------------------------------
// simplifyDebts — §3.5
// ---------------------------------------------------------------------------

describe("simplifyDebts", () => {
  it("simple chain collapses to ≤ n−1 transfers preserving nets", () => {
    const nets: MemberNet[] = [
      { user_id: ALICE, net_cents: 500 },
      { user_id: BOB, net_cents: -200 },
      { user_id: CARA, net_cents: -300 },
    ];
    const transfers = simplifyDebts(nets);
    expect(transfers.length).toBeLessThanOrEqual(2);
    expect(transfers).toEqual([
      { from_user_id: BOB, to_user_id: ALICE, amount_cents: 200 },
      { from_user_id: CARA, to_user_id: ALICE, amount_cents: 300 },
    ]);
  });

  it("preserves every member's net position exactly (invariant sweep)", () => {
    const fixtures: MemberNet[][] = [
      [
        { user_id: ALICE, net_cents: 1 },
        { user_id: BOB, net_cents: -1 },
      ],
      [
        { user_id: ALICE, net_cents: 700 },
        { user_id: BOB, net_cents: 300 },
        { user_id: CARA, net_cents: -400 },
        { user_id: DAVE, net_cents: -600 },
      ],
      [
        { user_id: ALICE, net_cents: 0 },
        { user_id: BOB, net_cents: 250 },
        { user_id: CARA, net_cents: -125 },
        { user_id: DAVE, net_cents: -125 },
      ],
      [],
    ];
    for (const nets of fixtures) {
      const transfers = simplifyDebts(nets);
      expect(transfers.length).toBeLessThanOrEqual(Math.max(nets.length - 1, 0));
      const applied = new Map(nets.map((n) => [n.user_id, 0]));
      for (const t of transfers) {
        expect(t.amount_cents).toBeGreaterThan(0);
        applied.set(t.from_user_id, (applied.get(t.from_user_id) ?? 0) - t.amount_cents);
        applied.set(t.to_user_id, (applied.get(t.to_user_id) ?? 0) + t.amount_cents);
      }
      for (const n of nets) {
        expect(applied.get(n.user_id)).toBe(n.net_cents);
      }
    }
  });

  it("breaks magnitude ties by ascending user_id (deterministic)", () => {
    const transfers = simplifyDebts([
      { user_id: CARA, net_cents: 100 },
      { user_id: BOB, net_cents: 100 },
      { user_id: ALICE, net_cents: -200 },
    ]);
    // creditors tie at 100 → bob (asc) first
    expect(transfers).toEqual([
      { from_user_id: ALICE, to_user_id: BOB, amount_cents: 100 },
      { from_user_id: ALICE, to_user_id: CARA, amount_cents: 100 },
    ]);
  });

  it("is deterministic across input orderings", () => {
    const nets: MemberNet[] = [
      { user_id: DAVE, net_cents: -600 },
      { user_id: ALICE, net_cents: 700 },
      { user_id: CARA, net_cents: -400 },
      { user_id: BOB, net_cents: 300 },
    ];
    const shuffled = [nets[2], nets[0], nets[3], nets[1]] as MemberNet[];
    expect(simplifyDebts(nets)).toEqual(simplifyDebts(shuffled));
  });

  it("rejects nets that don't sum to zero", () => {
    expect(() => simplifyDebts([{ user_id: ALICE, net_cents: 5 }])).toThrow(/sum to 0/);
  });

  it("end-to-end: balances → simplify round-trip", () => {
    const { members } = computeBalances(
      [
        expense(ALICE, 3000, [
          [ALICE, 1000],
          [BOB, 1000],
          [CARA, 1000],
        ]),
        expense(BOB, 1200, [
          [BOB, 400],
          [CARA, 400],
          [DAVE, 400],
        ]),
      ],
      [{ from_user_id: CARA, to_user_id: ALICE, amount_cents: 500 }],
    );
    netsSumToZero(members);
    const transfers = simplifyDebts(members);
    expect(transfers.length).toBeLessThanOrEqual(members.length - 1);
  });
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

describe("ExpenseCreate (R-db-2 mirror)", () => {
  const valid = {
    description: "Dinner",
    category: "food",
    paid_by: U(1),
    amount_cents: 1000,
    currency: "JPY",
    shares: [
      { user_id: U(1), share_cents: 500 },
      { user_id: U(2), share_cents: 500 },
    ],
  };

  it("accepts exact-sum shares", () => {
    expect(ExpenseCreateSchema.parse(valid).amount_cents).toBe(1000);
  });

  it("rejects shares summing ≠ amount (off by one cent)", () => {
    expect(
      ExpenseCreateSchema.safeParse({
        ...valid,
        shares: [
          { user_id: U(1), share_cents: 500 },
          { user_id: U(2), share_cents: 499 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate share users (PK mirror)", () => {
    expect(
      ExpenseCreateSchema.safeParse({
        ...valid,
        shares: [
          { user_id: U(1), share_cents: 500 },
          { user_id: U(1), share_cents: 500 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects float amounts and float shares (Law #2)", () => {
    expect(ExpenseCreateSchema.safeParse({ ...valid, amount_cents: 1000.5 }).success).toBe(false);
    expect(
      ExpenseCreateSchema.safeParse({
        ...valid,
        shares: [{ user_id: U(1), share_cents: 1000.0000001 }],
      }).success,
    ).toBe(false);
  });

  it("requires the FX pair together (R-money-6)", () => {
    expect(ExpenseCreateSchema.safeParse({ ...valid, fx_rate: "0.0067" }).success).toBe(false);
    expect(ExpenseCreateSchema.safeParse({ ...valid, base_amount_cents: 670 }).success).toBe(false);
    const withPair = ExpenseCreateSchema.parse({
      ...valid,
      fx_rate: "0.0067",
      base_amount_cents: 7,
      shares: valid.shares,
    });
    expect(withPair.fx_rate).toBe("0.0067");
  });

  it("fx_rate is a decimal STRING — floats/zero rejected", () => {
    expect(FxRateSchema.safeParse("0.00670000").success).toBe(true);
    expect(FxRateSchema.safeParse("142.51").success).toBe(true);
    expect(FxRateSchema.safeParse("0").success).toBe(false);
    expect(FxRateSchema.safeParse("0.0").success).toBe(false);
    expect(FxRateSchema.safeParse(0.0067).success).toBe(false);
    expect(FxRateSchema.safeParse("1e-3").success).toBe(false);
  });
});

describe("ExpenseUpdate coupling rule", () => {
  it("amount without shares → rejected", () => {
    expect(ExpenseUpdateSchema.safeParse({ amount_cents: 500 }).success).toBe(false);
  });
  it("shares-only body is allowed (server checks against stored amount)", () => {
    expect(
      ExpenseUpdateSchema.safeParse({ shares: [{ user_id: U(1), share_cents: 500 }] }).success,
    ).toBe(true);
  });
  it("amount + shares must still sum", () => {
    expect(
      ExpenseUpdateSchema.safeParse({
        amount_cents: 500,
        shares: [{ user_id: U(1), share_cents: 499 }],
      }).success,
    ).toBe(false);
  });
});

describe("SettlementCreate", () => {
  it("rejects self-settlement", () => {
    expect(
      SettlementCreateSchema.safeParse({
        from_user_id: U(1),
        to_user_id: U(1),
        amount_cents: 100,
        currency: "USD",
        method: "venmo",
      }).success,
    ).toBe(false);
  });
  it("rejects zero/negative amounts (PositiveCents)", () => {
    expect(
      SettlementCreateSchema.safeParse({
        from_user_id: U(1),
        to_user_id: U(2),
        amount_cents: 0,
        currency: "USD",
        method: "cash",
      }).success,
    ).toBe(false);
  });
});
