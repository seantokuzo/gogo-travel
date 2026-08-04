/**
 * Cross-tab jump pins (T-7.9). The reason this module exists is a landmine
 * nothing else catches: an imperative push at another tab's URL SILENTLY
 * no-ops. So the pins are about the walk finding the right navigator, and
 * about the not-found case degrading rather than throwing.
 */
import { jumpToTripTab, type TabJumpNavigation } from "./tab-jump";
import { recallTab, resetTabMemory } from "./tab-memory";

const TRIP_ID = "trip-1";

/** A navigator in a fake `getParent()` chain. */
function makeNav(routeNames: string[] | undefined, parent?: TabJumpNavigation) {
  const navigate = jest.fn();
  const nav: TabJumpNavigation = {
    navigate,
    getParent: () => parent,
    getState: () => (routeNames === undefined ? undefined : { routeNames }),
  };
  return { nav, navigate };
}

beforeEach(() => {
  resetTabMemory();
});

it("navigates on the FIRST ancestor that declares the tab, not the caller's own stack", () => {
  const tabs = makeNav(["today", "itinerary", "map", "money", "more"]);
  const stack = makeNav(["index", "item/[itemId]", "booking/[bookingId]"], tabs.nav);

  expect(jumpToTripTab(stack.nav, TRIP_ID, "map")).toBe(true);
  expect(tabs.navigate).toHaveBeenCalledWith("map");
  // The stack itself has no `map` route — it must NOT have been asked.
  expect(stack.navigate).not.toHaveBeenCalled();
});

it("records the jump as a MANUAL tab selection (R-nav-9), like a tab-bar press", () => {
  const tabs = makeNav(["today", "itinerary", "map", "money", "more"]);
  const stack = makeNav(["index"], tabs.nav);
  // CONTROL: nothing remembered before the jump, so the assertion after it
  // cannot be reading a pre-existing value.
  expect(recallTab(TRIP_ID)).toBeUndefined();

  jumpToTripTab(stack.nav, TRIP_ID, "money");
  expect(recallTab(TRIP_ID)).toBe("money");
});

it("returns false and navigates NOTHING when no ancestor declares the tab", () => {
  const root = makeNav(["(auth)", "(trips)"]);
  const stack = makeNav(["index"], root.nav);

  expect(jumpToTripTab(stack.nav, TRIP_ID, "map")).toBe(false);
  expect(root.navigate).not.toHaveBeenCalled();
  expect(stack.navigate).not.toHaveBeenCalled();
  // A failed jump must not claim a manual tab choice either.
  expect(recallTab(TRIP_ID)).toBeUndefined();
});

it("tolerates a navigator with no state (getState() ⇒ undefined) and keeps walking", () => {
  const tabs = makeNav(["today", "itinerary", "map"]);
  const stateless = makeNav(undefined, tabs.nav);

  expect(jumpToTripTab(stateless.nav, TRIP_ID, "itinerary")).toBe(true);
  expect(tabs.navigate).toHaveBeenCalledWith("itinerary");
});

it("degrades to false on an undefined navigation object (never throws at a button press)", () => {
  expect(jumpToTripTab(undefined, TRIP_ID, "map")).toBe(false);
});

it("terminates on a self-referential parent chain instead of hanging", () => {
  const navigate = jest.fn();
  const looping: TabJumpNavigation = {
    navigate,
    getParent: () => looping,
    getState: () => ({ routeNames: ["index"] }),
  };
  expect(jumpToTripTab(looping, TRIP_ID, "map")).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});
