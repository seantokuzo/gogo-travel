/**
 * Collab client layer (T-6.9 / CT-6 — trips spec §2.6). Covers:
 * - the event → query-key invalidation map, EXHAUSTIVE over the 10-event
 *   shared catalog (the Record fixture is typed over `TripDomainEvent`, so a
 *   catalog append breaks this suite at compile time — by design);
 * - unknown/malformed payloads ignored (forward-compat posture);
 * - entity-targeted extras: own-role refetch, forced exit + subtree eviction
 *   for `trip.deleted` / self-`member.removed`;
 * - the `exact: true` list-key pin (T-6.6 refetch-loop landmine);
 * - both refetch-on-focus legs (AppState foreground, screen focus skip-first).
 *
 * expo-router is mocked at module grain: this suite exercises the focus
 * POLICY (skip-first + invalidation targets), not the navigation transport —
 * the real focus event plumbing is expo-router's own contract.
 */
import type { Paginated, TripDomainEvent, TripListItem } from "@gogo/shared";
import { QueryClientProvider, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AppState, type NativeEventSubscription } from "react-native";

import {
  collabInvalidationPlan,
  evictTripSubtree,
  handleCollabEvent,
  useAppForegroundRefetch,
  useScreenFocusRefetch,
  type CollabDeps,
  type CollabInvalidationPlan,
} from "@/data/collab";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { makePlanningTrip } from "@/test-utils/trip-fixtures";

let mockFocusCallback: (() => void) | undefined;
jest.mock("expo-router", () => ({
  __esModule: true,
  useFocusEffect: (cb: () => void) => {
    mockFocusCallback = cb;
  },
}));

const OTHER_USER_ID = "99999999-9999-4999-8999-999999999999";

/** Seed observer-less entries (gcTime pinned — the T-6.1 GC-race landmine). */
function seedTripFamily(client: QueryClient): void {
  const keys = [
    queryKeys.trips,
    queryKeys.tripsList,
    queryKeys.trip(TEST_TRIP_ID),
    queryKeys.trip(TRIP_B_ID),
    queryKeys.tripMembers(TEST_TRIP_ID),
    queryKeys.tripInvites(TEST_TRIP_ID),
  ];
  for (const key of keys) client.setQueryDefaults(key, { gcTime: Infinity });
  const trip = makePlanningTrip(TEST_TRIP_ID);
  const page: Paginated<TripListItem> = { items: [trip], nextCursor: null };
  client.setQueryData(queryKeys.trips, page);
  // Shape stands in for the list screen's InfiniteData — only the
  // invalidation FLAG is asserted here, never the contents.
  client.setQueryData(queryKeys.tripsList, { pages: [page], pageParams: [undefined] });
  client.setQueryData(queryKeys.trip(TEST_TRIP_ID), trip);
  client.setQueryData(queryKeys.trip(TRIP_B_ID), makePlanningTrip(TRIP_B_ID));
  client.setQueryData(queryKeys.tripMembers(TEST_TRIP_ID), []);
  client.setQueryData(queryKeys.tripInvites(TEST_TRIP_ID), []);
}

function invalidated(client: QueryClient, key: QueryKey): boolean {
  return client.getQueryState(key)?.isInvalidated ?? false;
}

function makeDeps(
  client: QueryClient,
  overrides?: Partial<Pick<CollabDeps, "currentTripId" | "currentUserId">>,
): CollabDeps & { onForcedExit: jest.Mock } {
  const onForcedExit = jest.fn();
  return {
    client,
    currentUserId: TEST_USER.id,
    currentTripId: null,
    onForcedExit,
    ...overrides,
  };
}

/** Real timers here — one macrotask hop runs the deferred eviction. */
const flushDeferredEvict = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
  jest.restoreAllMocks();
  mockFocusCallback = undefined;
});

describe("collabInvalidationPlan (§2.6 table, exhaustive over the catalog)", () => {
  it("maps all 10 events onto the concrete plan — lists via the helper flag, detail keys exact", () => {
    const T = TEST_TRIP_ID;
    const tripRow: CollabInvalidationPlan = {
      tripLists: true,
      targets: [{ queryKey: queryKeys.trip(T), exact: true }],
    };
    const memberRow: CollabInvalidationPlan = {
      tripLists: true,
      targets: [{ queryKey: queryKeys.tripMembers(T), exact: true }],
    };
    const inviteRow: CollabInvalidationPlan = {
      tripLists: false,
      targets: [{ queryKey: queryKeys.tripInvites(T), exact: true }],
    };
    // Typed over TripDomainEvent: a catalog append fails compilation here.
    const expected: Record<TripDomainEvent, CollabInvalidationPlan> = {
      "trip.updated": tripRow,
      "trip.status_changed": tripRow,
      "trip.deleted": { tripLists: true, targets: [] },
      "member.added": memberRow,
      "member.role_changed": memberRow,
      "member.removed": memberRow,
      "member.left": memberRow,
      "ownership.transferred": memberRow,
      "invite.created": inviteRow,
      "invite.revoked": inviteRow,
    };
    for (const [event, plan] of Object.entries(expected)) {
      expect(collabInvalidationPlan(event as TripDomainEvent, T)).toEqual(plan);
    }
  });
});

describe("handleCollabEvent", () => {
  it("ignores unknown event names and payloads smuggling extra fields", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);
    const deps = makeDeps(client);

    expect(
      handleCollabEvent({ event: "money.expense_added", trip_id: TEST_TRIP_ID }, deps),
    ).toEqual({ handled: false, forcedExit: false });
    expect(
      handleCollabEvent(
        { event: "trip.updated", trip_id: TEST_TRIP_ID, name: "smuggled" },
        deps,
      ),
    ).toEqual({ handled: false, forcedExit: false });
    expect(handleCollabEvent(undefined, deps)).toEqual({ handled: false, forcedExit: false });

    expect(invalidated(client, queryKeys.trips)).toBe(false);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(false);
    expect(deps.onForcedExit).not.toHaveBeenCalled();
  });

  it("trip.updated invalidates BOTH lists (helper) + detail EXACTLY — never another trip's detail or the members key", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);

    const result = handleCollabEvent(
      { event: "trip.updated", trip_id: TEST_TRIP_ID },
      makeDeps(client),
    );

    expect(result).toEqual({ handled: true, forcedExit: false });
    // Key-cache law: "the trips list" is the invalidateTripLists two-key op.
    expect(invalidated(client, queryKeys.trips)).toBe(true);
    expect(invalidated(client, queryKeys.tripsList)).toBe(true);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(true);
    // The exactness pins: ["trips"] must not sweep the detail universe
    // (T-6.6 landmine) and the detail invalidate must not sweep its subtree.
    expect(invalidated(client, queryKeys.trip(TRIP_B_ID))).toBe(false);
    expect(invalidated(client, queryKeys.tripMembers(TEST_TRIP_ID))).toBe(false);
  });

  it("a member event targeting ANOTHER user refreshes members + lists but not my role's detail row", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);

    handleCollabEvent(
      { event: "member.role_changed", trip_id: TEST_TRIP_ID, entity_id: OTHER_USER_ID },
      makeDeps(client),
    );

    expect(invalidated(client, queryKeys.tripMembers(TEST_TRIP_ID))).toBe(true);
    expect(invalidated(client, queryKeys.trips)).toBe(true);
    expect(invalidated(client, queryKeys.tripsList)).toBe(true);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(false);
  });

  it("a member event targeting ME also refetches the detail row (own role gates the UI)", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);

    handleCollabEvent(
      { event: "ownership.transferred", trip_id: TEST_TRIP_ID, entity_id: TEST_USER.id },
      makeDeps(client),
    );

    expect(invalidated(client, queryKeys.tripMembers(TEST_TRIP_ID))).toBe(true);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(true);
  });

  it("trip.deleted while INSIDE forces exit, then evicts the subtree on the microtask", async () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);
    const deps = makeDeps(client, { currentTripId: TEST_TRIP_ID });

    const result = handleCollabEvent({ event: "trip.deleted", trip_id: TEST_TRIP_ID }, deps);

    expect(result).toEqual({ handled: true, forcedExit: true });
    expect(deps.onForcedExit).toHaveBeenCalledWith({
      event: "trip.deleted",
      trip_id: TEST_TRIP_ID,
    });
    // Deferred: the exit navigation's unmount commit goes first.
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeDefined();
    await flushDeferredEvict();
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryState(queryKeys.tripMembers(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryState(queryKeys.tripInvites(TEST_TRIP_ID))).toBeUndefined();
    // The LISTS survive (invalidated, not evicted) — and other trips' details too.
    expect(client.getQueryData(queryKeys.trips)).toBeDefined();
    expect(client.getQueryData(queryKeys.tripsList)).toBeDefined();
    expect(invalidated(client, queryKeys.trips)).toBe(true);
    expect(invalidated(client, queryKeys.tripsList)).toBe(true);
    expect(client.getQueryData(queryKeys.trip(TRIP_B_ID))).toBeDefined();
  });

  it("trip.deleted while OUTSIDE evicts immediately with no exit", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);
    const deps = makeDeps(client, { currentTripId: TRIP_B_ID });

    const result = handleCollabEvent({ event: "trip.deleted", trip_id: TEST_TRIP_ID }, deps);

    expect(result).toEqual({ handled: true, forcedExit: false });
    expect(deps.onForcedExit).not.toHaveBeenCalled();
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
  });

  it("member.removed targeting ME while inside = forced exit + eviction; targeting another user = neither", async () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);
    const deps = makeDeps(client, { currentTripId: TEST_TRIP_ID });

    const bystander = handleCollabEvent(
      { event: "member.removed", trip_id: TEST_TRIP_ID, entity_id: OTHER_USER_ID },
      deps,
    );
    expect(bystander).toEqual({ handled: true, forcedExit: false });
    expect(deps.onForcedExit).not.toHaveBeenCalled();
    expect(client.getQueryData(queryKeys.trip(TEST_TRIP_ID))).toBeDefined();

    const removed = handleCollabEvent(
      { event: "member.removed", trip_id: TEST_TRIP_ID, entity_id: TEST_USER.id },
      deps,
    );
    expect(removed).toEqual({ handled: true, forcedExit: true });
    expect(deps.onForcedExit).toHaveBeenCalledTimes(1);
    await flushDeferredEvict();
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
  });

  it("member.removed targeting ME while OUTSIDE still evicts (membership gone — Law #3), no exit", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);
    const deps = makeDeps(client, { currentTripId: null });

    const result = handleCollabEvent(
      { event: "member.removed", trip_id: TEST_TRIP_ID, entity_id: TEST_USER.id },
      deps,
    );

    expect(result).toEqual({ handled: true, forcedExit: false });
    expect(deps.onForcedExit).not.toHaveBeenCalled();
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
  });
});

describe("evictTripSubtree", () => {
  it("removes detail + members + invites, leaving the list and other trips", () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);

    evictTripSubtree(client, TEST_TRIP_ID);

    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryState(queryKeys.tripMembers(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryState(queryKeys.tripInvites(TEST_TRIP_ID))).toBeUndefined();
    expect(client.getQueryData(queryKeys.trips)).toBeDefined();
    expect(client.getQueryData(queryKeys.trip(TRIP_B_ID))).toBeDefined();
  });
});

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useAppForegroundRefetch (R-tripui-3, foreground leg)", () => {
  it("AppState → active invalidates the whole trips family; other transitions don't; unmount unsubscribes", async () => {
    const listeners: ((status: string) => void)[] = [];
    const remove = jest.fn();
    (jest.spyOn(AppState, "addEventListener") as unknown as jest.Mock).mockImplementation(
      (_type: string, handler: (status: string) => void) => {
        listeners.push(handler);
        return { remove } as unknown as NativeEventSubscription;
      },
    );
    const client = makeTestQueryClient();
    seedTripFamily(client);

    const { unmount } = await renderHook(() => useAppForegroundRefetch(), {
      wrapper: makeWrapper(client),
    });
    expect(listeners).toHaveLength(1);

    await act(async () => listeners[0]?.("background"));
    expect(invalidated(client, queryKeys.trips)).toBe(false);

    await act(async () => listeners[0]?.("active"));
    // Lists via the helper (key-cache law) + one deliberately NON-exact
    // sweep of the ["trips", …] detail family.
    expect(invalidated(client, queryKeys.trips)).toBe(true);
    expect(invalidated(client, queryKeys.tripsList)).toBe(true);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(true);
    expect(invalidated(client, queryKeys.tripMembers(TEST_TRIP_ID))).toBe(true);

    await unmount();
    expect(remove).toHaveBeenCalled();
  });
});

describe("useScreenFocusRefetch (R-tripui-3, screen-focus leg)", () => {
  it("skips the initial focus (mount already fetches), then invalidates the targets + lists via the helper", async () => {
    const client = makeTestQueryClient();
    seedTripFamily(client);

    await renderHook(
      () =>
        useScreenFocusRefetch([{ queryKey: queryKeys.trip(TEST_TRIP_ID), exact: true }], {
          tripLists: true,
        }),
      { wrapper: makeWrapper(client) },
    );
    expect(mockFocusCallback).toBeDefined();

    // First focus = the mount — no refetch storm on top of initial queries.
    await act(async () => mockFocusCallback?.());
    expect(invalidated(client, queryKeys.trips)).toBe(false);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(false);

    // A REAL refocus invalidates exactly the screen's keys (lists through
    // the mandatory two-key helper — key-cache law).
    await act(async () => mockFocusCallback?.());
    expect(invalidated(client, queryKeys.trips)).toBe(true);
    expect(invalidated(client, queryKeys.tripsList)).toBe(true);
    expect(invalidated(client, queryKeys.trip(TEST_TRIP_ID))).toBe(true);
    expect(invalidated(client, queryKeys.trip(TRIP_B_ID))).toBe(false);
    expect(invalidated(client, queryKeys.tripMembers(TEST_TRIP_ID))).toBe(false);
  });
});
