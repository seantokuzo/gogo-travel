/**
 * Expense form model (T-9.6 / CMON-3) — Law #2 pins for every money path:
 * split evaluation over the SHARED computeShares (per-type §2.4 validation
 * states + resolved-preview parity), basis-point percent parsing, the
 * BigInt FX base derivation (half-up inside the server's floor/ceil
 * window), equal-split detection, edit seeding, booking prefill (§2.3
 * mapping), and the changed-shares comparator that keeps ex-member history
 * PATCH-safe.
 *
 * Mutation map (which prod mutation each pin kills):
 * - exact remaining/over gates → gut the `remaining !== 0` branches in
 *   evaluateSplit ⇒ the underfunded/overfunded pins go RED
 * - half-up rounding → change `remainder * 2n >= den` to floor-always ⇒
 *   the "1.005 rounds up" pin goes RED
 * - percent Σ=10000 gate → drop the sum check ⇒ the 99.99% pin goes RED
 * - sameShareSets cents comparison → compare ids only ⇒ the changed-cents
 *   pin goes RED
 */
import { computeShares, EXPENSE_CATEGORIES } from "@gogo/shared";

import { MEMBER_B_ID, MEMBER_C_ID } from "@/test-utils/ids";
import { makeExpense } from "@/test-utils/money-fixtures";
import { TEST_USER } from "@/test-utils/session-fixtures";

import {
  bookingPrefill,
  bpToPercentText,
  deriveBaseAmountCents,
  editSeedFromExpense,
  emptySplitState,
  evaluateSplit,
  EXPENSE_CATEGORY_LABELS,
  isEquallySplit,
  parsePercentToBp,
  sameShareSets,
  type SplitFormState,
} from "./expense-form-model";

const ME = TEST_USER.id; // "0000…" — first in canonical user_id order
const B = MEMBER_B_ID; // "4444…"
const C = MEMBER_C_ID; // "5555…"

function split(overrides: Partial<SplitFormState>): SplitFormState {
  return { ...emptySplitState([ME, B]), ...overrides };
}

describe("evaluateSplit — equal", () => {
  it("resolves the shared largest-remainder allocation (odd cent → first user_id)", () => {
    const result = evaluateSplit(2551, "USD", split({}));
    expect(result.ok).toBe(true);
    expect(result.shares).toEqual([
      { user_id: ME, share_cents: 1276 },
      { user_id: B, share_cents: 1275 },
    ]);
    // Preview parity with the pinned §3.3 algorithm — same function, same
    // inputs, byte-identical output.
    expect(result.shares).toEqual(
      computeShares(2551, { type: "equal", participants: [ME, B] }),
    );
  });

  it("zero participants is invalid with the pick-someone readout", () => {
    const result = evaluateSplit(2550, "USD", split({ participants: [] }));
    expect(result.ok).toBe(false);
    expect(result.readout).toMatch(/at least one person/i);
  });

  it("an unparsed amount is quietly invalid (the amount field owns that error)", () => {
    const result = evaluateSplit(null, "USD", split({}));
    expect(result.ok).toBe(false);
    expect(result.readout).toBeNull();
    expect(result.shares).toEqual([]);
  });
});

describe("evaluateSplit — exact (§2.4 'remaining to allocate')", () => {
  it("underfunded shows the remaining readout and blocks", () => {
    const result = evaluateSplit(
      2550,
      "USD",
      split({ type: "exact", exactText: { [ME]: "21.00" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.readout).toBe("Remaining: USD 4.50");
    expect(result.shares).toEqual([]);
  });

  it("overfunded shows the over-by readout and blocks", () => {
    const result = evaluateSplit(
      2550,
      "USD",
      split({ type: "exact", exactText: { [ME]: "26.50" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.readout).toBe("Over by USD 1.00");
  });

  it("an exact-sum allocation resolves — empty entries are EXPLICIT zero rows (§2.4)", () => {
    const result = evaluateSplit(
      2550,
      "USD",
      split({ type: "exact", exactText: { [ME]: "25.50" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.readout).toBe("Remaining: USD 0.00");
    expect(result.shares).toEqual([
      { user_id: ME, share_cents: 2550 },
      { user_id: B, share_cents: 0 },
    ]);
  });

  it("malformed amount text blocks with the parse readout", () => {
    const result = evaluateSplit(
      2550,
      "USD",
      split({ type: "exact", exactText: { [ME]: "12.5.0", [B]: "1" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.readout).toMatch(/plain numbers/i);
  });

  it("parses against the LOGGED currency — JPY rejects decimals in a share", () => {
    const result = evaluateSplit(
      1500,
      "JPY",
      split({ type: "exact", exactText: { [ME]: "7.50", [B]: "750" } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("evaluateSplit — percent (2dp = basis points)", () => {
  it("99.99% shows the sum readout and blocks", () => {
    const result = evaluateSplit(
      10000,
      "USD",
      split({ type: "percent", percentText: { [ME]: "50", [B]: "49.99" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.readout).toBe("Sum: 99.99% — needs 100%");
  });

  it("a 100% sum resolves through computeShares (thirds — largest remainder)", () => {
    const state = split({
      participants: [ME, B, C],
      type: "percent",
      percentText: { [ME]: "33.34", [B]: "33.33", [C]: "33.33" },
    });
    const result = evaluateSplit(10000, "USD", state);
    expect(result.ok).toBe(true);
    expect(result.readout).toBe("Sum: 100%");
    const total = result.shares.reduce((acc, s) => acc + s.share_cents, 0);
    expect(total).toBe(10000);
    expect(result.shares).toEqual(
      computeShares(10000, {
        type: "percent",
        participants: [
          { user_id: ME, percent_bp: 3334 },
          { user_id: B, percent_bp: 3333 },
          { user_id: C, percent_bp: 3333 },
        ],
      }),
    );
  });

  it("malformed percent text blocks", () => {
    const result = evaluateSplit(
      10000,
      "USD",
      split({ type: "percent", percentText: { [ME]: "50x", [B]: "50" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.readout).toMatch(/percentages/i);
  });
});

describe("evaluateSplit — shares (integer weights)", () => {
  it("weights resolve 2:1 with the remainder placed deterministically", () => {
    const result = evaluateSplit(
      1000,
      "USD",
      split({ type: "shares", weights: { [ME]: 2, [B]: 1 } }),
    );
    expect(result.ok).toBe(true);
    expect(result.shares).toEqual([
      { user_id: ME, share_cents: 667 },
      { user_id: B, share_cents: 333 },
    ]);
  });

  it("untouched weights default to 1 (equal by weight)", () => {
    const result = evaluateSplit(1000, "USD", split({ type: "shares" }));
    expect(result.ok).toBe(true);
    expect(result.shares.map((s) => s.share_cents)).toEqual([500, 500]);
  });
});

describe("parsePercentToBp / bpToPercentText", () => {
  it("round-trips the 2dp basis-point grammar", () => {
    expect(parsePercentToBp("")).toBe(0);
    expect(parsePercentToBp("12")).toBe(1200);
    expect(parsePercentToBp("12.5")).toBe(1250);
    expect(parsePercentToBp("12,55")).toBe(1255);
    expect(parsePercentToBp("abc")).toBeNull();
    expect(parsePercentToBp("12.555")).toBeNull();
    expect(bpToPercentText(10000)).toBe("100");
    expect(bpToPercentText(9850)).toBe("98.5");
    expect(bpToPercentText(9805)).toBe("98.05");
  });
});

describe("deriveBaseAmountCents (Law #2 — BigInt rationals, half-up)", () => {
  it("2dp → 2dp: EUR 100.00 × 1.08 → 10800 base cents", () => {
    expect(deriveBaseAmountCents(10000, "1.08", "EUR", "USD")).toBe(10800);
  });

  it("0dp → 2dp exponent lift: JPY 1500 × 0.0067 → 1005 cents", () => {
    expect(deriveBaseAmountCents(1500, "0.0067", "JPY", "USD")).toBe(1005);
  });

  it("2dp → 0dp exponent drop: USD 25.50 × 147.5 → 3761 yen (fraction floored)", () => {
    expect(deriveBaseAmountCents(2550, "147.5", "USD", "JPY")).toBe(3761);
  });

  it("half-up at exactly .5 — the floor-mutation killer", () => {
    // 100 × 1.005 = 100.5 exactly: half-up ⇒ 101 (floor would say 100).
    expect(deriveBaseAmountCents(100, "1.005", "USD", "EUR")).toBe(101);
  });

  it("result always lands in the server's floor/ceil consistency window", () => {
    // 3761.25 exact: floor 3761, ceil 3762 — half-up picked 3761 (≤ .5 down).
    const derived = deriveBaseAmountCents(2550, "147.5", "USD", "JPY");
    expect([3761, 3762]).toContain(derived);
  });

  it("rejects invalid rates and out-of-domain results", () => {
    expect(deriveBaseAmountCents(2550, "", "EUR", "USD")).toBeNull();
    expect(deriveBaseAmountCents(2550, "0", "EUR", "USD")).toBeNull();
    expect(deriveBaseAmountCents(2550, "1.2e3", "EUR", "USD")).toBeNull();
    // Rounds to zero base cents — not a PositiveCents, so unusable.
    expect(deriveBaseAmountCents(1, "0.001", "USD", "EUR")).toBeNull();
    expect(deriveBaseAmountCents(0, "1.08", "EUR", "USD")).toBeNull();
    expect(deriveBaseAmountCents(25.5, "1.08", "EUR", "USD")).toBeNull();
  });
});

describe("isEquallySplit (R-cmoney-12 detectability)", () => {
  it("detects the canonical equal allocation, remainder placement included", () => {
    const shares = computeShares(2551, { type: "equal", participants: [ME, B] });
    expect(isEquallySplit(2551, shares)).toBe(true);
  });

  it("rejects a skewed allocation and the empty set", () => {
    expect(
      isEquallySplit(2550, [
        { user_id: ME, share_cents: 2000 },
        { user_id: B, share_cents: 550 },
      ]),
    ).toBe(false);
    expect(isEquallySplit(2550, [])).toBe(false);
  });
});

describe("sameShareSets (the ex-member PATCH guard's comparator)", () => {
  const shares = [
    { user_id: ME, share_cents: 1275 },
    { user_id: B, share_cents: 1275 },
  ];

  it("is order-independent", () => {
    expect(sameShareSets(shares, [...shares].reverse())).toBe(true);
  });

  it("catches changed cents and changed membership", () => {
    expect(
      sameShareSets(shares, [
        { user_id: ME, share_cents: 1276 },
        { user_id: B, share_cents: 1274 },
      ]),
    ).toBe(false);
    expect(sameShareSets(shares, [{ user_id: ME, share_cents: 2550 }])).toBe(false);
  });
});

describe("editSeedFromExpense (R-cmoney-12)", () => {
  it("prefills every field and opens the split editor in exact mode", () => {
    const expense = makeExpense();
    const seed = editSeedFromExpense(expense);
    expect(seed.description).toBe("Dinner at Menya");
    expect(seed.amountText).toBe("25.50");
    expect(seed.currencyText).toBe("USD");
    expect(seed.category).toBe("food");
    expect(seed.payerId).toBe(ME);
    expect(seed.spentAt).toBe("2026-08-28");
    expect(seed.split.type).toBe("exact");
    expect(seed.split.participants).toEqual([ME, B]);
    expect(seed.split.exactText).toEqual({ [ME]: "12.75", [B]: "12.75" });
    expect(seed.equallySplit).toBe(true);
    expect(seed.fxRateText).toBe("");
    expect(seed.bookingId).toBeNull();
  });

  it("seeds a stored FX pair's rate string verbatim and JPY whole-unit texts", () => {
    const expense = makeExpense({
      amount_cents: 1500,
      currency: "JPY",
      fx_rate: "0.00670000",
      base_amount_cents: 1005,
      effective_base_cents: 1005,
      shares: [
        { user_id: ME, share_cents: 750 },
        { user_id: B, share_cents: 750 },
      ],
    });
    const seed = editSeedFromExpense(expense);
    expect(seed.amountText).toBe("1500");
    expect(seed.split.exactText).toEqual({ [ME]: "750", [B]: "750" });
    expect(seed.fxRateText).toBe("0.00670000");
  });
});

describe("bookingPrefill (§2.3 — the shared mapping, prefill only)", () => {
  it("maps categories through BOOKING_TO_EXPENSE_CATEGORY and formats the price", () => {
    expect(
      bookingPrefill({
        title: "UA 837",
        category: "flight",
        price_cents: 45000,
        currency: "USD",
      }),
    ).toEqual({
      description: "UA 837",
      category: "transport",
      amountText: "450.00",
      currencyText: "USD",
    });
    expect(
      bookingPrefill({ title: "Park Hyatt", category: "lodging", price_cents: null, currency: null })
        .amountText,
    ).toBeNull();
  });

  it("a priced booking with no stored currency leaves the amount alone (meaningless digits)", () => {
    const prefill = bookingPrefill({
      title: "Onsen",
      category: "activity",
      price_cents: 8000,
      currency: null,
    });
    expect(prefill.amountText).toBeNull();
    expect(prefill.currencyText).toBeNull();
    expect(prefill.category).toBe("activities");
  });
});

it("EXPENSE_CATEGORY_LABELS covers the full shared taxonomy (R-cmoney-4)", () => {
  for (const category of EXPENSE_CATEGORIES) {
    expect(EXPENSE_CATEGORY_LABELS[category]).toEqual(expect.any(String));
  }
});
