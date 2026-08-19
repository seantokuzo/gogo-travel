/**
 * Map search hook (T-8.3 / MAP-2 — R-map-25). Load-bearing:
 *  - the 2-char floor gates the QUERY, not just the UI (a sub-floor request
 *    fired past the gate is a live server 400 — CT-2 doc);
 *  - every fired request carries the bbox geo bound + trip_id (the floor's
 *    LEGALITY — text-only 2-char is a 400 by schema);
 *  - the key extends the CT-2 `placeSearch` family with the map
 *    discriminator + tripId so map and destination caches never collide.
 */
import { placeEndpoints, type Paginated, type Place } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import { queryKeys } from "@/data/query-client";
import { isSearchableMapQuery, useMapPlaceSearch } from "@/features/map/map-search";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { makePlace } from "@/test-utils/trip-fixtures";

const DESTINATION = { lat: 35.0116, lng: 135.7681 };
const CONTEXT = { tripId: TEST_TRIP_ID, destination: DESTINATION };

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

describe("isSearchableMapQuery (R-map-25 floor)", () => {
  it.each([
    ["", false],
    [" ", false],
    ["k", false],
    [" k ", false],
    ["ky", true],
    ["  ky  ", true],
    ["kyoto", true],
  ])("%j → %s", (raw, expected) => {
    expect(isSearchableMapQuery(raw)).toBe(expected);
  });
});

describe("useMapPlaceSearch", () => {
  it("below the floor: no request fires (the gate IS the client floor)", async () => {
    const request = spyRequest();
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(CONTEXT, "k"), {
      wrapper: makeWrapper(client),
    });

    expect(request).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });

  it("at the floor: fires the descriptor with q + bbox + trip_id + limit", async () => {
    const page: Paginated<Place> = { items: [makePlace()], nextCursor: null };
    const request = spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(CONTEXT, "  ky  "), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledTimes(1);
    const [descriptor, input] = request.mock.calls[0] as [unknown, { query: Record<string, unknown> }];
    expect(descriptor).toBe(placeEndpoints.searchPlaces);
    expect(input.query["q"]).toBe("ky"); // trimmed + NFC
    expect(input.query["trip_id"]).toBe(TEST_TRIP_ID);
    expect(input.query["limit"]).toBe(20);
    // The legality bound: 1.5°-per-axis destination-region box, wire order.
    expect(input.query["bbox"]).toBe("135,34.5,136.5,36");
  });

  it("keys under the CT-2 placeSearch family + map discriminator + tripId", async () => {
    const page: Paginated<Place> = { items: [], nextCursor: null };
    spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(CONTEXT, "ky"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const expectedKey = [...queryKeys.placeSearch("ky"), "map", TEST_TRIP_ID];
    expect(client.getQueryData(expectedKey)).toEqual(page);
    // Disjoint from the destination search's entry for the SAME q.
    expect(client.getQueryData(queryKeys.placeSearch("ky"))).toBeUndefined();
  });
});
