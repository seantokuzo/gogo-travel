/**
 * Already-member invite walkthrough (T-6.8 / CT-3; R-tripui-12) — the
 * preview flags membership, the screen shows the notice + Open trip, and
 * "Open trip" rides the IDEMPOTENT accept (R-trips-15: 200 + already_member,
 * no use_count increment) because the preview withholds trip_id until
 * acceptance. One navigating walkthrough per file (harness quirk 3).
 */
import { fireEvent, screen, within } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_INVITE_TOKEN, TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeInvitePreview, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("already-member: notice + Open trip → idempotent accept → straight into the trip", async () => {
  const request = mockNavApi({
    invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview({ already_member: true }) },
    overrides: {
      "POST /invites/:token/accept": () =>
        Promise.resolve({
          trip_id: TEST_TRIP_ID,
          role: "editor",
          joined_at: "2026-07-26T00:00:00.000Z",
          already_member: true,
        }),
    },
  });
  await renderApp(`/invite/${TEST_INVITE_TOKEN}`);

  const join = await screen.findByTestId("invite-join-screen");
  expect(await within(join).findByText("You're already in this trip.")).toBeOnTheScreen();
  // No accept/decline pair on the already-member surface (§2.4 row).
  expect(within(join).queryByTestId("invite-join-button-accept")).toBeNull();
  expect(within(join).queryByTestId("invite-join-button-decline")).toBeNull();

  await fireEvent.press(within(join).getByTestId("invite-join-button-open-trip"));

  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  const acceptCalls = request.mock.calls.filter(
    ([descriptor]) => (descriptor as { path: string }).path === "/invites/:token/accept",
  );
  expect(acceptCalls).toHaveLength(1);
});
