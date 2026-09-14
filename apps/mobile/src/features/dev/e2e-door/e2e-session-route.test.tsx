/**
 * `(auth)/e2e-session` route (S-4 T4; .specs/testing/session-door.spec.md
 * §4.5) — the double render gate (R-door-7), the load-bearing `flex: 1`
 * inert marker (mirrors the diagnostics-route falsification, S-4 PR #61),
 * the hydration-then-reset-then-mint ordering (R-door-8), and the
 * ready/error state markers.
 *
 * Component-level over the REAL `useSessionStore` singleton + REAL
 * `apiClient` (only `globalThis.fetch` mocked) — per the mobile-rules
 * landmine, a wholesale `jest.mock("@/auth")` here would hide a render-time
 * crash in that module (T-5.7 precedent).
 */
import { act, screen, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import E2eSessionRoute from "@/app/(auth)/e2e-session";
import { useSessionStore } from "@/auth";
import { renderWithTheme } from "@/test-utils/render";

jest.mock("expo-secure-store", () => {
  const map = new Map<string, string>();
  return {
    __esModule: true,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlock",
    getItemAsync: jest.fn(async (key: string) => map.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      map.delete(key);
    }),
  };
});

jest.mock("expo-device", () => ({ __esModule: true, deviceName: "Test Device" }));

// Mutable per-test (R-door-16 third gate) — a getter so `isDoorBundleId()`'s
// default read picks up whatever the CURRENT test set, without a
// `jest.resetModules()`/`jest.doMock()` dance per case.
let mockBundleId: string | null = "app.gogotravel.e2edoor";
jest.mock("expo-application", () => ({
  __esModule: true,
  get applicationId() {
    return mockBundleId;
  },
}));

let mockSearchParams: Record<string, string | undefined> = {};
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockSearchParams,
}));

const SECRET = "s".repeat(32);
const LOCAL_API_URL = "http://localhost:3000";
const PUBLIC_API_URL = "https://api.gogotravel.example";
const DOOR_BUNDLE_ID = "app.gogotravel.e2edoor";
const SHIPPING_BUNDLE_ID = "app.gogotravel";

const originalFetch = globalThis.fetch;
const originalSecretEnv = process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
const originalApiUrlEnv = process.env.EXPO_PUBLIC_API_URL;

function signInJson(overrides: { is_new_user?: boolean } = {}) {
  return {
    user: {
      id: "00000000-0000-4000-8000-000000000003",
      email: "e2e+flow-1@gogotravel.invalid",
      display_name: "E2E flow-1",
      avatar_key: null,
      prefs: {},
      venmo_username: null,
      cashtag: null,
      paypalme_username: null,
      zelle_handle: null,
      zelle_display_name: null,
      forward_email_slug: null,
      created_at: "2026-09-13T00:00:00.000Z",
    },
    tokens: { access_token: "door-access", refresh_token: "door-refresh", expires_in: 900 },
    is_new_user: overrides.is_new_user ?? false,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  mockSearchParams = { user_key: "flow-1", first_run: "false" };
  mockBundleId = DOOR_BUNDLE_ID;
  useSessionStore.setState({
    hydrated: true,
    user: null,
    accessToken: null,
    firstRun: false,
    pendingDestination: null,
    resetting: false,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecretEnv === undefined) delete process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
  else process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = originalSecretEnv;
  if (originalApiUrlEnv === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = originalApiUrlEnv;
});

describe("render gate (R-door-7): both conditions must hold or the arm is inert", () => {
  it("door-free build (no secret) -> inert marker, load-bearing flex:1, NO network call", async () => {
    delete process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);

    const marker = screen.getByTestId("e2e-session-screen-inert");
    expect(marker).toBeOnTheScreen();
    // 🔴 flex:1 IS LOAD-BEARING (mirrors diagnostics-screen-inert, S-4 PR #61):
    // a zero-frame view is excluded from the XCUITest a11y hierarchy outright.
    // Falsification: drop `flex: 1` from the inert View's style -> RED here.
    expect(StyleSheet.flatten(marker.props.style)).toMatchObject({ flex: 1 });
    expect(screen.queryByTestId("e2e-session-screen")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("door build + PUBLIC api base -> inert marker, NO network call (secret alone is not enough)", async () => {
    // Falsification: drop the `isLocalOrPrivateHost` half of the route's gate
    // -> this goes RED (a live fetch would fire against the public host).
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = PUBLIC_API_URL;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);

    expect(screen.getByTestId("e2e-session-screen-inert")).toBeOnTheScreen();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("door build + LOCAL api base + SHIPPING bundle id -> inert marker, NO network call (R-door-16 third gate)", async () => {
    // Falsification: drop the `isDoorBundleId` half of the route's gate ->
    // this goes RED (a live fetch would fire from a binary that skipped
    // prebuild and still wears the shipping identity — review round 1 B1).
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    mockBundleId = SHIPPING_BUNDLE_ID;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);

    expect(screen.getByTestId("e2e-session-screen-inert")).toBeOnTheScreen();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("door build + LOCAL api base -> enabled arm mounts (control arm proving the gate can open)", async () => {
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    // T-7.9 pattern: hold the mint genuinely in flight so the PENDING marker
    // is observable, released in `finally` (a thrown assertion must not
    // wedge the file).
    let releaseMint: (() => void) | undefined;
    const mintPending = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    const fetchMock = jest.fn(async () => {
      await mintPending;
      return jsonResponse(200, signInJson());
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);

    const root = screen.getByTestId("e2e-session-screen");
    expect(root).toBeOnTheScreen();
    expect(screen.queryByTestId("e2e-session-screen-inert")).toBeNull();
    try {
      // 🔴 flex:1 is load-bearing on EVERY marker, not just the inert one —
      // a zero-frame view is excluded from the XCUITest a11y hierarchy
      // outright, so Maestro's `notVisible: e2e-session-screen` barrier
      // (§5.3) would silently pass on a zero-frame screen even on a door
      // FAILURE. Pinned here on the root and the pending marker (still
      // visible while the mint is deliberately held open); the ready marker
      // is pinned below, once released.
      expect(StyleSheet.flatten(root.props.style)).toMatchObject({ flex: 1 });
      expect(
        StyleSheet.flatten(screen.getByTestId("e2e-session-pending").props.style),
      ).toMatchObject({ flex: 1 });
    } finally {
      releaseMint?.();
    }

    await waitFor(() => expect(screen.getByTestId("e2e-session-ready")).toBeOnTheScreen());
    expect(StyleSheet.flatten(screen.getByTestId("e2e-session-ready").props.style)).toMatchObject({
      flex: 1,
    });
  });
});

describe("ordering (R-door-8): hydration gate, then reset, then mint, then apply", () => {
  it("does not attempt a mint until hydration finishes", async () => {
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(200, signInJson()));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    useSessionStore.setState({ hydrated: false });

    await renderWithTheme(<E2eSessionRoute />);

    expect(screen.getByTestId("e2e-session-pending")).toBeOnTheScreen();
    expect(fetchMock).not.toHaveBeenCalled();

    // Falsification: remove the `!hydrated` early-return in the route's
    // effect -> the mint would already have fired above, RED.
    await act(async () => {
      useSessionStore.setState({ hydrated: true });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("e2e-session-ready")).toBeOnTheScreen());
  });

  it("applies the minted session through the real applySignIn path (user + tokens land on the store)", async () => {
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    const body = signInJson({ is_new_user: true });
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, body)) as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);
    await waitFor(() => expect(screen.getByTestId("e2e-session-ready")).toBeOnTheScreen());

    expect(useSessionStore.getState().user?.id).toBe(body.user.id);
    expect(useSessionStore.getState().accessToken).toBe("door-access");
    expect(useSessionStore.getState().firstRun).toBe(true);
  });
});

describe("server rejection (R-door-3): a 401 never applies a session", () => {
  it("renders e2e-session-error and leaves the store signed out", async () => {
    process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
    process.env.EXPO_PUBLIC_API_URL = LOCAL_API_URL;
    globalThis.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { error: { code: "UNAUTHENTICATED", message: "Not authenticated." } }),
      ) as unknown as typeof fetch;

    await renderWithTheme(<E2eSessionRoute />);

    await waitFor(() => expect(screen.getByTestId("e2e-session-error")).toBeOnTheScreen());
    expect(useSessionStore.getState().user).toBeNull();
    // 🔴 flex:1 load-bearing on the error marker too (B3, mirrors the
    // pending/ready pins above) — an error must be as reliably assertable
    // by Maestro as success.
    expect(StyleSheet.flatten(screen.getByTestId("e2e-session-error").props.style)).toMatchObject({
      flex: 1,
    });
  });
});
