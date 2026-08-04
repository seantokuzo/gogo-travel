/**
 * Offline-signal pins (T-7.9 / IT-10 — R-itin-29).
 *
 * The whole degrade surface hangs off `isOfflineError`, so its NEGATIVES are
 * the load-bearing half: a 404 or a 500 must NOT read as offline (that would
 * replace a real "this booking is gone" with "you're offline"), and every
 * negative here is paired with the positive that proves the assertion could
 * have gone the other way.
 *
 * Sync notify scheduler + observer-less cache asserts pin `gcTime: Infinity`
 * per the P-6 landmine (bookings.test.tsx pattern).
 */
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { ApiRequestError } from "@/auth";
import { isOfflineError, tripHasOfflineError, useTripOffline } from "@/data/offline";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID, TRIP_C_ID } from "@/test-utils/ids";

beforeAll(() => {
  notifyManager.setScheduler((cb) => cb());
});
afterAll(() => {
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * Drive a query to a settled FAILURE without a component: `fetchQuery` rejects,
 * which is the same state a mounted screen's failed read lands in.
 */
async function failQuery(client: QueryClient, key: readonly unknown[], error: unknown) {
  await expect(
    client.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(error) }),
  ).rejects.toBe(error);
}

describe("isOfflineError", () => {
  it("is TRUE only for the api-client's transport marker (status 0 / NETWORK)", () => {
    expect(isOfflineError(new ApiRequestError(0, "NETWORK", "network request failed"))).toBe(true);
  });

  it("is FALSE for every error the SERVER produced — it answered, so the network works", () => {
    // Each negative is meaningful only next to the positive above: same class,
    // same constructor, only `status` differs.
    expect(isOfflineError(new ApiRequestError(404, "NOT_FOUND", "not found"))).toBe(false);
    expect(isOfflineError(new ApiRequestError(403, "FORBIDDEN", "forbidden"))).toBe(false);
    expect(isOfflineError(new ApiRequestError(500, "UNKNOWN", "boom"))).toBe(false);
  });

  it("is FALSE for non-ApiRequestError values (a render crash is not offline)", () => {
    expect(isOfflineError(new Error("network request failed"))).toBe(false);
    expect(isOfflineError(null)).toBe(false);
    expect(isOfflineError(undefined)).toBe(false);
    expect(isOfflineError({ status: 0 })).toBe(false);
  });
});

describe("tripHasOfflineError", () => {
  it("sees a transport failure ANYWHERE in the trip's detail subtree", async () => {
    const client = makeClient();
    const cache = client.getQueryCache();
    // Baseline CONTROL: nothing cached ⇒ not offline. Without this the
    // positive below could be true for a reason that has nothing to do with
    // the seeded error.
    expect(tripHasOfflineError(cache, TEST_TRIP_ID)).toBe(false);

    await failQuery(
      client,
      queryKeys.tripItinerary(TEST_TRIP_ID),
      new ApiRequestError(0, "NETWORK", "network request failed"),
    );
    expect(tripHasOfflineError(cache, TEST_TRIP_ID)).toBe(true);
  });

  it("sees the [tripId] GUARD's own failure — the earliest offline tell", async () => {
    const client = makeClient();
    await failQuery(
      client,
      queryKeys.trip(TEST_TRIP_ID),
      new ApiRequestError(0, "NETWORK", "network request failed"),
    );
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(true);
  });

  it("is trip-SCOPED: another trip's transport failure does not degrade this one", async () => {
    const client = makeClient();
    await failQuery(
      client,
      queryKeys.tripItinerary(TRIP_C_ID),
      new ApiRequestError(0, "NETWORK", "network request failed"),
    );
    // The very same error IS visible under its own trip — so the false below
    // is scoping, not a broken lookup.
    expect(tripHasOfflineError(client.getQueryCache(), TRIP_C_ID)).toBe(true);
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(false);
  });

  it("does NOT fire for a server error (404/500) on a trip query", async () => {
    const client = makeClient();
    await failQuery(
      client,
      queryKeys.tripItinerary(TEST_TRIP_ID),
      new ApiRequestError(404, "NOT_FOUND", "not found"),
    );
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(false);
    // CONTROL: swap ONLY the status on the same key and it flips true.
    await failQuery(
      client,
      queryKeys.tripBookings(TEST_TRIP_ID),
      new ApiRequestError(0, "NETWORK", "network request failed"),
    );
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(true);
  });

  it("clears when a read succeeds again (recovery needs no extra plumbing)", async () => {
    const client = makeClient();
    const key = queryKeys.tripItinerary(TEST_TRIP_ID);
    await failQuery(client, key, new ApiRequestError(0, "NETWORK", "network request failed"));
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(true);

    await client.fetchQuery({ queryKey: key, queryFn: () => Promise.resolve({ ok: true }) });
    expect(tripHasOfflineError(client.getQueryCache(), TEST_TRIP_ID)).toBe(false);
  });
});

describe("useTripOffline", () => {
  it("re-renders its consumer when the cache flips offline and back", async () => {
    const client = makeClient();
    // RNTL v14: renderHook is ASYNC — await it (mobile.md floating-act rule).
    const { result } = await renderHook(() => useTripOffline(TEST_TRIP_ID), {
      wrapper: wrapperFor(client),
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await failQuery(
        client,
        queryKeys.tripItinerary(TEST_TRIP_ID),
        new ApiRequestError(0, "NETWORK", "network request failed"),
      );
    });
    expect(result.current).toBe(true);

    await act(async () => {
      await client.fetchQuery({
        queryKey: queryKeys.tripItinerary(TEST_TRIP_ID),
        queryFn: () => Promise.resolve({ items: [], legs: [] }),
      });
    });
    expect(result.current).toBe(false);
  });
});
