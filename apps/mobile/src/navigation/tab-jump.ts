/**
 * Cross-tab jump (T-7.9) — the ONLY sanctioned way a trip surface sends the
 * user to another tab.
 *
 * THE LANDMINE (`.claude/rules/mobile.md`, sim-confirmed P-4 QA): an
 * imperative `router.push()`/`router.navigate()` at a URL inside ANOTHER tab
 * SILENTLY NO-OPS once you are inside the vendored tab navigator. A "view this
 * on the map" button written the obvious way is a dead button that no test
 * catches — it neither throws nor navigates. The working move is the one the
 * tab bar itself makes: `navigate(tabKey)` on the TAB NAVIGATOR
 * (`app/[tripId]/_layout.tsx` `TripTabBar.onSelect`).
 *
 * So this walks UP from the calling screen's navigation object to the first
 * navigator that actually declares the target tab route, and navigates there —
 * recording the manual selection first, exactly as a tab-bar press does, so
 * R-nav-9's in-session sticky tab stays truthful (a jump the user initiated is
 * a manual choice).
 *
 * WHY A WALK AND NOT `useNavigation("/[tripId]")`: expo-router's parent form
 * THROWS ("Could not find parent navigation with route …") when the route
 * isn't an ancestor — a red screen on a button press. The walk degrades to a
 * no-op and reports it, which a caller can surface.
 *
 * DEPTH ONLY, never a nested screen target: this deliberately lands on the
 * tab, not on a screen inside it. The itinerary spec's cross-tab links are
 * "→ map tab" / "→ money tab" (R-itin-24), and the destinations themselves
 * (place detail, expense detail) belong to the maps and money specs (§2.10).
 */
import { rememberTab } from "./tab-memory";

/**
 * The slice of the expo-router navigation object this needs. Structural on
 * purpose: it keeps the walk unit-testable without standing up a navigator,
 * and the real object (`useNavigation()`'s return) satisfies it.
 */
export interface TabJumpNavigation {
  getParent(): TabJumpNavigation | undefined;
  getState(): { routeNames?: readonly string[] } | undefined;
  navigate(name: string): void;
}

/** Bound on the walk — the deepest realistic nesting here is stack→tabs→root. */
const MAX_PARENT_DEPTH = 10;

/**
 * Jump to `tabKey` within the current trip. Returns whether a navigator
 * declaring that tab was found — `false` means nothing happened (no throw, no
 * silent lie), which is what a caller renders a fallback for.
 */
export function jumpToTripTab(
  navigation: TabJumpNavigation | undefined,
  tripId: string,
  tabKey: string,
): boolean {
  let current = navigation;
  for (let depth = 0; current !== undefined && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (current.getState()?.routeNames?.includes(tabKey) === true) {
      // Order matters: record BEFORE navigating, like TripTabBar.onSelect —
      // the tab navigator may re-render synchronously off `navigate`.
      rememberTab(tripId, tabKey);
      current.navigate(tabKey);
      return true;
    }
    current = current.getParent();
  }
  return false;
}
