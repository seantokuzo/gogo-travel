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

import { queryClient } from "@/data/query-client";
import { readDeeplinkOutRecord, recordDeeplinkOut } from "@/features/deeplinks/return-prompt-store";
import { defaultZoneFor, rememberTripZone } from "@/features/itinerary/add-edit/last-zone-store";
import { deviceTimeZone } from "@/features/itinerary/add-edit/zoned-time";
import { recallMoneySegment, rememberMoneySegment } from "@/features/money/segment-memory";
import {
  consumePendingSettleReturn,
  recordSettleDeeplinkOut,
} from "@/features/money/settle-return-store";
import { readLastViewedTrip, stampLastViewedTrip } from "@/navigation/last-viewed-trip";
import { recallTab, rememberTab } from "@/navigation/tab-memory";

import { ApiRequestError } from "./api-client";
import { secureTokenStorage } from "./secure-storage";
import {
  createSessionSlice,
  useSessionStore,
  type SessionDeps,
  type SessionState,
} from "./session-store";

// In-memory Keychain for the SINGLETON path below — the slice tests inject
// fake storage, but the real store's signOut clears the real secure-storage
// adapter, which must not reach native under jest.
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

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

describe("session store — resetLocalSession (session-door spec R-door-8): client-local ONLY, never a server call", () => {
  it("clears identity + token and flags a reset, identically to signOut's local effects", async () => {
    const { store, storage } = makeStore();
    await store.getState().applySignIn({ user: USER, tokens: TOKENS, is_new_user: false });

    await store.getState().resetLocalSession();

    expect(store.getState()).toMatchObject({
      user: null,
      accessToken: null,
      firstRun: false,
      pendingDestination: null,
      resetting: true,
    });
    expect(storage.clearRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("NEVER calls the server, even with a live access token present (unlike signOut)", async () => {
    // Falsification: change `resetLocalSession` to call `signOut` (or to
    // otherwise read `deps.api`) → this goes RED, since `api.request` would
    // then be invoked for the best-effort /auth/logout the way it is for
    // signOut (pinned above, "attempts /auth/logout ... when a token is
    // present"). A door run's local reset must never depend on network
    // reachability to the API.
    const { store, api } = makeStore();
    store.setState({ user: USER, accessToken: "access-live" });

    await store.getState().resetLocalSession();

    expect(api.request).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ user: null, accessToken: null, resetting: true });
  });

  it("fires the onSignedOut seam AFTER clearing (same ordering signOut guarantees)", async () => {
    const storage = {
      getRefreshToken: jest.fn<Promise<string | null>, []>().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearRefreshToken: jest.fn().mockResolvedValue(undefined),
    };
    const api = { request: jest.fn() };
    const onSignedOut = jest.fn();
    const deps: SessionDeps = { storage, api, onSignedOut };
    const store = createStore<SessionState>()(createSessionSlice(deps));
    await store.getState().applySignIn({ user: USER, tokens: TOKENS, is_new_user: false });

    await store.getState().resetLocalSession();

    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(api.request).not.toHaveBeenCalled();
    expect(onSignedOut.mock.invocationCallOrder[0]).toBeGreaterThan(
      storage.clearRefreshToken.mock.invocationCallOrder[0],
    );
  });

  it("singleton wiring: resetLocalSession on the REAL useSessionStore clears the SAME R-nav-4 state signOut does, with no network call", async () => {
    // Mirrors "singleton wiring — R-nav-4" below, but for resetLocalSession —
    // the door's actual call site (never signOut).
    rememberTab("trip-y", "map");
    stampLastViewedTrip("trip-y");
    rememberMoneySegment("trip-y", "balances");
    expect(recallTab("trip-y")).toBe("map");
    expect(readLastViewedTrip()?.tripId).toBe("trip-y");

    // The REAL singleton's apiClient is wired to `globalThis.fetch`
    // (session-store.ts `fetchImpl: (input, init) => fetch(input, init)`) —
    // stubbing it here catches ANY network call the reset performs, not just
    // a logout POST specifically. Assign-and-restore (not `jest.spyOn`,
    // which requires the property to already be a function) — the same
    // pattern `diagnostics-route.test.tsx` uses for this exact global.
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    useSessionStore.setState({ user: USER, accessToken: "access-live", hydrated: true });

    try {
      await useSessionStore.getState().resetLocalSession();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(recallTab("trip-y")).toBeUndefined();
      expect(readLastViewedTrip()).toBeNull();
      expect(recallMoneySegment("trip-y")).toBeUndefined();
      expect(useSessionStore.getState()).toMatchObject({ user: null, resetting: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /**
   * R-door-8 "clean slate" acceptance (session-door.spec.md §2.1 test
   * obligation, review round 1 A3/adversarial Finding C): the EXHAUSTIVE
   * nine-item list — session store, secure-store refresh token, query
   * cache, tab memory, last-viewed trip, money-segment memory,
   * deeplink-return AND settle-return records, last-zone map — driven
   * TWICE for the SAME user_key, so a second door run cannot inherit the
   * first run's local state. Only 3 of 9 were pinned before this (tab
   * memory, last-viewed trip, money-segment memory); this covers the
   * remaining 6 (identity/token, secure-store refresh token, query cache,
   * deeplink-return record, settle-return record, last-zone map).
   */
  it("R-door-8 two-run replay: ALL NINE persisted items are back at cold-boot empty before EACH run's session applies — same user_key both times", async () => {
    // Falsification: drop any ONE call from the singleton's `onSignedOut`
    // closure (session-store.ts) -> the corresponding assertion below goes
    // RED, on run 1 or run 2.
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // The file's top-level `expo-secure-store` mock is a dumb stub
    // (`getItemAsync` always resolves `null`, never round-trips a write) —
    // spy on the adapter's OWN `clearRefreshToken` instead of trying to read
    // a value back through it, matching how the rest of this file verifies
    // secure-storage calls.
    const clearRefreshTokenSpy = jest.spyOn(secureTokenStorage, "clearRefreshToken");

    async function populateAllNine(runTag: string): Promise<void> {
      // 1: session store identity + in-memory access token.
      await useSessionStore.getState().applySignIn({
        user: USER,
        tokens: {
          access_token: `access-${runTag}`,
          refresh_token: `refresh-${runTag}`,
          expires_in: 900,
        },
        is_new_user: false,
      });
      // 2: secure-store refresh token — written via applySignIn above;
      // cleared-call assertion lives at each reset site below.
      // 3: query cache.
      queryClient.setQueryData(["probe", runTag], { seeded: true });
      // 4: tab memory.
      rememberTab("trip-r8", "map");
      // 5: last-viewed trip.
      stampLastViewedTrip("trip-r8");
      // 6: money-segment memory.
      rememberMoneySegment("trip-r8", "balances");
      // 7: deeplink-return record.
      recordDeeplinkOut({
        partner: "airbnb",
        category: "lodging",
        tripId: "trip-r8",
        timestamp: Date.now(),
      });
      // 8: settle-return record.
      recordSettleDeeplinkOut({
        tripId: "trip-r8",
        counterpartyId: "member-r8",
        method: "venmo",
        amountCents: 1234,
      });
      // 9: last-zone map (per-trip).
      rememberTripZone("trip-r8", "Asia/Tokyo");
    }

    function assertAllNineColdBootEmpty(): void {
      expect(useSessionStore.getState().user).toBeNull(); // 1
      expect(useSessionStore.getState().accessToken).toBeNull(); // 1
      expect(recallTab("trip-r8")).toBeUndefined(); // 4
      expect(readLastViewedTrip()).toBeNull(); // 5
      expect(recallMoneySegment("trip-r8")).toBeUndefined(); // 6
      expect(readDeeplinkOutRecord()).toBeNull(); // 7
      expect(consumePendingSettleReturn()).toBeNull(); // 8
      expect(defaultZoneFor("trip-r8")).toBe(deviceTimeZone()); // 9
    }

    try {
      // --- Run 1 ---
      await populateAllNine("run1");
      expect(queryClient.getQueryData(["probe", "run1"])).toEqual({ seeded: true }); // 3, seeded

      await useSessionStore.getState().resetLocalSession();

      assertAllNineColdBootEmpty();
      expect(clearRefreshTokenSpy).toHaveBeenCalledTimes(1); // 2
      expect(queryClient.getQueryData(["probe", "run1"])).toBeUndefined(); // 3 (queryClient.clear())

      // --- Run 2, SAME user_key/trip, proving run 2 does not inherit run 1 ---
      await populateAllNine("run2");
      expect(queryClient.getQueryData(["probe", "run2"])).toEqual({ seeded: true }); // 3, seeded again

      await useSessionStore.getState().resetLocalSession();

      assertAllNineColdBootEmpty();
      expect(clearRefreshTokenSpy).toHaveBeenCalledTimes(2); // 2, again
      expect(queryClient.getQueryData(["probe", "run1"])).toBeUndefined();
      expect(queryClient.getQueryData(["probe", "run2"])).toBeUndefined(); // 3

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      clearRefreshTokenSpy.mockRestore();
    }
  });
});

describe("singleton wiring — R-nav-4 'reset the entire navigation state' (T-6.6 R1)", () => {
  it("sign-out on the REAL useSessionStore clears tab memory, the last-viewed stamp AND the deeplink-return slot", async () => {
    // Round-1 finding: the slice tests inject a jest.fn onSignedOut, so the
    // PRODUCTION wiring (queryClient.clear + resetTabMemory +
    // clearLastViewedTrip + clearDeeplinkOutRecord) could silently revert
    // while every test stayed green. This pins the real singleton's reset.
    rememberTab("trip-x", "map");
    stampLastViewedTrip("trip-x");
    recordDeeplinkOut({
      partner: "airbnb",
      category: "lodging",
      tripId: "trip-x",
      timestamp: Date.now(),
    });
    // T-9.5 R1 (security): money-segment memory is the same R-nav-4 class.
    rememberMoneySegment("trip-x", "balances");
    // T-9.7 R1 (security): so is the settle-return stash — a pending "Did
    // you complete the payment?" record at the NEXT account would leak the
    // previous account's payment AND let B post a fabricated settlement.
    recordSettleDeeplinkOut({
      tripId: "trip-x",
      counterpartyId: "member-y",
      method: "venmo",
      amountCents: 2550,
    });
    // B-9 R1 (security): the per-TRIP last-used time zone is the same class
    // again, and it is keyed by TRIP rather than by user — on a shared
    // device, two collaborators on one trip share the rung, so user B's next
    // booking form would default its zone picker to the zone user A last
    // submitted.
    rememberTripZone("trip-x", "Asia/Tokyo");
    expect(recallTab("trip-x")).toBe("map");
    expect(readLastViewedTrip()?.tripId).toBe("trip-x");
    expect(defaultZoneFor("trip-x")).toBe("Asia/Tokyo");
    expect(readDeeplinkOutRecord()).not.toBeNull();
    expect(recallMoneySegment("trip-x")).toBe("balances");

    // No access token → the best-effort /auth/logout is skipped (that branch
    // is slice-tested above); this test is about the onSignedOut wiring.
    useSessionStore.setState({ user: USER, accessToken: null, hydrated: true });
    await useSessionStore.getState().signOut();

    expect(recallTab("trip-x")).toBeUndefined();
    expect(readLastViewedTrip()).toBeNull();
    // T-7.8 R1 sign-out hygiene: no "Did you book it?" prompt can cross
    // accounts for the previous account's trip.
    expect(readDeeplinkOutRecord()).toBeNull();
    // T-9.5 R1: the next account's money tab re-defaults to budget.
    expect(recallMoneySegment("trip-x")).toBeUndefined();
    // T-9.7 R1: no settle-return prompt (or fabricated settlement) can cross
    // the account boundary — the stash is gone, not merely stale.
    expect(consumePendingSettleReturn()).toBeNull();
    // B-9 R1: the next account's form falls back to the DEVICE zone, not to
    // the previous account's last submission.
    expect(defaultZoneFor("trip-x")).toBe(deviceTimeZone());
    expect(useSessionStore.getState()).toMatchObject({ user: null, resetting: true });
  });
});
