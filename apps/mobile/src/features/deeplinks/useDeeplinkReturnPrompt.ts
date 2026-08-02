/**
 * Foreground half of the deeplink-out → return-prompt loop (T-7.8 / IT-8;
 * itinerary spec §2.8, nav spec §2.3 / R-nav-18): on `AppState → active` —
 * and once on mount, which covers the killed-in-partner-app cold-start
 * return — consume the pending record (present-once semantics live in the
 * store: the slot clears on read, stale >30 min records expire silently)
 * and hold it as "the prompt is up" state until the host dismisses.
 *
 * The AppState listener pattern is data/collab.ts's foreground leg.
 */
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";

import { consumePendingReturnPrompt, type DeeplinkOutRecord } from "./return-prompt-store";

export interface DeeplinkReturnPrompt {
  /** Non-null ⇒ the "Did you book it?" sheet is presented for this record. */
  record: DeeplinkOutRecord | null;
  dismiss(): void;
}

export function useDeeplinkReturnPrompt(): DeeplinkReturnPrompt {
  const [record, setRecord] = useState<DeeplinkOutRecord | null>(null);

  useEffect(() => {
    // Mount check (cold-start return), scheduled — never a synchronous
    // setState in the effect body (react-hooks/set-state-in-effect).
    // Consume is idempotent: a second effect run (StrictMode dev) reads an
    // already-cleared slot and no-ops; unmount-before-fire cancels WITHOUT
    // consuming, so the record survives for the next mount/foreground.
    const mountCheck = setTimeout(() => {
      const pending = consumePendingReturnPrompt();
      if (pending !== null) setRecord(pending);
    }, 0);

    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      const next = consumePendingReturnPrompt();
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
