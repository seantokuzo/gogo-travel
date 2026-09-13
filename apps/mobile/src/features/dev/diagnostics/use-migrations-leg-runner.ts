/**
 * Migrations-leg runner (B-28) — the same self-run-on-mount / individually
 * re-runnable / stale-result-discarded lifecycle as `use-leg-runner.ts`, but
 * typed for `MigrationsLegResult`'s tri-state outcome instead of
 * `LegResult`'s pass/fail. Kept as a small, deliberate duplicate rather than
 * genericizing the shared runner: `useLegRunner` backs all six existing
 * legs (including the runId/stale-settle pin in
 * `DiagnosticsScreen.test.tsx`) and this change has no reason to touch it.
 *
 * Review round-1 (correctness lane, advisory): the runId guard discards a
 * STALE *result* on unmount, but nothing aborted the underlying *request* —
 * navigating away leaked the socket until the OS gave up. This runner now
 * owns an `AbortController` per run and aborts it on unmount (and on
 * rerun), threading the signal into `run` so `runMigrationsLeg` can wire it
 * to the same fetch call its own 8s timeout uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, type MigrationsLegResult } from "./legs";

export type MigrationsRowState = { status: "running" } | MigrationsLegResult;

export function useMigrationsLegRunner(
  run: (signal: AbortSignal) => Promise<MigrationsLegResult>,
): {
  state: MigrationsRowState;
  rerun: () => void;
} {
  const [state, setState] = useState<MigrationsRowState>({ status: "running" });
  // Monotonic run id: a rerun invalidates any in-flight result; unmount
  // (cleanup bumps the id) invalidates everything — no setState-after-unmount.
  const runIdRef = useRef(0);
  // The AbortController for whichever run is CURRENTLY in flight — aborted
  // on unmount so the request itself is cancelled, not just its result
  // ignored (review round-1 advisory: the socket-leak half of the finding).
  const abortRef = useRef<AbortController | null>(null);

  const execute = useCallback(
    (id: number) => {
      const controller = new AbortController();
      abortRef.current = controller;
      run(controller.signal)
        .then((result) => {
          if (runIdRef.current === id) setState(result);
        })
        .catch((err: unknown) => {
          if (runIdRef.current === id) {
            setState({
              status: "unknown",
              summary: "leg crashed — exact cause below",
              evidence: describeError(err),
            });
          }
        });
    },
    [run],
  );

  const rerun = useCallback(() => {
    setState({ status: "running" });
    execute(++runIdRef.current);
  }, [execute]);

  // Self-run on mount. No synchronous setState here (lint:
  // react-hooks/set-state-in-effect): the initial state is already
  // "running", so the effect only kicks the async execution.
  useEffect(() => {
    execute(++runIdRef.current);
    return () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, [execute]);

  return { state, rerun };
}
