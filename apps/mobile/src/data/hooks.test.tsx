/**
 * Server-state hooks (T-5.8) — each hook wraps `apiClient.request` over a
 * `@gogo/shared` descriptor; mutations keep the cache honest. The network
 * boundary (`apiClient.request`) is the only thing mocked.
 */
import {
  authEndpoints,
  entitlementEndpoints,
  inviteEndpoints,
  tripEndpoints,
  userEndpoints,
  type AuthSessionInfo,
  type EffectiveEntitlements,
} from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient, ApiRequestError } from "@/auth";
import {
  queryKeys,
  shouldRetry,
  useEntitlements,
  useInvitePreview,
  useMe,
  usePaymentHandlesUpdate,
  useRevokeSession,
  useSessions,
  useTrip,
  useTrips,
  useUpdateMe,
} from "@/data";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { makeInvitePreview, makePlanningTrip } from "@/test-utils/trip-fixtures";

const SESSION: AuthSessionInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  device_name: "iPhone",
  platform: "ios",
  created_at: "2026-07-24T00:00:00.000Z",
  last_used_at: "2026-07-24T00:00:00.000Z",
  current: true,
};

const ENTITLEMENTS: EffectiveEntitlements = {
  plan: "free",
  ai_calls_per_day: 30,
  alerts_enabled: true,
  premium_place_details: false,
};

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

describe("useMe", () => {
  it("fetches GET /users/me", async () => {
    const request = spyRequest();
    request.mockResolvedValue(TEST_USER);
    const { result, unmount } = await renderHook(() => useMe(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(TEST_USER);
    expect(request).toHaveBeenCalledWith(userEndpoints.getMe, {}, { signal: expect.any(AbortSignal) });
    // Close the settle→cleanup gap in act so no trailing query update escapes.
    await unmount();
  });
});

describe("useUpdateMe", () => {
  it("PATCHes and writes the returned user straight into the me cache", async () => {
    const request = spyRequest();
    const updated = { ...TEST_USER, display_name: "New Name" };
    request.mockResolvedValue(updated);
    const client = makeTestQueryClient();
    // Determinism guard: onSuccess writes the `me` entry with NO observer
    // mounted (only useUpdateMe renders here), and the harness's gcTime:0
    // schedules immediate GC of observer-less entries — whether the assertion
    // below beats that timer is a race (it flipped with unrelated module-load
    // timing, T-6.1). Infinity = no GC timer at all, so no leaked handle.
    client.setQueryDefaults(queryKeys.me, { gcTime: Infinity });
    const { result, unmount } = await renderHook(() => useUpdateMe(), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ display_name: "New Name" });
    });

    expect(request).toHaveBeenCalledWith(userEndpoints.updateMe, {
      body: { display_name: "New Name" },
    });
    expect(client.getQueryData(queryKeys.me)).toEqual(updated);
    await unmount();
  });
});

describe("usePaymentHandlesUpdate", () => {
  it("PATCHes handles and invalidates the me cache", async () => {
    const request = spyRequest();
    request.mockResolvedValue({
      venmo_username: "sean",
      cashtag: null,
      paypalme_username: null,
      zelle_handle: null,
      zelle_display_name: null,
    });
    const client = makeTestQueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result, unmount } = await renderHook(() => usePaymentHandlesUpdate(), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ venmo_username: "@sean" });
    });

    expect(request).toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, {
      body: { venmo_username: "@sean" },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.me });
    await unmount();
  });
});

describe("useEntitlements", () => {
  it("fetches GET /users/me/entitlements", async () => {
    const request = spyRequest();
    request.mockResolvedValue(ENTITLEMENTS);
    const { result, unmount } = await renderHook(() => useEntitlements(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(ENTITLEMENTS);
    expect(request).toHaveBeenCalledWith(entitlementEndpoints.getMyEntitlements, {}, { signal: expect.any(AbortSignal) });
    await unmount();
  });
});

describe("useSessions", () => {
  it("fetches GET /auth/sessions with an empty cursor query", async () => {
    const request = spyRequest();
    const page = { items: [SESSION], nextCursor: null };
    request.mockResolvedValue(page);
    const { result, unmount } = await renderHook(() => useSessions(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(page);
    expect(request).toHaveBeenCalledWith(authEndpoints.listSessions, { query: {} }, { signal: expect.any(AbortSignal) });
    await unmount();
  });
});

describe("useRevokeSession", () => {
  it("DELETEs the session and invalidates the sessions cache", async () => {
    const request = spyRequest();
    request.mockResolvedValue(undefined);
    const client = makeTestQueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result, unmount } = await renderHook(() => useRevokeSession(), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync("sess-9");
    });

    expect(request).toHaveBeenCalledWith(authEndpoints.revokeSession, {
      params: { sessionId: "sess-9" },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions });
    await unmount();
  });
});

describe("useTrips (T-6.6)", () => {
  it("fetches GET /trips with the 100-cap first page", async () => {
    const request = spyRequest();
    const page = { items: [makePlanningTrip(TEST_TRIP_ID)], nextCursor: null };
    request.mockResolvedValue(page);
    const { result, unmount } = await renderHook(() => useTrips(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(page);
    expect(request).toHaveBeenCalledWith(
      tripEndpoints.listTrips,
      { query: { limit: 100 } },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });

  it("never fires while disabled (the entry redirect's unauthed hold)", async () => {
    const request = spyRequest();
    const { result, unmount } = await renderHook(() => useTrips({ enabled: false }), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });
    expect(result.current.status).toBe("pending");
    expect(request).not.toHaveBeenCalled();
    await unmount();
  });
});

describe("useTrip (T-6.6)", () => {
  it("fetches GET /trips/:tripId under the ['trips', id] key", async () => {
    const request = spyRequest();
    const trip = makePlanningTrip(TEST_TRIP_ID);
    request.mockResolvedValue(trip);
    const client = makeTestQueryClient();
    client.setQueryDefaults(queryKeys.trip(TEST_TRIP_ID), { gcTime: Infinity });
    const { result, unmount } = await renderHook(() => useTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(trip);
    expect(request).toHaveBeenCalledWith(
      tripEndpoints.getTrip,
      { params: { tripId: TEST_TRIP_ID } },
      { signal: expect.any(AbortSignal) },
    );
    expect(client.getQueryData(queryKeys.trip(TEST_TRIP_ID))).toEqual(trip);
    await unmount();
  });

  it("surfaces the guard's 404 as the query error (no retry — 4xx)", async () => {
    const request = spyRequest();
    request.mockRejectedValue(new ApiRequestError(404, "NOT_FOUND", "not found"));
    const { result, unmount } = await renderHook(() => useTrip(TEST_TRIP_ID), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiRequestError);
    expect((result.current.error as ApiRequestError).status).toBe(404);
    expect(request).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe("useInvitePreview (T-6.6)", () => {
  it("fetches GET /invites/:token", async () => {
    const request = spyRequest();
    const preview = makeInvitePreview();
    request.mockResolvedValue(preview);
    const { result, unmount } = await renderHook(() => useInvitePreview("tok-1"), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(preview);
    expect(request).toHaveBeenCalledWith(
      inviteEndpoints.previewInvite,
      { params: { token: "tok-1" } },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });
});

describe("query cancellation (T-6.6 R1)", () => {
  it("forwards TanStack's abort signal — unmounting mid-flight aborts the request", async () => {
    const request = spyRequest();
    let captured: AbortSignal | undefined;
    request.mockImplementation((_d: unknown, _i: unknown, opts?: { signal?: AbortSignal }) => {
      captured = opts?.signal;
      return new Promise(() => undefined); // in flight forever
    });
    const { unmount } = await renderHook(() => useTrips(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.aborted).toBe(false);
    // The queryFn CONSUMED the signal, so v5 cancels the query when its last
    // observer unmounts — the abort must reach the client (and the fetch cap
    // composition, api-client.test.ts).
    await unmount();
    await waitFor(() => expect(captured?.aborted).toBe(true));
  });
});

describe("shouldRetry", () => {
  it("never retries a 4xx", () => {
    expect(shouldRetry(0, new ApiRequestError(400, "UNKNOWN", "bad"))).toBe(false);
    expect(shouldRetry(0, new ApiRequestError(404, "UNKNOWN", "gone"))).toBe(false);
  });

  it("retries transport failures and 5xx up to two attempts", () => {
    expect(shouldRetry(0, new ApiRequestError(0, "NETWORK", "offline"))).toBe(true);
    expect(shouldRetry(1, new ApiRequestError(500, "UNKNOWN", "boom"))).toBe(true);
    expect(shouldRetry(2, new ApiRequestError(500, "UNKNOWN", "boom"))).toBe(false);
  });
});
