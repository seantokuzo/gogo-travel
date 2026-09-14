/**
 * A5 (S-4 T4 review round 1): "warm-authed start" into the E2E session door
 * — `gogo://e2e-session` opens while the app is ALREADY mounted, settled,
 * and authenticated (e.g. the door link fires mid-session rather than from
 * a cold, signed-out launch — the shape `renderRouter`'s honest warm-link
 * scope note (`deep-link-flow.test.tsx` R-nav-16) says a native `url` EVENT
 * can't simulate, but an imperative warm `router.navigate` — the SAME
 * pattern `navigation-skeleton.test.tsx`/`trip-default-tab.test.tsx` already
 * use for a warm in-app navigation — reproduces the same React tree-mounting
 * shape). Mounted through the REAL route tree — `AuthGate` wraps the door
 * route in the actual app.
 *
 * The reviewer's theorized mechanism (`resolveGate`'s `resume` branch,
 * `auth-gate.ts:55`, firing on a STALE pre-reset `authed` closure because
 * `AuthGate`'s redirect effect runs in the same commit as, but after, the
 * door route's own reset-triggering mount effect) is real React behavior in
 * general, and `AuthGate.tsx` now reads the session store FRESH
 * (`useSessionStore.getState()`) at decision time instead of the render-time
 * `authed`/`firstRun`/`resetting` closures, which is strictly more correct
 * regardless. BUT: this specific test does NOT falsify that fix. Instrumented
 * while drafting it (a temporary `console.log` on every `resolveGate` call,
 * removed before this landed): react-navigation's own dispatch for
 * `router.navigate` — and separately, `renderRouter`'s `initialUrl` cold-boot
 * path plus the pre-existing B-14 `routeReadSettled` latch — both already
 * give the reset several render cycles' head start before `AuthGate`'s
 * redirect effect ever observes `inAuthGroup: true`; `authed` was ALREADY
 * `false` by the first commit where that mattered, with or without the live
 * read. Two reproduction shapes were tried (a bare cold `renderApp` mount on
 * this route, and this warm `router.navigate` shape) and neither could be
 * made to fail on the reverted fix. Recorded here rather than silently
 * dropped, per the testing standard's "a probe that finds nothing has not
 * proven absence" rule (`.claude/rules/testing.md` #3) — this is NOT a
 * verified mutation-red pin for the race; it IS new, real coverage of a
 * previously completely untested path (A5's actual complaint), which the
 * deferred-mint checkpoint below still exercises meaningfully: the door
 * screen must still be showing, mid-mint, at the paused checkpoint, and the
 * mint must actually reach the store once released.
 */
import { act, screen, waitFor } from "expo-router/testing-library";
import { router } from "expo-router";

import { useSessionStore } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { renderApp } from "@/test-utils/render-app";
import { mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

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
jest.mock("expo-application", () => ({
  __esModule: true,
  applicationId: "app.gogotravel.e2edoor",
}));

const SECRET = "s".repeat(32);
const originalSecretEnv = process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
const originalApiUrlEnv = process.env.EXPO_PUBLIC_API_URL;

const NEW_FIXTURE_USER = {
  id: "00000000-0000-4000-8000-00000000ee01",
  email: "e2e+warm-1@gogotravel.invalid",
  display_name: "E2E warm-1",
  avatar_key: null,
  prefs: {},
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
  forward_email_slug: null,
  created_at: "2026-09-13T00:00:00.000Z",
};

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
  if (originalSecretEnv === undefined) delete process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
  else process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = originalSecretEnv;
  if (originalApiUrlEnv === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = originalApiUrlEnv;
});

it("a WARM navigation into the door while already authenticated survives AuthGate's resume race: the door screen is still mid-mint (not already navigated away) when the mint is paused, and the store ends on the NEW fixture user once it's released", async () => {
  process.env.EXPO_PUBLIC_E2E_DOOR_SECRET = SECRET;
  process.env.EXPO_PUBLIC_API_URL = "http://localhost:3000";

  // T-7.9 pattern: hold the mint request genuinely in flight, release in
  // `finally` so a thrown assertion can never wedge the file.
  let releaseMint: (value: unknown) => void = () => undefined;
  const mintPromise = new Promise((resolve) => {
    releaseMint = resolve;
  });
  const mintRequest = jest.fn(() => mintPromise);
  mockNavApi({ overrides: { "POST /auth/e2e/session": mintRequest } });

  // Mount on an ordinary authenticated route FIRST and let it fully settle
  // (routeReadSettled flips true) — this is what makes the LATER navigation
  // below a WARM one, past the B-14 latch's one-cycle grace.
  await renderApp("/");
  await screen.findByTestId("trip-list-screen");

  // Warm imperative navigation into the door route — same pattern
  // `navigation-skeleton.test.tsx` uses for a warm in-app navigation.
  await act(async () => {
    router.navigate(
      "/e2e-session?user_key=warm-1&first_run=false" as Parameters<typeof router.navigate>[0],
    );
  });

  try {
    // The mint is deliberately still pending here — nothing past this point
    // depends on it, so this checkpoint is stable. The door screen must
    // still be showing (mid-mint), NOT already replaced by a premature
    // `resume`.
    expect(mintRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("e2e-session-pending")).toBeOnTheScreen();
    expect(screen.queryByTestId("sign-in-screen")).toBeNull();
    expect(screen.queryByTestId("trip-list-screen")).toBeNull();
  } finally {
    releaseMint({
      user: NEW_FIXTURE_USER,
      tokens: {
        access_token: "warm-door-access",
        refresh_token: "warm-door-refresh",
        expires_in: 900,
      },
      is_new_user: false,
    });
  }

  await waitFor(() => expect(useSessionStore.getState().user?.id).toBe(NEW_FIXTURE_USER.id));
  expect(useSessionStore.getState().accessToken).toBe("warm-door-access");
});
