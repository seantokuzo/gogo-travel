/**
 * Trip switcher bar (B-25 — the navigation dead end device QA hit).
 *
 * `[tripId]/_layout`'s tab shell has no back affordance, so this bar is the
 * ONLY exit. The pins below are the properties that make it one:
 *
 *  - it renders with a single trip (the old `activeTrips.length < 2` gate
 *    rendered nothing at all for the exact account Sean was testing);
 *  - the sheet's "All trips" row leaves for the trip list, and does so even
 *    when the trips read failed — the way out must not depend on a network
 *    call;
 *  - a FAILED REFETCH that retains data shows the retained list and no error
 *    note (round-1 review: the note contradicted the list beneath it);
 *  - the sheet shows the WHOLE trip set (planning + past included), grouped
 *    by the trip list's own `groupTripsIntoSections`, with the current trip
 *    checkmarked.
 *
 * `navCalls` records ROUTER CALLS ONLY. It therefore pins that the navigation
 * is issued from the press handler itself and NOT deferred to the Sheet's
 * `onExited` (the assertions run before any settle), and which primitive was
 * used — nothing about `setOpen` ordering. An earlier revision framed it as a
 * "close, THEN navigate" ORDER claim, which the log cannot observe: both are
 * state updates coalesced into one commit, and the log is byte-identical
 * either way (round-1 review, Law #7). Undeferred navigation is only safe
 * because the destination is not a `presentation: "modal"` route; that half is
 * pinned in `__tests__/modal-presentation.test.ts`, and the TripSwitcher
 * module doc carries the B-19 mechanism.
 *
 * Route-level proof that the press actually LANDS on `(trips)` (mobile.md is
 * emphatic that imperative navigation can silently no-op inside the vendored
 * tab navigator) lives against the real tree in
 * `__tests__/trip-switcher-exit.test.tsx` (cold-launch entry shape) and
 * `__tests__/trip-switcher-exit-from-list.test.tsx` (push entry shape — the
 * one that discriminates `dismissTo` from `replace`).
 */
import { act, fireEvent, screen, within } from "@testing-library/react-native";

import { TripSwitcherBar } from "./TripSwitcher";
import { queryKeys } from "@/data";
import { TEST_TRIP_ID, TRIP_B_ID, TRIP_C_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

/** Router-call log: which primitive, with what href — see the file doc. */
const navCalls: [string, unknown][] = [];
const mockReplace = jest.fn((href: unknown) => navCalls.push(["replace", href]));
const mockPush = jest.fn((href: unknown) => navCalls.push(["push", href]));
const mockDismissTo = jest.fn((href: unknown) => navCalls.push(["dismissTo", href]));
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush, dismissTo: mockDismissTo }),
}));

const CURRENT = makePlanningTrip(TEST_TRIP_ID, { name: "Kyoto" });

beforeEach(() => {
  jest.clearAllMocks();
  navCalls.length = 0;
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

it("the sheet's 'All trips' row dismisses to the trip list, and closes the sheet", async () => {
  await renderBar();
  await openSheet();
  await fireEvent.press(screen.getByTestId("trip-switcher-list-item-all-trips"));

  // `dismissTo`, not `replace`: on the push entry path REPLACE swaps the route
  // at `state.index` in place and would leave a SECOND trip list on the stack.
  // The route-level proof of the resulting stack shape lives in
  // `__tests__/trip-switcher-exit-from-list.test.tsx`.
  expect(mockDismissTo).toHaveBeenCalledWith("/(trips)");
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  // Asserted BEFORE any settle: the navigation is issued from the press
  // handler, not deferred to the Sheet's `onExited` (safe only because the
  // destination is a plain card route — see the file doc).
  expect(navCalls).toEqual([["dismissTo", "/(trips)"]]);
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
  expect(mockDismissTo).toHaveBeenCalledWith("/(trips)");
});

it("a FAILED REFETCH that retains data lists the trips and shows NO error note", async () => {
  // TanStack flips `status` to "error" on a failed refetch while KEEPING the
  // last successful page, so an `isError`-only gate printed "couldn't load
  // your other trips" directly above a complete, pressable list (round-1
  // review). Offline foreground-refetch is the everyday way to hit it.
  const client = makeTestQueryClient();
  const request = mockNavApi({ trips: [CURRENT, makeActiveTrip(TRIP_B_ID, { name: "Lisbon" })] });
  await renderWithProviders(<TripSwitcherBar currentTrip={CURRENT} />, { queryClient: client });
  await settle();

  request.mockRejectedValue(new Error("offline"));
  await act(async () => {
    await client.refetchQueries({ queryKey: queryKeys.trips });
  });

  // The premise, asserted — otherwise "no note" would hold vacuously.
  expect(client.getQueryState(queryKeys.trips)?.status).toBe("error");
  expect(client.getQueryData(queryKeys.trips)).not.toBeUndefined();

  await openSheet();
  expect(screen.queryByText(/Couldn't load your other trips/)).toBeNull();
  expect(screen.getByTestId(`trip-switcher-list-item-${TRIP_B_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}`)).toBeOnTheScreen();
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
  // Trip→trip stays a REPLACE: it swaps the `[tripId]` route in place, which
  // is exactly right — it must not add or remove a stack entry.
  expect(navCalls).toEqual([["replace", `/${TRIP_B_ID}`]]);
});

it("pressing the CURRENT trip navigates nowhere — it just closes the sheet", async () => {
  await renderBar([CURRENT, makeActiveTrip(TRIP_B_ID)]);
  await openSheet();
  await fireEvent.press(screen.getByTestId(`trip-switcher-list-item-${TEST_TRIP_ID}`));
  expect(navCalls).toEqual([]);
  await settle();
  expect(screen.queryByTestId("trip-switcher-sheet")).toBeNull();
});
