/**
 * T-6.7 data module (CT-1/CT-2) — infinite trip list (real keyset paging),
 * create-trip mutation cache effects, destination place search gating. The
 * network boundary (`apiClient.request`) is the only thing mocked.
 */
import { placeEndpoints, tripEndpoints, type TripCreate } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import {
  isSearchableDestinationQuery,
  queryKeys,
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
