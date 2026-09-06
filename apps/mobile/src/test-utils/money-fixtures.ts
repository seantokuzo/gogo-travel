/**
 * Money fixtures (T-9.5 / CMON-1+CMON-4) — wire-schema-VALID documents for
 * the money-tab suites, mocked at the ApiClient/descriptor boundary (the
 * P-7/P-8 fixture-driven precedent: the T-9.4 server lands in parallel, so
 * these are built against the T-9.1 descriptors, not a running server).
 *
 * Every builder round-trips its document through the `@gogo/shared` schema
 * (`.parse`) so contract drift turns these suites RED instead of letting the
 * client test against a shape the wire no longer speaks.
 *
 * Lives outside `__tests__/` so jest never treats it as a suite.
 */
import {
  BalancesReadSchema,
  BudgetsReadSchema,
  EXPENSE_CATEGORIES,
  SettleRequestSchema,
  type BalancesRead,
  type BudgetItemRead,
  type BudgetsRead,
  type SettleRequest,
} from "@gogo/shared";

import { MEMBER_B_ID, MEMBER_C_ID, TEST_TRIP_ID } from "./ids";
import { TEST_USER } from "./session-fixtures";

/** A settle-request id the annotation-seam suites can reference. */
export const TEST_REQUEST_ID = "99999999-9999-4999-8999-999999999999";

/**
 * Empty-universe balances — the mockNavApi default (route-tree suites
 * mounting the money tab settle without retry noise; real universes ride
 * `overrides`, mirroring the itinerary-family posture).
 */
export function emptyBalancesRead(currency = "USD"): BalancesRead {
  return BalancesReadSchema.parse({ currency, members: [], pairwise: [], simplified: [] });
}

/** Full-taxonomy G1 items, all-null caps/estimates, zero spend. */
function untouchedItems(currency: string): BudgetItemRead[] {
  return EXPENSE_CATEGORIES.map((category) => ({
    category,
    cap_cents: null,
    ai_estimate_cents: null,
    ai_estimated_at: null,
    currency,
    spent_cents: 0,
  }));
}

/** Untouched budgets doc — also the mockNavApi default. */
export function emptyBudgetsRead(currency = "USD"): BudgetsRead {
  return BudgetsReadSchema.parse({
    items: untouchedItems(currency),
    total: { cap_cents: null, spent_cents: 0, ai_estimate_cents: null },
  });
}

/**
 * The default balances universe — a triangle whose SIMPLIFIED transfers
 * differ from the pairwise rows, so the R-cmoney-6 toggle pins are
 * discriminating (identical sets would make the toggle unfalsifiable):
 *
 * - pairwise: B owes the caller 2550 · C owes B 2450
 * - member nets: caller +2550, B −100, C −2450
 * - simplified (greedy): C→caller 2450 · B→caller 100
 *
 * Row testIDs therefore differ per view: `{B}-{me}` + `{C}-{B}` pairwise vs
 * `{C}-{me}` + `{B}-{me}` simplified — `{C}-{B}` exists ONLY pairwise and
 * `{C}-{me}` ONLY simplified. `{C}-{B}` is also the caller-uninvolved row
 * (no action affordance — R-cmoney-6 control arm).
 */
export function makeBalancesRead(overrides?: Partial<BalancesRead>): BalancesRead {
  return BalancesReadSchema.parse({
    currency: "USD",
    members: [
      { user_id: TEST_USER.id, net_cents: 2550 },
      { user_id: MEMBER_B_ID, net_cents: -100 },
      { user_id: MEMBER_C_ID, net_cents: -2450 },
    ],
    // Canonical unordered pairs: user_id < counterparty_id (lowercase);
    // net > 0 = counterparty owes user_id.
    pairwise: [
      {
        trip_id: TEST_TRIP_ID,
        user_id: TEST_USER.id,
        counterparty_id: MEMBER_B_ID,
        net_cents: 2550,
      },
      {
        trip_id: TEST_TRIP_ID,
        user_id: MEMBER_B_ID,
        counterparty_id: MEMBER_C_ID,
        net_cents: 2450,
      },
    ],
    simplified: [
      { from_user_id: MEMBER_C_ID, to_user_id: TEST_USER.id, amount_cents: 2450 },
      { from_user_id: MEMBER_B_ID, to_user_id: TEST_USER.id, amount_cents: 100 },
    ],
    ...overrides,
  });
}

/** All-zero balances — the "All settled up" EmptyState arm (R-cmoney-29). */
export function makeSettledBalancesRead(): BalancesRead {
  return makeBalancesRead({
    members: [
      { user_id: TEST_USER.id, net_cents: 0 },
      { user_id: MEMBER_B_ID, net_cents: 0 },
    ],
    pairwise: [],
    simplified: [],
  });
}

export interface BudgetItemOverride {
  cap_cents?: number | null;
  ai_estimate_cents?: number | null;
  ai_estimated_at?: string | null;
  spent_cents?: number;
}

/**
 * The default budgets universe (R-cmoney-2 progress-state coverage):
 * lodging normal (20%), transport OVER (120%), food WARNING (85%), the
 * rest capless; shopping carries an AI estimate so the est. column has a
 * rendered arm. `total.spent` is the coherent Σ of item spend; total cap
 * null unless overridden.
 */
export function makeBudgetsRead(opts?: {
  currency?: string;
  items?: Partial<Record<(typeof EXPENSE_CATEGORIES)[number], BudgetItemOverride>>;
  total?: Partial<BudgetsRead["total"]>;
}): BudgetsRead {
  const currency = opts?.currency ?? "USD";
  const defaults: Record<string, BudgetItemOverride> = {
    lodging: { cap_cents: 100000, spent_cents: 20000 },
    transport: { cap_cents: 5000, spent_cents: 6000 },
    food: { cap_cents: 10000, spent_cents: 8500 },
    shopping: {
      ai_estimate_cents: 30000,
      ai_estimated_at: "2026-08-20T12:00:00.000Z",
      spent_cents: 0,
    },
  };
  const items = untouchedItems(currency).map((item) => ({
    ...item,
    ...defaults[item.category],
    ...opts?.items?.[item.category],
  }));
  const spentSum = items.reduce((acc, item) => acc + item.spent_cents, 0);
  return BudgetsReadSchema.parse({
    items,
    total: {
      cap_cents: null,
      spent_cents: spentSum,
      ai_estimate_cents: null,
      ...opts?.total,
    },
  });
}

/**
 * An OPEN settle-request the caller (creditor) sent to B — the §2.7 step-5
 * balances-row annotation seam's fixture (empty-in-prod until a list
 * endpoint exists; see the BalancesSegment module doc).
 */
export function makeSettleRequest(overrides?: Partial<SettleRequest>): SettleRequest {
  return SettleRequestSchema.parse({
    id: TEST_REQUEST_ID,
    trip_id: TEST_TRIP_ID,
    from_user_id: MEMBER_B_ID,
    to_user_id: TEST_USER.id,
    amount_cents: 2550,
    currency: "USD",
    note: null,
    status: "open",
    resolved: false,
    settlement_id: null,
    created_by: TEST_USER.id,
    created_at: "2026-08-22T09:30:00.000Z",
    link: `https://gogo.example/t/${TEST_TRIP_ID}/request/${TEST_REQUEST_ID}`,
    ...overrides,
  });
}

export interface MoneyApiOptions {
  balances?: BalancesRead;
  budgets?: BudgetsRead;
  /**
   * `PUT /trips/:tripId/budgets/:category` responder result — defaults to
   * echoing the request into an updated document (cap applied to the
   * targeted category or the total block, spend untouched).
   */
  putBudget?: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Money-family `overrides` for `mockNavApi` — `METHOD path` → responder,
 * the descriptor-routing convention of trip-fixtures.
 */
export function moneyApiOverrides(
  opts: MoneyApiOptions = {},
): Record<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const budgets = opts.budgets ?? makeBudgetsRead();
  return {
    "GET /trips/:tripId/balances": () => Promise.resolve(opts.balances ?? makeBalancesRead()),
    "GET /trips/:tripId/budgets": () => Promise.resolve(budgets),
    "PUT /trips/:tripId/budgets/:category": (input) => {
      if (opts.putBudget) return opts.putBudget(input);
      const params = input["params"] as { category: string };
      const body = input["body"] as { cap_cents: number | null };
      if (params.category === "total") {
        return Promise.resolve(
          BudgetsReadSchema.parse({
            ...budgets,
            total: { ...budgets.total, cap_cents: body.cap_cents },
          }),
        );
      }
      return Promise.resolve(
        BudgetsReadSchema.parse({
          ...budgets,
          items: budgets.items.map((item) =>
            item.category === params.category ? { ...item, cap_cents: body.cap_cents } : item,
          ),
        }),
      );
    },
  };
}
