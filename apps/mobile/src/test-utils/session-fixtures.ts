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
 * Seed the store to match the auth reachability of the URL a route-tree render
 * is about to address: `(auth)/sign-in` needs no user; `(auth)/onboarding`
 * needs a first-run user; every other route needs an authenticated user.
 */
export function seedSessionForUrl(url: string): void {
  if (url === "/onboarding") seedAuthenticated({ firstRun: true });
  else if (url.startsWith("/sign-in")) seedUnauthenticated();
  else seedAuthenticated();
}
