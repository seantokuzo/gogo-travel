/**
 * Session store (T-5.7 / NAV-2) — boot hydration + sign-in/refresh/sign-out
 * state machine, with injected fakes for the secure storage + API client
 * seams. The refresh token invariant is asserted structurally: only the
 * refresh token is ever written to storage, never the access token.
 */
import {
  authEndpoints,
  userEndpoints,
  type AuthTokens,
  type SignInResponse,
  type User,
} from "@gogo/shared";
import { createStore, type StoreApi } from "zustand/vanilla";

import { ApiRequestError } from "./api-client";
import { createSessionSlice, type SessionDeps, type SessionState } from "./session-store";

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

const TOKENS: AuthTokens = {
  access_token: "access-1",
  refresh_token: "refresh-rotated",
  expires_in: 900,
};

function makeStore() {
  const storage = {
    getRefreshToken: jest.fn<Promise<string | null>, []>().mockResolvedValue(null),
    setRefreshToken: jest.fn().mockResolvedValue(undefined),
    clearRefreshToken: jest.fn().mockResolvedValue(undefined),
  };
  const api = { request: jest.fn() };
  const deps: SessionDeps = { storage, api };
  const store: StoreApi<SessionState> = createStore<SessionState>()(createSessionSlice(deps));
  return { store, storage, api };
}

describe("session store — hydration (R-nav-3)", () => {
  it("lands unauthenticated when no refresh token is stored", async () => {
    const { store, storage, api } = makeStore();
    storage.getRefreshToken.mockResolvedValue(null);

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({ hydrated: true, user: null, accessToken: null });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("rotates the stored token and fetches the user", async () => {
    const { store, storage, api } = makeStore();
    storage.getRefreshToken.mockResolvedValue("refresh-old");
    api.request.mockImplementation((descriptor: unknown) => {
      if (descriptor === authEndpoints.refresh) return Promise.resolve(TOKENS);
      if (descriptor === userEndpoints.getMe) return Promise.resolve(USER);
      throw new Error("unexpected request");
    });

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({ hydrated: true, user: USER, accessToken: "access-1" });
    expect(storage.setRefreshToken).toHaveBeenCalledWith("refresh-rotated");
  });

  it("clears an expired/revoked token on a 401", async () => {
    const { store, storage, api } = makeStore();
    storage.getRefreshToken.mockResolvedValue("refresh-old");
    api.request.mockRejectedValue(new ApiRequestError(401, "UNAUTHENTICATED", "x"));

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({ hydrated: true, user: null });
    expect(storage.clearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("retains the token on a network failure (offline recovery)", async () => {
    const { store, storage, api } = makeStore();
    storage.getRefreshToken.mockResolvedValue("refresh-old");
    api.request.mockRejectedValue(new ApiRequestError(0, "NETWORK", "offline"));

    await store.getState().hydrate();

    expect(store.getState()).toMatchObject({ hydrated: true, user: null });
    expect(storage.clearRefreshToken).not.toHaveBeenCalled();
  });

  it("is idempotent — a second hydrate is a no-op", async () => {
    const { store, storage } = makeStore();
    store.setState({ hydrated: true });
    await store.getState().hydrate();
    expect(storage.getRefreshToken).not.toHaveBeenCalled();
  });
});

describe("session store — sign-in / onboarding / sign-out", () => {
  const signInResponse = (isNew: boolean): SignInResponse => ({
    user: USER,
    tokens: TOKENS,
    is_new_user: isNew,
  });

  it("applySignIn persists ONLY the refresh token and sets first-run from is_new_user", async () => {
    const { store, storage } = makeStore();
    await store.getState().applySignIn(signInResponse(true));

    expect(store.getState()).toMatchObject({
      user: USER,
      accessToken: "access-1",
      firstRun: true,
      hydrated: true,
    });
    // Invariant: the refresh token is stored; the access token never is.
    expect(storage.setRefreshToken).toHaveBeenCalledWith("refresh-rotated");
    expect(storage.setRefreshToken).not.toHaveBeenCalledWith("access-1");
  });

  it("completeOnboarding clears the first-run flag", async () => {
    const { store } = makeStore();
    await store.getState().applySignIn(signInResponse(true));
    store.getState().completeOnboarding();
    expect(store.getState().firstRun).toBe(false);
  });

  it("signOut clears identity + token and flags a reset", async () => {
    const { store, storage } = makeStore();
    await store.getState().applySignIn(signInResponse(false));
    store.getState().stashDestination("/trip-1/today");

    await store.getState().signOut();

    expect(store.getState()).toMatchObject({
      user: null,
      accessToken: null,
      firstRun: false,
      pendingDestination: null,
      resetting: true,
    });
    expect(storage.clearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("signOut fires the onSignedOut seam AFTER clearing (query-cache clear, nav §2.2)", async () => {
    const storage = {
      getRefreshToken: jest.fn<Promise<string | null>, []>().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearRefreshToken: jest.fn().mockResolvedValue(undefined),
    };
    const api = { request: jest.fn().mockResolvedValue(undefined) };
    const onSignedOut = jest.fn();
    const deps: SessionDeps = { storage, api, onSignedOut };
    const store = createStore<SessionState>()(createSessionSlice(deps));
    await store.getState().applySignIn(signInResponse(false));

    await store.getState().signOut();

    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(store.getState().user).toBeNull();
    // Ordering: the local token clear happens before the cache clear.
    expect(onSignedOut.mock.invocationCallOrder[0]).toBeGreaterThan(
      storage.clearRefreshToken.mock.invocationCallOrder[0],
    );
  });

  it("stash/consume round-trips the intended destination once", () => {
    const { store } = makeStore();
    store.getState().stashDestination("/trip-1/money");
    expect(store.getState().pendingDestination).toBe("/trip-1/money");
    expect(store.getState().consumeDestination()).toBe("/trip-1/money");
    expect(store.getState().pendingDestination).toBeNull();
    expect(store.getState().consumeDestination()).toBeNull();
  });
});

describe("session store — mid-session token rotation (applyRefreshedTokens)", () => {
  const rotated: AuthTokens = {
    access_token: "access-rotated",
    refresh_token: "refresh-next",
    expires_in: 900,
  };

  it("persists the rotated refresh token and swaps the in-memory access token", async () => {
    const { store, storage } = makeStore();
    store.setState({ accessToken: "access-old" });

    await store.getState().applyRefreshedTokens(rotated);

    expect(store.getState().accessToken).toBe("access-rotated");
    expect(storage.setRefreshToken).toHaveBeenCalledWith("refresh-next");
    // Invariant preserved: the access token is never written to secure storage.
    expect(storage.setRefreshToken).not.toHaveBeenCalledWith("access-rotated");
  });

  it("does not resolve until the secure-store write lands (single-flight ordering)", async () => {
    const { store, storage } = makeStore();
    let releaseWrite: () => void = () => undefined;
    storage.setRefreshToken.mockImplementation(
      () => new Promise<void>((resolve) => (releaseWrite = resolve)),
    );

    let settled = false;
    const pending = store
      .getState()
      .applyRefreshedTokens(rotated)
      .then(() => {
        settled = true;
      });

    // The persist promise is still pending → applyRefreshedTokens must not have
    // resolved (this is what lets the ApiClient single-flight wait before it
    // clears refreshInFlight, closing the pre-rotation-read window).
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseWrite();
    await pending;
    expect(settled).toBe(true);
  });
});

describe("session store — sign-out calls /auth/logout (best-effort, spec §3.6.1)", () => {
  it("attempts /auth/logout before clearing local state when a token is present", async () => {
    const { store, storage, api } = makeStore();
    api.request.mockResolvedValue(undefined);
    store.setState({ user: USER, accessToken: "access-live" });

    await store.getState().signOut();

    expect(api.request).toHaveBeenCalledWith(authEndpoints.logout, { body: {} });
    expect(store.getState()).toMatchObject({ user: null, accessToken: null, resetting: true });
    expect(storage.clearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("still clears local state when /auth/logout fails (a dead session must not block)", async () => {
    const { store, storage, api } = makeStore();
    api.request.mockRejectedValue(new ApiRequestError(401, "UNAUTHENTICATED", "revoked"));
    store.setState({ user: USER, accessToken: "access-live" });

    await expect(store.getState().signOut()).resolves.toBeUndefined();

    expect(store.getState()).toMatchObject({ user: null, accessToken: null, resetting: true });
    expect(storage.clearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("skips /auth/logout when there is no access token (nothing to revoke)", async () => {
    const { store, api } = makeStore();
    store.setState({ user: null, accessToken: null });

    await store.getState().signOut();

    expect(api.request).not.toHaveBeenCalled();
  });
});
