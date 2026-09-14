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
// Module namespace import (not the named re-export) so `jest.spyOn` attaches
// to the SAME live binding `DiagnosticsScreen.tsx` calls at runtime (Babel's
// CJS interop resolves named imports through the module object at each call
// site, not a destructured local) — the round-2 per-leg discriminator below.
import * as legsModule from "./legs";

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

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Serves BOTH of a fresh mount's `/health` calls: leg 2 (health) fires
 * first, leg 7 (migrations) second — the JSX/effect order in
 * `DiagnosticsScreen` (`RunnerLegRow legKey="health"` is declared before
 * `MigrationsRow`, and React commits sibling effects in tree order; each
 * leg's fetch call is issued synchronously inside its own effect, before
 * either awaits anything, so the ORDER of calls into this mock is
 * deterministic across a single render pass). Review round-1 C4 gave leg 7
 * its own abort signal, so `init` is no longer a usable discriminator (BOTH
 * legs now pass one) — a call-order counter replaces it. Valid for exactly
 * one full mount (2 calls); use `migrationsOnly` for a later single-leg
 * rerun.
 */
function withMigrationsOnMount(migrations: unknown) {
  let calls = 0;
  return async (): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
    calls += 1;
    return calls === 1
      ? { ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1" }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1", migrations }) };
  };
}

/** Serves a single migrations-shaped response — for swapping in AFTER mount, when only the migrations leg's OWN "rerun" button will trigger the next fetch call (the health leg isn't touched, so it never asks). */
function migrationsOnly(
  migrations: unknown,
): () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, version: "0.0.1", migrations }),
  });
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

  it("legs are individually re-runnable: rerunning health calls ONLY runHealthLeg again — the per-leg discriminator (round-2 restore)", async () => {
    // Round-1 C4 gave leg 7 (migrations) the same abort-`init` watchdog as
    // leg 2 (health), so both hit `/health` with an indistinguishable
    // fetch call shape — a bare fetch-call TOTAL (the round-1 fix's
    // replacement discriminator) can't tell "health re-fired" apart from
    // "migrations re-fired instead of health": a bug that wired "rerun
    // health" to the WRONG leg could still land on the same total and pass.
    // Spy on the actual leg functions instead — real per-leg discrimination.
    const healthSpy = jest.spyOn(legsModule, "runHealthLeg");
    const migrationsSpy = jest.spyOn(legsModule, "runMigrationsLeg");
    try {
      await renderWithTheme(<DiagnosticsScreen />);
      await drainLegs();
      // Two legs hit `/health` on mount: leg 2 (health) and leg 7
      // (migrations, B-28).
      expect(healthSpy).toHaveBeenCalledTimes(1);
      expect(migrationsSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.length).toBe(2);

      const secureStore = jest.requireMock("expo-secure-store") as {
        setItemAsync: jest.Mock;
      };
      const keychainWrites = secureStore.setItemAsync.mock.calls.length;

      await act(async () => {
        await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-health"));
      });

      // Falsification: wiring "rerun health" to (also, or INSTEAD) refire
      // the migrations leg reds `migrationsSpy`/`healthSpy` respectively —
      // a bare total (the round-1 shape) cannot distinguish either case
      // from the correct one, since both produce exactly 3 fetch calls.
      expect(healthSpy).toHaveBeenCalledTimes(2);
      expect(migrationsSpy).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls.length).toBe(3);
      expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
      // Individual rerun: the secure-store leg did NOT run again (falsification:
      // wire rerun to re-mount every leg → red).
      expect(secureStore.setItemAsync.mock.calls.length).toBe(keychainWrites);
    } finally {
      healthSpy.mockRestore();
      migrationsSpy.mockRestore();
    }
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
  // Leg 7 — migration state (B-28): the four rendered states (MODIFIED
  // added round-2).
  // ---------------------------------------------------------------------

  it("migrations leg: CURRENT (pending empty) renders green with the applied count", async () => {
    fetchMock.mockImplementation(
      withMigrationsOnMount({
        onDisk: 4,
        applied: 4,
        pending: [],
        pendingCount: 0,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/applied: 4/);
    expect(evidence).toHaveTextContent(/pending: \(none\)/);
  });

  it("migrations leg: PENDING renders red, naming EVERY pending tag (not just a count)", async () => {
    fetchMock.mockImplementation(
      withMigrationsOnMount({
        onDisk: 4,
        applied: 2,
        pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
        pendingCount: 2,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("PENDING");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/0002_lowly_venom/);
    expect(evidence).toHaveTextContent(/0003_outstanding_doctor_spectrum/);
  });

  it("migrations leg: pending redacted outside development/test renders red with a count, names withheld", async () => {
    // Architecture review round-1 #3, mobile leg: names present → show them;
    // count-only → show the count instead of a blank/misleading list.
    fetchMock.mockImplementation(
      withMigrationsOnMount({
        onDisk: 4,
        applied: 2,
        pending: [],
        pendingCount: 2,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("PENDING");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/pendingCount: 2/);
    expect(evidence).toHaveTextContent(/redacted/);
  });

  it("migrations leg (round-2, B-28): MODIFIED renders with its OWN badge, distinct from PENDING and CURRENT", async () => {
    fetchMock.mockImplementation(
      withMigrationsOnMount({
        onDisk: 4,
        applied: 4,
        pending: [],
        pendingCount: 0,
        modified: ["0001_edited_after_apply"],
        modifiedCount: 1,
        checkedAt: CHECKED_AT,
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    const badge = screen.getByTestId("diagnostics-status-migrations");
    expect(badge).toHaveTextContent("MODIFIED");
    // Falsification: rendering `modifiedCount > 0` with the same badge as
    // PENDING (re-conflating the exact states the server-side fix split
    // apart) makes this red — MODIFIED must never read as PENDING or CURRENT.
    expect(badge).not.toHaveTextContent("PENDING");
    expect(badge).not.toHaveTextContent("CURRENT");
    const evidence = screen.getByTestId("diagnostics-evidence-migrations");
    expect(evidence).toHaveTextContent(/0001_edited_after_apply/);
  });

  it("migrations leg: field absent (older server) renders a DISTINCT unknown state, with evidence that distinguishes it from a leg crash (review round-1 C2/F2)", async () => {
    // Falsification: treating an absent `migrations` field as "current"
    // would make the FIRST assertion below fail instead — the whole point
    // of the optional field is that absence is not evidence of currency.
    // Falsification (C2/F2, the vacuous-pin fix): a refactor that deletes
    // the absent-field branch but still lands on UNKNOWN via the generic
    // leg-crashed catch path (e.g. narrowing the guard to
    // `!parsed.success`, so an absent field throws instead) ALSO renders
    // the UNKNOWN badge — so asserting on the badge alone can't tell "server
    // doesn't report migration state" from "leg crashed." The evidence
    // assertion below is the one that actually discriminates: it fails
    // under that exact mutation (the crash path's evidence reads "leg
    // crashed — exact cause below" instead).
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    const badge = screen.getByTestId("diagnostics-status-migrations");
    expect(badge).toHaveTextContent("UNKNOWN");
    expect(badge).not.toHaveTextContent("CURRENT");
    expect(badge).not.toHaveTextContent("PENDING");
    expect(screen.getByTestId("diagnostics-evidence-migrations")).toHaveTextContent(
      /no `migrations` field/,
    );
  });

  it("migrations leg is individually re-runnable, independent of the health leg", async () => {
    fetchMock.mockImplementation(
      withMigrationsOnMount({
        onDisk: 4,
        applied: 4,
        pending: [],
        pendingCount: 0,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");

    fetchMock.mockImplementation(
      migrationsOnly({
        onDisk: 4,
        applied: 3,
        pending: ["0003_outstanding_doctor_spectrum"],
        pendingCount: 1,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      }),
    );
    await act(async () => {
      await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-migrations"));
    });
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("PENDING");
    // The health leg's own status is untouched by the migrations rerun.
    expect(screen.getByTestId("diagnostics-status-health")).toHaveTextContent("PASS");
  });

  it("migrations leg aborts its in-flight request on unmount — closes the socket-leak half of review round-1's advisory (F3/C4)", async () => {
    // Call 1 (health, on mount) resolves normally; call 2 (migrations, on
    // mount) hangs until aborted — capture ITS signal and prove unmount
    // aborts it. Falsification: dropping `abortRef.current?.abort()` from
    // `useMigrationsLegRunner`'s unmount cleanup leaves `capturedSignal`
    // unaborted after `view.unmount()`.
    let call = 0;
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          call += 1;
          if (call === 1) {
            resolve({ ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1" }) });
            return;
          }
          // Migrations leg's mount-time call: hangs until aborted — a REAL
          // fetch rejects on abort (mobile.md mock-fidelity discipline), so
          // reject here too rather than leaving a promise permanently
          // pending (which would leak the leg's internal 8s watchdog timer
          // as an open jest handle).
          capturedSignal = init?.signal;
          capturedSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
        }),
    );
    const view = await renderWithTheme(<DiagnosticsScreen />);
    await drainLegs();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    await view.unmount();
    expect(capturedSignal?.aborted).toBe(true);
    await drainLegs();
  });

  it("the stale-settle guard (runId) is pinned for the migrations leg too, not just health (review round-1 F3)", async () => {
    // Mirrors the "rerunning a HUNG leg works and the stale settle is
    // discarded" pin above, but for leg 7: mount's migrations call hangs
    // until released; the rerun resolves a DIFFERENT (current) result.
    // Falsification: dropping `runIdRef.current === id` from
    // `useMigrationsLegRunner`'s `.then` lets the late mount-time settle
    // overwrite the rerun's result — both pins below would then read PENDING
    // instead of CURRENT.
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    fetchMock.mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) {
        // Health leg's mount-time call.
        return { ok: true, status: 200, json: async () => ({ ok: true, version: "0.0.1" }) };
      }
      if (call === 2) {
        // Migrations leg's mount-time call — wedged until released, THEN
        // resolves a stale PENDING body.
        await gate;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            version: "0.0.1",
            migrations: {
              onDisk: 4,
              applied: 3,
              pending: ["0003_outstanding_doctor_spectrum"],
              pendingCount: 1,
              modified: [],
              modifiedCount: 0,
              checkedAt: CHECKED_AT,
            },
          }),
        };
      }
      // The rerun's own call — resolves promptly with a CURRENT body.
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          version: "0.0.1",
          migrations: {
            onDisk: 4,
            applied: 4,
            pending: [],
            pendingCount: 0,
            modified: [],
            modifiedCount: 0,
            checkedAt: CHECKED_AT,
          },
        }),
      };
    });

    try {
      await renderWithTheme(<DiagnosticsScreen />);
      await drainLegs();
      expect(screen.queryByTestId("diagnostics-evidence-migrations")).toBeNull();
      await act(async () => {
        await fireEvent.press(screen.getByTestId("diagnostics-button-rerun-migrations"));
      });
      expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");
    } finally {
      releaseFirst?.();
      await drainLegs();
    }
    expect(screen.getByTestId("diagnostics-status-migrations")).toHaveTextContent("CURRENT");
  });
});
