/**
 * `useMigrationsLegRunner` (B-28 round-2, R-test-4) — the module doc claims
 * "aborts it on unmount (and on rerun)", but the round-2 verifier found
 * `execute` only ever OVERWROTE `abortRef.current` with a new controller —
 * it never called `.abort()` on whatever run `rerun()` was replacing, so the
 * claim was false: the previous request's socket stayed open until it
 * settled on its own (the runId guard only discarded its RESULT).
 *
 * Falsification (R-test-7) stated per test. Deferred promises released in
 * `finally` (mobile.md: an assertion throwing first must not strand the
 * mutation and hang the file).
 */
import { act, renderHook } from "@testing-library/react-native";

import type { MigrationsLegResult } from "./legs";
import { useMigrationsLegRunner } from "./use-migrations-leg-runner";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const CURRENT: MigrationsLegResult = { status: "current", summary: "4 applied", evidence: "ok" };

describe("useMigrationsLegRunner — rerun aborts the PRIOR in-flight run (B-28 round-2)", () => {
  it("rerun() aborts the mount run's signal before starting a second run with a FRESH, un-aborted signal", async () => {
    const signals: AbortSignal[] = [];
    // Hold the MOUNT run genuinely in flight — a deferred promise, not an
    // already-settled one (testing.md/mobile.md: "already-settled promises
    // proves nothing" for anything asserting mid-flight state).
    const first = deferred<MigrationsLegResult>();
    const run = jest.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : Promise.resolve(CURRENT);
    });

    const { result, unmount } = await renderHook(() => useMigrationsLegRunner(run));
    try {
      expect(signals).toHaveLength(1);
      const firstSignal = signals[0]!;
      expect(firstSignal.aborted).toBe(false);

      await act(async () => {
        result.current.rerun();
      });

      // Falsification: the pre-fix `execute` overwrote `abortRef.current`
      // without ever calling `.abort()` on the controller it replaced —
      // this is the exact assertion that catches that regression (reverting
      // to the old shape leaves `firstSignal.aborted` false here).
      expect(firstSignal.aborted).toBe(true);
      expect(signals).toHaveLength(2);
      const secondSignal = signals[1]!;
      expect(secondSignal).not.toBe(firstSignal);
      expect(secondSignal.aborted).toBe(false);
      expect(result.current.state).toEqual(CURRENT);
    } finally {
      first.resolve(CURRENT);
    }
    await unmount();
  });

  it("control: unmount still aborts whatever run is in flight (the pre-existing round-1 fix — must not regress)", async () => {
    const signals: AbortSignal[] = [];
    const hang = deferred<MigrationsLegResult>();
    const run = jest.fn((signal: AbortSignal) => {
      signals.push(signal);
      return hang.promise;
    });
    const { unmount } = await renderHook(() => useMigrationsLegRunner(run));
    try {
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
      await unmount();
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      hang.resolve(CURRENT);
    }
  });
});
