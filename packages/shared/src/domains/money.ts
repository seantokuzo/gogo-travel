/**
 * Money domain (contracts spec §3.4 `money.ts`; schema spec §3.3.12–15,
 * §3.3.25; money spec §3.2–3.5).
 *
 * Law #2: money is integer cents, floats fail validation — including
 * intermediates: all split/allocation arithmetic below is integer (BigInt)
 * math with exact rational remainder comparison, never floating point.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
import {
  EXPENSE_CATEGORIES,
  ExpenseCategorySchema,
  RequestStatusSchema,
  SettlementMethodSchema,
} from "../enums.js";
import {
  CentsSchema,
  CurrencyCodeSchema,
  ISODateSchema,
  ISODateTimeSchema,
  PositiveCentsSchema,
  UuidSchema,
} from "../scalars.js";
import { UserProfileSchema } from "./user.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A share as it travels on the wire, embedded in its expense (R-db-2). */
export const ExpenseShareSchema = z.object({
  user_id: UuidSchema,
  /** ≥ 0 — a zero share is legal (payer covered someone entirely). */
  share_cents: CentsSchema,
});
export type ExpenseShare = z.infer<typeof ExpenseShareSchema>;

/** `numeric(18,8)` on the wire as a decimal STRING — never a float (Law #2). */
export const FxRateSchema = z.string().regex(/^(?!0+(?:\.0+)?$)\d{1,10}(\.\d{1,8})?$/, {
  message: "fx_rate must be a positive decimal string (≤8 fraction digits)",
});
export type FxRate = z.infer<typeof FxRateSchema>;

/**
 * Caps on the client-writable (request-direction) shapes — the booking.ts /
 * T-6.1 convention (PR #28 R1): name-like free text 200, notes-like prose
 * 2000, arrays bounded by named consts. Entity schemas (server-generated
 * responses) stay uncapped, same as bookings.
 */
const ExpenseDescriptionSchema = z.string().trim().min(1).max(200);
const optionalNote = z.string().max(2000).optional();
/**
 * Share-rows bound (PR #28 R1). No trip-members cap exists anywhere in
 * shared to inherit, so 50 is the headroom pick (interpretation — recorded
 * in the PR): shares are one row per participating member and real groups
 * top out far below it.
 */
export const MAX_EXPENSE_SHARES = 50;
/**
 * PR #11 R2 landmine parity (booking.ts `localTime`): `z.iso.datetime`
 * places NO bound on fractional seconds — a multi-MB "datetime" parses
 * valid. 64 chars fits every real offset+microseconds datetime with slack;
 * the cap is LOCAL (the shared scalar stays uncapped — its other uses are
 * server-generated, never client-writable).
 */
const boundedDateTime = ISODateTimeSchema.max(64);

const sharesSumRule = (
  val: {
    amount_cents?: number | undefined;
    shares?: readonly { user_id: string; share_cents: number }[] | undefined;
  },
  ctx: z.core.$RefinementCtx,
): void => {
  if (!val.shares) return;
  const seen = new Set<string>();
  for (const share of val.shares) {
    const key = share.user_id.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate share user_id '${share.user_id}'`,
        path: ["shares"],
      });
      return;
    }
    seen.add(key);
  }
  if (val.amount_cents === undefined) return;
  const sum = val.shares.reduce((acc, s) => acc + s.share_cents, 0);
  if (sum !== val.amount_cents) {
    ctx.addIssue({
      code: "custom",
      message: `shares must sum to amount_cents exactly (got ${sum}, expected ${val.amount_cents})`,
      path: ["shares"],
    });
  }
};

const fxPairRule = (
  val: { fx_rate?: string | null | undefined; base_amount_cents?: number | null | undefined },
  ctx: z.core.$RefinementCtx,
): void => {
  const hasRate = val.fx_rate !== undefined && val.fx_rate !== null;
  const hasBase = val.base_amount_cents !== undefined && val.base_amount_cents !== null;
  if (hasRate !== hasBase) {
    ctx.addIssue({
      code: "custom",
      message: "fx_rate and base_amount_cents must be provided together",
      path: [hasRate ? "base_amount_cents" : "fx_rate"],
    });
  }
};

/** The `expenses` row + embedded shares + computed effective base (money spec §3.2). */
export const ExpenseSchema = z
  .object({
    id: UuidSchema,
    trip_id: UuidSchema,
    description: z.string(),
    category: ExpenseCategorySchema,
    paid_by: UuidSchema,
    amount_cents: PositiveCentsSchema,
    /** As logged (spend-in-local-currency). */
    currency: CurrencyCodeSchema,
    /** Present exactly when currency ≠ trip base (R-db-20). */
    fx_rate: FxRateSchema.nullable(),
    base_amount_cents: PositiveCentsSchema.nullable(),
    booking_id: UuidSchema.nullable(),
    spent_at: ISODateSchema,
    created_by: UuidSchema,
    /** Soft delete + audit trail (R-db-21). */
    deleted_at: ISODateTimeSchema.nullable(),
    deleted_by: UuidSchema.nullable(),
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
    shares: z.array(ExpenseShareSchema),
    /** `base_amount_cents ?? amount_cents` — computed, in trip base currency. */
    effective_base_cents: CentsSchema,
  })
  .superRefine(sharesSumRule)
  .superRefine(fxPairRule);
export type Expense = z.infer<typeof ExpenseSchema>;

/**
 * `POST /trips/:tripId/expenses` — carries RESOLVED shares inline (the
 * atomic-write contract, R-db-2). Split-type math runs client-side through
 * `computeShares`; the server re-validates the sum invariant here.
 */
export const ExpenseCreateSchema = z
  .object({
    description: ExpenseDescriptionSchema,
    category: ExpenseCategorySchema,
    paid_by: UuidSchema,
    amount_cents: PositiveCentsSchema,
    currency: CurrencyCodeSchema,
    fx_rate: FxRateSchema.optional(),
    base_amount_cents: PositiveCentsSchema.optional(),
    booking_id: UuidSchema.optional(),
    /** Default: server CURRENT_DATE. */
    spent_at: ISODateSchema.optional(),
    shares: z.array(ExpenseShareSchema).max(MAX_EXPENSE_SHARES),
  })
  .superRefine(sharesSumRule)
  .superRefine(fxPairRule);
export type ExpenseCreate = z.infer<typeof ExpenseCreateSchema>;

/**
 * `PATCH …/expenses/:expenseId` — any create field optional, with the
 * coupling rule: `amount_cents` present ⇒ `shares` present. A shares-only
 * body is allowed iff it sums to the STORED amount (server-validated).
 */
export const ExpenseUpdateSchema = z
  .object({
    description: ExpenseDescriptionSchema.optional(),
    category: ExpenseCategorySchema.optional(),
    paid_by: UuidSchema.optional(),
    amount_cents: PositiveCentsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    fx_rate: FxRateSchema.nullable().optional(),
    base_amount_cents: PositiveCentsSchema.nullable().optional(),
    booking_id: UuidSchema.nullable().optional(),
    spent_at: ISODateSchema.optional(),
    shares: z.array(ExpenseShareSchema).max(MAX_EXPENSE_SHARES).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.amount_cents !== undefined && val.shares === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a body containing amount_cents must contain shares",
        path: ["shares"],
      });
    }
  })
  .superRefine(sharesSumRule)
  .superRefine(fxPairRule);
export type ExpenseUpdate = z.infer<typeof ExpenseUpdateSchema>;

/** Record-only ledger entry (R-db-14) — immutable once written. */
export const SettlementSchema = z
  .object({
    id: UuidSchema,
    trip_id: UuidSchema,
    from_user_id: UuidSchema,
    to_user_id: UuidSchema,
    amount_cents: PositiveCentsSchema,
    /** Trip base currency by convention (R-money-13). */
    currency: CurrencyCodeSchema,
    /** Self-reported everywhere — no rail has webhooks. */
    method: SettlementMethodSchema,
    note: z.string().nullable(),
    settled_at: ISODateTimeSchema,
    created_by: UuidSchema,
    created_at: ISODateTimeSchema,
  })
  .superRefine(noSelfSettlement);
export type Settlement = z.infer<typeof SettlementSchema>;

function noSelfSettlement(
  val: { from_user_id: string; to_user_id: string },
  ctx: z.core.$RefinementCtx,
): void {
  if (val.from_user_id === val.to_user_id) {
    ctx.addIssue({
      code: "custom",
      message: "from_user_id and to_user_id must differ",
      path: ["to_user_id"],
    });
  }
}

/** `POST /trips/:tripId/settlements` (money spec §3.2). */
export const SettlementCreateSchema = z
  .object({
    from_user_id: UuidSchema,
    to_user_id: UuidSchema,
    amount_cents: PositiveCentsSchema,
    currency: CurrencyCodeSchema,
    method: SettlementMethodSchema,
    note: optionalNote,
    /** Default now; not future (server-enforced against its clock). */
    settled_at: boundedDateTime.optional(),
    /** Links + settles an open settle-request (R-money-18). */
    request_id: UuidSchema.optional(),
  })
  .superRefine(noSelfSettlement);
export type SettlementCreate = z.infer<typeof SettlementCreateSchema>;

/** One row per trip per category (schema spec §3.3.15). */
export const BudgetSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  category: ExpenseCategorySchema,
  /** null = no cap, estimate only. */
  cap_cents: CentsSchema.nullable(),
  ai_estimate_cents: CentsSchema.nullable(),
  ai_estimated_at: ISODateTimeSchema.nullable(),
  /** App invariant: equals `trips.base_currency`. */
  currency: CurrencyCodeSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type Budget = z.infer<typeof BudgetSchema>;

/**
 * Computed, never stored. One row per unordered pair
 * (`user_id < counterparty_id`); `net_cents` is explicitly SIGNED:
 * positive = counterparty owes user_id (the one documented exception to the
 * non-negative Cents convention — contracts spec §3.3).
 */
export const BalanceSchema = z.object({
  trip_id: UuidSchema,
  user_id: UuidSchema,
  counterparty_id: UuidSchema,
  net_cents: z.int(),
});
export type Balance = z.infer<typeof BalanceSchema>;

/** "Send the bill" request (schema spec §3.3.25; money spec §3.2 response shape). */
export const SettleRequestSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  /** Debtor being billed. */
  from_user_id: UuidSchema,
  /** Creditor = creator. */
  to_user_id: UuidSchema,
  amount_cents: PositiveCentsSchema,
  currency: CurrencyCodeSchema,
  note: z.string().nullable(),
  status: RequestStatusSchema,
  /** Derived: the billed debt no longer outstanding (R-money-18). */
  resolved: z.boolean(),
  settlement_id: UuidSchema.nullable(),
  created_by: UuidSchema,
  created_at: ISODateTimeSchema,
  /** `https://<domain>/t/<tripId>/request/<requestId>` — domain-agnostic format. */
  link: z.string(),
});
export type SettleRequest = z.infer<typeof SettleRequestSchema>;

export const SettleRequestCreateSchema = z.object({
  from_user_id: UuidSchema,
  /** Default: current pairwise debt from_user → caller. */
  amount_cents: PositiveCentsSchema.optional(),
  note: optionalNote,
});
export type SettleRequestCreate = z.infer<typeof SettleRequestCreateSchema>;

// ---------------------------------------------------------------------------
// Pure money math (money spec §3.3–3.5) — single implementation, used by the
// client's live preview, the server's authoritative computation, and tests.
// ---------------------------------------------------------------------------

export interface ShareAllocation {
  user_id: string;
  share_cents: number;
}

export type SplitSpec =
  | { type: "equal"; participants: readonly string[] }
  | { type: "percent"; participants: ReadonlyArray<{ user_id: string; percent_bp: number }> }
  | { type: "shares"; participants: ReadonlyArray<{ user_id: string; weight: number }> }
  | { type: "exact"; participants: ReadonlyArray<{ user_id: string; share_cents: number }> };

/** Canonical ordering everywhere in this module (money spec §3.3). */
function canonicalCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

function assertInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer (got ${value})`);
  }
}

function assertUniqueUsers(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toLowerCase();
    if (seen.has(key)) throw new RangeError(`duplicate participant user_id '${id}'`);
    seen.add(key);
  }
}

/**
 * Largest-remainder core (money spec §3.3): `base_i = floor(quota_i)`;
 * leftover cents go +1 each to the largest fractional remainders, ties by
 * `user_id` ascending. Exact rational comparison via BigInt `num/den` —
 * Law #2 applies to intermediates too.
 */
function allocateLargestRemainder(
  total: bigint,
  quotas: ReadonlyArray<{ user_id: string; num: bigint; den: bigint }>,
): ShareAllocation[] {
  const rows = quotas.map((q) => ({
    user_id: q.user_id,
    base: q.num / q.den,
    remainder: q.num % q.den,
  }));
  let leftover = total - rows.reduce((acc, r) => acc + r.base, 0n);
  const byRemainder = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return canonicalCompare(a.user_id, b.user_id);
  });
  const bonus = new Map<string, bigint>();
  for (const row of byRemainder) {
    if (leftover <= 0n) break;
    bonus.set(row.user_id, 1n);
    leftover -= 1n;
  }
  /* istanbul ignore next -- structurally impossible: 0 ≤ leftover < n */
  if (leftover !== 0n) throw new RangeError("largest-remainder allocation did not converge");
  return rows.map((r) => ({
    user_id: r.user_id,
    share_cents: Number(r.base + (bonus.get(r.user_id) ?? 0n)),
  }));
}

/**
 * THE pinned split algorithm (money spec §3.3). Deterministic: participants
 * are sorted ascending by canonical lowercase `user_id`; all arithmetic is
 * integer; `Σ share_cents = amount_cents` exactly (R-money-3).
 *
 * Throws `RangeError` on invalid input: non-positive amount, empty/duplicate
 * participants, percent bp not summing to exactly 10000, weights < 1, exact
 * shares not summing to the amount.
 */
export function computeShares(amount_cents: number, split: SplitSpec): ShareAllocation[] {
  assertInt(amount_cents, "amount_cents");
  if (amount_cents <= 0) throw new RangeError(`amount_cents must be > 0 (got ${amount_cents})`);
  const A = BigInt(amount_cents);

  switch (split.type) {
    case "equal": {
      if (split.participants.length === 0)
        throw new RangeError("at least one participant is required");
      // Exact duplicates throw exactly like case-insensitive ones do — the
      // same duplicate semantics as the other three split types.
      assertUniqueUsers(split.participants);
      const sorted = [...split.participants].sort(canonicalCompare);
      const n = BigInt(sorted.length);
      return allocateLargestRemainder(
        A,
        sorted.map((user_id) => ({ user_id, num: A, den: n })),
      );
    }
    case "percent": {
      if (split.participants.length === 0)
        throw new RangeError("at least one participant is required");
      assertUniqueUsers(split.participants.map((p) => p.user_id));
      let sumBp = 0;
      for (const p of split.participants) {
        assertInt(p.percent_bp, "percent_bp");
        if (p.percent_bp < 0) throw new RangeError("percent_bp must be ≥ 0");
        sumBp += p.percent_bp;
      }
      if (sumBp !== 10000)
        throw new RangeError(`percent_bp must sum to exactly 10000 (got ${sumBp})`);
      const sorted = [...split.participants].sort((a, b) => canonicalCompare(a.user_id, b.user_id));
      return allocateLargestRemainder(
        A,
        sorted.map((p) => ({ user_id: p.user_id, num: A * BigInt(p.percent_bp), den: 10000n })),
      );
    }
    case "shares": {
      if (split.participants.length === 0)
        throw new RangeError("at least one participant is required");
      assertUniqueUsers(split.participants.map((p) => p.user_id));
      let totalWeight = 0;
      for (const p of split.participants) {
        assertInt(p.weight, "weight");
        if (p.weight < 1) throw new RangeError("weight must be an integer ≥ 1");
        totalWeight += p.weight;
      }
      const W = BigInt(totalWeight);
      const sorted = [...split.participants].sort((a, b) => canonicalCompare(a.user_id, b.user_id));
      return allocateLargestRemainder(
        A,
        sorted.map((p) => ({ user_id: p.user_id, num: A * BigInt(p.weight), den: W })),
      );
    }
    case "exact": {
      if (split.participants.length === 0)
        throw new RangeError("at least one participant is required");
      assertUniqueUsers(split.participants.map((p) => p.user_id));
      let sum = 0;
      for (const p of split.participants) {
        assertInt(p.share_cents, "share_cents");
        if (p.share_cents < 0) throw new RangeError("share_cents must be ≥ 0");
        sum += p.share_cents;
      }
      if (sum !== amount_cents)
        throw new RangeError(
          `exact shares must sum to amount_cents (got ${sum}, expected ${amount_cents})`,
        );
      return [...split.participants]
        .sort((a, b) => canonicalCompare(a.user_id, b.user_id))
        .map((p) => ({ user_id: p.user_id, share_cents: p.share_cents }));
    }
  }
}

/**
 * Proportional allocation by non-negative integer weights via the same
 * largest-remainder method — used to allocate `base_amount_cents` across an
 * expense's shares (quota `B·share_i/A`, money spec §3.4 step 2). Unlike
 * `computeShares('shares')`, zero weights are legal here.
 */
export function allocateProportional(
  total_cents: number,
  weights: ReadonlyArray<{ user_id: string; weight: number }>,
): ShareAllocation[] {
  assertInt(total_cents, "total_cents");
  if (total_cents < 0) throw new RangeError("total_cents must be ≥ 0");
  if (weights.length === 0) throw new RangeError("at least one weight is required");
  assertUniqueUsers(weights.map((w) => w.user_id));
  let totalWeight = 0;
  for (const w of weights) {
    assertInt(w.weight, "weight");
    if (w.weight < 0) throw new RangeError("weight must be ≥ 0");
    totalWeight += w.weight;
  }
  if (totalWeight === 0) throw new RangeError("total weight must be > 0");
  const T = BigInt(total_cents);
  const W = BigInt(totalWeight);
  const sorted = [...weights].sort((a, b) => canonicalCompare(a.user_id, b.user_id));
  return allocateLargestRemainder(
    T,
    sorted.map((w) => ({ user_id: w.user_id, num: T * BigInt(w.weight), den: W })),
  );
}

// ---------------------------------------------------------------------------
// Balance computation (money spec §3.4)
// ---------------------------------------------------------------------------

export interface ExpenseForBalance {
  paid_by: string;
  amount_cents: number;
  /** Present when the expense currency ≠ trip base (R-money-6). */
  base_amount_cents?: number | null;
  /** Soft-deleted expenses are excluded from balance math (R-db-21). */
  deleted_at?: string | null;
  shares: ReadonlyArray<{ user_id: string; share_cents: number }>;
}

export interface SettlementForBalance {
  from_user_id: string;
  to_user_id: string;
  amount_cents: number;
}

export interface MemberNet {
  user_id: string;
  /** Signed; positive = is owed. `Σ net_cents = 0` always. */
  net_cents: number;
}

export interface PairwiseNet {
  user_id: string;
  counterparty_id: string;
  /** Signed; positive = counterparty owes user_id. */
  net_cents: number;
}

/**
 * Per-trip balances in trip base currency, computed on read (R-money-8/9) —
 * the server is the authoritative executor; the client may reuse it for
 * optimistic display. Deterministic across row orderings.
 */
export function computeBalances(
  expenses: readonly ExpenseForBalance[],
  settlements: readonly SettlementForBalance[],
): { members: MemberNet[]; pairwise: PairwiseNet[] } {
  /** debt.get(a)?.get(b) = cents a owes b. */
  const debt = new Map<string, Map<string, number>>();
  const users = new Set<string>();
  const addDebt = (from: string, to: string, cents: number): void => {
    users.add(from);
    users.add(to);
    if (cents === 0 || from === to) return;
    let row = debt.get(from);
    if (!row) {
      row = new Map<string, number>();
      debt.set(from, row);
    }
    row.set(to, (row.get(to) ?? 0) + cents);
  };
  const getDebt = (from: string, to: string): number => debt.get(from)?.get(to) ?? 0;

  for (const expense of expenses) {
    if (expense.deleted_at != null) continue;
    users.add(expense.paid_by);
    for (const share of expense.shares) users.add(share.user_id);

    const base = expense.base_amount_cents ?? expense.amount_cents;
    let baseShares: ReadonlyArray<{ user_id: string; share_cents: number }>;
    if (base === expense.amount_cents) {
      baseShares = expense.shares;
    } else {
      // Allocate the base amount proportionally by share_cents (§3.4 step 2).
      baseShares = allocateProportional(
        base,
        expense.shares.map((s) => ({ user_id: s.user_id, weight: s.share_cents })),
      );
    }
    for (const share of baseShares) {
      if (share.user_id !== expense.paid_by) {
        addDebt(share.user_id, expense.paid_by, share.share_cents);
      }
    }
  }

  // A settlement (f → t, a) offsets f's debt to t: debt[t→f] += a (§3.4 step 3).
  for (const settlement of settlements) {
    addDebt(settlement.to_user_id, settlement.from_user_id, settlement.amount_cents);
  }

  const sortedUsers = [...users].sort(canonicalCompare);

  const members: MemberNet[] = sortedUsers.map((user) => {
    let net = 0;
    for (const other of sortedUsers) {
      if (other === user) continue;
      net += getDebt(other, user) - getDebt(user, other);
    }
    return { user_id: user, net_cents: net };
  });

  const pairwise: PairwiseNet[] = [];
  for (let i = 0; i < sortedUsers.length; i += 1) {
    for (let j = i + 1; j < sortedUsers.length; j += 1) {
      const u = sortedUsers[i] as string;
      const v = sortedUsers[j] as string;
      const net = getDebt(v, u) - getDebt(u, v);
      if (net !== 0) pairwise.push({ user_id: u, counterparty_id: v, net_cents: net });
    }
  }

  return { members, pairwise };
}

// ---------------------------------------------------------------------------
// Debt simplification (money spec §3.5)
// ---------------------------------------------------------------------------

export interface SettlementTransfer {
  from_user_id: string;
  to_user_id: string;
  amount_cents: number;
}

/**
 * Greedy max-matching over net positions: ≤ `members − 1` transfers, every
 * member's net preserved exactly, integer-only, deterministic (R-money-10).
 * Display/suggestion only — settlements are always recorded against the real
 * paying pair.
 */
export function simplifyDebts(members: readonly MemberNet[]): SettlementTransfer[] {
  let sum = 0;
  for (const m of members) {
    assertInt(m.net_cents, "net_cents");
    sum += m.net_cents;
  }
  if (sum !== 0) throw new RangeError(`member nets must sum to 0 (got ${sum})`);

  const debtors = members
    .filter((m) => m.net_cents < 0)
    .map((m) => ({ user_id: m.user_id, remaining: -m.net_cents }));
  const creditors = members
    .filter((m) => m.net_cents > 0)
    .map((m) => ({ user_id: m.user_id, remaining: m.net_cents }));

  const takeLargest = (
    list: Array<{ user_id: string; remaining: number }>,
  ): { user_id: string; remaining: number } => {
    let best = list[0] as { user_id: string; remaining: number };
    for (const entry of list) {
      if (
        entry.remaining > best.remaining ||
        (entry.remaining === best.remaining && canonicalCompare(entry.user_id, best.user_id) < 0)
      ) {
        best = entry;
      }
    }
    return best;
  };

  const transfers: SettlementTransfer[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    const debtor = takeLargest(debtors);
    const creditor = takeLargest(creditors);
    const amount = Math.min(debtor.remaining, creditor.remaining);
    transfers.push({
      from_user_id: debtor.user_id,
      to_user_id: creditor.user_id,
      amount_cents: amount,
    });
    debtor.remaining -= amount;
    creditor.remaining -= amount;
    if (debtor.remaining === 0) debtors.splice(debtors.indexOf(debtor), 1);
    if (creditor.remaining === 0) creditors.splice(creditors.indexOf(creditor), 1);
  }

  return transfers.sort(
    (a, b) =>
      canonicalCompare(a.from_user_id, b.from_user_id) ||
      canonicalCompare(a.to_user_id, b.to_user_id),
  );
}

// ---------------------------------------------------------------------------
// List queries + read documents (money spec §3.2) — T-9.1 / MON-1
// ---------------------------------------------------------------------------

/**
 * E2 query (money spec §3.2): standard cursor round-trip + coerced,
 * server-capped `limit` (envelope §3.5 convention) + filters. `member`
 * matches payer OR share-holder; `from`/`to` bound `spent_at`.
 */
export const ExpenseListQuerySchema = CursorQuerySchema.extend({
  category: ExpenseCategorySchema.optional(),
  member: UuidSchema.optional(),
  from: ISODateSchema.optional(),
  to: ISODateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ExpenseListQuery = z.infer<typeof ExpenseListQuerySchema>;

/** S2 query: `cursor?`, `limit?` only (money spec §3.2). */
export const SettlementListQuerySchema = CursorQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type SettlementListQuery = z.infer<typeof SettlementListQuerySchema>;

/**
 * B1 response document (money spec §3.2): member nets are explicitly SIGNED
 * (+ = is owed; Σ = 0 server-enforced), `pairwise` is one `Balance` row per
 * unordered pair with zero-net pairs omitted, and `simplified` is always
 * returned — the pairwise/simplified toggle is client-side (R-money-10).
 */
export const BalancesReadSchema = z.object({
  /** Trip base currency. */
  currency: CurrencyCodeSchema,
  members: z.array(z.object({ user_id: UuidSchema, net_cents: z.int() })),
  pairwise: z.array(BalanceSchema),
  simplified: z.array(
    z.object({
      from_user_id: UuidSchema,
      to_user_id: UuidSchema,
      amount_cents: PositiveCentsSchema,
    }),
  ),
});
export type BalancesRead = z.infer<typeof BalancesReadSchema>;

/**
 * Q2 response: the request plus the requester's `UserProfile` — display
 * name, avatar, payment handles; deliberately member-visible and deliberately
 * NOTHING more (R-money-17 minimum disclosure).
 */
export const SettleRequestDetailSchema = SettleRequestSchema.extend({
  requester: UserProfileSchema,
});
export type SettleRequestDetail = z.infer<typeof SettleRequestDetailSchema>;

/**
 * G1 item: one row per `expense_category` — absent DB rows are synthesized
 * with nulls so the client always renders the full taxonomy (R-money-20);
 * `spent_cents` is computed on read (Σ effective base per category).
 */
export const BudgetItemReadSchema = z.object({
  category: ExpenseCategorySchema,
  cap_cents: CentsSchema.nullable(),
  ai_estimate_cents: CentsSchema.nullable(),
  ai_estimated_at: ISODateTimeSchema.nullable(),
  currency: CurrencyCodeSchema,
  spent_cents: CentsSchema,
});
export type BudgetItemRead = z.infer<typeof BudgetItemReadSchema>;

/** G1 response: full-taxonomy items + the optional overall trip cap block. */
export const BudgetsReadSchema = z.object({
  items: z.array(BudgetItemReadSchema),
  total: z.object({
    cap_cents: CentsSchema.nullable(),
    spent_cents: CentsSchema,
    ai_estimate_cents: CentsSchema.nullable(),
  }),
});
export type BudgetsRead = z.infer<typeof BudgetsReadSchema>;

/** G2 body: `null` clears the cap, preserving any AI estimate (R-money-20). */
export const BudgetPutSchema = z.object({
  cap_cents: CentsSchema.nullable(),
});
export type BudgetPut = z.infer<typeof BudgetPutSchema>;

/**
 * G2's `:category` path segment: a real `expense_category` OR the `total`
 * pseudo-category — the overall trip cap rides the same verb/path
 * (R-money-20, resolved Gate 2). Derived from the canonical tuple so the
 * two can never drift.
 */
export const BudgetCategorySegmentSchema = z.enum([...EXPENSE_CATEGORIES, "total"] as const);
export type BudgetCategorySegment = z.infer<typeof BudgetCategorySegmentSchema>;

/**
 * `GET /fx/rate` (P-9 ruling ③, 2026-08-25): keyless Frankfurter v2 behind a
 * thin server proxy with a per-day cache — the client fetches OUR endpoint,
 * no key anywhere; provider-swappable seam (P-10 §3.7 reuses it). The rate
 * crosses the wire as a decimal STRING (`FxRate` — Law #2), ready to be
 * captured verbatim into `expenses.fx_rate` at entry (R-money-6).
 */
export const FxRateQuerySchema = z.object({
  base: CurrencyCodeSchema,
  quote: CurrencyCodeSchema,
});
export type FxRateQuery = z.infer<typeof FxRateQuerySchema>;

export const FxRateReadSchema = z.object({
  base: CurrencyCodeSchema,
  quote: CurrencyCodeSchema,
  rate: FxRateSchema,
  /** The provider's rate date (day-cache granularity). */
  as_of: ISODateSchema,
});
export type FxRateRead = z.infer<typeof FxRateReadSchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (money spec §3.1; contracts spec §3.6)
// ---------------------------------------------------------------------------

const tripIdParams = z.object({ tripId: UuidSchema });
const expenseParams = z.object({ tripId: UuidSchema, expenseId: UuidSchema });
const settlementParams = z.object({ tripId: UuidSchema, settlementId: UuidSchema });
const requestParams = z.object({ tripId: UuidSchema, requestId: UuidSchema });
const budgetParams = z.object({ tripId: UuidSchema, category: BudgetCategorySegmentSchema });

/**
 * Machine-readable mirror of the §3.1 money routes (MON-2..MON-6 implement
 * them; the FX proxy is T-9.4's). All trip-scoped routes run behind
 * `requireAuth` + the membership gate — a non-member's 404 is
 * indistinguishable from an absent trip (R-money-25); write-role rules are
 * §3.8's, server-enforced. The A1 AI-estimate descriptor deliberately lands
 * with MON-7 (P-10 platform), not here.
 */
export const moneyEndpoints = {
  /** E1: expense + resolved shares, atomic (R-money-1/2). 201. */
  createExpense: {
    method: "POST",
    path: "/trips/:tripId/expenses",
    params: tripIdParams,
    body: ExpenseCreateSchema,
    response: ExpenseSchema,
  },
  /** E2: newest first (`spent_at DESC, created_at DESC`). */
  listExpenses: {
    method: "GET",
    path: "/trips/:tripId/expenses",
    params: tripIdParams,
    query: ExpenseListQuerySchema,
    response: paginatedSchema(ExpenseSchema),
  },
  /** E3: detail + shares. */
  getExpense: {
    method: "GET",
    path: "/trips/:tripId/expenses/:expenseId",
    params: expenseParams,
    response: ExpenseSchema,
  },
  /** E4: coupling rule in `ExpenseUpdate`; accepted shares REPLACE the set. */
  updateExpense: {
    method: "PATCH",
    path: "/trips/:tripId/expenses/:expenseId",
    params: expenseParams,
    body: ExpenseUpdateSchema,
    response: ExpenseSchema,
  },
  /** E5: SOFT delete — audit trail stays (R-money-27). 204. */
  deleteExpense: {
    method: "DELETE",
    path: "/trips/:tripId/expenses/:expenseId",
    params: expenseParams,
    response: NoContentSchema,
  },
  /** B1: computed on read; both pairwise and simplified, always. */
  getBalances: {
    method: "GET",
    path: "/trips/:tripId/balances",
    params: tripIdParams,
    response: BalancesReadSchema,
  },
  /** S1: record-only ledger entry; party-only (R-money-12). 201. */
  createSettlement: {
    method: "POST",
    path: "/trips/:tripId/settlements",
    params: tripIdParams,
    body: SettlementCreateSchema,
    response: SettlementSchema,
  },
  /** S2: `settled_at DESC`. */
  listSettlements: {
    method: "GET",
    path: "/trips/:tripId/settlements",
    params: tripIdParams,
    query: SettlementListQuerySchema,
    response: paginatedSchema(SettlementSchema),
  },
  /** S3: recorder-only ≤ 24 h hard delete; linked request reopens (R-money-15). 204. */
  deleteSettlement: {
    method: "DELETE",
    path: "/trips/:tripId/settlements/:settlementId",
    params: settlementParams,
    response: NoContentSchema,
  },
  /** Q1: creditor-only; amount defaults to the live pairwise debt (R-money-16). 201. */
  createSettleRequest: {
    method: "POST",
    path: "/trips/:tripId/settle-requests",
    params: tripIdParams,
    body: SettleRequestCreateSchema,
    response: SettleRequestSchema,
  },
  /** Q2: deep-link data; R-money-17 minimum disclosure. */
  getSettleRequest: {
    method: "GET",
    path: "/trips/:tripId/settle-requests/:requestId",
    params: requestParams,
    response: SettleRequestDetailSchema,
  },
  /** Q3: soft cancel (`status = 'cancelled'`) — the link keeps rendering. 204. */
  cancelSettleRequest: {
    method: "DELETE",
    path: "/trips/:tripId/settle-requests/:requestId",
    params: requestParams,
    response: NoContentSchema,
  },
  /** G1: full-taxonomy rows + computed spend + total block. */
  getBudgets: {
    method: "GET",
    path: "/trips/:tripId/budgets",
    params: tripIdParams,
    response: BudgetsReadSchema,
  },
  /**
   * G2: upsert a category cap — or the overall trip cap via the `total`
   * pseudo-category segment. Returns the recomputed G1 document (uniform
   * across real categories and `total`, which has no `budgets` row).
   */
  putBudget: {
    method: "PUT",
    path: "/trips/:tripId/budgets/:category",
    params: budgetParams,
    body: BudgetPutSchema,
    response: BudgetsReadSchema,
  },
  /**
   * Ruling ③ FX proxy (T-9.4 implements) — global, not trip-scoped, but
   * still behind `requireAuth`; cache writes only on provider-confirmed
   * pairs (an unauthenticated open proxy / attacker-fillable cache is the
   * R1 security finding this line pins against).
   */
  getFxRate: {
    method: "GET",
    path: "/fx/rate",
    query: FxRateQuerySchema,
    response: FxRateReadSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
