/**
 * Places data-layer pins (T-8.2 / MAP-1). Load-bearing cases:
 *  - KEY-CACHE LAW: `tripSavedPlaces` joins the `["trips", tripId, …]`
 *    DETAIL subtree (never `["trip-list"]`, never a foreign root) so the
 *    guard's 404-scrub + `evictTripSubtree` prefix removal reach it.
 *  - The hook requests the PL-4 descriptor at the full-pin-set page limit
 *    and surfaces the page's items.
 *
 * apiClient spy per the members/bookings test pattern.
 */
import { placeEndpoints, type Paginated, type SavedPlaceWithPlace } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import { useSavedPlaces } from "@/data/places";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { makeSavedPlaceWithPlace } from "@/test-utils/trip-fixtures";

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

it("tripSavedPlaces joins the trip-detail subtree (KEY-CACHE LAW)", () => {
  expect(queryKeys.tripSavedPlaces(TEST_TRIP_ID)).toEqual([
    "trips",
    TEST_TRIP_ID,
    "saved-places",
  ]);
  // Prefix relationship the eviction machinery depends on: the detail key
  // is a strict prefix of the saved-places key.
  const detail = queryKeys.trip(TEST_TRIP_ID);
  expect(queryKeys.tripSavedPlaces(TEST_TRIP_ID).slice(0, detail.length)).toEqual([...detail]);
});

it("fetches the saved-places page through the PL-4 descriptor and caches under the detail key", async () => {
  const saved = makeSavedPlaceWithPlace();
  const page: Paginated<SavedPlaceWithPlace> = { items: [saved], nextCursor: null };
  const request = spyRequest().mockResolvedValue(page);
  const client = makeTestQueryClient();

  const { result } = await renderHook(() => useSavedPlaces(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.items).toEqual([saved]);
  expect(request).toHaveBeenCalledWith(
    placeEndpoints.listSavedPlaces,
    { params: { tripId: TEST_TRIP_ID }, query: { limit: 100 } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(client.getQueryData(queryKeys.tripSavedPlaces(TEST_TRIP_ID))).toEqual(page);
});

it("surfaces a fetch failure as error state (screen banner arm)", async () => {
  spyRequest().mockRejectedValue(new Error("boom"));
  const { result } = await renderHook(() => useSavedPlaces(TEST_TRIP_ID), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
});
