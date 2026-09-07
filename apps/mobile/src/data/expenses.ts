/**
 * Expense server-state layer (T-9.6 / CMON-2+CMON-3 — client money spec
 * R-cmoney-5/12/13/32). Typed hooks over the `@gogo/shared` money
 * descriptors for the expense screens; its OWN module beside `money.ts`
 * (the `bookings.ts` precedent — and the W4 parallel-worktree contract:
 * T-9.7's settlement hooks land in `money.ts`'s domain, not here).
 *
 * READS
 * - `useTripExpenses` — the E2 infinite list on the shared `Paginated`
 *   cursor (`nextCursor` round-trips as `?cursor=`, `null` = end — the
 *   `useTripList` precedent). Page size stays the SERVER default (50, cap
 *   100): the list virtualizes, so there is no client reason to override.
 *   Filters (member / category — R-cmoney-5) are part of the query key;
 *   every variant sits under the frozen `tripExpensesRoot` prefix so the
 *   R-cmoney-32 trio invalidation reaches all of them at once.
 * - `useExpense` — the E3 detail read. E3 RETURNS soft-deleted expenses
 *   with the audit pair populated (T-9.2 recorded interpretation) — the
 *   detail screen renders the R-cmoney-13 audit state from it.
 * - `useFxRate` — the ruling-③ `GET /fx/rate` proxy (R-cmoney-10). The
 *   client calls OUR endpoint only; `base` = the expense's logged
 *   currency, `quote` = the trip base, so `rate` is exactly the
 *   `currency → base` major-unit decimal string the wire's `fx_rate`
 *   captures verbatim (server `expenses/fx.ts` pins the direction).
 *
 * MUTATIONS (E1/E4/E5) — every success calls `invalidateMoneyData` (the
 * ONE sanctioned R-cmoney-32 trio: expenses + balances + budgets together;
 * the detail key lives under the expenses root prefix, so it rides the same
 * invalidation). NOT optimistic (house policy: optimism is reserved for
 * interaction-continuity surfaces; a form commit shows its pending state).
 *
 * Mutation-callback policy (T-6.8/T-6.9 landmine): hook-level seams fire
 * for EVERY settled call — screens never hang banners on per-call `mutate`
 * callbacks. Every query forwards TanStack's `{ signal }` (T-6.6 R1).
 */
import {
  moneyEndpoints,
  type Expense,
  type ExpenseCategory,
  type ExpenseCreate,
  type ExpenseUpdate,
  type FxRateRead,
  type Paginated,
} from "@gogo/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { invalidateMoneyData, type MoneyMutationOptions } from "./money";
import { queryKeys } from "./query-client";

/** R-cmoney-5 list filters — member (payer OR share-holder) + category. */
export interface ExpenseListFilters {
  member?: string;
  category?: ExpenseCategory;
}

/** `GET /trips/:tripId/expenses` — E2, newest first, cursor-paginated. */
export function useTripExpenses(
  tripId: string,
  filters: ExpenseListFilters = {},
): UseInfiniteQueryResult<InfiniteData<Paginated<Expense>, string | undefined>, Error> {
  return useInfiniteQuery({
    queryKey: queryKeys.tripExpenses(tripId, filters),
    queryFn: ({ pageParam, signal }) =>
      apiClient.request(
        moneyEndpoints.listExpenses,
        {
          params: { tripId },
          query: {
            ...(pageParam !== undefined ? { cursor: pageParam } : {}),
            ...(filters.member !== undefined ? { member: filters.member } : {}),
            ...(filters.category !== undefined ? { category: filters.category } : {}),
          },
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    // `null` (shared contract's "no further page") and `undefined` both mean
    // stop in v5 — normalize so the pageParam type stays `string | undefined`.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/** `GET /trips/:tripId/expenses/:expenseId` — E3 detail + shares (+ audit). */
export function useExpense(
  tripId: string,
  expenseId: string,
  options?: { enabled?: boolean },
): UseQueryResult<Expense, Error> {
  return useQuery({
    queryKey: queryKeys.tripExpense(tripId, expenseId),
    queryFn: ({ signal }) =>
      apiClient.request(moneyEndpoints.getExpense, { params: { tripId, expenseId } }, { signal }),
    enabled: options?.enabled ?? true,
  });
}

/**
 * `GET /fx/rate` (R-cmoney-10) — enabled by the FORM (online ∧ valid pair ∧
 * currency ≠ base); the rate string prefills the form's rate field, manual
 * override always wins (the form owns that gate — this hook just reads).
 */
export function useFxRate(
  base: string,
  quote: string,
  options?: { enabled?: boolean },
): UseQueryResult<FxRateRead, Error> {
  return useQuery({
    queryKey: queryKeys.fxRate(base, quote),
    queryFn: ({ signal }) =>
      apiClient.request(moneyEndpoints.getFxRate, { query: { base, quote } }, { signal }),
    enabled: options?.enabled ?? true,
  });
}

/** `POST /trips/:tripId/expenses` — E1 create (atomic expense + shares). */
export function useCreateExpense(
  tripId: string,
  options?: MoneyMutationOptions<Expense>,
): UseMutationResult<Expense, Error, ExpenseCreate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExpenseCreate) =>
      apiClient.request(moneyEndpoints.createExpense, { params: { tripId }, body }),
    onSuccess: (created) => {
      // Seam first (fires for EVERY settled call — superseded-call law).
      options?.onMutationSuccess?.(created);
      invalidateMoneyData(qc, tripId);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

export interface ExpenseUpdateVars {
  expenseId: string;
  input: ExpenseUpdate;
}

/**
 * `PATCH /trips/:tripId/expenses/:expenseId` — E4 full-value replacement
 * (accepted shares REPLACE the set). The response IS the updated expense —
 * seed the detail cache with it for instant render, then run the trio
 * invalidation (which marks that same key stale and refetches it while
 * active — correctness over the saved round trip). `onMutate` cancels any
 * in-flight detail refetch first (the T-9.5 R1 LWW guard: a stale read
 * settling after `setQueryData` would overwrite the fresh document).
 */
export function useUpdateExpense(
  tripId: string,
  options?: MoneyMutationOptions<Expense>,
): UseMutationResult<Expense, Error, ExpenseUpdateVars> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ expenseId, input }: ExpenseUpdateVars) =>
      apiClient.request(moneyEndpoints.updateExpense, {
        params: { tripId, expenseId },
        body: input,
      }),
    onMutate: async ({ expenseId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.tripExpense(tripId, expenseId) });
    },
    onSuccess: (updated, { expenseId }) => {
      options?.onMutationSuccess?.(updated);
      qc.setQueryData<Expense>(queryKeys.tripExpense(tripId, expenseId), updated);
      invalidateMoneyData(qc, tripId);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/**
 * `DELETE /trips/:tripId/expenses/:expenseId` — E5 SOFT delete (R-money-27:
 * the row survives as the audit record; a later E3 read renders the audit
 * state). Trio invalidation covers the list, balances, budgets AND the
 * detail key (prefix).
 */
export function useDeleteExpense(
  tripId: string,
  options?: MoneyMutationOptions<void>,
): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (expenseId: string) =>
      apiClient.request(moneyEndpoints.deleteExpense, { params: { tripId, expenseId } }),
    onSuccess: () => {
      options?.onMutationSuccess?.(undefined);
      invalidateMoneyData(qc, tripId);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}
