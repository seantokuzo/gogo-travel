/**
 * `/diagnostics` URL → screen resolution (T-S3.5) — the in-app half of the
 * `gogo://diagnostics` deeplink, through the REAL route tree (real layouts,
 * real AuthGate, real session store) with an UNAUTHED session: the panel's
 * charter is to work exactly when sign-in is broken.
 *
 * renderRouter suite ⇒ sanctioned reset recipe (mobile.md): prod singleton
 * queryClient cleared, tab memory + last-viewed-trip reset, restoreAllMocks.
 * Single URL render, no presses (render-app quirk 3).
 *
 * Falsification: rename/move the route file, gate the route behind auth, or
 * claim `/diagnostics` in the deep-link registry → red.
 */
import { act, screen } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { renderApp } from "@/test-utils/render-app";
import { seedUnauthenticated } from "@/test-utils/session-fixtures";

import { resetConsoleTapForTests } from "@/features/dev/diagnostics/console-tap";

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

describe("deeplink resolution: /diagnostics through the real route tree", () => {
  it("mounts the panel UNAUTHED — reachable exactly when sign-in is broken", async () => {
    // Seed BEFORE the render so the gate's first pass is already an
    // unauthed hydrated store (`seedSessionForUrl` would seed an AUTHED user
    // for a non-sign-in URL, whose "resume" arm bounces (auth) routes —
    // unauthed is this panel's design condition).
    seedUnauthenticated();
    const app = await renderApp("/diagnostics", { seedSession: false });

    expect(await screen.findByTestId("diagnostics-screen")).toBeOnTheScreen();
    expect(app.getPathname()).toBe("/diagnostics");

    // The panel is live, not a shell: leg 1 settles with tier provenance.
    // (RNTL string matchers are exact — partial evidence pins use RegExp.)
    expect(await screen.findByTestId("diagnostics-evidence-base-url")).toHaveTextContent(
      /tier: 4 \(localhost-fallback\)/,
    );
    // And the health probe went through the (fixtured) transport seam — the
    // real wiring dials <resolved base>/health from this runtime.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/health",
      expect.objectContaining({ signal: expect.anything() }),
    );

    // Drain the remaining leg settles inside act so nothing lands after the
    // test (the act-warnings=0 gate).
    await act(async () => {});
  });
});
