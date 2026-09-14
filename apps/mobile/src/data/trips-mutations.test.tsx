/**
 * T-6.7 data module (CT-1/CT-2) — infinite trip list (real keyset paging),
 * create-trip mutation cache effects, destination place search gating. The
 * network boundary (`apiClient.request`) is the only thing mocked.
 */
import { placeEndpoints, tripEndpoints, type TripCreate } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";
import {
  isNonBlankDestinationQuery,
  isSearchableDestinationQuery,
  queryKeys,
  useCreateCustomDestination,
  useCreateTrip,
  usePlaceSearch,
  useTripList,
} from "@/data";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { makePlace, makePlanningTrip } from "@/test-utils/trip-fixtures";

const PLACE = makePlace();

/** Cast away the descriptor generics so mockResolvedValue accepts any payload. */
function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useTripList (CT-1 — real pagination)", () => {
  it("fetches the first page with no cursor and exposes it as pages[0]", async () => {
    const request = spyRequest();
    const page = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: null };
    request.mockResolvedValue(page);
    const { result, unmount } = await renderHook(() => useTripList(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.pages).toEqual([page]);
    expect(result.current.hasNextPage).toBe(false);
    expect(request).toHaveBeenCalledWith(
      tripEndpoints.listTrips,
      { query: {} },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });

  it("round-trips nextCursor as ?cursor= on fetchNextPage and stops at null", async () => {
    const request = spyRequest();
    const page1 = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: "cur-1" };
    const page2 = { items: [makePlanningTrip(TRIP_B_ID)], nextCursor: null };
    request.mockImplementation((_d: unknown, input: { query?: { cursor?: string } }) =>
      Promise.resolve(input.query?.cursor === "cur-1" ? page2 : page1),
    );
    const { result, unmount } = await renderHook(() => useTripList(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.fetchNextPage();
    });

    expect(request).toHaveBeenCalledWith(
      tripEndpoints.listTrips,
      { query: { cursor: "cur-1" } },
      { signal: expect.any(AbortSignal) },
    );
    // The append notification can land a macrotask after act — poll it.
    await waitFor(() => expect(result.current.data?.pages).toEqual([page1, page2]));
    expect(result.current.hasNextPage).toBe(false);
    await unmount();
  });
});

describe("useCreateTrip (CT-2)", () => {
  const input: TripCreate = {
    name: "Kyoto",
    destination_name: "Kyoto",
    destination_lat: PLACE.lat,
    destination_lng: PLACE.lng,
    start_date: "2027-05-01",
    end_date: "2027-05-08",
    base_currency: "USD",
  };

  it("POSTs the body, seeds the detail cache, and invalidates BOTH list keys exactly", async () => {
    const request = spyRequest();
    const created = makePlanningTrip(TEST_TRIP_ID);
    request.mockResolvedValue(created);
    const client = makeTestQueryClient();
    // T-6.1 landmine: the onSuccess seed lands with no observer mounted —
    // under the harness's gcTime:0 the assert races immediate GC; Infinity
    // per-key removes the timer entirely.
    client.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { gcTime: Infinity });
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result, unmount } = await renderHook(() => useCreateTrip(), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync(input);
    });

    expect(request).toHaveBeenCalledWith(tripEndpoints.createTrip, { body: input });
    expect(client.getQueryData(queryKeys.trip(TEST_TRIP_ID))).toEqual(created);
    // R1: ONE canonical two-key invalidation (invalidateTripLists) with
    // refetchType "none" — the list's guaranteed focus refetch on return
    // does the work; an eager refetch here would be a redundant RTT.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.trips,
      exact: true,
      refetchType: "none",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tripsList,
      exact: true,
      refetchType: "none",
    });
    // NEVER a bare ["trips"] prefix invalidate — it would match every
    // ["trips", id] detail key and refetch-loop the [tripId] guard (T-6.6).
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: queryKeys.trips, exact: false }),
    );
    await unmount();
  });
});

describe("key-namespace disjointness (R1 blocker 1, extended over the T-6.8 merge)", () => {
  it("no route-param-driven factory key can alias OR prefix-cover the trip-list root", () => {
    // The guard's key space is arbitrary URL segments, and its 404-scrub
    // removes by PREFIX over trip(param) — so for adversarial params, every
    // param-driven factory key must neither EQUAL queryKeys.tripsList nor be
    // a PREFIX of it. Covers T-6.8's factories (tripMembers/tripInvites/
    // invitePreview) so future factory additions inherit the check pattern.
    const adversarialParams = ["list", "trip-list", "infinite", TEST_TRIP_ID];
    const factories = [
      queryKeys.trip,
      queryKeys.tripMembers,
      queryKeys.tripInvites,
      queryKeys.invitePreview,
    ];
    const listKey: readonly unknown[] = queryKeys.tripsList;
    for (const param of adversarialParams) {
      for (const factory of factories) {
        const key: readonly unknown[] = factory(param);
        expect(JSON.stringify(key)).not.toBe(JSON.stringify(listKey));
        // key is a prefix of listKey ⇔ listKey.slice(0, key.length) equals it
        expect(JSON.stringify(listKey.slice(0, key.length))).not.toBe(JSON.stringify(key));
      }
    }
  });
});

describe("useTripList cold-start seed (R1 perf)", () => {
  it("seeds the infinite cache from the entry redirect's ['trips'] page — rows render with no list request settled", async () => {
    const request = spyRequest();
    // The list's own fetch never settles: any rendered rows can only have
    // come from the seed. (The harness client's staleTime 0 marks the seed
    // stale so a background refetch fires — prod's 5-min staleTime plus the
    // carried dataUpdatedAt is what suppresses it on real cold starts.)
    request.mockImplementation(() => new Promise(() => undefined));
    const client = makeTestQueryClient();
    const page = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: null };
    client.setQueryData(queryKeys.trips, page);

    const { result, unmount } = await renderHook(() => useTripList(), {
      wrapper: makeWrapper(client),
    });

    expect(result.current.data?.pages).toEqual([page]);
    expect(result.current.status).toBe("success");
    await unmount();
  });

  it("starts empty (pending) when no redirect page is cached", async () => {
    const request = spyRequest();
    request.mockImplementation(() => new Promise(() => undefined));
    const { result, unmount } = await renderHook(() => useTripList(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });
    expect(result.current.status).toBe("pending");
    await unmount();
  });
});

describe("usePlaceSearch (CT-2 — destination search)", () => {
  it("mirrors the shared text-only floor: <4 chars never fires", async () => {
    const request = spyRequest();
    const { result, unmount } = await renderHook(() => usePlaceSearch("Kyo"), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });
    expect(result.current.status).toBe("pending");
    expect(request).not.toHaveBeenCalled();
    expect(isSearchableDestinationQuery("Kyo")).toBe(false);
    expect(isSearchableDestinationQuery("Kyot")).toBe(true);
    // Whitespace padding doesn't sneak past the floor (schema trims).
    expect(isSearchableDestinationQuery("  Kyo  ")).toBe(false);
    await unmount();
  });

  it("fires GET /places/search with the trimmed q at ≥4 chars", async () => {
    const request = spyRequest();
    request.mockResolvedValue({ items: [PLACE], nextCursor: null });
    const { result, unmount } = await renderHook(() => usePlaceSearch("  Kyoto "), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items).toEqual([PLACE]);
    expect(request).toHaveBeenCalledWith(
      placeEndpoints.searchPlaces,
      { query: { q: "Kyoto" } },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });
});

describe("isNonBlankDestinationQuery (B-7 — the empty-results row's own gate)", () => {
  it("rejects empty and whitespace-only, accepts anything else after trim", () => {
    expect(isNonBlankDestinationQuery("")).toBe(false);
    expect(isNonBlankDestinationQuery("   ")).toBe(false);
    expect(isNonBlankDestinationQuery("\t\n")).toBe(false);
    expect(isNonBlankDestinationQuery("a")).toBe(true);
    expect(isNonBlankDestinationQuery("  Nowhereville  ")).toBe(true);
  });
});

describe("useCreateCustomDestination (B-7 — empty-results fallback, R-tripui-23)", () => {
  const CUSTOM = makePlace({
    id: "77777777-7777-4777-8777-777777777777",
    source: "custom",
    source_id: null,
    name: "Nowhereville",
    category: null,
    created_by: "11111111-1111-4111-8111-111111111111",
  });

  it("POSTs exactly {name, lat: 0, lng: 0} trimmed — Law #3: the wire shape has no visibility field to widen", async () => {
    const request = spyRequest();
    request.mockResolvedValue(CUSTOM);
    const { result, unmount } = await renderHook(() => useCreateCustomDestination(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync("  Nowhereville  ");
    });

    expect(request).toHaveBeenCalledWith(placeEndpoints.createPlace, {
      body: { name: "Nowhereville", lat: 0, lng: 0 },
    });
    // Falsifies if a future edit rides `category`/`trip_id`/a visibility
    // field along: the key set must stay EXACTLY the schema's own shape.
    const body = (request.mock.calls[0][1] as { body: Record<string, unknown> }).body;
    expect(Object.keys(body).sort()).toEqual(["lat", "lng", "name"]);
    expect(returned).toEqual(CUSTOM);
    await unmount();
  });

  it("fires the hook-level onMutationSuccess seam with the created place", async () => {
    const request = spyRequest();
    request.mockResolvedValue(CUSTOM);
    const onMutationSuccess = jest.fn();
    const { result, unmount } = await renderHook(
      () => useCreateCustomDestination({ onMutationSuccess }),
      { wrapper: makeWrapper(makeTestQueryClient()) },
    );

    await act(async () => {
      await result.current.mutateAsync("Nowhereville");
    });

    expect(onMutationSuccess).toHaveBeenCalledWith(CUSTOM);
    await unmount();
  });

  it("surfaces a create failure untouched (the REAL ApiRequestError, not a stub) and fires onMutationError", async () => {
    const request = spyRequest();
    const failure = new ApiRequestError(409, "CONFLICT", "boom");
    request.mockRejectedValue(failure);
    const onMutationError = jest.fn();
    const { result, unmount } = await renderHook(
      () => useCreateCustomDestination({ onMutationError }),
      { wrapper: makeWrapper(makeTestQueryClient()) },
    );

    await act(async () => {
      await expect(result.current.mutateAsync("Nowhereville")).rejects.toBe(failure);
    });

    expect(onMutationError).toHaveBeenCalledWith(failure);
    await unmount();
  });
});

describe("useCreateCustomDestination cache invalidation (B-7 review R1 B2, blocking)", () => {
  const NOWHEREVILLE = makePlace({
    id: "88888888-8888-4888-8888-888888888888",
    source: "custom",
    source_id: null,
    name: "Nowhereville",
    lat: 0,
    lng: 0,
    category: null,
    created_by: "11111111-1111-4111-8111-111111111111",
  });

  it("invalidates the place-search family so a just-created place is not re-offered under PROD staleTime", async () => {
    let searchCalls = 0;
    const request = spyRequest();
    request.mockImplementation((descriptor: unknown) => {
      if (descriptor === placeEndpoints.searchPlaces) {
        searchCalls += 1;
        // Call 1 (pre-create): genuinely empty. Call 2 (post-invalidation
        // refetch): the place now exists — this is what an un-invalidated
        // 5-min-fresh cache would NEVER re-fetch to discover.
        return Promise.resolve(
          searchCalls === 1
            ? { items: [], nextCursor: null }
            : { items: [NOWHEREVILLE], nextCursor: null },
        );
      }
      if (descriptor === placeEndpoints.createPlace) {
        return Promise.resolve(NOWHEREVILLE);
      }
      return Promise.reject(new Error("unexpected request"));
    });

    const client = makeTestQueryClient();
    // A1 advisory: the harness's global staleTime:0 makes this whole defect
    // class invisible — apply PROD staleTime to exactly the places/search
    // family so the pin actually exercises the "stale empty page" bug.
    client.setQueryDefaults(queryKeys.placeSearchRoot, { staleTime: 1000 * 60 * 5 });
    const wrapper = makeWrapper(client);

    const search = await renderHook(() => usePlaceSearch("Nowhereville"), { wrapper });
    await waitFor(() => expect(search.result.current.isSuccess).toBe(true));
    expect(search.result.current.data?.items).toEqual([]);

    const create = await renderHook(() => useCreateCustomDestination(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync("Nowhereville");
    });

    // Falsification: comment out the `invalidateQueries` call in the hook's
    // onSuccess and this waitFor times out — the mounted search observer
    // keeps serving the pre-create empty page for the rest of prod's 5-min
    // staleTime window, and `searchCalls` never advances past 1.
    await waitFor(() => expect(search.result.current.data?.items).toEqual([NOWHEREVILLE]));
    expect(searchCalls).toBe(2);

    await search.unmount();
    await create.unmount();
  });
});
