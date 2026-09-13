/**
 * DiagnosticsScreen (T-S3.5) — the panel through its REAL default wiring:
 * no deps prop, real `@/auth` modules (google unconfigured under jest — the
 * T-5.7 render-gate arm exercised with the real gate, per the mobile.md
 * "don't mock the whole feature module" landmine). The two runtime seams are
 * neutralized file-locally (no new global mocks — mock-fidelity convention):
 * - network: globalThis.fetch swapped for a fixture (the default wiring
 *   reads the live global at call time, so the swap is honored — no real
 *   network in jest);
 * - keychain: expo-secure-store mocked as an in-memory map (same surface the
 *   real module exposes; shape precedent: secure-storage.test.ts).
 *
 * Leg settles are drained inside `act` (self-running legs resolve fixture
 * promises after mount/press — the drain keeps act-warnings at the gate's
 * required zero). RNTL string matchers are EXACT; partial evidence pins use
 * RegExp.
 *
 * Falsification: unwire any leg from the panel → its row/evidence pins red;
 * break self-run-on-mount → the post-drain getBys red; break rerun → the
 * fetch-count pin reds; break stale-discard (runId) → the mid-flight pin
 * reds with the 599 overwrite.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";

import { renderWithTheme } from "@/test-utils/render";

import { resetConsoleTapForTests } from "./console-tap";
import { DiagnosticsScreen } from "./DiagnosticsScreen";

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

const fetchMock = jest.fn();
const originalFetch = globalThis.fetch;

function healthOk(): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, version: "0.0.1" }),
  });
}

/** Drain every pending leg settle inside act (fixtures are microtask-only). */
async function drainLegs(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  resetConsoleTapForTests();
  fetchMock.mockReset().mockImplementation(healthOk);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConsoleTapForTests();
});

/**
 * Distinguishes the health leg's fetch call from the migrations leg's: both
 * hit the exact same `/health` URL, but `runHealthLeg` always passes an
 * `init` (abort signal) and `runMigrationsLeg` never does (B-28's leg 7
 * needs no cancellation) — so `init` presence is a reliable per-call
 * discriminator without coupling to call ORDER.
 */
function withMigrations(migrations: unknown) {
  return async (
    _url: string,
    init?: unknown,
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> =>
    init
      ? { ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1" }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1", migrations }) };
}

describe("DiagnosticsScreen (real default wiring)", () => {
  it("renders unauthed with real auth modules and settles ALL seven legs — no throw, no generic states", async () => {
    // No session seeding of any kind: the panel must not depend on auth state.
    await renderWithTheme(<DiagnosticsScreen />);
    expect(screen.getByTestId("diagnostics-screen")).toBeOnTheScreen();
    await drainLegs();

    // Leg 1 — base URL + tier. jest preset: no hostUri, scriptURL null →
    // tier 4, and the runtime is not a device → PASS with provenance.
    expect(screen.getByTestId("diagnostics-evidence-base-url")).toHaveTextContent(
      /tier: 4 \(localhost-fallback\)/,
    );
    expect(screen.getByTestId("diagnostics-status-base-url")).toHaveTextContent("PASS");

    // Leg 2 — health round-trip through the transport seam (fixture 200).
    expect(screen.getByTestId("diagnostics-evidence-health")).toHaveTextContent(/status: 200/);
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/health",
      expect.objectContaining({ signal: expect.anything() }),
    );

    // Leg 3 — env roster (names only).
    expect(screen.getByTestId("diagnostics-evidence-env")).toHaveTextContent(/EXPO_PUBLIC_API_URL/);

    // Leg 4 — google: REAL isGoogleConfigured() is false under jest (no
    // client id env), so the real render gate takes the unconfigured arm —
    // definite FAIL row, hook never called, nothing throws (T-5.7 landmine).
    expect(screen.getByTestId("diagnostics-evidence-google-request")).toHaveTextContent(
      /isGoogleConfigured\(\): false/,
    );
    expect(screen.getByTestId("diagnostics-status-google-request")).toHaveTextContent("FAIL");

    // Leg 5 — secure-store round-trip against the in-memory keychain.
    expect(screen.getByTestId("diagnostics-evidence-secure-store")).toHaveTextContent(
      /verify-gone: ok/,
    );
    expect(screen.getByTestId("diagnostics-status-secure-store")).toHaveTextContent("PASS");

    // Leg 6 — console tap installed by the panel's own mount effect.
    expect(screen.getByTestId("diagnostics-evidence-last-error")).toHaveTextContent(/captured: 0/);
    expect(screen.getByTestId("diagnostics-status-last-error")).toHaveTextContent("PASS");

    // Leg 7 — migration state (B-28): the default fixture's `/health` body
    // has no `migrations` key (an older-server shape), so this settles to
    // the distinct UNKNOWN state, never PASS/FAIL/CURRENT.
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("UNKNOWN");
    expect(screen.getByTestId("diagnostics-evidence-migrations")).toHaveTextContent(
      /no `migrations` field/,
    );
  });

  it("health leg FAILS with the exact transport cause — never a generic banner (B-6)", async () => {
    const cause = new TypeError("Network request failed");
    (cause as { cause?: unknown }).cause = new Error("ECONNREFUSED 127.0.0.1:3000");
    fetchMock.mockImplementation(() => Promise.reject(cause));

    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    const evidence = screen.getByTestId("diagnostics-evidence-health");
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("FAIL");
    expect(evidence).toHaveTextContent(/TypeError: Network request failed/);
    expect(evidence).toHaveTextContent(/ECONNREFUSED 127\.0\.0\.1:3000/);
    // The dialed URL is part of the failure evidence (the missing B-5 clue).
    expect(evidence).toHaveTextContent(/GET http:\/\/localhost:3000\/api\/health/);
  });

  it("legs are individually re-runnable: rerunning health fetches again WITHOUT rerunning others", async () => {
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    // Two legs hit `/health` on mount: leg 2 (health) and leg 7 (migrations,
    // B-28) — distinguish by `init` presence (see `withMigrations` above),
    // never by a bare total that a future leg addition would silently
    // reinterpret.
    const healthCallsAfterMount = fetchMock.mock.calls.filter(
      (call) => call[1] !== undefined,
    ).length;
    expect(healthCallsAfterMount).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(2);

    const secureStore = jest.requireMock("expo-secure-store") as {
      setItemAsync: jest.Mock;
    };
    const keychainWrites = secureStore.setItemAsync.mock.calls.length;

    await act(async () => {
      await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-health"));
    });
    const healthCallsAfterRerun = fetchMock.mock.calls.filter(
      (call) => call[1] !== undefined,
    ).length;
    expect(healthCallsAfterRerun).toBe(2);
    // The migrations leg (leg 7) did NOT rerun — only ITS one mount-time
    // call has no `init`.
    expect(fetchMock.mock.calls.filter((call) => call[1] === undefined).length).toBe(1);
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
    // Individual rerun: the secure-store leg did NOT run again (falsification:
    // wire rerun to re-mount every leg → red).
    expect(secureStore.setItemAsync.mock.calls.length).toBe(keychainWrites);
  });

  it("rerunning a HUNG leg works and the stale settle is discarded (runId pin)", async () => {
    // Mount's health call hangs until released; the rerun resolves 200.
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fetchMock
      .mockImplementationOnce(async () => {
        await gate;
        return { ok: false, status: 599, json: async () => ({ stale: true }) };
      })
      .mockImplementation(healthOk);

    try {
      await renderWithTheme(<DiagnosticsScreen />);
      await drainLegs();
      // Run 1 is wedged: no settled evidence yet — and the rerun button must
      // still fire (a disabled-while-running button couldn't rescue a hang).
      expect(screen.queryByTestId("diagnostics-evidence-health")).toBeNull();
      await act(async () => {
        await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-health"));
      });
      expect(screen.getByTestId("diagnostics-evidence-health")).toHaveTextContent(/status: 200/);
    } finally {
      // Release in finally (mobile.md: a wedged deferred hangs the file
      // instead of failing it) and drain run 1's late settle inside act.
      releaseFirst?.();
      await drainLegs();
    }
    // Falsification: drop the runId check in useLegRunner → the late 599
    // overwrites and both pins below red.
    expect(screen.getByTestId("diagnostics-evidence-health")).toHaveTextContent(/status: 200/);
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
  });

  // ---------------------------------------------------------------------
  // Leg 7 — migration state (B-28): the three rendered states.
  // ---------------------------------------------------------------------

  it("migrations leg: CURRENT (pending empty) renders green with the applied count", async () => {
    fetchMock.mockImplementation(withMigrations({ onDisk: 4, applied: 4, pending: [] }));
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/applied: 4/);
    expect(evidence).toHaveTextContent(/pending: \(none\)/);
  });

  it("migrations leg: PENDING renders red, naming EVERY pending tag (not just a count)", async () => {
    fetchMock.mockImplementation(
      withMigrations({
        onDisk: 4,
        applied: 2,
        pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("PENDING");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/0002_lowly_venom/);
    expect(evidence).toHaveTextContent(/0003_outstanding_doctor_spectrum/);
  });

  it("migrations leg: field absent (older server) renders a DISTINCT unknown state — never conflated with CURRENT", async () => {
    // Falsification: treating an absent `migrations` field as "current"
    // would make the FIRST assertion below fail instead — the whole point
    // of the optional field is that absence is not evidence of currency.
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    const badge = screen.getByTestId("diagnostics-status-migrations");
    expect(badge).toHaveTextContent("UNKNOWN");
    expect(badge).not.toHaveTextContent("CURRENT");
    expect(badge).not.toHaveTextContent("PENDING");
  });

  it("migrations leg is individually re-runnable, independent of the health leg", async () => {
    fetchMock.mockImplementation(withMigrations({ onDisk: 4, applied: 4, pending: [] }));
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");

    fetchMock.mockImplementation(
      withMigrations({ onDisk: 4, applied: 3, pending: ["0003_outstanding_doctor_spectrum"] }),
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-migrations"));
    });
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("PENDING");
    // The health leg's own status is untouched by the migrations rerun.
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
  });
});
