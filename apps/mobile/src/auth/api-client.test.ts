/**
 * API client (T-5.7) — descriptor-driven requests + refresh-on-401 rotation.
 * fetch is injected; the shared `@gogo/shared` descriptors drive URL/verb/parse.
 */
import { authEndpoints, userEndpoints, type User } from "@gogo/shared";

import {
  ApiRequestError,
  createApiClient,
  REQUEST_TIMEOUT_MS,
  type ApiClientConfig,
} from "./api-client";

const USER: User = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "traveler@example.com",
  display_name: "Test Traveler",
  avatar_key: null,
  prefs: {},
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
  forward_email_slug: null,
  created_at: "2026-07-24T00:00:00.000Z",
};

const TOKENS = { access_token: "access-2", refresh_token: "refresh-2", expires_in: 900 };

function httpResponse(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

const apiError = (code: string) => ({ error: { code, message: "denied" } });

function setup(overrides?: Partial<ApiClientConfig>) {
  let accessToken: string | null = "access-1";
  const fetchImpl = jest.fn();
  const onTokensRefreshed = jest.fn((tokens: { access_token: string }) => {
    accessToken = tokens.access_token;
  });
  const onAuthLost = jest.fn();
  const client = createApiClient({
    baseUrl: "http://host:3000/api",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    getAccessToken: () => accessToken,
    getRefreshToken: async () => "refresh-1",
    onTokensRefreshed,
    onAuthLost,
    ...overrides,
  });
  return {
    client,
    fetchImpl,
    onTokensRefreshed,
    onAuthLost,
    setAccess: (t: string | null) => (accessToken = t),
  };
}

describe("createApiClient — request building", () => {
  it("substitutes path params, attaches the bearer token, and parses the response", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(httpResponse(200, USER));

    const result = await client.request(userEndpoints.getUserProfile, {
      params: { userId: USER.id },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://host:3000/api/users/${USER.id}`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer access-1");
    expect(result.id).toBe(USER.id);
  });

  it("sends a JSON body for writes", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(
      httpResponse(200, { user: USER, tokens: TOKENS, is_new_user: true }),
    );

    await client.request(authEndpoints.appleSignIn, {
      body: {
        identity_token: "id",
        authorization_code: "code",
        raw_nonce: "nonce",
        device: { platform: "ios" },
      },
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body).raw_nonce).toBe("nonce");
  });

  it("returns undefined for a 204 endpoint", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(httpResponse(204));
    await expect(client.request(authEndpoints.logout, { body: {} })).resolves.toBeUndefined();
  });

  it("throws a typed ApiRequestError for a non-2xx envelope", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(httpResponse(400, apiError("VALIDATION_FAILED")));
    await expect(client.request(userEndpoints.getMe, {})).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_FAILED",
    });
  });

  it("maps a transport failure to a NETWORK error without leaking the URL", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockRejectedValue(new Error("ECONNREFUSED http://host:3000/api/users/me"));
    const err = await client.request(userEndpoints.getMe, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe("NETWORK");
    expect((err as ApiRequestError).message).not.toContain("host:3000");
  });
});

describe("createApiClient — refresh-on-401 rotation", () => {
  it("refreshes once and retries the request on a 401", async () => {
    const { client, fetchImpl, onTokensRefreshed } = setup();
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return httpResponse(200, TOKENS);
      // first /users/me → 401, retry → 200
      return fetchImpl.mock.calls.filter((c) => (c[0] as string).endsWith("/users/me")).length <= 1
        ? httpResponse(401, apiError("UNAUTHENTICATED"))
        : httpResponse(200, USER);
    });

    const result = await client.request(userEndpoints.getMe, {});
    expect(result.id).toBe(USER.id);
    expect(onTokensRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "access-2" }),
    );
    // The retry carried the rotated access token.
    const retryCall = fetchImpl.mock.calls.filter((c) => (c[0] as string).endsWith("/users/me"))[1];
    expect(retryCall[1].headers.Authorization).toBe("Bearer access-2");
  });

  it("collapses concurrent 401s into a single refresh (single-flight)", async () => {
    const { client, fetchImpl } = setup();
    let meCalls = 0;
    let refreshCalls = 0;
    fetchImpl.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return httpResponse(200, TOKENS);
      }
      meCalls += 1;
      return meCalls <= 2
        ? httpResponse(401, apiError("UNAUTHENTICATED"))
        : httpResponse(200, USER);
    });

    const [a, b] = await Promise.all([
      client.request(userEndpoints.getMe, {}),
      client.request(userEndpoints.getMe, {}),
    ]);
    expect(a.id).toBe(USER.id);
    expect(b.id).toBe(USER.id);
    expect(refreshCalls).toBe(1);
  });

  it("signs out and rethrows when the refresh itself fails", async () => {
    const { client, fetchImpl, onAuthLost } = setup();
    fetchImpl.mockImplementation(async (url: string) =>
      url.endsWith("/auth/refresh")
        ? httpResponse(401, apiError("UNAUTHENTICATED"))
        : httpResponse(401, apiError("UNAUTHENTICATED")),
    );

    await expect(client.request(userEndpoints.getMe, {})).rejects.toBeInstanceOf(ApiRequestError);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it("signs out when the refresh succeeds but the retried request still 401s", async () => {
    // Distinct from refresh-itself-fails: the rotation SUCCEEDS (onTokensRefreshed
    // fires), but the server rejects even the retried, freshly-bearer'd request
    // (revoked mid-flight) → the explicit auth-loss exit at the retry branch.
    const { client, fetchImpl, onTokensRefreshed, onAuthLost } = setup();
    fetchImpl.mockImplementation(
      async (url: string) =>
        url.endsWith("/auth/refresh")
          ? httpResponse(200, TOKENS) // rotation succeeds
          : httpResponse(401, apiError("UNAUTHENTICATED")), // original + retry both 401
    );

    await expect(client.request(userEndpoints.getMe, {})).rejects.toMatchObject({ status: 401 });
    expect(onTokensRefreshed).toHaveBeenCalledTimes(1);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it("never refresh-retries a request that carried no access token (public route)", async () => {
    const { client, fetchImpl, onAuthLost } = setup({ getAccessToken: () => null });
    fetchImpl.mockResolvedValue(httpResponse(401, apiError("UNAUTHENTICATED")));

    await expect(
      client.request(authEndpoints.refresh, { body: { refresh_token: "r" } }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      fetchImpl.mock.calls.filter((c) => (c[0] as string).endsWith("/auth/refresh")),
    ).toHaveLength(1);
    expect(onAuthLost).not.toHaveBeenCalled();
  });
});

describe("request timeout + cancellation (T-6.6 R1)", () => {
  // A signal-respecting transport that never responds on its own — the
  // captive-portal/black-hole stall the cap exists for (Android RN OkHttp
  // ships with timeouts DISABLED; without the cap this hangs forever).
  const stalledFetch = (onSignal?: (signal: AbortSignal) => void) =>
    jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          onSignal?.(init.signal);
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts a stalled request at the REQUEST_TIMEOUT_MS cap → transport error", async () => {
    jest.useFakeTimers();
    const fetchImpl = stalledFetch();
    const { client } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const pending = client.request(userEndpoints.getMe, {});
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, code: "NETWORK" });
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
    // The settle cleaned its own timer — nothing left ticking (jest handles).
    expect(jest.getTimerCount()).toBe(0);
  });

  it("just under the cap, the request is still pending (the cap is the cap)", async () => {
    jest.useFakeTimers();
    const fetchImpl = stalledFetch();
    const { client } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });

    let settled = false;
    const pending = client.request(userEndpoints.getMe, {}).catch(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });

  it("forwards the external signal into fetch — aborting it cancels the request", async () => {
    let received: AbortSignal | undefined;
    const fetchImpl = stalledFetch((signal) => {
      received = signal;
    });
    const { client } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const controller = new AbortController();
    const pending = client.request(userEndpoints.getMe, {}, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, code: "NETWORK" });
    expect(received?.aborted).toBe(false);
    controller.abort();
    await assertion;
    // External abort propagated through the composed signal fetch received.
    expect(received?.aborted).toBe(true);
  });

  it("an already-aborted external signal short-circuits", async () => {
    const fetchImpl = jest.fn((_url: string, init: { signal: AbortSignal }) =>
      init.signal.aborted
        ? Promise.reject(new Error("aborted"))
        : Promise.resolve(httpResponse(200, USER)),
    );
    const { client } = setup({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.request(userEndpoints.getMe, {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ status: 0, code: "NETWORK" });
  });

  it("clears the cap timer when a request settles normally (no leaked handles)", async () => {
    jest.useFakeTimers();
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(httpResponse(200, USER));
    await client.request(userEndpoints.getMe, {});
    expect(jest.getTimerCount()).toBe(0);
  });
});
