/**
 * Map search hook (T-8.3 / MAP-2 — R-map-25). Load-bearing:
 *  - the 2-char floor gates the QUERY, not just the UI (a sub-floor request
 *    fired past the gate is a live server 400 — CT-2 doc);
 *  - every fired request carries the bbox geo bound + trip_id (the floor's
 *    LEGALITY — text-only 2-char is a 400 by schema);
 *  - the key extends the CT-2 `placeSearch` family with the map
 *    discriminator + tripId + the request's OWN bbox string, so map and
 *    destination caches never collide AND a moved destination can never
 *    serve another region's cached rows (review A1 — stale-region guard).
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
/** DESTINATION's cell-envelope bbox — the wire param AND the key member. */
const DESTINATION_BBOX = "135,34.5,136.5,36";

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
    expect(input.query["bbox"]).toBe(DESTINATION_BBOX);
  });

  it("keys under the CT-2 placeSearch family + map discriminator + tripId + bbox", async () => {
    const page: Paginated<Place> = { items: [], nextCursor: null };
    spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(CONTEXT, "ky"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // A1: the key carries the geo bound the request carried.
    const expectedKey = [...queryKeys.placeSearch("ky"), "map", TEST_TRIP_ID, DESTINATION_BBOX];
    expect(client.getQueryData(expectedKey)).toEqual(page);
    // Disjoint from the destination search's entry for the SAME q…
    expect(client.getQueryData(queryKeys.placeSearch("ky"))).toBeUndefined();
    // …and from the bbox-less key shape (nothing lives where a geo-unbound
    // entry could be served to any region).
    expect(
      client.getQueryData([...queryKeys.placeSearch("ky"), "map", TEST_TRIP_ID]),
    ).toBeUndefined();
  });

  it("A1 stale-region guard: a moved destination cannot present another region's cached rows", async () => {
    const client = makeTestQueryClient();
    const oldRegionPage: Paginated<Place> = { items: [makePlace()], nextCursor: null };
    // Seed the GEO-UNBOUND key shape — what a key that drops the bbox would
    // read for this q + trip regardless of destination. With the bbox in
    // the key this entry is unreachable (old entries just miss).
    client.setQueryData([...queryKeys.placeSearch("ky"), "map", TEST_TRIP_ID], oldRegionPage);

    // Hold the fresh request genuinely in flight (mobile.md: resolver ARRAY,
    // released in finally) — the discriminating window is BEFORE it lands.
    const resolvers: ((page: Paginated<Place>) => void)[] = [];
    spyRequest().mockImplementation(
      () =>
        new Promise<Paginated<Place>>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    // Same q, same trip — the destination has since moved (Auckland).
    const moved = { tripId: TEST_TRIP_ID, destination: { lat: -36.8485, lng: 174.7633 } };
    const { result } = await renderHook(() => useMapPlaceSearch(moved, "ky"), {
      wrapper: makeWrapper(client),
    });
    try {
      // While the fresh request pends, NOTHING presents: the old region's
      // rows are not this key's data.
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPending).toBe(true);
    } finally {
      for (const resolve of resolvers) resolve({ items: [], nextCursor: null });
    }
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
