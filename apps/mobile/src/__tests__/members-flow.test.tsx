/**
 * Members screen through the REAL tree (T-6.8 / CT-4) — URL-addressed via
 * the [tripId] membership guard + TripProvider, real layouts and hooks, only
 * the network mocked (mockNavApi). Pure-URL renders only (interaction depth
 * is members-screen.test.tsx — harness quirk 3 keeps presses out of
 * multi-render files).
 */
import { screen, within } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { MEMBER_B_ID, TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { makeMember, makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("owner: the members URL renders the real list + invite section through the guard", async () => {
  mockNavApi({
    members: [
      makeMember(),
      makeMember({ user: { id: MEMBER_B_ID, display_name: "Blake Editor" }, role: "editor" }),
    ],
    invites: [],
  });
  await renderApp(`/${TEST_TRIP_ID}/more/members`);

  const root = await screen.findByTestId("members-screen");
  expect(await within(root).findByText("Test Traveler (you)")).toBeOnTheScreen();
  expect(within(root).getByTestId(`members-list-item-${MEMBER_B_ID}`)).toBeOnTheScreen();
  expect(within(root).getByTestId("members-button-invite")).toBeOnTheScreen();
});

it("viewer: the same URL renders zero admin affordances and never queries invites (R-tripui-14)", async () => {
  const request = mockNavApi({
    trips: [makePlanningTrip(TEST_TRIP_ID, { role: "viewer" })],
    members: [
      makeMember({ user: { id: MEMBER_B_ID, display_name: "Blake Owner" } }),
      makeMember({ role: "viewer" }),
    ],
  });
  await renderApp(`/${TEST_TRIP_ID}/more/members`);

  const root = await screen.findByTestId("members-screen");
  expect(await within(root).findByText("Test Traveler (you)")).toBeOnTheScreen();
  expect(within(root).queryByTestId("members-button-invite")).toBeNull();
  expect(within(root).queryByText("Invites")).toBeNull();
  const inviteCalls = request.mock.calls.filter(
    ([descriptor]) => (descriptor as { path: string }).path === "/trips/:tripId/invites",
  );
  expect(inviteCalls).toHaveLength(0);
});
