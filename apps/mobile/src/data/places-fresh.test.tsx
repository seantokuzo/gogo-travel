/**
 * usePlaceFresh — the §2.4 fetch-fresh contract with the v1 dormancy flag
 * flipped ON (T-8.4 / MAP-3 — R-map-9/10). The flag now lives in its own
 * module and is folded into the hook's `enabled` STRUCTURALLY (R1 review),
 * so the flip is a mock of `@/data/place-fresh-flag` — everything in
 * `places.ts` stays REAL. The flag-off world (bare call issues nothing,
 * `enabled: true` cannot override) is pinned in places.test.tsx.
 *
 * apiClient spy per the members/bookings test pattern.
 */
import { placeEndpoints, type PlaceDetails } from "@gogo/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";
import { usePlaceFresh } from "@/data/places";
import { queryKeys } from "@/data/query-client";
import { makeTestQueryClient } from "@/test-utils/render";
import { makePlace, TEST_PLACE_ID } from "@/test-utils/trip-fixtures";

// The flag flip — the ONE binding this file changes.
jest.mock("@/data/place-fresh-flag", () => ({ PLACE_FRESH_ENABLED: true }));

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

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

afterEach(() => {
  jest.restoreAllMocks();
});

it("usePlaceFresh sends fresh=true, selects the fresh block, and carries the §2.4 config", async () => {
  const details: PlaceDetails = {
    place: makePlace({ source: "fsq_os", source_id: "fsq-1" }),
    fresh: {
      fetched_at: "2026-08-18T00:00:00.000Z",
      attribution: {
        text: "Powered by Foursquare",
        logo_required: false,
        url: "https://foursquare.com",
      },
      fields: { hours: "9–17", open_now: true },
    },
  };
  const request = spyRequest().mockResolvedValue(details);
  const client = libraryDefaultClient();

  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID), {
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
  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});

it("usePlaceFresh: retry:false — ONE request then error state (degrade, never hammer a metered upstream)", async () => {
  // Library-default client: its retry default is 3× — the single call below
  // can only come from the HOOK's retry:false.
  const request = spyRequest().mockRejectedValue(new ApiRequestError(502, "UNKNOWN", "upstream"));
  const { result } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID), {
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
      attribution: {
        text: "Powered by Foursquare",
        logo_required: false,
        url: "https://foursquare.com",
      },
      fields: {},
    },
  } satisfies PlaceDetails);
  // Library-default client (gcTime 5 min default): evaporation below can
  // only come from the HOOK's gcTime 0.
  const client = libraryDefaultClient();
  const { result, unmount } = await renderHook(() => usePlaceFresh(TEST_PLACE_ID), {
    wrapper: makeWrapper(client),
  });
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

it("usePlaceFresh enabled:false issues NO request even flag-on (the caller-off arm survives the fold)", async () => {
  const request = spyRequest().mockResolvedValue({ place: makePlace() });
  await renderHook(() => usePlaceFresh(TEST_PLACE_ID, { enabled: false }), {
    wrapper: makeWrapper(makeTestQueryClient()),
  });
  expect(request).not.toHaveBeenCalled();
});
