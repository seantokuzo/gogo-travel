/**
 * Session store (T-5.7 / NAV-2; navigation.spec §2.2) — the Zustand client
 * state behind the auth gate. Holds the auth identity + in-memory access
 * token; the refresh token lives ONLY in `secureTokenStorage` (never here).
 *
 * Boot hydration (R-nav-3): read the stored refresh token → rotate it for a
 * fresh access token → fetch `/users/me` → authenticated. No token → signed
 * out. A 401 (expired/revoked) clears the stored token; a network failure
 * lands signed-out but RETAINS the token so a later online launch recovers
 * (offline auth-boot is out of NAV-2 scope, navigation.spec §2.8).
 *
 * The store is the single writer of token state: `applySignIn` /
 * `applyRefreshedTokens` persist the rotated refresh token and swap the access
 * token; `signOut` clears everything locally (best-effort, never blocks on
 * network — auth-users spec §3.6.1).
 */
import {
  authEndpoints,
  userEndpoints,
  type ApiClient,
  type AuthTokens,
  type SignInResponse,
  type User,
} from "@gogo/shared";
import { create, type StateCreator } from "zustand";

import { ApiRequestError, createApiClient } from "./api-client";
import { resolveApiBaseUrl } from "./config";
import { secureTokenStorage, type SecureTokenStorage } from "./secure-storage";

export interface SessionState {
  /** False until boot hydration finishes — the gate holds the splash (R-nav-3). */
  hydrated: boolean;
  /** Authenticated identity, or null when signed out. */
  user: User | null;
  /** In-memory access token (15-min TTL) — never persisted. */
  accessToken: string | null;
  /** `is_new_user` from sign-in → route through onboarding first (R-nav-2). */
  firstRun: boolean;
  /** Path stashed while unauthenticated, resumed after sign-in (R-nav-1/2). */
  pendingDestination: string | null;
  /** True during a sign-out reset so the gate does NOT re-stash the leaving path (R-nav-4). */
  resetting: boolean;

  /** Boot: hydrate the session from secure storage (idempotent). */
  hydrate(): Promise<void>;
  /** Store a completed sign-in (persists refresh token + sets identity). */
  applySignIn(response: SignInResponse): Promise<void>;
  /** Persist a rotated token pair from a refresh (single writer). */
  applyRefreshedTokens(tokens: AuthTokens): void;
  /** First-run onboarding finished → leave the onboarding branch. */
  completeOnboarding(): void;
  /** Local sign-out reset (R-nav-4): clear identity, token, and stashes. */
  signOut(): Promise<void>;
  /** Remember the intended destination while redirecting to sign-in (R-nav-1). */
  stashDestination(path: string): void;
  /** Read + clear the stashed destination (R-nav-2). */
  consumeDestination(): string | null;
}

export interface SessionDeps {
  storage: SecureTokenStorage;
  api: ApiClient;
}

/** The store initializer — shared by the singleton and the test factory. */
export const createSessionSlice =
  (deps: SessionDeps): StateCreator<SessionState> =>
  (set, get) => ({
    hydrated: false,
    user: null,
    accessToken: null,
    firstRun: false,
    pendingDestination: null,
    resetting: false,

    async hydrate() {
      if (get().hydrated) return;
      const refreshToken = await deps.storage.getRefreshToken();
      if (!refreshToken) {
        set({ hydrated: true, user: null, accessToken: null });
        return;
      }
      try {
        const tokens = await deps.api.request(authEndpoints.refresh, {
          body: { refresh_token: refreshToken },
        });
        await deps.storage.setRefreshToken(tokens.refresh_token);
        set({ accessToken: tokens.access_token });
        const user = await deps.api.request(userEndpoints.getMe, {});
        set({ hydrated: true, user, firstRun: false, resetting: false });
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
          // Expired / revoked — the token is dead, drop it.
          await deps.storage.clearRefreshToken();
        }
        // Network/transient failures keep the token for a later recovery.
        set({ hydrated: true, user: null, accessToken: null });
      }
    },

    async applySignIn(response) {
      await deps.storage.setRefreshToken(response.tokens.refresh_token);
      set({
        hydrated: true,
        user: response.user,
        accessToken: response.tokens.access_token,
        firstRun: response.is_new_user,
        resetting: false,
      });
    },

    applyRefreshedTokens(tokens) {
      // Persist the rotated refresh token (secure store) off the request hot
      // path; the in-memory access token is what the next request reads.
      void deps.storage.setRefreshToken(tokens.refresh_token);
      set({ accessToken: tokens.access_token });
    },

    completeOnboarding() {
      set({ firstRun: false });
    },

    async signOut() {
      set({
        user: null,
        accessToken: null,
        firstRun: false,
        pendingDestination: null,
        resetting: true,
      });
      await deps.storage.clearRefreshToken();
    },

    stashDestination(path) {
      set({ pendingDestination: path });
    },

    consumeDestination() {
      const dest = get().pendingDestination;
      if (dest !== null) set({ pendingDestination: null });
      return dest;
    },
  });

/**
 * Wired singletons. The API client and store form a cycle (client needs the
 * access token + persistence callbacks; store drives the client) — broken with
 * lazy closures: the bridge callbacks read `useSessionStore` only at
 * request/refresh time, never during construction.
 */
export const apiClient: ApiClient = createApiClient({
  baseUrl: resolveApiBaseUrl(),
  fetchImpl: (input, init) => fetch(input, init),
  getAccessToken: () => useSessionStore.getState().accessToken,
  getRefreshToken: () => secureTokenStorage.getRefreshToken(),
  onTokensRefreshed: (tokens) => useSessionStore.getState().applyRefreshedTokens(tokens),
  onAuthLost: () => useSessionStore.getState().signOut(),
});

export const useSessionStore = create<SessionState>()(
  createSessionSlice({ storage: secureTokenStorage, api: apiClient }),
);
