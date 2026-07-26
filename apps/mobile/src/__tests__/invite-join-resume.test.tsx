/**
 * Unauth-then-resume invite acceptance, end-to-end (T-6.8 / CT-3;
 * R-nav-14 + R-tripui-10/12) — the invite link while signed out stashes the
 * PARSED target, sign-in resumes it, and the join screen lands
 * AUTHENTICATED so the accept mutation completes the join. Extends the
 * T-6.6 stash/resume pin (deep-link-flow.test.tsx) through the accept leg.
 * One navigating walkthrough per file (harness quirk 3).
 */
import { act, fireEvent, screen, waitFor, within } from "expo-router/testing-library";

import { useSessionStore } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_INVITE_TOKEN, TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { seedUnauthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeInvitePreview, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// In-memory Keychain so the applySignIn token write doesn't hit native
// (same posture as deep-link-flow.test.tsx / auth-gate-flow.test.tsx).
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-nav-14 + CT-3: signed-out invite link stashes, sign-in resumes, accept joins end-to-end", async () => {
  mockNavApi({
    invitePreviews: { [TEST_INVITE_TOKEN]: makeInvitePreview() },
    overrides: {
      "POST /invites/:token/accept": () =>
        Promise.resolve({
          trip_id: TEST_TRIP_ID,
          role: "editor",
          joined_at: "2026-07-26T00:00:00.000Z",
          already_member: false,
        }),
    },
  });
  useSessionStore.setState({ hydrate: async () => undefined });
  seedUnauthenticated();
  await renderApp(`/invite/${TEST_INVITE_TOKEN}`, { seedSession: false });

  // Stash: sign-in first, with the REWRITTEN in-app path (never the raw URL).
  await waitFor(() => expect(screen.getByTestId("sign-in-screen")).toBeOnTheScreen());
  expect(useSessionStore.getState().pendingDestination).toBe(`/join/${TEST_INVITE_TOKEN}`);

  // Resume: sign-in lands on the join screen with the preview, AUTHENTICATED.
  await act(async () => {
    await useSessionStore.getState().applySignIn({
      user: TEST_USER,
      tokens: { access_token: "a", refresh_token: "r", expires_in: 900 },
      is_new_user: false,
    });
  });
  const join = await screen.findByTestId("invite-join-screen");
  expect(await within(join).findByText("Kyoto")).toBeOnTheScreen();
  expect(useSessionStore.getState().pendingDestination).toBeNull();

  // The accept leg works from the resumed screen — the whole point of CT-3's
  // unauth-resume acceptance path.
  await fireEvent.press(within(join).getByTestId("invite-join-button-accept"));
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
});
