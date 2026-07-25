/**
 * Redirect-gate logic (T-5.7 / NAV-2; navigation.spec §2.2) — the PURE
 * decision function behind the root auth gate. Kept side-effect-free so every
 * R-nav-1..4 branch is unit-testable without a router or the store.
 *
 * Pseudocode it implements (§2.2):
 *   !hydrated              → wait on splash                       (R-nav-3)
 *   !user  & !in (auth)    → sign-in, stash the intended path     (R-nav-1)
 *   user   & firstRun      → onboarding                           (R-nav-2)
 *   user   & in (auth)     → resume the stash / entry redirect    (R-nav-2)
 *   otherwise              → render the requested route
 */
export type GateAction =
  | { type: "wait" } // hold the hydration splash — no navigation yet (R-nav-3)
  | { type: "render" } // requested route is allowed
  | { type: "sign-in"; stash: string | null } // redirect to sign-in (R-nav-1)
  | { type: "onboarding" } // first-run detour (R-nav-2)
  | { type: "resume" }; // authed user sitting in (auth) → leave to stash/entry

export interface GateInput {
  hydrated: boolean;
  authed: boolean;
  firstRun: boolean;
  /** A sign-out reset is in flight — never stash the path we're leaving (R-nav-4). */
  resetting: boolean;
  /** `segments[0] === "(auth)"`. */
  inAuthGroup: boolean;
  /** In the `(auth)` group AND on the onboarding route. */
  onOnboarding: boolean;
  /** Resolved pathname (`usePathname`) for the stash — no group segment. */
  pathname: string;
}

/** Paths that must never be stashed as a resume target. */
function stashable(pathname: string): string | null {
  if (!pathname || pathname === "/") return null;
  if (pathname.startsWith("/sign-in") || pathname.startsWith("/onboarding")) return null;
  return pathname;
}

export function resolveGate(input: GateInput): GateAction {
  if (!input.hydrated) return { type: "wait" };

  if (!input.authed) {
    // The sign-in screen is the only unauthenticated-reachable route; every
    // other route (including onboarding, which needs a user) redirects out.
    if (input.inAuthGroup && !input.onOnboarding) return { type: "render" };
    return { type: "sign-in", stash: input.resetting ? null : stashable(input.pathname) };
  }

  if (input.firstRun) {
    return input.onOnboarding ? { type: "render" } : { type: "onboarding" };
  }

  if (input.inAuthGroup) return { type: "resume" };
  return { type: "render" };
}
