/**
 * Session seeding for route-tree tests (T-5.7 / NAV-2). The auth gate reads
 * the real `useSessionStore` singleton, so integration tests seed it directly
 * instead of standing up the network. Lives outside `__tests__/` so jest never
 * treats it as a suite.
 */
import type { User } from "@gogo/shared";

import { useSessionStore } from "@/auth";

export const TEST_USER: User = {
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

export function seedAuthenticated(opts?: { firstRun?: boolean }): void {
  useSessionStore.setState({
    hydrated: true,
    user: TEST_USER,
    accessToken: "test-access-token",
    firstRun: opts?.firstRun ?? false,
    pendingDestination: null,
    resetting: false,
  });
}

export function seedUnauthenticated(): void {
  useSessionStore.setState({
    hydrated: true,
    user: null,
    accessToken: null,
    firstRun: false,
    pendingDestination: null,
    resetting: false,
  });
}

/**
 * Cold-boot-faithful UNAUTHED seed (B-14): `hydrated` starts FALSE and flips
 * true only when the returned `releaseHydration` is called — mirroring the
 * real `hydrate()`, which awaits `storage.getRefreshToken()` before
 * `set({ hydrated: true })` even for a signed-out user. `seedUnauthenticated`
 * cannot reproduce boot races: it sets `hydrated: true` synchronously
 * pre-render, so the gate never sees the splash-hold window.
 *
 * `releaseHydration` resolves the storage read AND awaits the store flip, so
 * callers can wrap it in `act` and assert the post-hydration navigation.
 */
export function seedColdBootUnauthenticated(): { releaseHydration: () => Promise<void> } {
  let release!: () => void;
  const storageRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hydrate = async (): Promise<void> => {
    if (useSessionStore.getState().hydrated) return;
    await storageRead; // the async secure-store read (no token → signed out)
    useSessionStore.setState({ hydrated: true, user: null, accessToken: null });
  };
  useSessionStore.setState({
    hydrated: false,
    user: null,
    accessToken: null,
    firstRun: false,
    pendingDestination: null,
    resetting: false,
    hydrate,
  });
  return {
    releaseHydration: async () => {
      release();
      await storageRead;
    },
  };
}

/**
 * Seed the store to match the auth reachability of the URL a route-tree render
 * is about to address: `(auth)/sign-in` needs no user; `(auth)/onboarding`
 * needs a first-run user; every other route needs an authenticated user.
 */
export function seedSessionForUrl(url: string): void {
  if (url === "/onboarding") seedAuthenticated({ firstRun: true });
  else if (url.startsWith("/sign-in")) seedUnauthenticated();
  else seedAuthenticated();
}
