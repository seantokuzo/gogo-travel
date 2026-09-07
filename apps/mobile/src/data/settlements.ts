/**
 * Settle server-state layer (T-9.7 / CMON-5+CMON-6 — client money spec
 * §2.6/§2.7). Typed hooks over the `@gogo/shared` settlement descriptors:
 *
 * - `useCreateSettlement` — S1 (record-only ledger entry, R-money-11..14;
 *   `request_id` links + settles an open request in one transaction,
 *   R-money-18). Success invalidates the R-cmoney-32 TRIO via the frozen
 *   `invalidateMoneyData` seam PLUS the linked request detail when a
 *   `request_id` rode the POST.
 * - `useCreateSettleRequest` — Q1 ("send the bill", R-money-16). No cache
 *   to invalidate: no settle-request list endpoint exists (the flagged spec
 *   gap) and a request changes no balance.
 * - `useCancelSettleRequest` — Q3 (soft cancel; the link keeps rendering).
 *   Success invalidates the request detail so an open recipient view flips.
 * - `useSettleRequestDetail` — Q2 (the deep-link read, R-money-17 minimum
 *   disclosure). 404 folds unknown-id and non-member together by design
 *   (R-money-25) — the screen renders ONE EmptyState for both.
 * - `useTripSettlements` — S2 first page (`settled_at DESC`): the request
 *   screen's who-settled-when lookup (R-cmoney-26 resolved state). Named
 *   rows beyond page one degrade to generic resolved copy — best-effort by
 *   construction, never load-bearing.
 *
 * NEW FILE on purpose (W4 ∥ contract): T-9.6 owns the expense hooks in
 * data/money.ts; settle hooks live here so the two waves never write one
 * file. Barrel wiring (data/index.ts) is an integration-time one-liner —
 * T-9.7 surfaces import this module directly (the T-9.5 R1 concrete-import
 * precedent).
 *
 * Mutation-callback policy, key-cache law, and `{ signal }` forwarding all
 * follow data/money.ts (its module doc is the rationale home).
 */
import {
  moneyEndpoints,
  type Paginated,
  type SettleRequest,
  type SettleRequestDetail,
  type Settlement,
  type SettlementCreate,
  type SettleRequestCreate,
} from "@gogo/shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { invalidateMoneyData, type MoneyMutationOptions } from "./money";
import { queryKeys } from "./query-client";

/** `GET /trips/:tripId/settle-requests/:requestId` — the Q2 deep-link read. */
export function useSettleRequestDetail(
  tripId: string,
  requestId: string,
): UseQueryResult<SettleRequestDetail, Error> {
  return useQuery({
    queryKey: queryKeys.tripSettleRequest(tripId, requestId),
    queryFn: ({ signal }) =>
      apiClient.request(
        moneyEndpoints.getSettleRequest,
        { params: { tripId, requestId } },
        { signal },
      ),
  });
}

/** `GET /trips/:tripId/settlements` — S2 first page (who-settled-when lookup). */
export function useTripSettlements(tripId: string): UseQueryResult<Paginated<Settlement>, Error> {
  return useQuery({
    queryKey: queryKeys.tripSettlements(tripId),
    queryFn: ({ signal }) =>
      apiClient.request(moneyEndpoints.listSettlements, { params: { tripId } }, { signal }),
  });
}

/**
 * `POST /trips/:tripId/settlements` (S1). The R-cmoney-32 trio invalidates
 * on success — a settlement changes balances, and the settlements list +
 * any linked request detail go stale with it. The 409 arm (`request_id`
 * present but the request is no longer open / a different pair) is the
 * caller's to surface SPECIFICALLY (R-money-18 racing another settler) —
 * this hook also refreshes the request detail on error so the screen's
 * next render shows the true state.
 */
export function useCreateSettlement(
  tripId: string,
  options?: MoneyMutationOptions<Settlement>,
): UseMutationResult<Settlement, Error, SettlementCreate> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettlementCreate) =>
      apiClient.request(moneyEndpoints.createSettlement, { params: { tripId }, body }),
    onSuccess: (settlement, vars) => {
      options?.onMutationSuccess?.(settlement);
      invalidateMoneyData(qc, tripId);
      void qc.invalidateQueries({ queryKey: queryKeys.tripSettlements(tripId) });
      if (vars.request_id !== undefined) {
        void qc.invalidateQueries({
          queryKey: queryKeys.tripSettleRequest(tripId, vars.request_id),
        });
      }
    },
    onError: (err, vars) => {
      options?.onMutationError?.(err);
      // A 409 means the request moved under us (settled/cancelled
      // elsewhere) — refetch so the surface can render the truth.
      if (vars.request_id !== undefined) {
        void qc.invalidateQueries({
          queryKey: queryKeys.tripSettleRequest(tripId, vars.request_id),
        });
      }
    },
  });
}

/** `POST /trips/:tripId/settle-requests` (Q1) — returns the wire `link`. */
export function useCreateSettleRequest(
  tripId: string,
  options?: MoneyMutationOptions<SettleRequest>,
): UseMutationResult<SettleRequest, Error, SettleRequestCreate> {
  return useMutation({
    mutationFn: (body: SettleRequestCreate) =>
      apiClient.request(moneyEndpoints.createSettleRequest, { params: { tripId }, body }),
    onSuccess: (request) => {
      options?.onMutationSuccess?.(request);
    },
    onError: (err) => {
      options?.onMutationError?.(err);
    },
  });
}

/** `DELETE /trips/:tripId/settle-requests/:requestId` (Q3, soft cancel). */
export function useCancelSettleRequest(
  tripId: string,
  options?: MoneyMutationOptions<void>,
): UseMutationResult<unknown, Error, { requestId: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId }: { requestId: string }) =>
      apiClient.request(moneyEndpoints.cancelSettleRequest, { params: { tripId, requestId } }),
    onSuccess: (_data, vars) => {
      options?.onMutationSuccess?.(undefined);
      void qc.invalidateQueries({
        queryKey: queryKeys.tripSettleRequest(tripId, vars.requestId),
      });
    },
    onError: (err, vars) => {
      options?.onMutationError?.(err);
      // Same truth-refresh posture as S1: a 409 cancel means the request
      // already moved (settled/cancelled) — show the real state.
      void qc.invalidateQueries({
        queryKey: queryKeys.tripSettleRequest(tripId, vars.requestId),
      });
    },
  });
}
