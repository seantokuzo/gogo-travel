/**
 * Trip-settings data layer (T-6.9 / CT-5 — trips spec §2.5/§2.6). The
 * settings screen's mutations over `PATCH /trips/:tripId`, `DELETE
 * /trips/:tripId`, and self-removal (leave). All PATCHes ride the diffed
 * `buildTripPatch` output so:
 *
 * - only TOUCHED keys go on the wire — the server's owner-only authz is
 *   KEY-PRESENCE (`status`/`base_currency` present ⇒ owner required,
 *   R-trips-20), so an editor's name-save must never carry them; and
 * - `expect_updated_at` is ALWAYS carried (R-tripui-19: "the form always
 *   sends it"), echoing the row's `updated_at` string VERBATIM — the server
 *   compares at millisecond grain (`date_trunc`), and the echoed wire value
 *   is already ms-grain ISO; re-deriving/re-formatting it is the T-6.1
 *   false-conflict landmine.
 *
 * Optimistic policy (§2.6): trip-row PATCHes (settings save, theme change)
 * apply optimistically via the collab helpers and reconcile with the returned
 * row. Delete and leave are NOT optimistic — §2.6's sanctioned list doesn't
 * include them; both are destructive Confirm-gated exits where a spinner is
 * the honest surface and the §2.6 forced-exit/eviction machinery handles the
 * cache.
 */
import {
  memberEndpoints,
  tripEndpoints,
  type Trip,
  type TripStatus,
  type TripUpdate,
} from "@gogo/shared";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { apiClient, ApiRequestError, useSessionStore } from "@/auth";
import { localTodayISO } from "@/navigation/trip-defaults";

import {
  applyOptimisticTripPatch,
  reconcileTripRow,
  rollbackTripPatch,
} from "./collab";
import { queryKeys } from "./query-client";

// ---------------------------------------------------------------------------
// 409 CONFLICT discrimination (trips spec §3.5 rule 2; R-trips-6/22)
// ---------------------------------------------------------------------------

/**
 * Machine-readable `details.reason` values the trips PATCH puts on its 409s.
 * Wire home: `apps/server/src/http/expect-updated-at.ts`
 * (`STALE_UPDATED_AT_REASON`) and `apps/server/src/trips/routes.ts`
 * (`base_currency_locked`). Defer candidate: promote to `@gogo/shared` once a
 * second domain reuses the precondition client-side.
 */
export const STALE_UPDATED_AT_REASON = "stale_updated_at";
export const BASE_CURRENCY_LOCKED_REASON = "base_currency_locked";

function conflictReason(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/** Stale `expect_updated_at` — somebody else saved first (R-tripui-19). */
export function isStaleUpdatedAt(error: unknown): boolean {
  return conflictReason(error) === STALE_UPDATED_AT_REASON;
}

/** Base-currency change rejected — first expense already exists (R-trips-22). */
export function isBaseCurrencyLocked(error: unknown): boolean {
  return conflictReason(error) === BASE_CURRENCY_LOCKED_REASON;
}

// ---------------------------------------------------------------------------
// Diffed PATCH builder (T-5.8 diffField pattern, grown to the trip row)
// ---------------------------------------------------------------------------

/**
 * The fields the settings screen can touch. `theme: null` = back to app
 * default; `status: null` = clear the manual override (unarchive —
 * derivation resumes). Absent key = untouched.
 */
export interface TripSettingsEdits {
  name?: string;
  start_date?: string;
  end_date?: string;
  theme?: string | null;
  base_currency?: string;
  status?: TripStatus | null;
}

/**
 * Build the wire PATCH: only keys whose value actually CHANGED from the
 * current row (key-presence authz — an unchanged `base_currency` must not be
 * sent just because the owner opened the picker), plus `expect_updated_at`
 * always. `status` compares against `status_override` (the wire field IS the
 * override), so "clear" (`null`) on an already-clear row is a no-op. Returns
 * null when nothing changed — the caller skips the request entirely.
 */
export function buildTripPatch(current: Trip, edits: TripSettingsEdits): TripUpdate | null {
  const patch: TripUpdate = { expect_updated_at: current.updated_at };
  let touched = false;
  if (edits.name !== undefined && edits.name !== current.name) {
    patch.name = edits.name;
    touched = true;
  }
  if (edits.start_date !== undefined && edits.start_date !== current.start_date) {
    patch.start_date = edits.start_date;
    touched = true;
  }
  if (edits.end_date !== undefined && edits.end_date !== current.end_date) {
    patch.end_date = edits.end_date;
    touched = true;
  }
  if (edits.theme !== undefined && edits.theme !== current.theme) {
    patch.theme = edits.theme;
    touched = true;
  }
  if (edits.base_currency !== undefined && edits.base_currency !== current.base_currency) {
    patch.base_currency = edits.base_currency;
    touched = true;
  }
  if (edits.status !== undefined && edits.status !== current.status_override) {
    patch.status = edits.status;
    touched = true;
  }
  return touched ? patch : null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * `PATCH /trips/:tripId` — optimistic (§2.6 "settings save" / "theme
 * change"): apply → reconcile with the returned row → rollback + surface on
 * error. A stale-409 additionally refetches the detail + list so the form can
 * re-render with FRESH values (R-tripui-19 — the notice itself is the
 * screen's); the client never silently overwrites. A locked-409
 * (`base_currency_locked`) only rolls back — the stored row didn't move, so
 * there is nothing to refetch; the screen explains the lock.
 */
export function useUpdateTrip(tripId: string): UseMutationResult<Trip, Error, TripUpdate> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: TripUpdate) =>
      apiClient.request(tripEndpoints.updateTrip, { params: { tripId }, body: patch }),
    onMutate: (patch) => applyOptimisticTripPatch(client, tripId, patch, localTodayISO()),
    onError: (error, _patch, snapshot) => {
      if (snapshot !== undefined) rollbackTripPatch(client, tripId, snapshot);
      if (isStaleUpdatedAt(error)) {
        void client.invalidateQueries({ queryKey: queryKeys.trip(tripId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
      }
    },
    onSuccess: (row) => {
      reconcileTripRow(client, tripId, row);
      // Row contents are reconciled in place; the list still refetches for
      // section/sort placement (status/date moves re-bucket the row).
      void client.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    },
  });
}

/**
 * Post-DELETE 404 convergence (trips spec §3.5 rule 3): deletes converge —
 * a 404 answer to a delete-shaped call means someone else's delete already
 * won, which IS the caller's desired end state. Success-equivalent.
 */
function isConvergedDelete(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

/**
 * `DELETE /trips/:tripId` — owner-only, Confirm-gated (R-tripui-20). NOT
 * optimistic (not in §2.6's sanctioned list; the trip shell is still mounted
 * while the request runs, so optimistic eviction would yank the UI out from
 * under the confirm dialog). Cache scrub: the trips list invalidates here
 * (exact — the T-6.6 landmine); the SUBTREE eviction is the screen's, riding
 * its unmount teardown so no live observer re-creates the dead queries.
 */
export function useDeleteTrip(tripId: string): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        await apiClient.request(tripEndpoints.deleteTrip, { params: { tripId } });
      } catch (error) {
        if (!isConvergedDelete(error)) throw error;
      }
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    },
  });
}

/**
 * Leave trip = `DELETE /trips/:tripId/members/:me` (§2.5; server R-trips-11 —
 * owner leave 409s server-side, and the screen never offers it to owners:
 * transfer-first, R-tripui-20). NOT optimistic — leaving exits the trip
 * entirely, so there is no surviving in-trip surface to update in place
 * (§2.6's optimistic "member remove/leave" targets the members-screen list,
 * which is CT-4's surface). Same 404 convergence + teardown-eviction contract
 * as delete.
 */
export function useLeaveTrip(tripId: string): UseMutationResult<void, Error, void> {
  const client = useQueryClient();
  const userId = useSessionStore((s) => s.user?.id);
  return useMutation({
    mutationFn: async () => {
      if (userId === undefined) {
        // Unreachable under the auth gate; the narrow keeps the params honest.
        throw new Error("not signed in");
      }
      try {
        await apiClient.request(memberEndpoints.removeMember, { params: { tripId, userId } });
      } catch (error) {
        if (!isConvergedDelete(error)) throw error;
      }
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.trips, exact: true });
    },
  });
}
