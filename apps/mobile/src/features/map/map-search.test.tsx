/**
 * Map search hook (T-8.3 / MAP-2 — R-map-25). Load-bearing:
 *  - the ABSOLUTE 2-char floor (`PLACES_SEARCH_MIN_CHARS`) gates the QUERY,
 *    not just the UI — a `q` shorter than it fired past the gate is still a
 *    live server 400 (VALIDATION_FAILED — CT-2 doc). B-7 review R1
 *    (BLOCKING × 3 lanes): this floor now applies UNBOUNDED too (no bbox) —
 *    a 2-3-char text-only query is no longer a live 400 (R-places-28); the
 *    server, not this gate, picks the arm;
 *  - every fired request carries the bbox geo bound (when bounded) + trip_id
 *    AND forwards TanStack's abort signal (T-6.6 posture —
 *    cancel-on-clear/unmount must reach the transport; review A10);
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
import {
  isSearchableMapQuery,
  mapSearchMinChars,
  useMapPlaceSearch,
} from "@/features/map/map-search";
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

describe("mapSearchMinChars / isSearchableMapQuery (R-map-25 floor, B-7 part 3 R-map-26)", () => {
  it("is 2 with a geo bound, and 2 (the shared ABSOLUTE floor) without one — B-7 review R1: this used to be 4 (PLACES_SEARCH_TEXT_ONLY_MIN_CHARS) without a bbox, which is what left a coordinate-less trip's map search unreachable below 4 chars (falsification: reverting mapSearchMinChars's null-destination branch to PLACES_SEARCH_TEXT_ONLY_MIN_CHARS turns this red)", () => {
    expect(mapSearchMinChars(DESTINATION)).toBe(2);
    expect(mapSearchMinChars(null)).toBe(2);
  });

  it.each([
    ["", false],
    [" ", false],
    ["k", false],
    [" k ", false],
    ["ky", true],
    ["  ky  ", true],
    ["kyoto", true],
  ])("bounded: %j → %s", (raw, expected) => {
    expect(isSearchableMapQuery(raw, DESTINATION)).toBe(expected);
  });

  // B-7 review R1: a coordinate-less trip now gates at the SAME absolute
  // floor as the bbox-bound case — the server, not this client, picks the
  // arm for a sub-PLACES_SEARCH_TEXT_ONLY_MIN_CHARS text-only query
  // (R-places-28). Falsification: reverting to the old wider floor turns
  // "ky"/"kyo" back to false here.
  it.each([
    ["", false],
    ["k", false],
    ["ky", true],
    ["kyo", true],
    ["kyot", true],
    ["  kyot  ", true],
    ["kyoto", true],
  ])("unbounded (destination null): %j → %s", (raw, expected) => {
    expect(isSearchableMapQuery(raw, null)).toBe(expected);
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
    const [descriptor, input, options] = request.mock.calls[0] as [
      unknown,
      { query: Record<string, unknown> },
      { signal?: AbortSignal } | undefined,
    ];
    expect(descriptor).toBe(placeEndpoints.searchPlaces);
    // A10: the abort signal reaches the transport call.
    expect(options?.signal).toBeInstanceOf(AbortSignal);
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

describe("useMapPlaceSearch — coordinate-less trip (B-7 part 3, R-map-26)", () => {
  const NO_DEST_CONTEXT = { tripId: TEST_TRIP_ID, destination: null };

  it("below the ABSOLUTE 2-char floor (1 char): no request fires", async () => {
    const request = spyRequest();
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(NO_DEST_CONTEXT, "k"), {
      wrapper: makeWrapper(client),
    });

    expect(request).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });

  it("B-7 review R1 fix: fires at the ABSOLUTE 2-char floor with q + trip_id + limit and NO bbox key at all — this used to require 4 chars (falsification: reverting mapSearchMinChars's null-destination branch to PLACES_SEARCH_TEXT_ONLY_MIN_CHARS turns this back to zero requests)", async () => {
    const page: Paginated<Place> = { items: [makePlace()], nextCursor: null };
    const request = spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(NO_DEST_CONTEXT, "  ky  "), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledTimes(1);
    const [, input] = request.mock.calls[0] as [unknown, { query: Record<string, unknown> }];
    expect(input.query["q"]).toBe("ky");
    expect(input.query["trip_id"]).toBe(TEST_TRIP_ID);
    expect(input.query["limit"]).toBe(20);
    // Falsification: sending a `bbox` key here (even `undefined`) would be a
    // structural regression back toward the Null Island bbox this fixes —
    // the request must carry NO bbox key at all, not just a falsy one.
    expect("bbox" in input.query).toBe(false);
  });

  it("at 4+ chars (trigram arm): still fires with q + trip_id + limit and NO bbox key at all (unchanged)", async () => {
    const page: Paginated<Place> = { items: [makePlace()], nextCursor: null };
    const request = spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(NO_DEST_CONTEXT, "  kyot  "), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(request).toHaveBeenCalledTimes(1);
    const [, input] = request.mock.calls[0] as [unknown, { query: Record<string, unknown> }];
    expect(input.query["q"]).toBe("kyot");
    expect(input.query["trip_id"]).toBe(TEST_TRIP_ID);
    expect(input.query["limit"]).toBe(20);
    expect("bbox" in input.query).toBe(false);
  });

  it("keys the bbox slot with the literal 'no-bbox' marker — never collides with a real bbox key", async () => {
    const page: Paginated<Place> = { items: [], nextCursor: null };
    spyRequest().mockResolvedValue(page);
    const client = makeTestQueryClient();

    const { result } = await renderHook(() => useMapPlaceSearch(NO_DEST_CONTEXT, "kyot"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const expectedKey = [...queryKeys.placeSearch("kyot"), "map", TEST_TRIP_ID, "no-bbox"];
    expect(client.getQueryData(expectedKey)).toEqual(page);
  });

  it("a trip HEALED to real coordinates (settings remediation) is a cache MISS, never a stale unbounded hit", async () => {
    const client = makeTestQueryClient();
    // Seed the unbounded entry a coordinate-less trip would have cached.
    client.setQueryData([...queryKeys.placeSearch("kyot"), "map", TEST_TRIP_ID, "no-bbox"], {
      items: [makePlace({ id: "stale-unbounded-hit" })],
      nextCursor: null,
    } satisfies Paginated<Place>);

    const page: Paginated<Place> = { items: [makePlace()], nextCursor: null };
    const request = spyRequest().mockResolvedValue(page);
    const { result } = await renderHook(
      () => useMapPlaceSearch({ ...NO_DEST_CONTEXT, destination: DESTINATION }, "kyot"),
      {
        wrapper: makeWrapper(client),
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The healed trip's bounded key is a real bbox string, disjoint from
    // "no-bbox" — it never sees the stale unbounded page.
    expect(result.current.data?.items).toEqual(page.items);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
