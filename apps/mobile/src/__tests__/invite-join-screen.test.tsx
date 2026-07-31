/**
 * Invite-join screen states (T-6.6 route / T-6.8 accept; R-tripui-9..12) —
 * component-level over the REAL hooks (only `apiClient.request` mocked,
 * routed by descriptor). Route-level plumbing is the flow suites.
 *
 * Pins the §2.4 matrix: loading, active preview, DISTINCT dead states
 * (expired ≠ revoked/maxed ≠ not-found), already-member, accept success →
 * trips invalidation + navigation, terminal accept 409s vs the RETRYABLE
 * transport class (network drop / 12s timeout — task contract), decline.
 */
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import InviteJoinScreen from "@/app/(trips)/join/[token]";
import { apiClient, ApiRequestError } from "@/auth";
import type { InviteAccept } from "@gogo/shared";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { makeInvitePreview } from "@/test-utils/trip-fixtures";

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn() }),
  useLocalSearchParams: () => ({ token: "tok-under-test" }),
}));

const ACCEPTED: InviteAccept = {
  trip_id: TEST_TRIP_ID,
  role: "editor",
  joined_at: "2026-07-26T00:00:00.000Z",
  already_member: false,
};

const transportError = () => new ApiRequestError(0, "NETWORK", "network request failed");
const conflictError = (reason: string) =>
  new ApiRequestError(409, "CONFLICT", "invite is dead", { reason });

/** Descriptor-routed network mock: preview GET + accept POST. */
function routeApi(routes: {
  preview?: () => Promise<unknown>;
  accept?: () => Promise<unknown>;
}): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((descriptor: { method: string; path: string }) => {
    const key = `${descriptor.method} ${descriptor.path}`;
    if (key === "GET /invites/:token") {
      return (routes.preview ?? (() => Promise.resolve(makeInvitePreview())))();
    }
    if (key === "POST /invites/:token/accept") {
      return (routes.accept ?? (() => Promise.reject(new Error("accept not stubbed"))))();
    }
    return Promise.reject(new Error(`unexpected ${key}`));
  });
  return request;
}

/**
 * Run TanStack's deferred notifyManager batch INSIDE act (B-2 family). The
 * accept tests assert on `mockReplace` — a NON-render observation — so the
 * mutation's state-change notify (a setTimeout(0) batch) would otherwise
 * fire in the gap between act-wrapped operations under CI's 2-core
 * contention ("not wrapped in act", green locally / red in CI). Scheduling
 * our own later timer inside act forces the earlier notify timer to execute
 * within the act scope.
 */
async function flushNotify() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  // Two act-wrapped hops drain both queued batches before teardown (same
  // pattern as profile-screen.test.tsx, which pinned this flake).
  await flushNotify();
  await flushNotify();
  jest.restoreAllMocks();
  mockReplace.mockClear();
});

it("holds a loading surface while the preview is in flight", async () => {
  routeApi({ preview: () => new Promise(() => undefined) }); // never settles
  await renderWithProviders(<InviteJoinScreen />);
  expect(screen.getByTestId("invite-join-screen")).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-loading")).toBeOnTheScreen();
});

it("renders the preview with explicit accept/decline for an active token — never the token", async () => {
  routeApi({});
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("Kyoto")).toBeOnTheScreen();
  expect(screen.getByText(/Test Traveler invited you to join as editor/)).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-button-accept")).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-button-decline")).toBeOnTheScreen();
  expect(screen.queryByText(/tok-under-test/)).toBeNull();
});

it("R-tripui-11: an expired token renders the DISTINCT expired copy naming the inviter", async () => {
  routeApi({ preview: () => Promise.resolve(makeInvitePreview({ state: "expired" })) });
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("This invite has expired")).toBeOnTheScreen();
  expect(screen.getByText(/Ask Test Traveler for a new link/)).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-button-back")).toBeOnTheScreen();
});

it.each(["revoked", "max_uses_reached"] as const)(
  "R-tripui-11: a %s token renders the 'no longer valid' card",
  async (state) => {
    routeApi({ preview: () => Promise.resolve(makeInvitePreview({ state })) });
    await renderWithProviders(<InviteJoinScreen />);
    expect(await screen.findByText("This invite is no longer valid")).toBeOnTheScreen();
    expect(screen.getByTestId("invite-join-button-back")).toBeOnTheScreen();
  },
);

it("R-tripui-11: an unknown token (404) renders 'Invite not found', and back returns to trips", async () => {
  routeApi({ preview: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found")) });
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("Invite not found")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("invite-join-button-back"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
});

it("a preview transport failure is NOT a dead token: retry surface, and retry recovers", async () => {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockRejectedValueOnce(transportError()).mockResolvedValueOnce(makeInvitePreview());
  await renderWithProviders(<InviteJoinScreen />);
  expect(await screen.findByText("Couldn't load this invite")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("invite-join-retry"));
  expect(await screen.findByText("Kyoto")).toBeOnTheScreen();
});

it("R-tripui-12: accept invalidates ['trips'] and navigates into the trip", async () => {
  const request = routeApi({ accept: () => Promise.resolve(ACCEPTED) });
  const client = makeTestQueryClient();
  const invalidateSpy = jest.spyOn(client, "invalidateQueries");
  await renderWithProviders(<InviteJoinScreen />, { queryClient: client });

  await fireEvent.press(await screen.findByTestId("invite-join-button-accept"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  await flushNotify(); // navigation is mocked — settle the success re-render in act
  // Two-key op since the T-6.7 key split (invalidateTripLists): the entry
  // redirect's page AND the visible infinite list both go stale.
  expect(invalidateSpy).toHaveBeenCalledWith({
    queryKey: ["trips"],
    exact: true,
    refetchType: "active",
  });
  expect(invalidateSpy).toHaveBeenCalledWith({
    queryKey: ["trip-list"],
    exact: true,
    refetchType: "active",
  });
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/invites/:token/accept" }),
    { params: { token: "tok-under-test" } },
  );
});

it.each(["expired", "revoked", "max_uses_reached"] as const)(
  "an accept 409 (%s) is TERMINAL: the dead card replaces the preview, no navigation",
  async (reason) => {
    routeApi({ accept: () => Promise.reject(conflictError(reason)) });
    await renderWithProviders(<InviteJoinScreen />);

    await fireEvent.press(await screen.findByTestId("invite-join-button-accept"));

    const title =
      reason === "expired" ? "This invite has expired" : "This invite is no longer valid";
    expect(await screen.findByText(title)).toBeOnTheScreen();
    expect(screen.queryByTestId("invite-join-button-accept")).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
  },
);

it("an accept 404 renders the not-found card", async () => {
  routeApi({ accept: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "nf")) });
  await renderWithProviders(<InviteJoinScreen />);
  await fireEvent.press(await screen.findByTestId("invite-join-button-accept"));
  expect(await screen.findByText("Invite not found")).toBeOnTheScreen();
});

it("an accept transport failure (12s timeout class) is RETRYABLE: banner + intact preview, retry lands", async () => {
  let attempts = 0;
  routeApi({
    accept: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(transportError()) : Promise.resolve(ACCEPTED);
    },
  });
  await renderWithProviders(<InviteJoinScreen />);

  await fireEvent.press(await screen.findByTestId("invite-join-button-accept"));

  // Retryable class: NO dead card — the preview and accept stay available.
  const banner = await screen.findByTestId("invite-join-banner");
  expect(banner).toBeOnTheScreen();
  expect(screen.getByText(/network trouble/i)).toBeOnTheScreen();
  expect(screen.getByText("Kyoto")).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-button-accept")).toBeOnTheScreen();
  expect(mockReplace).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByTestId("invite-join-banner-retry"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  await flushNotify();
});

it("R-tripui-12 already-member: notice + Open trip (idempotent accept), no accept/decline pair", async () => {
  routeApi({
    preview: () => Promise.resolve(makeInvitePreview({ already_member: true })),
    accept: () => Promise.resolve({ ...ACCEPTED, already_member: true }),
  });
  await renderWithProviders(<InviteJoinScreen />);

  expect(await screen.findByText("You're already in this trip.")).toBeOnTheScreen();
  expect(screen.queryByTestId("invite-join-button-accept")).toBeNull();
  expect(screen.queryByTestId("invite-join-button-decline")).toBeNull();

  await fireEvent.press(screen.getByTestId("invite-join-button-open-trip"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  await flushNotify();
});

it("R-tripui-12 decline: returns to the trip list with NO server call", async () => {
  const request = routeApi({});
  await renderWithProviders(<InviteJoinScreen />);

  await fireEvent.press(await screen.findByTestId("invite-join-button-decline"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/(trips)"));
  const acceptCalls = request.mock.calls.filter(
    ([descriptor]) => (descriptor as { path: string }).path === "/invites/:token/accept",
  );
  expect(acceptCalls).toHaveLength(0);
});

it("a re-tapped link after accept refetches the preview — no stale 'Join as' replay (round-1 eviction)", async () => {
  let previewCalls = 0;
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((descriptor: { method: string; path: string }) => {
    const key = `${descriptor.method} ${descriptor.path}`;
    if (key === "GET /invites/:token") {
      previewCalls += 1;
      // The server flips already_member once the caller has accepted.
      return Promise.resolve(makeInvitePreview(previewCalls === 1 ? {} : { already_member: true }));
    }
    if (key === "POST /invites/:token/accept") return Promise.resolve(ACCEPTED);
    return Promise.reject(new Error(`unexpected ${key}`));
  });

  // Prod-like cache semantics: a non-evicted preview stays FRESH for 5min,
  // so this test is red without useAcceptInvite's removeQueries eviction.
  // Query gcTime must exceed the unmount→remount gap (or the entry would be
  // GC'd and refetched regardless, making the pin vacuous) — Infinity
  // schedules NO timer. Mutations pin gcTime 0: the default 5-min mutation
  // gc timer is the exact "jest did not exit" landmine mobile.md documents.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 5 * 60 * 1000 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  const first = await renderWithProviders(<InviteJoinScreen />, { queryClient: client });
  await fireEvent.press(await screen.findByTestId("invite-join-button-accept"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/${TEST_TRIP_ID}`));
  await flushNotify();
  await first.unmount();
  await flushNotify();

  // Re-tap: a fresh mount of the same route against the same cache.
  await renderWithProviders(<InviteJoinScreen />, { queryClient: client });
  expect(await screen.findByText("You're already in this trip.")).toBeOnTheScreen();
  expect(screen.getByTestId("invite-join-button-open-trip")).toBeOnTheScreen();
  expect(screen.queryByTestId("invite-join-button-accept")).toBeNull();
});
