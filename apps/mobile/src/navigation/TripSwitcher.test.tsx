/**
 * Trip switcher bar (B-25 — the navigation dead end device QA hit).
 *
 * Entering a trip replaces the stack, so `[tripId]/_layout`'s tab shell has
 * no back affordance and this bar is the ONLY exit. The pins below are the
 * three properties that make it one:
 *
 *  - it renders with a single trip (the old `activeTrips.length < 2` gate
 *    rendered nothing at all for the exact account Sean was testing);
 *  - the sheet's "All trips" row leaves for the trip list, and does so even
 *    when the trips read failed — the way out must not depend on a network
 *    call;
 *  - the sheet shows the WHOLE trip set (planning + past included), grouped
 *    by the trip list's own `groupTripsIntoSections`, with the current trip
 *    checkmarked.
 *
 * The undeferred navigation (no `onExited` round trip) is pinned here as an
 * ORDER claim — `setOpen(false)` then `replace`, in one handler. That is safe
 * only because the destination is not a `presentation: "modal"` route; the
 * route-config half of that argument is pinned in
 * `__tests__/modal-presentation.test.ts`, and the TripSwitcher module doc
 * carries the B-19 mechanism.
 *
 * Route-level proof that the press actually LANDS on `(trips)` (mobile.md is
 * emphatic that imperative navigation can silently no-op inside the vendored
 * tab navigator) lives in `__tests__/trip-switcher-exit.test.tsx`, against
 * the real tree.
 */
import { fireEvent, screen, within } from "@testing-library/react-native";

import { TripSwitcherBar } from "./TripSwitcher";
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import { renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

/** Ordered nav log — "close the sheet, then replace" is an ORDER claim. */
const navSequence: [string, unknown][] = [];
const mockReplace = jest.fn((href: unknown) => navSequence.push(["replace", href]));
const mockPush = jest.fn((href: unknown) => navSequence.push(["push", href]));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

const CURRENT = makePlanningTrip(TEST_TRIP_ID, { name: "Kyoto" });

beforeEach(() => {
  jest.clearAllMocks();
  navSequence.length = 0;
});

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
});

async function renderBar(trips = [CURRENT]) {
  mockNavApi({ trips });
  const view = await renderWithProviders(<TripSwitcherBar currentTrip={CURRENT} />);
  await settle();
  return view;
}

async function openSheet() {
  await fireEvent.press(screen.getByTestId("trip-switcher-button"));
  expect(await screen.findByTestId("trip-switcher-sheet")).toBeOnTheScreen();
}

it("renders with a SINGLE trip — the bar is orientation plus egress, not a 2+-active gate", async () => {
  await renderBar();
  expect(screen.getByTestId("trip-switcher-button")).toBeOnTheScreen();
  // The label has to stay meaningful now that the bar is always present.
  expect(screen.getByLabelText(/Current trip: Kyoto/)).toBeOnTheScreen();
});

it("renders for an all-planning/past account — the case that had NO affordance at all", async () => {
  await renderBar([CURRENT, makePastTrip(TRIP_B_ID)]);
  expect(screen.getByTestId("trip-switcher-button")).toBeOnTheScreen();
});

it("the sheet's 'All trips' row replaces to the trip list, after closing the sheet", async () => {
  await renderBar();
  await openSheet();
  await fireEvent.press(screen.getByTestId("trip-switcher-list-item-all-trips"));

  expect(mockReplace).toHaveBeenCalledWith("/(trips)");
  expect(mockPush).not.toHaveBeenCalled();
  // Order claim: the sheet is already closing when the replace is issued
  // (`setOpen(false)` precedes it in the handler), and the navigation is NOT
  // deferred to `onExited` — the destination is a plain card route.
  expect(navSequence).toEqual([["replace", "/(trips)"]]);
  await settle();
  expect(screen.queryByTestId("trip-switcher-sheet")).toBeNull();
});

it("the way out survives a failed trips read — the exit never depends on the query", async () => {
  mockNavApi({
    overrides: { "GET /trips": () => Promise.reject(new Error("offline")) },
  });
  await renderWithProviders(<TripSwitcherBar currentTrip={CURRENT} />);
  await settle();

  await openSheet();
  expect(screen.getByText(/Couldn't load your other trips/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId("trip-switcher-list-item-all-trips"));
  expect(mockReplace).toHaveBeenCalledWith("/(trips)");
});

it("lists NON-ACTIVE trips too, grouped active → upcoming → past like the trip list", async () => {
  await renderBar([
    makePastTrip(TRIP_C_ID, { name: "Oaxaca" }),
    CURRENT, // planning
    makeActiveTrip(TRIP_B_ID, { name: "Lisbon" }),
  ]);
  await openSheet();

  // Every trip is reachable — the old switcher filtered to the active set.
  expect(screen.getByTestId(`trip-switcher-list-item-${TRIP_B_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`trip-switcher-list-item-${TRIP_C_ID}`)).toBeOnTheScreen();

  // Section labels are the trip list's own (R-tripui-1), in its order.
  const headings = screen
    .getAllByText(/^(Happening now|Upcoming|Past)$/)
    .map((node) => node.props.children);
  expect(headings).toEqual(["Happening now", "Upcoming", "Past"]);

  // Sheet title is accurate now that it lists everything.
  expect(screen.getByText("Trips")).toBeOnTheScreen();
  expect(screen.queryByText("Active trips")).toBeNull();
});

it("marks the current trip and no other", async () => {
  await renderBar([CURRENT, makeActiveTrip(TRIP_B_ID)]);
  await openSheet();

  const current = screen.getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}`);
  const other = screen.getByTestId(`trip-switcher-list-item-${TRIP_B_ID}`);
  expect(
    within(current).getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}-check`),
  ).toBeOnTheScreen();
  expect(within(other).queryByTestId(`trip-switcher-list-item-${TRIP_B_ID}-check`)).toBeNull();
});

it("switching to another trip still replaces into that trip's root", async () => {
  await renderBar([CURRENT, makeActiveTrip(TRIP_B_ID)]);
  await openSheet();
  await fireEvent.press(screen.getByTestId(`trip-switcher-list-item-${TRIP_B_ID}`));
  expect(navSequence).toEqual([["replace", `/${TRIP_B_ID}`]]);
});

it("pressing the CURRENT trip navigates nowhere — it just closes the sheet", async () => {
  await renderBar([CURRENT, makeActiveTrip(TRIP_B_ID)]);
  await openSheet();
  await fireEvent.press(screen.getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}`));
  expect(navSequence).toEqual([]);
  await settle();
  expect(screen.queryByTestId("trip-switcher-sheet")).toBeNull();
});
