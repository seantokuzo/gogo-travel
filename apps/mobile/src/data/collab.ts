/**
 * Collab client layer (T-6.9 / CT-6 — trips spec §2.6; PLANNING § Cross-cutting,
 * client half). Collab sync v1 is REST + optimistic writes + refetch-on-focus +
 * push invalidation — NO sockets. This module is the one home for all three
 * client policies, so every trip surface shares the same semantics:
 *
 * 1. PUSH-INVALIDATION SEAM (R-tripui-4): `handleCollabEvent` maps the shared
 *    `PushInvalidationPayload` (ids-only, §3.5 rule 6) onto concrete query-key
 *    invalidations. It is TRANSPORT-AGNOSTIC — the P-13 notifications task
 *    plugs the real push transport in by calling it with the data payload and
 *    app-context deps (see `CollabDeps`); nothing here imports a transport.
 * 2. REFETCH-ON-FOCUS (R-tripui-3): `useAppForegroundRefetch` (AppState →
 *    `active`, mounted once at the root layout) and `useScreenFocusRefetch`
 *    (per-screen navigation focus) both "mark this spec's queries stale and
 *    refetch" — implemented as `invalidateQueries` (stale + refetch active).
 * 3. OPTIMISTIC WRITES (R-tripui-21): apply/rollback/reconcile helpers for the
 *    trip-row mutations §2.6 sanctions (settings save, theme change). The §2.6
 *    NON-optimistic list (trip create, invite accept — server-generated
 *    identity/membership) must NOT use these; they render spinners instead.
 *
 * Key-scheme note (key-cache law, T-6.7 merge): the spec's conceptual
 * `['trips']` column is a TWO-key operation — the `["trips"]` switcher/
 * redirect page plus the DISJOINT `["trip-list"]` infinite cache — and every
 * such site goes through `invalidateTripLists` (query-client.ts), never a
 * hand-rolled invalidate. The detail-family keys (`['trip', tripId]` →
 * `["trips", tripId]`, members/invites beneath it) invalidate `exact: true`
 * (the T-6.6 landmine: a non-exact `["trips"]` invalidate matches the
 * `[tripId]` guard's own query; inside its 404-scrub effect that
 * refetch-looped live). The one deliberate NON-exact invalidate
 * (`useAppForegroundRefetch`'s detail-subtree sweep) is safe because it
 * fires on an AppState transition, never in reaction to query state — it
 * cannot loop.
 */
import {
  PushInvalidationPayloadSchema,
  deriveTripStatus,
  type ISODate,
  type Paginated,
  type PushInvalidationPayload,
  type Trip,
  type TripDomainEvent,
  type TripListItem,
  type TripUpdate,
  type TripWithRole,
} from "@gogo/shared";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { invalidateTripLists, queryKeys } from "./query-client";

// ---------------------------------------------------------------------------
// 1. Push-invalidation seam (R-tripui-4; §2.6 mapping table)
// ---------------------------------------------------------------------------

/** One invalidation the §2.6 table asks for — `exact` per the key-scheme note. */
export interface InvalidationTarget {
  queryKey: QueryKey;
  exact: boolean;
}

/** What one §2.6 event invalidates — the executable form of the table's row. */
export interface CollabInvalidationPlan {
  /**
   * The table's `['trips']` column — a TWO-key op since the T-6.7 key split,
   * executed ONLY via `invalidateTripLists` (key-cache law; never a
   * hand-rolled list invalidate).
   */
  tripLists: boolean;
  /** Detail-family keys, invalidated exactly as given. */
  targets: InvalidationTarget[];
}

/**
 * The §2.6 event → query-key mapping, verbatim, on concrete keys. Pure and
 * me-agnostic — the entity-targeting extras (own-role refetch, forced exit)
 * are `handleCollabEvent`'s, which needs `CollabDeps` context.
 *
 * - `trip.updated` / `trip.status_changed` → `['trips']`, `['trip', tripId]`
 * - `trip.deleted` → `['trips']` (subtree eviction is handled separately —
 *   eviction is `removeQueries`, not an invalidation)
 * - member family + `ownership.transferred` → `['trip', tripId, 'members']`,
 *   `['trips']` (list rows carry `member_count`)
 * - `invite.created` / `invite.revoked` → `['trip', tripId, 'invites']`
 */
export function collabInvalidationPlan(
  event: TripDomainEvent,
  tripId: string,
): CollabInvalidationPlan {
  switch (event) {
    case "trip.updated":
    case "trip.status_changed":
      return { tripLists: true, targets: [{ queryKey: queryKeys.trip(tripId), exact: true }] };
    case "trip.deleted":
      return { tripLists: true, targets: [] };
    case "member.added":
    case "member.role_changed":
    case "member.removed":
    case "member.left":
    case "ownership.transferred":
      return {
        tripLists: true,
        targets: [{ queryKey: queryKeys.tripMembers(tripId), exact: true }],
      };
    case "invite.created":
    case "invite.revoked":
      return {
        tripLists: false,
        targets: [{ queryKey: queryKeys.tripInvites(tripId), exact: true }],
      };
  }
}

/**
 * Drop a trip's whole cached subtree (detail + members + invites — everything
 * under `["trips", tripId]`). Used when membership to the DATA is gone:
 * `trip.deleted`, self-`member.removed`, and the delete/leave flows (Law #3
 * client half — no dead trip data lingering to render).
 *
 * ⚠️ Removing an actively-OBSERVED query re-creates and refetches it (the
 * T-6.6 404-loop lesson) — callers still inside the trip must navigate out
 * first and evict AFTER the unmount commit (see `handleCollabEvent` and the
 * settings screen's teardown pattern).
 */
export function evictTripSubtree(client: QueryClient, tripId: string): void {
  client.removeQueries({ queryKey: queryKeys.trip(tripId) });
}

/** App context the transport wiring injects (P-13 readiness — no transport here). */
export interface CollabDeps {
  client: QueryClient;
  /** The signed-in user (member events target users via `entity_id`). */
  currentUserId: string;
  /** Trip the user is currently INSIDE (`[tripId]` shell mounted), or null. */
  currentTripId: string | null;
  /**
   * Forced exit (R-tripui-4): navigate to the trip list and surface a
   * non-blocking notice (the `showLinkNotice` + `router.replace("/(trips)")`
   * pair is the intended wiring). Called BEFORE eviction is scheduled so the
   * observers under `[tripId]` unmount before their cache entries vanish.
   */
  onForcedExit: (payload: PushInvalidationPayload) => void;
}

export interface CollabResult {
  /** False = payload failed the shared schema (unknown event / smuggled fields) — ignored. */
  handled: boolean;
  /** True when the event forced an exit from the currently-open trip. */
  forcedExit: boolean;
}

/** Events whose `entity_id` is a user id (the §3.5 table's member family). */
const MEMBER_EVENTS: ReadonlySet<TripDomainEvent> = new Set([
  "member.added",
  "member.role_changed",
  "member.removed",
  "member.left",
  "ownership.transferred",
]);

/**
 * The push-invalidation entry point (R-tripui-4). `raw` is the untrusted
 * data-only payload off the wire; anything the shared `strictObject` schema
 * rejects — unknown event names from a NEWER server, extra fields — is
 * IGNORED, not an error (forward-compat posture: old clients simply don't
 * refetch for events they don't know).
 *
 * Beyond the pure §2.6 table, three entity-targeted rules:
 * - member-family event with `entity_id` = me → also invalidate the trip
 *   detail (own role gates the whole UI — "refetch own role").
 * - `member.removed` targeting me → evict the trip subtree (membership gone;
 *   Law #3 client half) and, when inside that trip, forced exit + notice.
 * - `trip.deleted` → evict the subtree; forced exit when inside.
 *
 * Eviction ordering: when a forced exit fires, eviction is deferred one
 * macrotask (`setTimeout 0`) so the exit navigation's unmount commit runs
 * first — evicting while the `[tripId]` observers are live would re-create +
 * refetch the dead queries (T-6.6 landmine). A macrotask, NOT a microtask:
 * React may commit the navigation update after the current microtask queue,
 * and jest's modern fake timers fake `queueMicrotask` (a faked microtask
 * never runs under `waitFor`'s timer advancement — caught live in the T-6.9
 * delete/leave suites). When the user is NOT inside the trip there are no
 * live observers under the subtree, so eviction is immediate.
 */
export function handleCollabEvent(raw: unknown, deps: CollabDeps): CollabResult {
  const parsed = PushInvalidationPayloadSchema.safeParse(raw);
  if (!parsed.success) return { handled: false, forcedExit: false };
  const payload = parsed.data;
  const { event, trip_id, entity_id } = payload;

  const plan = collabInvalidationPlan(event, trip_id);
  if (plan.tripLists) invalidateTripLists(deps.client);
  for (const target of plan.targets) {
    void deps.client.invalidateQueries({ queryKey: target.queryKey, exact: target.exact });
  }

  const targetsMe = MEMBER_EVENTS.has(event) && entity_id === deps.currentUserId;
  if (targetsMe && event !== "member.removed") {
    // Own role changed/transferred — the detail row (TripWithRole) gates the UI.
    void deps.client.invalidateQueries({ queryKey: queryKeys.trip(trip_id), exact: true });
  }

  const evicts = event === "trip.deleted" || (event === "member.removed" && targetsMe);
  if (!evicts) return { handled: true, forcedExit: false };

  const inside = deps.currentTripId === trip_id;
  if (inside) {
    deps.onForcedExit(payload);
    setTimeout(() => evictTripSubtree(deps.client, trip_id), 0);
  } else {
    evictTripSubtree(deps.client, trip_id);
  }
  return { handled: true, forcedExit: inside };
}

// ---------------------------------------------------------------------------
// 2. Refetch-on-focus policy (R-tripui-3; §2.6)
// ---------------------------------------------------------------------------

/**
 * App-foreground leg: `AppState → active` refreshes "this spec's queries"
 * (§2.6) — the trip lists (via the mandatory `invalidateTripLists` helper,
 * key-cache law) plus the whole `["trips", …]` detail family (every trip's
 * detail/members/invites) in one deliberately NON-exact sweep: since the key
 * split, nothing but detail subtrees lives under that prefix, and a
 * foreground transition is a one-shot external trigger — it cannot enter the
 * 404-scrub refetch loop the guard's landmine note is about. Mounted ONCE at
 * the root layout.
 */
export function useAppForegroundRefetch(): void {
  const client = useQueryClient();
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") {
        invalidateTripLists(client);
        // Detail subtrees ONLY (length > 1): the bare ["trips"] page is the
        // helper's exact leg above — matching it again here would abort +
        // restart the just-dispatched switcher refetch (v5 cancelRefetch
        // default; round-1 perf finding).
        void client.invalidateQueries({
          queryKey: queryKeys.trips,
          predicate: (query) => query.queryKey.length > 1,
        });
      }
    });
    return () => subscription.remove();
  }, [client]);
}

/**
 * Screen-focus leg: on every navigation focus AFTER the first (mount already
 * fetches), invalidate the screen's own keys — mark stale + refetch active
 * (§2.6). Callers pass concrete detail-family targets; a screen whose focus
 * should also refresh the trip LISTS passes `tripLists: true`, which routes
 * through the mandatory `invalidateTripLists` helper (key-cache law) — never
 * hand a list key into `targets`. (The trip-list screen itself has its own
 * inline focus effect, T-6.7 / CT-1.)
 */
export function useScreenFocusRefetch(
  targets: readonly InvalidationTarget[],
  opts?: { tripLists?: boolean },
): void {
  const client = useQueryClient();
  const targetsRef = useRef(targets);
  const tripListsRef = useRef(opts?.tripLists ?? false);
  // Latest-value refs, updated in an effect (react-hooks/refs: no render-time
  // writes). Focus events only ever fire post-commit, so the effect has
  // always run before the callback reads them.
  useEffect(() => {
    targetsRef.current = targets;
    tripListsRef.current = opts?.tripLists ?? false;
  });
  const firstFocusRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      if (tripListsRef.current) invalidateTripLists(client);
      for (const target of targetsRef.current) {
        void client.invalidateQueries({ queryKey: target.queryKey, exact: target.exact });
      }
    }, [client]),
  );
}

// ---------------------------------------------------------------------------
// 3. Optimistic trip-row write helpers (R-tripui-21; §2.6 sanctioned list)
// ---------------------------------------------------------------------------

/** Cache snapshot taken before an optimistic apply — the rollback token. */
export interface TripPatchSnapshot {
  detail: TripWithRole | undefined;
  list: Paginated<TripListItem> | undefined;
}

/**
 * The `Trip` fields a `TripUpdate` patch predicts, for the optimistic apply.
 * `status` is special: the wire field is the manual OVERRIDE (null clears it),
 * while the row's `status` is effective — override wins, else the shared
 * `deriveTripStatus` derivation over the merged dates (trips spec §3.4; the
 * server reconciles identically, so the returned row converges with this).
 */
export function optimisticTripFields(
  current: Trip,
  patch: TripUpdate,
  today: ISODate,
): Partial<Trip> {
  const fields: Partial<Trip> = {};
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.destination_name !== undefined) fields.destination_name = patch.destination_name;
  if (patch.destination_lat !== undefined) fields.destination_lat = patch.destination_lat;
  if (patch.destination_lng !== undefined) fields.destination_lng = patch.destination_lng;
  if (patch.start_date !== undefined) fields.start_date = patch.start_date;
  if (patch.end_date !== undefined) fields.end_date = patch.end_date;
  if (patch.theme !== undefined) fields.theme = patch.theme;
  if (patch.base_currency !== undefined) fields.base_currency = patch.base_currency;

  const mergedStart = patch.start_date ?? current.start_date;
  const mergedEnd = patch.end_date ?? current.end_date;
  if (patch.status !== undefined) {
    // Owner override touched: value pins the status; null resumes derivation.
    fields.status_override = patch.status;
    fields.status = patch.status ?? deriveTripStatus(today, mergedStart, mergedEnd);
  } else if (patch.start_date !== undefined || patch.end_date !== undefined) {
    // Dates moved without touching the override: derived status follows the
    // merged dates unless an existing override still pins it.
    fields.status = current.status_override ?? deriveTripStatus(today, mergedStart, mergedEnd);
  }
  return fields;
}

/**
 * Optimistic apply for a trip-row PATCH (settings save / theme change — the
 * §2.6 sanctioned trip-row writes): cancel in-flight reads of both caches so
 * a racing refetch can't clobber the optimistic value, snapshot, then write
 * the predicted fields into the detail row AND the list row (role /
 * member_count survive — they ride the cached objects, not the patch).
 */
export async function applyOptimisticTripPatch(
  client: QueryClient,
  tripId: string,
  patch: TripUpdate,
  today: ISODate,
): Promise<TripPatchSnapshot> {
  await Promise.all([
    client.cancelQueries({ queryKey: queryKeys.trip(tripId), exact: true }),
    client.cancelQueries({ queryKey: queryKeys.trips, exact: true }),
  ]);
  const detail = client.getQueryData<TripWithRole>(queryKeys.trip(tripId));
  const list = client.getQueryData<Paginated<TripListItem>>(queryKeys.trips);
  if (detail !== undefined) {
    client.setQueryData<TripWithRole>(queryKeys.trip(tripId), {
      ...detail,
      ...optimisticTripFields(detail, patch, today),
    });
  }
  if (list !== undefined) {
    client.setQueryData<Paginated<TripListItem>>(queryKeys.trips, {
      ...list,
      items: list.items.map((item) =>
        item.id === tripId ? { ...item, ...optimisticTripFields(item, patch, today) } : item,
      ),
    });
  }
  return { detail, list };
}

/** Roll both caches back to the pre-apply snapshot (mutation failed). */
export function rollbackTripPatch(
  client: QueryClient,
  tripId: string,
  snapshot: TripPatchSnapshot,
): void {
  if (snapshot.detail !== undefined) {
    client.setQueryData<TripWithRole>(queryKeys.trip(tripId), snapshot.detail);
  }
  if (snapshot.list !== undefined) {
    client.setQueryData<Paginated<TripListItem>>(queryKeys.trips, snapshot.list);
  }
}

/**
 * Reconcile with the returned row (R-tripui-21 / API R-trips-19): the server's
 * committed `Trip` is truth — spread it over the cached rows, preserving the
 * caller-scoped extras (`role`, `member_count`) the PATCH response doesn't
 * carry. In particular the echoed `updated_at` is what the NEXT
 * `expect_updated_at` must round-trip verbatim.
 */
export function reconcileTripRow(client: QueryClient, tripId: string, row: Trip): void {
  const detail = client.getQueryData<TripWithRole>(queryKeys.trip(tripId));
  if (detail !== undefined) {
    client.setQueryData<TripWithRole>(queryKeys.trip(tripId), { ...detail, ...row });
  }
  const list = client.getQueryData<Paginated<TripListItem>>(queryKeys.trips);
  if (list !== undefined) {
    client.setQueryData<Paginated<TripListItem>>(queryKeys.trips, {
      ...list,
      items: list.items.map((item) => (item.id === tripId ? { ...item, ...row } : item)),
    });
  }
}
