/**
 * Server-state hooks (T-5.8) — each hook wraps `apiClient.request` over a
 * `@gogo/shared` descriptor; mutations keep the cache honest. The network
 * boundary (`apiClient.request`) is the only thing mocked.
 */
import {
  authEndpoints,
  entitlementEndpoints,
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
  useMe,
  usePaymentHandlesUpdate,
  useRevokeSession,
  useSessions,
  useUpdateMe,
} from "@/data";
import { makeTestQueryClient } from "@/test-utils/render";
import { TEST_USER } from "@/test-utils/session-fixtures";

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
    const { result } = await renderHook(() => useMe(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(TEST_USER);
    expect(request).toHaveBeenCalledWith(userEndpoints.getMe, {});
  });
});

describe("useUpdateMe", () => {
  it("PATCHes and writes the returned user straight into the me cache", async () => {
    const request = spyRequest();
    const updated = { ...TEST_USER, display_name: "New Name" };
    request.mockResolvedValue(updated);
    const client = makeTestQueryClient();
    const { result } = await renderHook(() => useUpdateMe(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ display_name: "New Name" });
    });

    expect(request).toHaveBeenCalledWith(userEndpoints.updateMe, {
      body: { display_name: "New Name" },
    });
    expect(client.getQueryData(queryKeys.me)).toEqual(updated);
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
    const { result } = await renderHook(() => usePaymentHandlesUpdate(), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ venmo_username: "@sean" });
    });

    expect(request).toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, {
      body: { venmo_username: "@sean" },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.me });
  });
});

describe("useEntitlements", () => {
  it("fetches GET /users/me/entitlements", async () => {
    const request = spyRequest();
    request.mockResolvedValue(ENTITLEMENTS);
    const { result } = await renderHook(() => useEntitlements(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(ENTITLEMENTS);
    expect(request).toHaveBeenCalledWith(entitlementEndpoints.getMyEntitlements, {});
  });
});

describe("useSessions", () => {
  it("fetches GET /auth/sessions with an empty cursor query", async () => {
    const request = spyRequest();
    const page = { items: [SESSION], nextCursor: null };
    request.mockResolvedValue(page);
    const { result } = await renderHook(() => useSessions(), {
      wrapper: makeWrapper(makeTestQueryClient()),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(page);
    expect(request).toHaveBeenCalledWith(authEndpoints.listSessions, { query: {} });
  });
});

describe("useRevokeSession", () => {
  it("DELETEs the session and invalidates the sessions cache", async () => {
    const request = spyRequest();
    request.mockResolvedValue(undefined);
    const client = makeTestQueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = await renderHook(() => useRevokeSession(), { wrapper: makeWrapper(client) });

    await act(async () => {
      await result.current.mutateAsync("sess-9");
    });

    expect(request).toHaveBeenCalledWith(authEndpoints.revokeSession, {
      params: { sessionId: "sess-9" },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions });
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
