/**
 * Profile screen (T-5.8) — component-level behavior with the REAL session store
 * and the network boundary (`apiClient.request`) mocked by descriptor. expo-router
 * is stubbed (PageHeader's useRouter). Covers: load via getMe, name edit PATCH,
 * handles edit PATCH, session list + confirmed revoke, hard-confirmed delete →
 * DELETE, confirmed sign-out → signOut + query-cache clear, entitlements render,
 * and the error state.
 */
import {
  authEndpoints,
  userEndpoints,
  type AuthSessionInfo,
  type EffectiveEntitlements,
} from "@gogo/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";

import type { QueryClient } from "@tanstack/react-query";

import { apiClient, ApiRequestError, useSessionStore } from "@/auth";
import ProfileScreen from "@/app/(trips)/profile";
import { queryClient } from "@/data";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { TEST_USER, seedAuthenticated } from "@/test-utils/session-fixtures";

/** The last render's client — the afterEach drain reads its isFetching. */
let lastClient: QueryClient | null = null;

async function renderScreen() {
  const client = makeTestQueryClient();
  lastClient = client;
  return renderWithProviders(<ProfileScreen />, { queryClient: client });
}

jest.mock("expo-router", () => ({
  __esModule: true,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

const SESSION_CURRENT: AuthSessionInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  device_name: "This iPhone",
  platform: "ios",
  created_at: "2026-07-24T00:00:00.000Z",
  last_used_at: "2026-07-24T00:00:00.000Z",
  current: true,
};

const SESSION_OTHER: AuthSessionInfo = {
  id: "22222222-2222-4222-8222-222222222222",
  device_name: "Old iPad",
  platform: "ios",
  created_at: "2026-07-20T00:00:00.000Z",
  last_used_at: "2026-07-22T00:00:00.000Z",
  current: false,
};

const ENTITLEMENTS: EffectiveEntitlements = {
  plan: "free",
  ai_calls_per_day: 30,
  alerts_enabled: true,
  premium_place_details: false,
};

const HANDLES = {
  venmo_username: "sean",
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
};

/**
 * Route the mocked network by `METHOD path` (path is the descriptor pattern).
 * `overrides` replaces individual routes — used to inject partial failures.
 */
function mockApi(overrides: Record<string, () => Promise<unknown>> = {}): jest.Mock {
  const request = jest.spyOn(apiClient, "request") as unknown as jest.Mock;
  request.mockImplementation((descriptor: { method: string; path: string }) => {
    const key = `${descriptor.method} ${descriptor.path}`;
    const override = overrides[key];
    if (override) return override();
    switch (key) {
      case "GET /users/me":
        return Promise.resolve(TEST_USER);
      case "PATCH /users/me":
        return Promise.resolve({ ...TEST_USER, display_name: "Edited" });
      case "PATCH /users/me/payment-handles":
        return Promise.resolve(HANDLES);
      case "GET /auth/sessions":
        return Promise.resolve({ items: [SESSION_CURRENT, SESSION_OTHER], nextCursor: null });
      case "DELETE /auth/sessions/:sessionId":
        return Promise.resolve(undefined);
      case "GET /users/me/entitlements":
        return Promise.resolve(ENTITLEMENTS);
      case "DELETE /users/me":
        return Promise.resolve(undefined);
      case "POST /auth/logout":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unexpected ${descriptor.method} ${descriptor.path}`));
    }
  });
  return request;
}

afterEach(async () => {
  // Drain TanStack's queued notifyManager macrotasks INSIDE act before
  // teardown: the screen mounts FOUR queries, and a test that ends on one
  // section's assertion can leave another section's settle notification on a
  // setTimeout(0) that lands post-test — an un-act-wrapped update (B-2 flake
  // family; SessionsSection/EntitlementsSection fired intermittently under
  // --maxWorkers=2). Loop-until-idle (T-6.6 R2, replacing a fixed 2-hop
  // constant): exit only after TWO consecutive idle hops — a hop that
  // settles the last in-flight fetch leaves that settle's notify batch
  // queued, so idleness must be observed twice (the second idle hop flushes
  // it). Bounded at 6 hops so a genuine hang fails the suite loudly.
  let hops = 0;
  let idleHops = 0;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    hops += 1;
    idleHops = (lastClient?.isFetching() ?? 0) > 0 ? 0 : idleHops + 1;
  } while (idleHops < 2 && hops < 6);
  // Loud exit (R1): hitting the hop bound while still fetching must FAIL
  // the suite, not silently hand a wedged query to the next test. The check
  // reads the RENDER's client — the prod singleton never fetches here.
  expect(lastClient?.isFetching() ?? 0).toBe(0);
  lastClient = null;
  jest.restoreAllMocks();
  queryClient.clear();
  // Defensive: real timers even if a sibling renderRouter suite leaked fake ones.
  jest.useRealTimers();
});

/**
 * Consume a mutation's settle chain INSIDE the test (B-2 family): the
 * request assert passes at call time, but the isPending flip and the
 * invalidate-driven me-refetch ride notify timers that otherwise fire in
 * the unwrapped gap between the test and afterEach (observed 1-in-4 under
 * the 8× --maxWorkers=2 protocol, T-6.7). Two timer awaits in ONE act
 * window: mutation notify → refetch fire+settle → its notify.
 */
async function settleMutation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ProfileScreen", () => {
  it("loads the profile and prefills the display name", async () => {
    seedAuthenticated();
    mockApi();
    await renderScreen();

    expect(await screen.findByTestId("profile-section-edit")).toBeOnTheScreen();
    expect(screen.getByTestId("profile-input-name").props.value).toBe(TEST_USER.display_name);
  });

  it("saves an edited display name via updateMe", async () => {
    seedAuthenticated();
    const request = mockApi();
    await renderScreen();
    await screen.findByTestId("profile-input-name");

    await fireEvent.changeText(screen.getByTestId("profile-input-name"), "Edited");
    await fireEvent.press(screen.getByTestId("profile-button-save-name"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(userEndpoints.updateMe, {
        body: { display_name: "Edited" },
      }),
    );
    await settleMutation();
  });

  it("saves payment handles via updatePaymentHandles", async () => {
    seedAuthenticated();
    const request = mockApi();
    await renderScreen();
    await screen.findByTestId("profile-input-venmo");

    await fireEvent.changeText(screen.getByTestId("profile-input-venmo"), "@sean");
    await fireEvent.press(screen.getByTestId("profile-button-save-handles"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(userEndpoints.updatePaymentHandles, {
        body: { venmo_username: "@sean" },
      }),
    );
    await settleMutation();
  });

  it("marks the current session, blocks its revoke, and revokes another after confirm", async () => {
    seedAuthenticated();
    const request = mockApi();
    await renderScreen();
    await screen.findByTestId(`profile-session-${SESSION_CURRENT.id}`);

    // Current session: badge present, no revoke button.
    expect(screen.queryByTestId(`profile-revoke-${SESSION_CURRENT.id}`)).toBeNull();

    await fireEvent.press(screen.getByTestId(`profile-revoke-${SESSION_OTHER.id}`));
    await fireEvent.press(screen.getByTestId("profile-revoke-dialog-confirm"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(authEndpoints.revokeSession, {
        params: { sessionId: SESSION_OTHER.id },
      }),
    );
    await settleMutation();
  });

  it("deletes the account after a hard confirm, then signs out", async () => {
    seedAuthenticated();
    const request = mockApi();
    await renderScreen();
    await screen.findByTestId("profile-button-delete");

    await fireEvent.press(screen.getByTestId("profile-button-delete"));
    await fireEvent.press(screen.getByTestId("profile-delete-dialog-confirm"));

    await waitFor(() => expect(request).toHaveBeenCalledWith(userEndpoints.deleteMe, {}));
    await waitFor(() => expect(useSessionStore.getState().user).toBeNull());
  });

  it("signs out after confirm and clears the query cache", async () => {
    seedAuthenticated();
    mockApi();
    const clear = jest.spyOn(queryClient, "clear");
    await renderScreen();
    await screen.findByTestId("profile-button-signout");

    await fireEvent.press(screen.getByTestId("profile-button-signout"));
    await fireEvent.press(screen.getByTestId("profile-signout-dialog-confirm"));

    await waitFor(() => expect(useSessionStore.getState().user).toBeNull());
    expect(clear).toHaveBeenCalled();
  });

  it("renders the read-only entitlements", async () => {
    seedAuthenticated();
    mockApi();
    await renderScreen();

    const planRow = await screen.findByTestId("profile-entitlement-plan");
    expect(within(planRow).getByText("Free")).toBeOnTheScreen();
    expect(within(screen.getByTestId("profile-entitlement-ai")).getByText("30")).toBeOnTheScreen();
  });

  it("shows an error banner when the profile read fails", async () => {
    seedAuthenticated();
    (jest.spyOn(apiClient, "request") as unknown as jest.Mock).mockRejectedValue(
      new ApiRequestError(500, "UNKNOWN", "boom"),
    );
    await renderScreen();

    expect(await screen.findByTestId("profile-error")).toBeOnTheScreen();
  });

  it("shows the sessions error on a partial failure (profile OK, sessions read fails)", async () => {
    seedAuthenticated();
    // getMe + entitlements resolve so the sections mount; ONLY the sessions read
    // fails — the realistic partial failure the sessions-error branch exists for.
    mockApi({
      "GET /auth/sessions": () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    await renderScreen();

    expect(await screen.findByTestId("profile-sessions-error")).toBeOnTheScreen();
  });

  it("surfaces a revoke failure instead of silently claiming success", async () => {
    seedAuthenticated();
    mockApi({
      "DELETE /auth/sessions/:sessionId": () =>
        Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    await renderScreen();
    await screen.findByTestId(`profile-session-${SESSION_OTHER.id}`);

    await fireEvent.press(screen.getByTestId(`profile-revoke-${SESSION_OTHER.id}`));
    await fireEvent.press(screen.getByTestId("profile-revoke-dialog-confirm"));

    expect(await screen.findByTestId("profile-revoke-error")).toBeOnTheScreen();
  });

  it("keeps the user signed in and surfaces an error when account deletion fails", async () => {
    seedAuthenticated();
    mockApi({
      "DELETE /users/me": () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    await renderScreen();
    await screen.findByTestId("profile-button-delete");

    await fireEvent.press(screen.getByTestId("profile-button-delete"));
    await fireEvent.press(screen.getByTestId("profile-delete-dialog-confirm"));

    expect(await screen.findByTestId("profile-delete-error")).toBeOnTheScreen();
    // Deletion failed → still authenticated, and the button returns from loading.
    expect(useSessionStore.getState().user).not.toBeNull();
    expect(screen.getByTestId("profile-button-delete")).toBeEnabled();
  });
});
