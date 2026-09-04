/**
 * B-14: cold-boot deep link to `/diagnostics` while SIGNED OUT must survive
 * async session hydration. Sim-reproduced: `gogo://diagnostics` cold-start
 * lands on sign-in — the panel mounts transiently (its /health probe hits the
 * server; dev-request-log evidence), then the gate's redirect effect stomps it
 * because it evaluates `resolveGate` off a `useSegments()` read not yet
 * coherent with the navigator's committed deep-linked landing.
 *
 * Why the T-S3.5 pin (diagnostics-route-resolution.test.tsx) was blind — BOTH
 * halves of the race were closed there:
 *  1. `seedUnauthenticated()` sets `hydrated: true` synchronously pre-render —
 *     no splash-hold window. Here `seedColdBootUnauthenticated` keeps
 *     hydration pending on a controllable promise, like the real `hydrate()`
 *     (which awaits `storage.getRefreshToken()` even when signed out).
 *  2. `renderRouter`'s `initialUrl` flows in as a synchronous `serverUrl`, so
 *     expo-router PREFETCHES the initial navigation state + route info —
 *     `useSegments()` is coherent from the very first render. On device the
 *     initial URL arrives from the native module, and expo-router's linking
 *     layer explicitly models it as possibly-async (`getLinkingConfig`'s
 *     non-string `getInitialURL` branch): no prefetch, route info sits at the
 *     default `/` until a commit syncs it. This harness renders `ExpoRoot`
 *     directly (no `location`) with `getLinkingURL` returning a controllable
 *     promise, driving that real async branch — the URL resolves, the
 *     container commits `/diagnostics` as its initial route, and the gate's
 *     subscribed route read is still the stale default when hydration lands.
 *
 * renderRouter-equivalent hygiene (mobile.md): fake timers installed exactly
 * like `renderRouter` does (navigation timeouts must not leak as open
 * handles), prod singleton queryClient cleared, tab memory + last-viewed-trip
 * reset, restoreAllMocks. Single URL render, no presses (render-app quirk 3).
 */
// `render` comes from RNTL directly: expo-router/testing-library re-exports
// it at runtime but its .d.ts only value-exports a fixed hook/util list.
import { render } from "@testing-library/react-native";
import { ExpoRoot } from "expo-router";
import { act, cleanup, getMockContext, screen } from "expo-router/testing-library";

import { useSessionStore } from "@/auth";
import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { seedColdBootUnauthenticated } from "@/test-utils/session-fixtures";

import { resetConsoleTapForTests } from "@/features/dev/diagnostics/console-tap";

/**
 * Deferred cold-start URL. `getLinkingURL`'s sync contract is string|null;
 * expo-router's own linking layer additionally handles a promise-valued
 * initial URL (`getLinkingConfig` promise branch — the RN
 * `Linking.getInitialURL` contract it shares code with). Returning a pending
 * promise routes iOS through that real async branch, reproducing the device
 * window where JS boots before the launch URL is handed over.
 *
 * Recreated per test in `beforeEach` (PR #46 R1): the mock reads the CURRENT
 * deferred through the `let` at call time, so a settled promise from an
 * earlier test can never leak into a later cold-boot arm.
 */
let mockResolveInitialUrl!: (url: string) => void;
let mockInitialUrl: Promise<string>;

jest.mock("expo-linking", () => ({
  __esModule: true,
  getLinkingURL: jest.fn(() => mockInitialUrl),
  createURL: jest.fn((path: string) => `gogo://${String(path).replace(/^\//, "")}`),
  addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  openURL: jest.fn(async () => true),
}));

jest.mock("expo-secure-store", () => {
  const map = new Map<string, string>();
  return {
    __esModule: true,
    getItemAsync: jest.fn(async (key: string) => map.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      map.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      map.delete(key);
    }),
  };
});

const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, version: "0.0.1" }),
}));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Fresh deferred per test — see the fixture note above.
  mockInitialUrl = new Promise<string>((resolve) => {
    mockResolveInitialUrl = resolve;
  });
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
  resetConsoleTapForTests();
});

/**
 * renderRouter-equivalent setup, minus its synchronous `location` seeding.
 * Mirrors render-app quirk 2 for the second mount in this file: unmount any
 * previous tree and cycle the clock so a prior test's scheduled navigation
 * work dies with it.
 */
async function renderColdBootApp(): Promise<void> {
  await cleanup();
  jest.useRealTimers();
  process.env.EXPO_ROUTER_IMPORT_MODE = "sync";
  jest.useFakeTimers();
  await render(<ExpoRoot context={getMockContext("src/app")} />);
}

describe("cold-boot deeplink race: gogo://diagnostics with async hydration (B-14)", () => {
  it("keeps the panel after hydration resolves signed-out — no sign-in stomp", async () => {
    const { releaseHydration } = seedColdBootUnauthenticated();
    await renderColdBootApp();

    // The native module hands over the launch URL; the navigator commits
    // /diagnostics as its initial route. Session hydration is STILL pending,
    // so the gate splash-holds — its route read never synced past `/`.
    await act(async () => {
      mockResolveInitialUrl("gogo://diagnostics");
    });
    expect(screen.getByTestId("sign-in-splash")).toBeOnTheScreen();

    // Hydration resolves signed-out — the sim-reproduced race window.
    await act(async () => {
      await releaseHydration();
    });
    await act(async () => {});

    // The unauthed-reachable (auth) route must survive the gate's decision:
    // no redirect to sign-in, the panel stays mounted.
    expect(screen.queryByTestId("sign-in-screen")).toBeNull();
    expect(screen.getByTestId("diagnostics-screen")).toBeOnTheScreen();

    // The panel is live, not a shell — its health probe went through the
    // (fixtured) transport, same wiring the dev-request-log evidence caught.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/health",
      expect.objectContaining({ signal: expect.anything() }),
    );

    // Drain remaining probe settles inside act (act-warnings=0 gate).
    await act(async () => {});
  });

  // LAST test in the file: the gate's replace navigates (render-app quirk 3 —
  // navigating tests must not precede another mount). This is the multi-test
  // smoke for the per-test deferred (PR #46 R1): a different URL must land
  // ITS OWN route — a leaked settled promise from test 1 would deliver
  // /diagnostics here (which renders unauthed, no sign-in, no stash) and both
  // asserts would go red. It also pins that a non-(auth) cold-boot target is
  // stashed for post-auth resume under the B-14 latch (sim arm D semantics).
  // NOTE: unlike test 1, this arm is NOT red on unfixed main — without the
  // latch the gate double-fires (stale decision, then the coherent re-fire
  // re-stashes) and converges to the same end state; test 1 owns the B-14
  // falsification.
  it("stashes a non-(auth) cold-boot target from the settled read, then lands sign-in", async () => {
    const { releaseHydration } = seedColdBootUnauthenticated();
    await renderColdBootApp();

    // Different launch URL, same race window (gallery: static, fetch-free).
    await act(async () => {
      mockResolveInitialUrl("gogo://gallery");
    });
    expect(screen.getByTestId("sign-in-splash")).toBeOnTheScreen();

    await act(async () => {
      await releaseHydration();
    });
    await act(async () => {});

    // Not an unauthed-reachable (auth) route → R-nav-1: sign-in now, with the
    // COHERENT landing stashed for post-auth resume (a stale boot-default "/"
    // read would stash nothing — stashable("/") is null).
    expect(screen.getByTestId("sign-in-screen")).toBeOnTheScreen();
    expect(useSessionStore.getState().pendingDestination).toBe("/gallery");

    await act(async () => {});
  });
});
