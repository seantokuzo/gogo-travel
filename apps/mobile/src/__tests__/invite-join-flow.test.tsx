/**
 * Invite-accept flows against the REAL tree (T-6.8 / CT-3; R-tripui-11/12).
 * Pure-URL dead-state render first; the accept-dead press (no navigation)
 * next; the accept-SUCCESS walkthrough (navigates) is the LAST test in the
 * file (harness quirk 3 — a navigating press wedges later mounts).
 *
 * Sibling walkthroughs live one-per-file for the same reason:
 * invite-join-already-member.test.tsx, invite-join-resume.test.tsx.
 */
import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";

import { ApiRequestError } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_INVITE_TOKEN, TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeInvitePreview, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const ACCEPTED = {
  trip_id: TEST_TRIP_ID,
  role: "editor",
  joined_at: "2026-07-26T00:00:00.000Z",
  already_member: false,
};

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-tripui-11 pure URL: a revoked token renders the 'no longer valid' card with back-to-trips", async () => {
  mockNavApi({
    invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview({ state: "revoked" }) },
  });
  await renderApp(`/invite/${TEST_INVITE_TOKEN}`);

  const join = await screen.findByTestId("invite-join-screen");
  expect(await within(join).findByText("This invite is no longer valid")).toBeOnTheScreen();
  expect(within(join).getByTestId("invite-join-button-back")).toBeOnTheScreen();
});

it("accept-dead: a 409-expired accept flips the live preview into the expired card, no navigation", async () => {
  mockNavApi({
    invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview() },
    overrides: {
      "POST /invites/:token/accept": () =>
        Promise.reject(new ApiRequestError(409, "CONFLICT", "expired", { reason: "expired" })),
    },
  });
  const result = await renderApp(`/invite/${TEST_INVITE_TOKEN}`);

  const join = await screen.findByTestId("invite-join-screen");
  await fireEvent.press(await within(join).findByTestId("invite-join-button-accept"));

  expect(await within(join).findByText("This invite has expired")).toBeOnTheScreen();
  expect(within(join).getByTestId("invite-join-button-back")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/join/${TEST_INVITE_TOKEN}`);
});

// LAST test — the navigating walkthrough (harness quirk 3).
it("accept-success: accept invalidates ['trips'] and lands inside the trip on the default tab", async () => {
  const request = mockNavApi({
    invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview() },
    overrides: {
      "POST /invites/:token/accept": () => Promise.resolve(ACCEPTED),
    },
  });
  const result = await renderApp(`/invite/${TEST_INVITE_TOKEN}`);
  // Seed a FRESH trips-list cache entry (staleTime 5min): without the
  // post-accept invalidation no observer would ever refetch it.
  queryClient.setQueryData(["trips"], { items: [], nextCursor: null });

  const join = await screen.findByTestId("invite-join-screen");
  await fireEvent.press(await within(join).findByTestId("invite-join-button-accept"));

  // Planning trip → itinerary default tab (R-nav-8 via the [tripId] layout).
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toContain(TEST_TRIP_ID);
  // Invalidation evidence: the seeded-fresh list was marked stale, so the
  // trip shell's list observer (TripSwitcher) refetched it — the GET /trips
  // network call exists ONLY because accept invalidated the key (a fresh,
  // un-invalidated entry would have served from cache and reset nothing).
  await waitFor(() => {
    const tripsListCalls = request.mock.calls.filter(
      ([descriptor]) => (descriptor as { path: string }).path === "/trips",
    );
    expect(tripsListCalls.length).toBeGreaterThanOrEqual(1);
  });
});
