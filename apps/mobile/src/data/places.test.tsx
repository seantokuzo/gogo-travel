/**
 * Places data-layer pins (T-8.2 / MAP-1 list read · T-8.4 / MAP-3 detail +
 * mutations). Load-bearing cases:
 *  - KEY-CACHE LAW: `tripSavedPlaces` joins the `["trips", tripId, …]`
 *    DETAIL subtree (never `["trip-list"]`, never a foreign root) so the
 *    guard's 404-scrub + `evictTripSubtree` prefix removal reach it —
 *    while `placeDetail`/`placeFresh` are PINNED OUTSIDE it (global spine
 *    reads; trip access loss must not evict them).
 *  - The list hook requests the PL-4 descriptor at the server page cap and
 *    follows `nextCursor` to exhaustion (R1 review: one page silently
 *    dropped pins >100 and their itinerary twins).
 *  - The §2.4 fetch-fresh contract (R-map-9): spec-verbatim key,
 *    staleTime 0 / gcTime 0 / retry false, `fresh=true` on the wire, cache
 *    entry EVAPORATES after use (the no-persister world's equivalent of
 *    "the persister snapshot contains no place-fresh entry").
 *  - R-map-11 save/unsave: optimistic against the ACCUMULATED list shape,
 *    reconcile-to-server-row, rollback + invalidate on failure, and
 *    409 ≡ success (R-places-16 client half).
 *
 * apiClient spy per the members/bookings test pattern.
 */
import {
  placeEndpoints,
  type Paginated,
  type PlaceDetails,
  type SavedPlaceWithPlace,
} from "@gogo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";
import {
  findSavedPlace,
  optimisticSavedPlaceId,
  usePlace,
  usePlaceFresh,
  useSavedPlaces,
  useSavePlace,
  useUnsavePlace,
  useUpdateSavedPlaceNote,
} from "@/data/places";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { makePlace, makeSavedPlaceWithPlace, TEST_PLACE_ID } from "@/test-utils/trip-fixtures";

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const SAVED_ROW_ID = "55555555-5555-4555-8555-555555555551";
const SAVED_ROW_B_ID = "55555555-5555-4555-8555-555555555552";
const PLACE_B_ID = "44444444-4444-4444-8444-444444444442";

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Keys (KEY-CACHE LAW)
// ---------------------------------------------------------------------------

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

it("placeDetail and placeFresh live OUTSIDE the trips subtree — global reads the 404-scrub must not evict", () => {
  expect(queryKeys.placeDetail(TEST_PLACE_ID)).toEqual(["places", "detail", TEST_PLACE_ID]);
  expect(queryKeys.placeFresh(TEST_PLACE_ID)).toEqual(["place-fresh", TEST_PLACE_ID]);
  // §2.4 names the fresh key VERBATIM; neither may root under ["trips", …].
  expect(queryKeys.placeDetail(TEST_PLACE_ID)[0]).not.toBe("trips");
  expect(queryKeys.placeFresh(TEST_PLACE_ID)[0]).not.toBe("trips");
});

// ---------------------------------------------------------------------------
// Saved-places list read (T-8.2)
// ---------------------------------------------------------------------------

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

it("follows nextCursor to exhaustion: >1 page accumulates EVERY row (R1 review)", async () => {
  const first = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID });
  const second = makeSavedPlaceWithPlace({ id: SAVED_ROW_B_ID });
  // Paging fake: page 1 (no cursor) hands back a nextCursor; page 2 ends it.
  const request = spyRequest().mockImplementation(
    (_descriptor: unknown, input: { query?: { cursor?: string } }) =>
      input.query?.cursor === undefined
        ? Promise.resolve({ items: [first], nextCursor: "cursor-2" })
        : Promise.resolve({ items: [second], nextCursor: null }),
  );
  const client = makeTestQueryClient();

  const { result } = await renderHook(() => useSavedPlaces(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // Both pages surfaced, in order — the >100-pin trip loses nothing.
  expect(result.current.data).toEqual({ items: [first, second], nextCursor: null });
  expect(request).toHaveBeenCalledTimes(2);
  // The opaque cursor round-trips verbatim as `?cursor=` (§3.5).
  expect(request).toHaveBeenNthCalledWith(
    2,
    placeEndpoints.listSavedPlaces,
    { params: { tripId: TEST_TRIP_ID }, query: { limit: 100, cursor: "cursor-2" } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it("surfaces a fetch failure as error state (screen banner arm)", async () => {
  spyRequest().mockRejectedValue(new Error("boom"));
  const { result } = await renderHook(() => useSavedPlaces(TEST_TRIP_ID), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
});

it("findSavedPlace resolves by place_id — and misses honestly", () => {
  const row = makeSavedPlaceWithPlace();
  const page: Paginated<SavedPlaceWithPlace> = { items: [row], nextCursor: null };
  expect(findSavedPlace(page, TEST_PLACE_ID)).toBe(row);
  expect(findSavedPlace(page, PLACE_B_ID)).toBeUndefined();
  expect(findSavedPlace(undefined, TEST_PLACE_ID)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// usePlace — the spine detail read (T-8.4)
// ---------------------------------------------------------------------------

it("usePlace requests the PL-3 descriptor WITHOUT the fresh param and caches under placeDetail", async () => {
  const details: PlaceDetails = { place: makePlace() };
  const request = spyRequest().mockResolvedValue(details);
  const client = makeTestQueryClient();

  const { result } = await renderHook(() => usePlace(TEST_PLACE_ID), {
    wrapper: makeWrapper(client),
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(request).toHaveBeenCalledWith(
    placeEndpoints.getPlace,
    { params: { placeId: TEST_PLACE_ID }, query: {} },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(client.getQueryData(queryKeys.placeDetail(TEST_PLACE_ID))).toEqual(details);
});

it("usePlace enabled:false issues no request (the empty-param screen guard)", async () => {
  const request = spyRequest().mockResolvedValue({ place: makePlace() });
  await renderHook(() => usePlace("", { enabled: false }), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  expect(request).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// usePlaceFresh — the §2.4 fetch-fresh contract (R-map-9/10)
// ---------------------------------------------------------------------------

/**
 * LIBRARY-DEFAULT client for the fresh pins — deliberately NOT
 * `makeTestQueryClient`: its `gcTime: 0` / `retry: false` DEFAULTS satisfy
 * the very §2.4 config under pin, so against it the evaporation and
 * retry-count tests stay green with the hook's own options deleted
 * (mutation-probed 2026-08-19 — the probe could not go red). A bare client
 * (gcTime 5 min, retry 3× defaults) makes the hook's config the only thing
 * that can pass these pins.
 */
function libraryDefaultClient(): QueryClient {
  return new QueryClient();
}

it("usePlaceFresh sends fresh=true, selects the fresh block, and carries the §2.4 config", async () => {
  const details: PlaceDetails = {
    place: makePlace({ source: "fsq_os", source_id: "fsq-1" }),
    fresh: {
      fetched_at: "2026-08-18T00:00:00.000Z",
      attribution: { text: "Powered by Foursquare", logo_required: false, url: "https://foursquare.com" },
      fields: { hours: "9–17", open_now: true },
    },
  };
  const request = spyRequest().mockResolvedValue(details);
  const client = libraryDefaultClient();

  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: true }), {
    wrapper: makeWrapper(client),
  });

  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(request).toHaveBeenCalledWith(
    placeEndpoints.getPlace,
    { params: { placeId: TEST_PLACE_ID }, query: { fresh: "true" } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  // select narrows to the fresh block — render-only props.
  expect(result.current.data).toEqual(details.fresh);

  // The §2.4 config sits on the live query itself, not just our source text
  // — against library defaults, so only the HOOK can have set these. (The
  // public `Query["options"]` type omits per-query staleTime — structural
  // read of the live options object.)
  const query = client.getQueryCache().find({ queryKey: queryKeys.placeFresh(TEST_PLACE_ID) });
  const options = query?.options as { staleTime?: unknown; gcTime?: unknown } | undefined;
  expect(options?.staleTime).toBe(0);
  expect(options?.gcTime).toBe(0);
});

it("usePlaceFresh: absent fresh block selects to null (R-map-10 — silent absence, not an error)", async () => {
  spyRequest().mockResolvedValue({
    place: makePlace(),
    fresh_unavailable_reason: "disabled",
  } satisfies PlaceDetails);
  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: true }), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});

it("usePlaceFresh: retry:false — ONE request then error state (degrade, never hammer a metered upstream)", async () => {
  // Library-default client: its retry default is 3× — the single call below
  // can only come from the HOOK's retry:false.
  const request = spyRequest().mockRejectedValue(new ApiRequestError(502, "UNKNOWN", "upstream"));
  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: true }), {
    wrapper: makeWrapper(libraryDefaultClient()),
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(request).toHaveBeenCalledTimes(1);
});

it("usePlaceFresh: the cache entry EVAPORATES once unobserved (gcTime 0 — nothing survives to persist)", async () => {
  spyRequest().mockResolvedValue({
    place: makePlace(),
    fresh: {
      fetched_at: "2026-08-18T00:00:00.000Z",
      attribution: { text: "Powered by Foursquare", logo_required: false, url: "https://foursquare.com" },
      fields: {},
    },
  } satisfies PlaceDetails);
  // Library-default client (gcTime 5 min default): evaporation below can
  // only come from the HOOK's gcTime 0.
  const client = libraryDefaultClient();
  const { result, unmount } = await renderHook(
    () => usePlaceFresh(TEST_PLACE_ID, { enabled: true }),
    { wrapper: makeWrapper(client) },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(
    client.getQueryCache().find({ queryKey: queryKeys.placeFresh(TEST_PLACE_ID) }),
  ).toBeDefined();

  // RNTL v14 unmount is async — un-awaited it leaves the observer attached
  // while the assertion runs (mobile.md: await every RNTL call).
  await unmount();
  await act(async () => {
    // gcTime 0 schedules removal on a 0 ms timer — drain a couple of cycles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    client.getQueryCache().find({ queryKey: queryKeys.placeFresh(TEST_PLACE_ID) }),
  ).toBeUndefined();
});

it("usePlaceFresh enabled:false issues NO request (the v1 dormancy arm the screen rides)", async () => {
  const request = spyRequest().mockResolvedValue({ place: makePlace() });
  await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: false }), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  expect(request).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// useSavePlace (R-map-11)
// ---------------------------------------------------------------------------

/**
 * A client seeded with the ACCUMULATED list shape the mutations reconcile.
 * `gcTime: Infinity` — the seeded entry has NO observer in these hook-only
 * renders, and the default test client's gcTime 0 removes an unobserved
 * entry on a 0 ms timer (the P-6 "observer-less cache asserts pin
 * gcTime: Infinity" landmine — the assert would read `undefined` and pass
 * vacuously against nothing).
 */
function seededClient(rows: SavedPlaceWithPlace[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  client.setQueryData<Paginated<SavedPlaceWithPlace>>(queryKeys.tripSavedPlaces(TEST_TRIP_ID), {
    items: rows,
    nextCursor: null,
  });
  return client;
}

function listItems(client: QueryClient): SavedPlaceWithPlace[] {
  return (
    client.getQueryData<Paginated<SavedPlaceWithPlace>>(queryKeys.tripSavedPlaces(TEST_TRIP_ID))
      ?.items ?? []
  );
}

it("save applies OPTIMISTICALLY while held in flight, then reconciles to the server row", async () => {
  const existing = makeSavedPlaceWithPlace({
    id: SAVED_ROW_B_ID,
    place_id: PLACE_B_ID,
    place: { id: PLACE_B_ID, source_id: "ovt-b" },
  });
  const client = seededClient([existing]);
  const place = makePlace({ name: "Fushimi Inari" });
  const serverRow = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: place.id });

  const releases: ((value: unknown) => void)[] = [];
  spyRequest().mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const onSuccess = jest.fn();
  const { result } = await renderHook(
    () => useSavePlace(TEST_TRIP_ID, { onMutationSuccess: onSuccess }),
    { wrapper: makeWrapper(client) },
  );

  await act(async () => {
    result.current.mutate({ place });
  });
  try {
    // In flight: the placeholder row is present — the map pin appears NOW.
    const held = listItems(client);
    expect(held.map((row) => row.id)).toEqual([SAVED_ROW_B_ID, optimisticSavedPlaceId(place.id)]);
    expect(held[1]?.place).toBe(place);
    // The untouched row keeps IDENTITY (structural-sharing contract the
    // map screen's memo chain rides).
    expect(held[0]).toBe(existing);
  } finally {
    // ALWAYS settle held requests — a wedged mutation hangs the file
    // (mobile.md: release in finally, resolvers in an ARRAY).
    await act(async () => {
      for (const release of releases) release(serverRow);
    });
  }
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // Reconciled: placeholder swapped for the server row, seam fired with it.
  expect(listItems(client).map((row) => row.id)).toEqual([SAVED_ROW_B_ID, SAVED_ROW_ID]);
  expect(onSuccess).toHaveBeenCalledWith(serverRow);
});

it("save FAILURE (non-409) rolls the optimistic row back and fires the error seam", async () => {
  const client = seededClient([]);
  const place = makePlace();
  spyRequest().mockRejectedValue(new ApiRequestError(500, "UNKNOWN", "boom"));
  const onError = jest.fn();
  const onSuccess = jest.fn();
  const { result } = await renderHook(
    () => useSavePlace(TEST_TRIP_ID, { onMutationError: onError, onMutationSuccess: onSuccess }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate({ place });
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(listItems(client)).toEqual([]);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onSuccess).not.toHaveBeenCalled();
});

it("save 409 ≡ SUCCESS (R-places-16): the row STAYS, the success seam fires with null, no error seam", async () => {
  const client = seededClient([]);
  const place = makePlace();
  spyRequest().mockRejectedValue(new ApiRequestError(409, "CONFLICT", "already saved"));
  const onError = jest.fn();
  const onSuccess = jest.fn();
  const { result } = await renderHook(
    () => useSavePlace(TEST_TRIP_ID, { onMutationError: onError, onMutationSuccess: onSuccess }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate({ place });
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  // Treated as success at the seam + cache level: optimistic row kept (the
  // 409-path invalidation refetch will swap in the real one), no error UI.
  expect(onSuccess).toHaveBeenCalledWith(null);
  expect(onError).not.toHaveBeenCalled();
  expect(listItems(client).map((row) => row.place_id)).toEqual([place.id]);
  // The list was marked STALE (truth re-syncs on next observation). The
  // seeded query has no observer in this hook-only harness, so an actual
  // refetch can't be the observable — `isInvalidated` is.
  expect(
    client.getQueryCache().find({ queryKey: queryKeys.tripSavedPlaces(TEST_TRIP_ID) })?.state
      .isInvalidated,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// useUnsavePlace (R-map-11)
// ---------------------------------------------------------------------------

it("unsave removes OPTIMISTICALLY and calls the DELETE descriptor with the row id", async () => {
  const row = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID });
  const client = seededClient([row]);
  const releases: ((value: unknown) => void)[] = [];
  const request = spyRequest().mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const { result } = await renderHook(() => useUnsavePlace(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate(SAVED_ROW_ID);
  });
  try {
    expect(listItems(client)).toEqual([]);
  } finally {
    await act(async () => {
      for (const release of releases) release(undefined);
    });
  }
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(request).toHaveBeenCalledWith(placeEndpoints.deleteSavedPlace, {
    params: { tripId: TEST_TRIP_ID, savedPlaceId: SAVED_ROW_ID },
  });
  expect(listItems(client)).toEqual([]);
});

it("unsave FAILURE restores the row (rollback) and fires the error seam", async () => {
  const row = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID });
  const client = seededClient([row]);
  spyRequest().mockRejectedValue(new ApiRequestError(500, "UNKNOWN", "boom"));
  const onError = jest.fn();
  const { result } = await renderHook(
    () => useUnsavePlace(TEST_TRIP_ID, { onMutationError: onError }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate(SAVED_ROW_ID);
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(listItems(client)).toEqual([row]);
  expect(onError).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// useUpdateSavedPlaceNote (R-map-14)
// ---------------------------------------------------------------------------

it("note PATCH reconciles the returned row IN PLACE (accumulated shape preserved)", async () => {
  const row = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID });
  const other = makeSavedPlaceWithPlace({
    id: SAVED_ROW_B_ID,
    place_id: PLACE_B_ID,
    place: { id: PLACE_B_ID, source_id: "ovt-b" },
  });
  const client = seededClient([row, other]);
  const updated = { ...row, note: "Go at dawn" };
  const request = spyRequest().mockResolvedValue(updated);
  const onSuccess = jest.fn();
  const { result } = await renderHook(
    () => useUpdateSavedPlaceNote(TEST_TRIP_ID, { onMutationSuccess: onSuccess }),
    { wrapper: makeWrapper(client) },
  );
  await act(async () => {
    result.current.mutate({ savedPlaceId: SAVED_ROW_ID, note: "Go at dawn" });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(request).toHaveBeenCalledWith(placeEndpoints.updateSavedPlace, {
    params: { tripId: TEST_TRIP_ID, savedPlaceId: SAVED_ROW_ID },
    body: { note: "Go at dawn" },
  });
  const after = client.getQueryData<Paginated<SavedPlaceWithPlace>>(
    queryKeys.tripSavedPlaces(TEST_TRIP_ID),
  );
  expect(after).toEqual({ items: [updated, other], nextCursor: null });
  // The untouched row keeps identity — structural sharing over the
  // accumulated shape, the contract the map's memo chain rides.
  expect(after?.items[1]).toBe(other);
  expect(onSuccess).toHaveBeenCalledWith(updated);
});
