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
 *  - v1 STRUCTURAL dormancy (R1 review): `PLACE_FRESH_ENABLED` is folded
 *    into `usePlaceFresh` itself — a bare call issues nothing, and an
 *    explicit `enabled: true` cannot override the flag. The flag-ON §2.4
 *    contract (spec-verbatim key, staleTime 0 / gcTime 0 / retry false,
 *    `fresh=true` on the wire, evaporation) is places-fresh.test.tsx.
 *  - R-map-11 save/unsave: optimistic against the ACCUMULATED list shape,
 *    reconcile-to-server-row, rollback + invalidate on failure,
 *    409 ≡ success (R-places-16 client half) — plus the R1 hardening pins:
 *    never-loaded-list save invalidates (no silent strand), unsave success
 *    re-asserts removal (resurrection window), and the double-insert guard
 *    is held-in-flight pinned.
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
// usePlaceFresh — v1 STRUCTURAL dormancy (R1 review / A3). The flag-ON §2.4
// contract pins live in places-fresh.test.tsx (the flag module is mocked
// there; here the REAL `PLACE_FRESH_ENABLED = false` is the world under pin).
// ---------------------------------------------------------------------------

it("a BARE usePlaceFresh call issues NOTHING in v1 (the flag is folded into the hook, not caller discipline)", async () => {
  const request = spyRequest().mockResolvedValue({ place: makePlace() });
  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  expect(request).not.toHaveBeenCalled();
  // Disabled, not errored — the screen's silent-absence arm.
  expect(result.current.data).toBeUndefined();
  expect(result.current.isError).toBe(false);
});

it("the flag OUTRANKS an explicit enabled:true — no caller can issue ?fresh=true in v1", async () => {
  const request = spyRequest().mockResolvedValue({ place: makePlace() });
  await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: true }), {
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

it("save success with a NEVER-LOADED list INVALIDATES instead of silently bailing (R1 review)", async () => {
  // The scenario: the initial list fetch is in flight when the user taps
  // Save — onMutate's cancelQueries kills it, so success finds NO cache
  // entry to reconcile into. A silent bail strands the query idle (POST
  // landed, button still "Save place", no saved pin); the invalidation
  // makes the active observer refetch the truth.
  const place = makePlace();
  const serverRow = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: place.id });
  const listReleases: ((value: unknown) => void)[] = [];
  spyRequest().mockImplementation((descriptor: unknown) =>
    descriptor === placeEndpoints.listSavedPlaces
      ? new Promise((resolve) => {
          listReleases.push(resolve);
        })
      : Promise.resolve(serverRow),
  );
  const client = makeTestQueryClient();
  const { result } = await renderHook(
    () => ({ list: useSavedPlaces(TEST_TRIP_ID), save: useSavePlace(TEST_TRIP_ID) }),
    { wrapper: makeWrapper(client) },
  );
  try {
    // The initial fetch is genuinely in flight — Save isn't gated on it.
    expect(listReleases).toHaveLength(1);
    await act(async () => {
      result.current.save.mutate({ place });
    });
    await waitFor(() => expect(result.current.save.isSuccess).toBe(true));
    // The observable the silent bail never produces: the invalidation made
    // the active observer issue a SECOND list request.
    await waitFor(() => expect(listReleases.length).toBeGreaterThanOrEqual(2));
  } finally {
    // Release EVERY held fetch (mobile.md: resolvers in an array, settle in
    // finally) with the server truth.
    await act(async () => {
      for (const release of listReleases) release({ items: [serverRow], nextCursor: null });
    });
  }
  // The refetch landed the truth: saved pin present without a second tap.
  await waitFor(() => expect(result.current.list.data?.items).toEqual([serverRow]));
});

it("double-device race: saving an ALREADY-PRESENT place appends no duplicate placeholder (held in flight)", async () => {
  // The scenario: a background refetch lands this place's row (saved from
  // another device) between render and press; the stale closure fires
  // mutate anyway. The onMutate dup-guard must leave the cache truthful —
  // one pin per place, even while the POST is in flight.
  const place = makePlace();
  const rowForPlace = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: place.id });
  const client = seededClient([rowForPlace]);
  const releases: ((value: unknown) => void)[] = [];
  spyRequest().mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const { result } = await renderHook(() => useSavePlace(TEST_TRIP_ID), {
    wrapper: makeWrapper(client),
  });
  await act(async () => {
    result.current.mutate({ place });
  });
  try {
    const held = listItems(client);
    expect(held).toHaveLength(1);
    // Untouched — not even an identity churn.
    expect(held[0]).toBe(rowForPlace);
  } finally {
    await act(async () => {
      for (const release of releases) release(rowForPlace);
    });
  }
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(listItems(client)).toHaveLength(1);
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

it("unsave success RE-ASSERTS removal — a mid-flight refetch resurrection is filtered back out (R1 review)", async () => {
  const row = makeSavedPlaceWithPlace({ id: SAVED_ROW_ID });
  const client = seededClient([row]);
  const releases: ((value: unknown) => void)[] = [];
  spyRequest().mockImplementation(
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
    // CONTROL: the optimistic removal took.
    expect(listItems(client)).toEqual([]);
    // The scenario: while the DELETE is in flight, a concurrent refetch
    // (e.g. another save's 409-path invalidation) reads the server BEFORE
    // the delete commits and RESURRECTS the row into the cache.
    client.setQueryData<Paginated<SavedPlaceWithPlace>>(
      queryKeys.tripSavedPlaces(TEST_TRIP_ID),
      { items: [row], nextCursor: null },
    );
    expect(listItems(client)).toEqual([row]);
  } finally {
    await act(async () => {
      for (const release of releases) release(undefined);
    });
  }
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // Success re-filters by id — the zombie pin dies with the DELETE.
  expect(listItems(client)).toEqual([]);
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
