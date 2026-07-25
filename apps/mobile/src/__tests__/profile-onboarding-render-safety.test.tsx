/**
 * Render safety for onboarding + profile (T-5.8) — the mobile.md landmine
 * guard: render each screen through the REAL `src/app` route tree
 * (renderRouter) with the REAL session store + api-client, mocking ONLY the
 * network boundary (`apiClient.request`), and assert it mounts WITHOUT throwing
 * — including profile in its error and empty states. A whole-module mock
 * (`jest.mock("@/auth")`) would have hidden the T-5.7 render-time crash; this
 * suite deliberately does not use one.
 */
import type { AuthSessionInfo, EffectiveEntitlements } from "@gogo/shared";
import { screen } from "@testing-library/react-native";
import { cleanup, renderRouter } from "expo-router/testing-library";

import { apiClient, ApiRequestError } from "@/auth";
import { queryClient } from "@/data";
import { TEST_USER, seedAuthenticated } from "@/test-utils/session-fixtures";

// Tab/segment haptics ride expo-haptics natively — keep it out of the loop
// (same convention as navigation-skeleton.test.tsx).
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const APP_DIR = "src/app";

const SESSION_CURRENT: AuthSessionInfo = {
  id: "11111111-1111-4111-8111-111111111111",
  device_name: "This iPhone",
  platform: "ios",
  created_at: "2026-07-24T00:00:00.000Z",
  last_used_at: "2026-07-24T00:00:00.000Z",
  current: true,
};

const ENTITLEMENTS: EffectiveEntitlements = {
  plan: "free",
  ai_calls_per_day: 30,
  alerts_enabled: true,
  premium_place_details: false,
};

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

async function renderApp(url: string) {
  await cleanup();
  jest.useRealTimers();
  const result = renderRouter(APP_DIR, { initialUrl: url });
  await result;
  return result;
}

// This suite renders the REAL route tree, so it uses the PROD queryClient
// singleton (mounted by src/app/_layout). Neutralize its production timing for
// tests — gcTime/staleTime 0 + retry off — so no lingering GC timeout or stale
// cache bleeds timing into later suites (determinism, B-2). Real store +
// real api-client stay untouched; only the client's timing config is test-safe.
beforeAll(() => {
  queryClient.setDefaultOptions({
    queries: { retry: false, gcTime: 0, staleTime: 0 },
    mutations: { retry: false, gcTime: 0 },
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await queryClient.cancelQueries();
  queryClient.clear();
  await cleanup();
  jest.useRealTimers();
});

describe("render safety — real route tree", () => {
  it("onboarding mounts without throwing", async () => {
    seedAuthenticated({ firstRun: true });
    spyRequest().mockResolvedValue(TEST_USER);

    await renderApp("/onboarding");

    expect(await screen.findByTestId("onboarding-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("onboarding-header")).toBeOnTheScreen();
  });

  it("profile mounts its sections with real store + mocked network", async () => {
    seedAuthenticated();
    spyRequest().mockImplementation((d: { method: string; path: string }) => {
      switch (`${d.method} ${d.path}`) {
        case "GET /users/me":
          return Promise.resolve(TEST_USER);
        case "GET /auth/sessions":
          return Promise.resolve({ items: [SESSION_CURRENT], nextCursor: null });
        case "GET /users/me/entitlements":
          return Promise.resolve(ENTITLEMENTS);
        default:
          return Promise.reject(new Error(`unexpected ${d.method} ${d.path}`));
      }
    });

    await renderApp("/profile");

    expect(await screen.findByTestId("profile-section-edit")).toBeOnTheScreen();
    expect(await screen.findByTestId(`profile-session-${SESSION_CURRENT.id}`)).toBeOnTheScreen();
  });

  it("profile mounts without throwing when the profile read fails (error state)", async () => {
    seedAuthenticated();
    spyRequest().mockRejectedValue(new ApiRequestError(400, "UNKNOWN", "bad request"));

    await renderApp("/profile");

    expect(await screen.findByTestId("profile-screen")).toBeOnTheScreen();
    expect(await screen.findByTestId("profile-error")).toBeOnTheScreen();
  });

  it("profile renders the empty sessions state without throwing", async () => {
    seedAuthenticated();
    spyRequest().mockImplementation((d: { method: string; path: string }) => {
      switch (`${d.method} ${d.path}`) {
        case "GET /users/me":
          return Promise.resolve(TEST_USER);
        case "GET /auth/sessions":
          return Promise.resolve({ items: [], nextCursor: null });
        case "GET /users/me/entitlements":
          return Promise.resolve(ENTITLEMENTS);
        default:
          return Promise.reject(new Error(`unexpected ${d.method} ${d.path}`));
      }
    });

    await renderApp("/profile");

    expect(await screen.findByTestId("profile-sessions-empty")).toBeOnTheScreen();
  });
});
