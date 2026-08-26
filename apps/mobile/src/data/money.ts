/**
 * Money server-state layer (T-9.5 / CMON-1+CMON-4 — client money spec §2.2).
 * Typed hooks over the `@gogo/shared` money descriptors for the money tab:
 *
 * - `useTripBalances` — the B1 read (`BalancesRead`): signed member nets,
 *   pairwise rows, and the always-present `simplified` array. The
 *   pairwise/simplified choice is a client VIEW toggle (R-cmoney-6) — one
 *   cache entry serves both.
 * - `useTripBudgets` — the G1 read (`BudgetsRead`): full-taxonomy category
 *   rows (absent DB rows server-synthesized, R-money-20) + the overall
 *   `total` block with computed spend.
 * - `usePutBudget` — the G2 cap upsert for a real category OR the `total`
 *   pseudo-category (R-cmoney-2). NOT optimistic (house policy: optimism is
 *   reserved for interaction-continuity surfaces like drag reorder; a form
 *   commit shows its pending state) — the response IS the recomputed G1
 *   document, so success reconciles by replacing the cached read outright.
 *   Failures surface visibly through the hook-level seam (R-cmoney-30/32
 *   offline posture: mutations fail visibly, never silently).
 *
 * KEY-CACHE LAW (T-6.7): all money keys live under the `["trips", tripId]`
 * DETAIL subtree — rationale at their `queryKeys` entries.
 *
 * INVALIDATION MAP (R-cmoney-32): an expense or settlement mutation must
 * invalidate expenses + balances + budgets TOGETHER — one stale leg of the
 * trio is the classic split-app bug. `invalidateMoneyData` is the single
 * frozen helper for that (T-9.6 expense writes and T-9.7 settlement writes
 * call it; nothing in T-9.5 mutates the trio). A budget cap PUT is
 * deliberately NOT a trio site: caps change no expense or balance row, and
 * its response already carries the recomputed budgets document.
 *
 * Mutation-callback policy (T-6.8/T-6.9 landmine): TanStack v5 fires
 * PER-CALL `mutate` callbacks only for the LATEST call on a mutation
 * instance — screens hand banner side effects to the HOOK-level
 * `MoneyMutationOptions` seam, which fires for every settled call.
 *
 * Every QUERY forwards TanStack's `{ signal }` (T-6.6 R1 cancellation/
 * timeout posture).
 */
import {
  moneyEndpoints,
  type BalancesRead,
  type BudgetCategorySegment,
  type BudgetsRead,
} from "@gogo/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/**
 * Hook-level mutation callback seam (module doc: the superseded-call drop).
 * Same shape as `ItineraryMutationOptions` — kept local per precedent (each
 * domain layer owns its seam).
 */
export interface MoneyMutationOptions<TData = unknown> {
  onMutationError?(error: unknown): void;
  onMutationSuccess?(data: TData): void;
}

/** `GET /trips/:tripId/balances` — computed on read, both views in one doc (B1). */
export function useTripBalances(tripId: string): UseQueryResult<BalancesRead, Error> {
  return useQuery({
    queryKey: queryKeys.tripBalances(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(moneyEndpoints.getBalances, { params: { tripId } }, { signal }),
  });
}

/** `GET /trips/:tripId/budgets` — full-taxonomy rows + computed spend + total (G1). */
export function useTripBudgets(tripId: string): UseQueryResult<BudgetsRead, Error> {
  return useQuery({
    queryKey: queryKeys.tripBudgets(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(moneyEndpoints.getBudgets, { params: { tripId } }, { signal }),
  });
}

export interface BudgetPutVars {
  /** A real `expense_category` or the `total` pseudo-category (R-money-20). */
  category: BudgetCategorySegment;
  /** `null` clears the cap, preserving any AI estimate (G2). */
  cap_cents: number | null;
}

/**
 * `PUT /trips/:tripId/budgets/:category` (R-cmoney-2) — upsert one cap.
 * Success replaces the cached G1 read with the server's recomputed document
 * (uniform across real categories and `total`); no invalidation needed — the
 * response is already the post-state truth.
 */
export function usePutBudget(
  tripId: string,
  options?: MoneyMutationOptions<BudgetsRead>,
): UseMutationResult<BudgetsRead, Error, BudgetPutVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, cap_cents }: BudgetPutVars) =>
      apiClient.request(moneyEndpoints.putBudget, {
        params: { tripId, category },
        body: { cap_cents },
      }),
    onSuccess: (doc) => {
      // Seam first (fires for EVERY settled call — superseded-call law).
      options?.onMutationSuccess?.(doc);
      qc.setQueryData<BudgetsRead>(queryKeys.tripBudgets(tripId), doc);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/**
 * The R-cmoney-32 invalidation TRIO — the one sanctioned way to mark money
 * data stale after an expense or settlement mutation. Expenses, balances,
 * and budgets are three projections of the same ledger; invalidating any
 * subset leaves the others lying (module doc). T-9.6/T-9.7 mutation hooks
 * call this on success — exported now so the seam is frozen before W4.
 */
export function invalidateMoneyData(qc: QueryClient, tripId: string): void {
  void qc.invalidateQueries({ queryKey: queryKeys.tripExpensesRoot(tripId) });
  void qc.invalidateQueries({ queryKey: queryKeys.tripBalances(tripId) });
  void qc.invalidateQueries({ queryKey: queryKeys.tripBudgets(tripId) });
}
