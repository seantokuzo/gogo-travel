/**
 * Deep links against the REAL tree (T-6.6 / NAV-5). Named per acceptance
 * line:
 *   - invite link, cold start → join screen with preview      (R-nav-11/16)
 *   - expired invite → in-screen error + path back            (R-nav-11)
 *   - non-member trip link → no-access, zero trip data        (R-nav-15)
 *   - settle-request link → request detail in trip context    (R-nav-13)
 *   - malformed link → trip list + non-blocking notice        (R-nav-17)
 *   - unauthenticated link → stash (PARSED target), resume    (R-nav-14)
 *
 * Cold start: renderRouter's initialUrl flows through the SAME
 * `getInitialURL → redirectSystemPath` path production uses (the harness
 * strips scheme/host first — full-URL parsing is pinned by the registry unit
 * tests). Warm-start scope note: see the R-nav-16 comment below.
 *
 * Store-transition/press tests are LAST (harness quirk 3).
 */
import { act, screen, waitFor, within } from "expo-router/testing-library";

import { useSessionStore } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { useLinkNoticeStore } from "@/navigation/link-notice";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_INVITE_TOKEN, TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { seedUnauthenticated, TEST_USER } from "@/test-utils/session-fixtures";
import { makeInvitePreview, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

// In-memory Keychain so the R-nav-14 applySignIn token write doesn't hit
// native (same posture as auth-gate-flow.test.tsx).
jest.mock("expo-secure-store", () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const EXPIRED_TOKEN = "tok-expired";

function mockLinkApi() {
  return mockNavApi({
    invitePreviews: {
      [TEST_INVITE_TOKEN]: makeInvitePreview(),
      [EXPIRED_TOKEN]: makeInvitePreview({ state: "expired" }),
    },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
  useLinkNoticeStore.setState({ message: null });
});

it("R-nav-11/16 cold: an invite link routes to the join screen and shows the preview", async () => {
  mockLinkApi();
  const result = await renderApp(`/invite/${TEST_INVITE_TOKEN}`);
  const join = await screen.findByTestId("invite-join-screen");
  expect(result.getPathname()).toBe(`/join/${TEST_INVITE_TOKEN}`);
  expect(await within(join).findByText("Kyoto")).toBeOnTheScreen();
  // Bearer-credential hygiene: the token itself is never rendered.
  expect(within(join).queryByText(new RegExp(TEST_INVITE_TOKEN))).toBeNull();
});

it("R-nav-11 expired: a dead token renders the in-screen error with a path back to trips", async () => {
  mockLinkApi();
  await renderApp(`/invite/${EXPIRED_TOKEN}`);
  const join = await screen.findByTestId("invite-join-screen");
  expect(await within(join).findByText("Invite not available")).toBeOnTheScreen();
  expect(within(join).getByTestId("invite-join-button-trips")).toBeOnTheScreen();
});

it("R-nav-15 + NAV-5: a trip deep link for a non-member renders no-access with zero trip data", async () => {
  const request = mockNavApi({ trips: [] }); // this user is a member of nothing
  await renderApp(`/t/${TRIP_B_ID}`);
  expect(await screen.findByTestId("no-access-screen")).toBeOnTheScreen();
  // The ONLY trip call is the guard's indistinguishable-404 membership check.
  const tripCalls = request.mock.calls.filter(
    ([descriptor]) => (descriptor as { path: string }).path.startsWith("/trips"),
  );
  expect(tripCalls).toEqual([
    [
      expect.objectContaining({ path: "/trips/:tripId" }),
      { params: { tripId: TRIP_B_ID } },
      { signal: expect.any(AbortSignal) },
    ],
  ]);
});

it("R-nav-13: a settle-request link routes to the request detail inside the trip's money context", async () => {
  mockLinkApi();
  const result = await renderApp(`/t/${TEST_TRIP_ID}/request/req-5`);
  const request = await screen.findByTestId("settle-request-screen");
  expect(within(request).getByText("Request req-5")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/money/request/req-5`);
});

it("R-nav-17: an unknown link lands on the trip list with the non-blocking notice — no crash, no blank screen", async () => {
  mockLinkApi();
  const result = await renderApp("/definitely/not/a/route");
  expect(await screen.findByTestId("trip-list-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe("/");
  expect(await screen.findByTestId("trip-list-link-notice")).toBeOnTheScreen();
});

/*
 * R-nav-16 warm-start HONEST SCOPE: renderRouter precomputes the initial
 * navigation state (serverUrl path), and under that path the container never
 * registers the expo-linking `url` subscription — a warm `url` EVENT is not
 * simulatable in this harness (verified empirically: Linking.addEventListener
 * is never called). Cold/warm parity is still machine-verified where it is
 * structural: expo-router invokes the SAME `redirectSystemPath` for the
 * initial URL (initial:true) and every warm event (initial:false), and
 * deep-links.test.ts pins that both flags resolve identically for every
 * family. The warm transport itself is simulator-QA evidence at phase close.
 */

it("R-nav-14: an invite link while signed out stashes the PARSED target and resumes it after sign-in", async () => {
  // LAST test (store transitions navigate — quirk 3).
  mockLinkApi();
  useSessionStore.setState({ hydrate: async () => undefined });
  seedUnauthenticated();
  await renderApp(`/invite/${TEST_INVITE_TOKEN}`, { seedSession: false });

  // R-nav-1 machinery: sign-in first, with the REWRITTEN in-app path stashed
  // (never the raw URL — authz/expiry re-checks happen at resume, §2.3).
  await waitFor(() => expect(screen.getByTestId("sign-in-screen")).toBeOnTheScreen());
  expect(useSessionStore.getState().pendingDestination).toBe(`/join/${TEST_INVITE_TOKEN}`);

  // Returning user signs in → the link resumes (R-nav-2/14).
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
});
