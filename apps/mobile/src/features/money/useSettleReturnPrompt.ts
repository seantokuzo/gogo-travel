/**
 * Foreground half of the settle return-prompt loop (T-9.7 — R-cmoney-21;
 * mechanics mirrored from useDeeplinkReturnPrompt, the R-nav-18 pattern):
 * on `AppState → active` — and once on mount, covering the
 * killed-in-payment-app cold-start return onto a settle surface — consume
 * the pending record (present-once semantics live in the store: the slot
 * clears on read, stale >30 min records expire silently) and hold it as
 * "the prompt is up" state until the surface dismisses it.
 */
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";

import { consumePendingSettleReturn, type SettleReturnRecord } from "./settle-return-store";

export interface SettleReturnPrompt {
  /** Non-null ⇒ the "Did you complete the payment?" sheet is presented. */
  record: SettleReturnRecord | null;
  dismiss(): void;
}

export function useSettleReturnPrompt(): SettleReturnPrompt {
  const [record, setRecord] = useState<SettleReturnRecord | null>(null);

  useEffect(() => {
    // Mount check (cold-start return), scheduled — never a synchronous
    // setState in the effect body. Consume is idempotent: a StrictMode
    // second run reads an already-cleared slot and no-ops; unmount-before-
    // fire cancels WITHOUT consuming, so the record survives for the next
    // mount/foreground.
    const mountCheck = setTimeout(() => {
      const pending = consumePendingSettleReturn();
      if (pending !== null) setRecord(pending);
    }, 0);

    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      const next = consumePendingSettleReturn();
      // Only ever set on a real record — a foreground with nothing pending
      // must not clobber a prompt the user is currently looking at.
      if (next !== null) setRecord(next);
    });
    return () => {
      clearTimeout(mountCheck);
      subscription.remove();
    };
  }, []);

  const dismiss = useCallback(() => setRecord(null), []);
  return { record, dismiss };
}
