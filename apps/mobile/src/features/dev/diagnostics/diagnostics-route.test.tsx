/**
 * `(auth)/diagnostics` route gate (T-S3.5) — the `__DEV__` gate pinned on
 * BOTH arms with a live-flip control, plus the deeplink registry pins.
 *
 * The gate reads `__DEV__` at RENDER time, so both arms are exercised by
 * flipping the runtime global (the sanctioned api-client.test.ts pattern) —
 * no module re-require, no second React instance.
 *
 * The route module's import-time side effect (console-tap install) is pinned
 * via the module-scope capture below — taken after the hoisted imports run,
 * before any test's reset can touch it. The install's own release arm
 * (never patch console when `__DEV__` is false) is pinned in
 * console-tap.test.ts, its canonical home.
 */
import { act, screen } from "@testing-library/react-native";

import DiagnosticsRoute from "@/app/(auth)/diagnostics";
import { parseDeepLink } from "@/navigation/deep-links";
import { renderWithTheme } from "@/test-utils/render";

import { readConsoleTap, resetConsoleTapForTests } from "./console-tap";

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

// Captured at module scope: the hoisted route import above has already run,
// so this is "did importing the route install the tap?" — before any reset.
const tapInstalledByRouteImport = readConsoleTap().installed;

const devGlobal = globalThis as unknown as { __DEV__: boolean };
const originalDev = devGlobal.__DEV__;
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
  devGlobal.__DEV__ = originalDev;
});

afterAll(() => {
  resetConsoleTapForTests();
});

/** Drain pending leg settles inside act (fixtures are microtask-only). */
async function drainLegs(): Promise<void> {
  await act(async () => {});
}

describe("(auth)/diagnostics __DEV__ gate", () => {
  it("dev arm: mounts the full panel", async () => {
    await renderWithTheme(<DiagnosticsRoute />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-screen")).toBeOnTheScreen();
    expect(screen.getByTestId("diagnostics-evidence-base-url")).toBeOnTheScreen();
  });

  it("RELEASE ARM: renders NOTHING — with the live-flip control proving the pin could fail", async () => {
    // Falsification: remove the `if (!__DEV__) return null` gate → the null
    // assertion below goes red.
    devGlobal.__DEV__ = false;
    const result = await renderWithTheme(<DiagnosticsRoute />);
    expect(result.toJSON()).toBeNull();
    expect(screen.queryByTestId("diagnostics-screen")).toBeNull();
    // No leg ran: release mounts no probes at all.
    expect(fetchMock).not.toHaveBeenCalled();
    await result.unmount();

    // Control arm: the SAME render harness with __DEV__ back on mounts the
    // panel — the null above was the gate's decision, not a broken harness.
    // (A fresh render, not `rerender`: rerender swaps the tree ABOVE the
    // ThemeProvider wrapper renderWithTheme installed.)
    devGlobal.__DEV__ = true;
    await renderWithTheme(<DiagnosticsRoute />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-screen")).toBeOnTheScreen();
  });

  it("importing the route installs the console tap (B-6 capture starts at route-tree load)", () => {
    // Falsification: drop the module-scope installConsoleTap() call in
    // app/(auth)/diagnostics.tsx → red.
    expect(tapInstalledByRouteImport).toBe(true);
  });
});

describe("deeplink entry (gogo://diagnostics)", () => {
  it("passes through the registry untouched on every transport shape", () => {
    // The parked entry decision means the deeplink IS the only door — if the
    // registry ever claims/rewrites this path (a new family, a fallback
    // rule), the door closes silently. Falsification: add a `diagnostics`
    // family to deep-links.ts that rewrites → red.
    expect(parseDeepLink("gogo://diagnostics")).toEqual({ kind: "passthrough" });
    expect(parseDeepLink("/diagnostics")).toEqual({ kind: "passthrough" });
  });

  it("control: the registry is live — a family path still rewrites", () => {
    // Proves the passthroughs above came from the registry's decision, not a
    // dead parser.
    expect(parseDeepLink("gogo://invite/tok123")).toEqual({ kind: "target", path: "/join/tok123" });
  });
});
