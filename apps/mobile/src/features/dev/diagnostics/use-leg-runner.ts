/**
 * Leg runner (T-S3.5) — one leg's lifecycle: self-run on mount, individually
 * re-runnable, stale results discarded. A leg that REJECTS (legs resolve by
 * contract, but this panel must survive anything) renders as a fail with the
 * exact cause — the panel never crashes on a broken leg.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, type LegResult } from "./legs";

export type LegState = { status: "running" } | LegResult;

export function useLegRunner(run: () => Promise<LegResult>): {
  state: LegState;
  rerun: () => void;
} {
  const [state, setState] = useState<LegState>({ status: "running" });
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
              status: "fail",
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
