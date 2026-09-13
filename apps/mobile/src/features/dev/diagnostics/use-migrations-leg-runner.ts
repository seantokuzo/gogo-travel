/**
 * Migrations-leg runner (B-28) — the same self-run-on-mount / individually
 * re-runnable / stale-result-discarded lifecycle as `use-leg-runner.ts`, but
 * typed for `MigrationsLegResult`'s tri-state outcome instead of
 * `LegResult`'s pass/fail. Kept as a small, deliberate duplicate rather than
 * genericizing the shared runner: `useLegRunner` backs all six existing
 * legs (including the runId/stale-settle pin in
 * `DiagnosticsScreen.test.tsx`) and this change has no reason to touch it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, type MigrationsLegResult } from "./legs";

export type MigrationsRowState = { status: "running" } | MigrationsLegResult;

export function useMigrationsLegRunner(run: () => Promise<MigrationsLegResult>): {
  state: MigrationsRowState;
  rerun: () => void;
} {
  const [state, setState] = useState<MigrationsRowState>({ status: "running" });
  // Monotonic run id: a rerun invalidates any in-flight result; unmount
  // (cleanup bumps the id) invalidates everything — no setState-after-unmount.
  const runIdRef = useRef(0);

  const execute = useCallback(
    (id: number) => {
      run()
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
    };
  }, [execute]);

  return { state, rerun };
}
