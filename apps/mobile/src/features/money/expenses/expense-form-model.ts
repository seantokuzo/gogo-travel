/**
 * Add/edit expense form model (T-9.6 / CMON-3 — client money spec
 * R-cmoney-7..12, §2.4). PURE logic — the component renders what this
 * decides, tests pin it without a renderer.
 *
 * LAW #2 — no float ever holds money, including intermediates:
 * - amounts parse through the SHARED `parseMoneyToCents` (integer string
 *   math, ISO-4217 minor-unit aware) and format through `centsToMoneyText`;
 * - split math is the SHARED `computeShares` (BigInt largest-remainder —
 *   THE pinned §3.3 algorithm, identical client preview and server checks);
 * - percent entry is integer BASIS POINTS ("33.33" → 3333 — 2dp = bp,
 *   R-cmoney-9), parsed with the same split-integer-parts technique;
 * - the FX base amount derives via exact BigInt rationals from the rate
 *   STRING (never `parseFloat`), half-up — which lands inside the server's
 *   floor/ceil acceptance window (`apps/server/src/expenses/fx.ts` pins
 *   "consistent" as floor ≤ base ≤ ceil of the exact rational).
 *
 * FX direction (R-cmoney-10; server fx.ts + provider.ts pin it):
 * `fx_rate` is `currency → base` in MAJOR units — exactly what
 * `GET /fx/rate?base=<logged currency>&quote=<trip base>` returns; the
 * fetched string is captured verbatim, manual override always allowed.
 */
import {
  BOOKING_TO_EXPENSE_CATEGORY,
  centsToMoneyText,
  computeShares,
  EXPENSE_CATEGORIES,
  FxRateSchema,
  minorUnitDigits,
  parseMoneyToCents,
  type BookingCategory,
  type Expense,
  type ExpenseCategory,
  type ISODate,
  type ShareAllocation,
} from "@gogo/shared";

import { moneyLabel } from "../money-format";

// ---------------------------------------------------------------------------
// Category labels (R-cmoney-4: the list derives from the SHARED enum — the
// Record shape makes a missing label a compile error when the enum grows)
// ---------------------------------------------------------------------------

export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  lodging: "Lodging",
  transport: "Transport",
  food: "Food",
  activities: "Activities",
  shopping: "Shopping",
  other: "Other",
};

/** Chips render in canonical tuple order (R-cmoney-4). */
export const EXPENSE_CATEGORY_OPTIONS = EXPENSE_CATEGORIES;

// ---------------------------------------------------------------------------
// Split state + evaluation (R-cmoney-9, §2.4)
// ---------------------------------------------------------------------------

export const SPLIT_TYPES = ["equal", "exact", "percent", "shares"] as const;
export type SplitType = (typeof SPLIT_TYPES)[number];

export const SPLIT_TYPE_LABELS: Readonly<Record<SplitType, string>> = {
  equal: "Equal",
  exact: "Exact",
  percent: "Percent",
  shares: "Shares",
};

/**
 * The split editor's state. `participants` is the toggled-IN set (§2.4:
 * toggling a member out makes their share ABSENT, not zero — zero-share
 * rows are only produced by explicit `exact` entry). Per-member entry maps
 * keep values for every member ever touched; only active participants'
 * entries count.
 */
export interface SplitFormState {
  type: SplitType;
  participants: string[];
  /** exact: per-member amount TEXT, parsed against the LOGGED currency. */
  exactText: Record<string, string>;
  /** percent: per-member percent TEXT (2dp = basis points). */
  percentText: Record<string, string>;
  /** shares: per-member integer weight ≥ 1 (stepper-bounded). */
  weights: Record<string, number>;
}

export function emptySplitState(participants: readonly string[]): SplitFormState {
  return {
    type: "equal",
    participants: [...participants],
    exactText: {},
    percentText: {},
    weights: {},
  };
}

/** Percent text → integer basis points; empty = 0 bp; malformed = null. */
export function parsePercentToBp(text: string): number | null {
  if (text.trim() === "") return 0;
  const match = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Integer bp → display text ("9850" → "98.5") — integer math + strings only. */
export function bpToPercentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export interface SplitEvaluation {
  /** Save-gating validity (R-cmoney-7/9: resolved shares sum exactly). */
  ok: boolean;
  /** Resolved per-member preview via the shared algorithm; empty when !ok. */
  shares: ShareAllocation[];
  /** Live readout under the editor (§2.4 validation states); null = quiet. */
  readout: string | null;
}

const invalid = (readout: string | null): SplitEvaluation => ({ ok: false, shares: [], readout });

/**
 * Evaluate the split live (every keystroke — §2.4): resolved preview from
 * the shared `computeShares`, plus the per-type validation readout. A null
 * `amountCents` (unparsed/empty amount) is quiet here — the amount field
 * owns that error.
 */
export function evaluateSplit(
  amountCents: number | null,
  currency: string,
  split: SplitFormState,
): SplitEvaluation {
  const active = split.participants;
  if (active.length === 0) return invalid("Add at least one person to the split.");
  if (amountCents === null || amountCents <= 0) return invalid(null);

  try {
    switch (split.type) {
      case "equal": {
        return {
          ok: true,
          shares: computeShares(amountCents, { type: "equal", participants: active }),
          readout: null,
        };
      }
      case "exact": {
        const entries: { user_id: string; share_cents: number }[] = [];
        let sum = 0;
        for (const userId of active) {
          const text = split.exactText[userId] ?? "";
          if (text.trim() === "") {
            entries.push({ user_id: userId, share_cents: 0 });
            continue;
          }
          const parsed = parseMoneyToCents(text, currency);
          if (!parsed.ok) return invalid("Check the amounts — plain numbers like 12.50.");
          entries.push({ user_id: userId, share_cents: parsed.cents });
          sum += parsed.cents;
        }
        const remaining = amountCents - sum;
        if (remaining > 0) return invalid(`Remaining: ${moneyLabel(remaining, currency)}`);
        if (remaining < 0) return invalid(`Over by ${moneyLabel(-remaining, currency)}`);
        return {
          ok: true,
          shares: computeShares(amountCents, { type: "exact", participants: entries }),
          readout: `Remaining: ${moneyLabel(0, currency)}`,
        };
      }
      case "percent": {
        const entries: { user_id: string; percent_bp: number }[] = [];
        let sumBp = 0;
        for (const userId of active) {
          const bp = parsePercentToBp(split.percentText[userId] ?? "");
          if (bp === null) return invalid("Check the percentages — numbers like 33.33.");
          entries.push({ user_id: userId, percent_bp: bp });
          sumBp += bp;
        }
        if (sumBp !== 10000) {
          return invalid(`Sum: ${bpToPercentText(sumBp)}% — needs 100%`);
        }
        return {
          ok: true,
          shares: computeShares(amountCents, { type: "percent", participants: entries }),
          readout: "Sum: 100%",
        };
      }
      case "shares": {
        const entries = active.map((userId) => ({
          user_id: userId,
          weight: split.weights[userId] ?? 1,
        }));
        return {
          ok: true,
          shares: computeShares(amountCents, { type: "shares", participants: entries }),
          readout: null,
        };
      }
    }
  } catch {
    // computeShares guards (dup ids, bad weights, …) — pre-checks above make
    // this unreachable in practice; degrade to a quiet invalid, never throw
    // out of a render.
    return invalid("This split doesn't add up.");
  }
}

// ---------------------------------------------------------------------------
// FX derivation (R-cmoney-10; server fx.ts consistency window)
// ---------------------------------------------------------------------------

const RATE_RE = /^(\d{1,10})(?:\.(\d{1,8}))?$/;

/**
 * `amount_cents × rate × 10^(minorDigits(base) − minorDigits(currency))`,
 * half-up over exact BigInt rationals — half-up is always the floor or the
 * ceiling of the exact value, so the derived pair passes the server's
 * R-money-6 consistency check by construction. Returns null when the rate
 * text is not a valid positive `FxRate` string or the result leaves the
 * `PositiveCents` domain (0 or unsafe).
 */
export function deriveBaseAmountCents(
  amountCents: number,
  rateText: string,
  currency: string,
  baseCurrency: string,
): number | null {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  if (!FxRateSchema.safeParse(rateText).success) return null;
  const match = RATE_RE.exec(rateText);
  if (match === null) return null;
  const whole = match[1] as string;
  const frac = match[2] ?? "";
  let num = BigInt(amountCents) * BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  const exponentDiff = minorUnitDigits(baseCurrency) - minorUnitDigits(currency);
  if (exponentDiff >= 0) {
    num *= 10n ** BigInt(exponentDiff);
  } else {
    den *= 10n ** BigInt(-exponentDiff);
  }
  const floor = num / den;
  const remainder = num % den;
  const rounded = remainder * 2n >= den ? floor + 1n : floor;
  if (rounded <= 0n || rounded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(rounded);
}

// ---------------------------------------------------------------------------
// Edit-mode seeding (R-cmoney-12) + equal-split detection
// ---------------------------------------------------------------------------

/**
 * Stored shares match the canonical equal split over the same member set
 * (the §3.3 algorithm's own ±1-cent remainder placement IS the "remainder
 * tolerance" — R-cmoney-12's detectability clause).
 */
export function isEquallySplit(
  amountCents: number,
  shares: readonly { user_id: string; share_cents: number }[],
): boolean {
  if (shares.length === 0 || amountCents <= 0) return false;
  try {
    const equal = computeShares(amountCents, {
      type: "equal",
      participants: shares.map((s) => s.user_id),
    });
    const byUser = new Map(equal.map((s) => [s.user_id, s.share_cents]));
    return shares.every((s) => byUser.get(s.user_id) === s.share_cents);
  } catch {
    return false;
  }
}

/**
 * Order-independent share-set equality — the edit form's "did the split
 * actually change" check (a PATCH resends `shares` ONLY when it did:
 * R-money-5 validates INCOMING ids against current members, so an untouched
 * legacy split naming an ex-member must ride through by omission).
 */
export function sameShareSets(
  a: readonly { user_id: string; share_cents: number }[],
  b: readonly { user_id: string; share_cents: number }[],
): boolean {
  if (a.length !== b.length) return false;
  const byUser = new Map(a.map((share) => [share.user_id, share.share_cents]));
  return b.every((share) => byUser.get(share.user_id) === share.share_cents);
}

export interface ExpenseFormSeed {
  description: string;
  amountText: string;
  currencyText: string;
  category: ExpenseCategory;
  payerId: string;
  spentAt: ISODate;
  split: SplitFormState;
  /** R-cmoney-12: equal-detectable edits show a "Split equally" hint. */
  equallySplit: boolean;
  /** "" = no FX pair stored. */
  fxRateText: string;
  bookingId: string | null;
}

/**
 * Prefill an edit from the stored expense (R-cmoney-12): every field, split
 * editor opened in `exact` mode with the current shares (resolved cents are
 * all v1 persists — R-money-29).
 */
export function editSeedFromExpense(expense: Expense): ExpenseFormSeed {
  const exactText: Record<string, string> = {};
  for (const share of expense.shares) {
    exactText[share.user_id] = centsToMoneyText(share.share_cents, expense.currency);
  }
  return {
    description: expense.description,
    amountText: centsToMoneyText(expense.amount_cents, expense.currency),
    currencyText: expense.currency,
    category: expense.category,
    payerId: expense.paid_by,
    spentAt: expense.spent_at,
    split: {
      type: "exact",
      participants: expense.shares.map((s) => s.user_id),
      exactText,
      percentText: {},
      weights: {},
    },
    equallySplit: isEquallySplit(expense.amount_cents, expense.shares),
    fxRateText: expense.fx_rate ?? "",
    bookingId: expense.booking_id,
  };
}

// ---------------------------------------------------------------------------
// Booking-link prefill (R-cmoney-11, §2.3 — mapping lives in @gogo/shared)
// ---------------------------------------------------------------------------

export interface BookingPrefillSource {
  title: string;
  category: BookingCategory;
  price_cents: number | null;
  currency: string | null;
}

export interface BookingPrefill {
  description: string;
  category: ExpenseCategory;
  /** null = booking has no price — leave the field alone. */
  amountText: string | null;
  /** Rides with the amount (a price without its currency corrupts meaning). */
  currencyText: string | null;
}

/** Prefill only — the user edits freely; the link persists as `booking_id`. */
export function bookingPrefill(booking: BookingPrefillSource): BookingPrefill {
  const prefill: BookingPrefill = {
    description: booking.title,
    category: BOOKING_TO_EXPENSE_CATEGORY[booking.category],
    amountText: null,
    currencyText: null,
  };
  if (booking.price_cents !== null && booking.currency !== null) {
    prefill.amountText = centsToMoneyText(booking.price_cents, booking.currency);
    prefill.currencyText = booking.currency;
  }
  return prefill;
}
