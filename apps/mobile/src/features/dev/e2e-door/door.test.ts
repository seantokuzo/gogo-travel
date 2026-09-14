/**
 * E2E session door — client half (S-4 T4; .specs/testing/session-door.spec.md
 * §2.1 T4 rows). Every branch of `openSessionDoor` (disabled × 2 reasons,
 * malformed input, success, 401, network failure) is unit-testable over
 * injected deps, per the module's own doc comment.
 *
 * The happy/rejected/network cases use a REAL `createApiClient` (only
 * `fetchImpl` mocked) rather than a fake `{ request: jest.fn() }` port, so
 * the request body / headers / `ApiRequestError` status mapping this suite
 * asserts on are the ACTUAL wire behavior, not a hand-rolled fiction of it
 * (`.claude/rules/testing.md` #4 — a green mock proves nothing on its own).
 */
import type { SignInResponse, User } from "@gogo/shared";

import { ApiRequestError, createApiClient, type MobileApiClient } from "@/auth/api-client";

import {
  isDoorSecretConfigured,
  openSessionDoor,
  parseFirstRun,
  resolveUserKey,
  type OpenDoorDeps,
} from "./door";

jest.mock("expo-device", () => ({ __esModule: true, deviceName: "Test Device" }));

const SECRET = "s".repeat(32);
const LOCAL_BASE = "http://localhost:3000/api";
const PUBLIC_BASE = "https://api.gogotravel.example/api";

const USER: User = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "e2e+flow-1@gogotravel.invalid",
  display_name: "E2E flow-1",
  avatar_key: null,
  prefs: {},
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
  forward_email_slug: null,
  created_at: "2026-09-13T00:00:00.000Z",
};

const SIGN_IN_RESPONSE: SignInResponse = {
  user: USER,
  tokens: { access_token: "door-access", refresh_token: "door-refresh", expires_in: 900 },
  is_new_user: false,
};

/** A real `ApiClient` adapter with only the transport (`fetchImpl`) faked. */
function makeRealApi(fetchImpl: jest.Mock): MobileApiClient {
  return createApiClient({
    baseUrl: LOCAL_BASE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    getAccessToken: () => null,
    getRefreshToken: async () => null,
    onTokensRefreshed: async () => undefined,
    onAuthLost: async () => undefined,
  });
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function makeDeps(overrides: Partial<OpenDoorDeps> = {}): {
  deps: OpenDoorDeps;
  resetLocalSession: jest.Mock;
  applySignIn: jest.Mock;
} {
  const resetLocalSession = jest.fn().mockResolvedValue(undefined);
  const applySignIn = jest.fn().mockResolvedValue(undefined);
  const deps: OpenDoorDeps = {
    api: makeRealApi(jest.fn()),
    apiBase: LOCAL_BASE,
    resetLocalSession,
    applySignIn,
    secret: SECRET,
    ...overrides,
  };
  return { deps, resetLocalSession, applySignIn };
}

describe("isDoorSecretConfigured (G3)", () => {
  it("boundary: exactly 32 chars is configured; 31 is not", () => {
    expect(isDoorSecretConfigured("a".repeat(32))).toBe(true);
    expect(isDoorSecretConfigured("a".repeat(31))).toBe(false);
  });

  it("undefined (a door-free build's folded-to-undefined member expression) is not configured", () => {
    expect(isDoorSecretConfigured(undefined)).toBe(false);
  });

  it("defaults to reading process.env.EXPO_PUBLIC_E2E_DOOR_SECRET when no arg is given", () => {
    const prev = process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
    try {
      delete process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
      expect(isDoorSecretConfigured()).toBe(false);
      process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
      expect(isDoorSecretConfigured()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
      else process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = prev;
    }
  });
});

describe("parseFirstRun (adversarial: first_run type confusion)", () => {
  it.each([
    ["true", true],
    [undefined, false],
    ["1", false],
    ["TRUE", false],
    ["True", false],
    [["true", "false"], false], // repeated query key → array, never truthy
    ["", false],
  ])("%p -> %p", (raw, expected) => {
    expect(parseFirstRun(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("resolveUserKey", () => {
  it.each([
    ["flow-1", "flow-1"],
    [undefined, "default"],
    ["", "default"],
    [["a", "b"], "default"], // repeated query key never becomes the identity
  ])("%p -> %p", (raw, expected) => {
    expect(resolveUserKey(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("openSessionDoor — disabled branch (R-door-7 double gate)", () => {
  it("secret not configured -> disabled, no reset, no network call", async () => {
    const fetchMock = jest.fn();
    const { deps, resetLocalSession } = makeDeps({
      api: makeRealApi(fetchMock),
      secret: undefined,
    });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resetLocalSession).not.toHaveBeenCalled();
  });

  it("secret too short (31 chars) -> disabled, no network call", async () => {
    const fetchMock = jest.fn();
    const { deps } = makeDeps({ api: makeRealApi(fetchMock), secret: "s".repeat(31) });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolved API base is a public host -> disabled, no network call (secret WAS configured)", async () => {
    // Falsification: drop the `isLocalOrPrivateHost` check from openSessionDoor
    // → this goes RED (a live fetch would fire against PUBLIC_BASE).
    const fetchMock = jest.fn();
    const { deps, resetLocalSession } = makeDeps({
      api: makeRealApi(fetchMock),
      apiBase: PUBLIC_BASE,
    });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resetLocalSession).not.toHaveBeenCalled();
  });

  it("a local/private base WITH the secret configured proceeds (control arm — proves the gate can pass)", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, SIGN_IN_RESPONSE));
    const { deps } = makeDeps({ api: makeRealApi(fetchMock) });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("openSessionDoor — malformed user_key (adversarial, no request)", () => {
  it("a user_key violating the shared regex is rejected client-side, no network call, no reset", async () => {
    const fetchMock = jest.fn();
    const { deps, resetLocalSession } = makeDeps({ api: makeRealApi(fetchMock) });

    const result = await openSessionDoor(
      { userKey: "UPPER CASE not allowed!!", firstRun: false },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resetLocalSession).not.toHaveBeenCalled();
  });
});

describe("openSessionDoor — happy path: ordering, request shape, session apply", () => {
  it("resets local session (awaited) strictly BEFORE the mint POST, then applies the response, Authorization-free", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, SIGN_IN_RESPONSE));
    const { deps, resetLocalSession, applySignIn } = makeDeps({ api: makeRealApi(fetchMock) });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: true }, deps);

    expect(result).toEqual({ ok: true });
    expect(resetLocalSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Ordering pin (R-door-8, §4.5): falsification — reorder openSessionDoor
    // to call `d.api.request` before `await d.resetLocalSession()` → RED.
    expect(resetLocalSession.mock.invocationCallOrder[0]).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0],
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${LOCAL_BASE}/auth/e2e/session`);
    expect(init.method).toBe("POST");
    // No Authorization header — the door is unauthenticated by construction
    // and the access token was just cleared by resetLocalSession anyway.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      secret: SECRET,
      user_key: "flow-1",
      device: { platform: "ios", device_name: "Test Device" },
      first_run: true,
    });

    expect(applySignIn).toHaveBeenCalledTimes(1);
    expect(applySignIn).toHaveBeenCalledWith(SIGN_IN_RESPONSE);
    // applySignIn happens AFTER the mint resolves.
    expect(applySignIn.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchMock.mock.invocationCallOrder[0],
    );
  });

  it("secret in the URL is ignored — the request always carries the injected/build secret, never a param value", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, SIGN_IN_RESPONSE));
    const { deps } = makeDeps({ api: makeRealApi(fetchMock) });
    // OpenDoorParams has no `secret` field at all — this simulates a caller
    // that tried to smuggle one through anyway (a crafted deep link with a
    // `?secret=` query param the route never reads into OpenDoorParams).
    const paramsWithSmuggledSecret = {
      userKey: "flow-1",
      firstRun: false,
      secret: "attacker-supplied-value-xxxxxxxx",
    };

    await openSessionDoor(paramsWithSmuggledSecret, deps);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { secret: string };
    expect(body.secret).toBe(SECRET);
    expect(body.secret).not.toBe("attacker-supplied-value-xxxxxxxx");
  });
});

describe("openSessionDoor — server 401 (R-door-3 uniform rejection)", () => {
  it("maps a 401 to reason 'rejected', never applies a session, never leaks the secret in the result", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Not authenticated." } }),
      );
    const { deps, applySignIn } = makeDeps({ api: makeRealApi(fetchMock) });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(applySignIn).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("openSessionDoor — network failure", () => {
  it("a transport throw maps to reason 'network', never applies a session", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("connection refused"));
    const { deps, applySignIn } = makeDeps({ api: makeRealApi(fetchMock) });

    const result = await openSessionDoor({ userKey: "flow-1", firstRun: false }, deps);

    expect(result).toEqual({ ok: false, reason: "network" });
    expect(applySignIn).not.toHaveBeenCalled();
  });

  it("distinguishes network (status 0) from rejected (401) via ApiRequestError.status", () => {
    // Direct pin on the mapping rule itself, no fetch involved — falsification:
    // invert the `err.status === 401` check in openSessionDoor -> RED.
    const rejected = new ApiRequestError(401, "UNAUTHENTICATED", "no");
    const network = new ApiRequestError(0, "NETWORK", "network request failed");
    expect(rejected.status).toBe(401);
    expect(network.status).toBe(0);
  });
});
