/**
 * Trip-settings data layer (T-6.9 / CT-5). The load-bearing pins:
 * - buildTripPatch KEY-PRESENCE semantics — the server's owner-only authz
 *   fires on key presence (R-trips-20), so unchanged keys must never ride
 *   along, `{status: null}` must SURVIVE the diff (falsy-value pin, the T-6.1
 *   truthiness landmine), and `expect_updated_at` echoes the row's
 *   `updated_at` string verbatim (date_trunc-ms round-trip landmine);
 * - useUpdateTrip optimistic apply → reconcile → rollback (R-tripui-21),
 *   with the 409 discrimination (stale refetches, locked doesn't);
 * - delete/leave 404 convergence (§3.5 rule 3) + list invalidation.
 */
import { tripEndpoints, type Trip } from "@gogo/shared";
import { notifyManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";
import { queryKeys } from "@/data/query-client";
import {
  buildTripPatch,
  isBaseCurrencyLocked,
  isStaleUpdatedAt,
  useDeleteTrip,
  useUpdateTrip,
} from "@/data/trip-settings";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { makePlanningTrip } from "@/test-utils/trip-fixtures";

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Seeded caches with GC pinned off (observer-less entries, T-6.1 landmine). */
function seededClient(trip = makePlanningTrip(TEST_TRIP_ID)): QueryClient {
  const client = makeTestQueryClient();
  client.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { gcTime: Infinity });
  client.setQueryDefaults(queryKeys.trips, { gcTime: Infinity });
  client.setQueryDefaults(queryKeys.tripsList, { gcTime: Infinity });
  client.setQueryData(queryKeys.trip(TEST_TRIP_ID), trip);
  client.setQueryData(queryKeys.trips, { items: [trip], nextCursor: null });
  // Stand-in for the list screen's InfiniteData — only invalidation FLAGS
  // are asserted on it (the key-cache-law two-key pin).
  client.setQueryData(queryKeys.tripsList, {
    pages: [{ items: [trip], nextCursor: null }],
    pageParams: [undefined],
  });
  return client;
}

const stale409 = () =>
  new ApiRequestError(409, "CONFLICT", "the row changed since it was read", {
    reason: "stale_updated_at",
  });
const locked409 = () =>
  new ApiRequestError(409, "CONFLICT", "base currency is locked once the first expense exists", {
    reason: "base_currency_locked",
  });

// Synchronous TanStack notify for THIS suite — mutation-settle batches on
// setTimeout(0) can land inside a waitFor sleep window (un-act-wrapped;
// contention-only, B-2 family). Same cure as the trip-settings-form and
// members suites; module state is per test file.
beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("buildTripPatch (diffField semantics on the trip row)", () => {
  const current = makePlanningTrip(TEST_TRIP_ID);

  it("emits ONLY changed keys plus expect_updated_at, echoing updated_at verbatim", () => {
    const patch = buildTripPatch(current, {
      name: "Kyoto Reloaded",
      start_date: current.start_date, // untouched value → omitted
      end_date: current.end_date,
    });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch ?? {}).sort()).toEqual(["expect_updated_at", "name"]);
    // Verbatim string echo — never re-derived/re-formatted (T-6.1 landmine).
    expect(patch?.expect_updated_at).toBe(current.updated_at);
  });

  it("never smuggles the owner-only keys: same-value base_currency and status are omitted", () => {
    expect(buildTripPatch(current, { base_currency: current.base_currency })).toBeNull();
    // status compares against the OVERRIDE (null here) — clearing a clear row is a no-op.
    expect(buildTripPatch(current, { status: null })).toBeNull();
  });

  it("pins the falsy override clear: {status: null} survives the diff on an archived trip", () => {
    const archived: Trip = { ...current, status: "past", status_override: "past" };
    const patch = buildTripPatch(archived, { status: null });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch ?? {}).sort()).toEqual(["expect_updated_at", "status"]);
    expect(patch?.status).toBeNull();
  });

  it("theme null (back to app default) survives when a theme is set; no-ops when already default", () => {
    const themed: Trip = { ...current, theme: "deepWaters" };
    expect(buildTripPatch(themed, { theme: null })?.theme).toBeNull();
    expect(buildTripPatch(current, { theme: null })).toBeNull();
  });

  it("returns null when nothing changed — the caller must skip the request", () => {
    expect(
      buildTripPatch(current, {
        name: current.name,
        start_date: current.start_date,
        end_date: current.end_date,
      }),
    ).toBeNull();
  });
});

describe("409 discrimination", () => {
  it("matches only its own reason on a 409", () => {
    expect(isStaleUpdatedAt(stale409())).toBe(true);
    expect(isStaleUpdatedAt(locked409())).toBe(false);
    expect(isBaseCurrencyLocked(locked409())).toBe(true);
    expect(isBaseCurrencyLocked(stale409())).toBe(false);
    expect(isStaleUpdatedAt(new ApiRequestError(409, "CONFLICT", "no reason"))).toBe(false);
    expect(isStaleUpdatedAt(new ApiRequestError(500, "INTERNAL", "boom"))).toBe(false);
    expect(isStaleUpdatedAt(new Error("plain"))).toBe(false);
  });
});

describe("useUpdateTrip (optimistic per §2.6)", () => {
  it("applies optimistically, then reconciles with the returned row (role/member_count preserved)", async () => {
    const trip = makePlanningTrip(TEST_TRIP_ID);
    const client = seededClient(trip);
    const request = spyRequest();
    let resolvePatch: (row: Trip) => void = () => undefined;
    request.mockImplementation(() => new Promise((resolve) => (resolvePatch = resolve)));

    const { result } = await renderHook(() => useUpdateTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ theme: "deepWaters", expect_updated_at: trip.updated_at });
    });

    // Optimistic: both caches show the new theme before the server answers.
    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.theme).toBe("deepWaters");
    const page = client.getQueryData<{ items: (Trip & { role: string; member_count: number })[] }>(
      queryKeys.trips,
    );
    expect(page?.items[0]?.theme).toBe("deepWaters");
    expect(page?.items[0]?.role).toBe("owner");

    const returned: Trip = { ...trip, theme: "deepWaters", updated_at: "2026-07-20T10:00:00.000Z" };
    await act(async () => resolvePatch(returned));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const detail = client.getQueryData<Trip & { role: string }>(queryKeys.trip(TEST_TRIP_ID));
    expect(detail?.updated_at).toBe(returned.updated_at);
    expect(detail?.role).toBe("owner");
    const reconciled = client.getQueryData<{
      items: (Trip & { member_count: number })[];
    }>(queryKeys.trips);
    expect(reconciled?.items[0]?.updated_at).toBe(returned.updated_at);
    expect(reconciled?.items[0]?.member_count).toBe(1);
    // Re-sort/section placement: BOTH lists refetch after a save — the
    // mandatory invalidateTripLists two-key op (key-cache law, T-6.7 merge).
    expect(client.getQueryState(queryKeys.trips)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripsList)?.isInvalidated).toBe(true);
    expect(request).toHaveBeenCalledWith(tripEndpoints.updateTrip, {
      params: { tripId: TEST_TRIP_ID },
      body: { theme: "deepWaters", expect_updated_at: trip.updated_at },
    });
  });

  it("rolls back on failure; a STALE 409 additionally refetches detail + list", async () => {
    const trip = makePlanningTrip(TEST_TRIP_ID);
    const client = seededClient(trip);
    spyRequest().mockRejectedValue(stale409());

    const { result } = await renderHook(() => useUpdateTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ name: "Doomed", expect_updated_at: trip.updated_at });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.name).toBe(trip.name);
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.trips)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripsList)?.isInvalidated).toBe(true);
  });

  it("a LOCKED 409 rolls back WITHOUT refetching (the stored row never moved)", async () => {
    const trip = makePlanningTrip(TEST_TRIP_ID);
    const client = seededClient(trip);
    spyRequest().mockRejectedValue(locked409());

    const { result } = await renderHook(() => useUpdateTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate({ base_currency: "EUR", expect_updated_at: trip.updated_at });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData<Trip>(queryKeys.trip(TEST_TRIP_ID))?.base_currency).toBe("USD");
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.trips)?.isInvalidated).toBe(false);
    expect(client.getQueryState(queryKeys.tripsList)?.isInvalidated).toBe(false);
  });
});

describe("useDeleteTrip", () => {
  it("delete: fires DELETE /trips/:tripId and invalidates BOTH lists (helper)", async () => {
    const client = seededClient();
    const request = spyRequest();
    request.mockResolvedValue(undefined);

    const { result } = await renderHook(() => useDeleteTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledWith(tripEndpoints.deleteTrip, {
      params: { tripId: TEST_TRIP_ID },
    });
    expect(client.getQueryState(queryKeys.trips)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.tripsList)?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.trip(TEST_TRIP_ID))?.isInvalidated).toBe(false);
  });

  it("delete: a 404 answer converges to success (§3.5 rule 3 — someone else's delete won)", async () => {
    const client = seededClient();
    spyRequest().mockRejectedValue(new ApiRequestError(404, "NOT_FOUND", "not found"));

    const { result } = await renderHook(() => useDeleteTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  // Leave-trip is NOT a hook here — the settings screen rides T-6.8's
  // `useRemoveMember` with the caller's own userId (see trip-settings.ts);
  // the wire + navigation + eviction flow is pinned end-to-end in
  // __tests__/trip-settings-leave.test.tsx.
});
