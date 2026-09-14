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

  it("destination coordinates ship as a pair — an unchanged name still ships both changed coordinates", () => {
    const patch = buildTripPatch(current, {
      destination_name: current.destination_name, // unchanged → omitted
      destination_lat: 34.6937,
      destination_lng: 135.5023,
    });
    expect(patch).not.toBeNull();
    expect(Object.keys(patch ?? {}).sort()).toEqual([
      "destination_lat",
      "destination_lng",
      "expect_updated_at",
    ]);
  });

  describe("round-1 A1: destination_lat/destination_lng diff as ONE PAIR, never independently", () => {
    // Reviewer's exact repro: two seeded destination-tier rows for
    // "Guéckédou" (apps/server/drizzle/0004_destination_tier_seed.sql)
    // share a latitude to full precision and differ only in longitude.
    const sameLat = 8.56164836883545;
    const rowA: Trip = {
      ...current,
      destination_lat: sameLat,
      destination_lng: -10.132828712463379,
    };
    const rowBLng = -10.132821083068848;

    it("a pick sharing the current latitude to full precision still ships BOTH keys, never a lone longitude", () => {
      const patch = buildTripPatch(rowA, {
        // destination_name omitted — unchanged, isolates the coordinate pair.
        destination_lat: sameLat, // identical to current — the independent-diff bug omitted this key
        destination_lng: rowBLng, // the only axis that actually changed
      });
      expect(patch).not.toBeNull();
      // Mutation-verify: revert `buildTripPatch` to diff `destination_lat`/
      // `destination_lng` independently (two separate `!==` guards) and this
      // assertion goes RED — the independent diff drops `destination_lat`
      // from the keys entirely, reproducing the half-pair 400
      // (`destinationCoordsPairRule`, packages/shared/src/domains/trip.ts).
      expect(Object.keys(patch ?? {}).sort()).toEqual([
        "destination_lat",
        "destination_lng",
        "expect_updated_at",
      ]);
      expect(patch?.destination_lat).toBe(sameLat);
      expect(patch?.destination_lng).toBe(rowBLng);
    });

    it("tri-state: both undefined = unchanged (no keys), both null = clear (both keys), both numbers = set (both keys)", () => {
      // undefined/undefined — the edits object never mentions the pair.
      expect(buildTripPatch(current, { name: "x" })?.destination_lat).toBeUndefined();
      expect(buildTripPatch(current, { name: "x" })?.destination_lng).toBeUndefined();

      // null/null against a non-null current — clears, both keys present.
      const clearPatch = buildTripPatch(current, {
        destination_lat: null,
        destination_lng: null,
      });
      expect(clearPatch?.destination_lat).toBeNull();
      expect(clearPatch?.destination_lng).toBeNull();

      // number/number against a different current — sets, both keys present.
      const setPatch = buildTripPatch(current, {
        destination_lat: 1.5,
        destination_lng: 2.5,
      });
      expect(setPatch?.destination_lat).toBe(1.5);
      expect(setPatch?.destination_lng).toBe(2.5);
    });
  });

  it("B-7 part 3: a NULL destination heals to real coordinates — the null-vs-number diff fires", () => {
    const coordless: Trip = { ...current, destination_lat: null, destination_lng: null };
    const patch = buildTripPatch(coordless, {
      destination_name: "Kyoto, Japan",
      destination_lat: 35.0116,
      destination_lng: 135.7681,
    });
    expect(patch).not.toBeNull();
    expect(patch?.destination_lat).toBe(35.0116);
    expect(patch?.destination_lng).toBe(135.7681);
  });

  it("B-7 part 3: picking ANOTHER coordinate-less custom place diffs null→null as unchanged (no key)", () => {
    const coordless: Trip = { ...current, destination_lat: null, destination_lng: null };
    // Falsification: this must stay a no-op patch on lat/lng specifically —
    // if the diff regressed to `!== undefined` alone (dropping the
    // value-equality check) it would wrongly emit `destination_lat: null`
    // even though nothing changed.
    const patch = buildTripPatch(coordless, {
      destination_name: "Somewhere Else",
      destination_lat: null,
      destination_lng: null,
    });
    expect(patch).not.toBeNull(); // destination_name DID change
    expect(patch?.destination_lat).toBeUndefined();
    expect(patch?.destination_lng).toBeUndefined();
  });

  it("B-7 part 3: a real destination going coordinate-less (re-picking a custom place) diffs number→null", () => {
    // Mutation-verify: comment out the null-arm of the `!==` comparison (or
    // coerce `edits.destination_lat` through `Number(...)`) and this reds —
    // `Number(null) === 0 !== current.destination_lat` would still diff, but
    // a naive `?? 0` default on the edits side would silently swallow it.
    const patch = buildTripPatch(current, {
      destination_name: "Nowhereville",
      destination_lat: null,
      destination_lng: null,
    });
    expect(patch).not.toBeNull();
    expect(patch?.destination_lat).toBeNull();
    expect(patch?.destination_lng).toBeNull();
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

  it("TripMutationOptions seam fires for a SUPERSEDED call (two-held-PATCH — per-call callbacks are dropped)", async () => {
    const trip = makePlanningTrip(TEST_TRIP_ID);
    const client = seededClient(trip);
    const request = spyRequest();
    const settlers: { resolve(row: Trip): void; reject(error: Error): void }[] = [];
    request.mockImplementation(
      () => new Promise((resolve, reject) => settlers.push({ resolve, reject })),
    );
    const onMutationError = jest.fn();
    const onMutationSuccess = jest.fn();

    const { result } = await renderHook(
      () => useUpdateTrip(TEST_TRIP_ID, { onMutationError, onMutationSuccess }),
      { wrapper: makeWrapper(client) },
    );
    // Two PATCHes on the shared instance; the second supersedes the first.
    await act(async () => {
      result.current.mutate({ name: "First", expect_updated_at: trip.updated_at });
    });
    await act(async () => {
      result.current.mutate({ theme: "deepWaters", expect_updated_at: trip.updated_at });
    });
    expect(settlers).toHaveLength(2);

    // The SUPERSEDED first call fails — v5 drops per-call callbacks for it,
    // so only the hook-level seam surfaces the error (the screen's triage).
    await act(async () => settlers[0]?.reject(new ApiRequestError(500, "INTERNAL", "boom")));
    await waitFor(() => expect(onMutationError).toHaveBeenCalledTimes(1));

    const returned: Trip = { ...trip, theme: "deepWaters", updated_at: "2026-07-21T00:00:00.000Z" };
    await act(async () => settlers[1]?.resolve(returned));
    await waitFor(() => expect(onMutationSuccess).toHaveBeenCalledTimes(1));
    // The seam hands the row AND the patch (the screen scopes its re-seed on it).
    expect(onMutationSuccess).toHaveBeenCalledWith(returned, {
      theme: "deepWaters",
      expect_updated_at: trip.updated_at,
    });
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
