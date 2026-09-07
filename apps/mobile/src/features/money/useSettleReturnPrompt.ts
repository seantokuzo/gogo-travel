/**
 * Foreground half of the settle return-prompt loop (T-9.7 — R-cmoney-21;
 * mechanics mirrored from useDeeplinkReturnPrompt, the R-nav-18 pattern):
 * on `AppState → active` — and once on mount, covering the
 * killed-in-payment-app cold-start return onto a settle surface — consume
 * the pending record (present-once semantics live in the store: the slot
 * clears on read, stale >30 min records expire silently) and hold it as
 * "the prompt is up" state until the surface dismisses it.
 *
 * TRIP-SCOPED (R1 correctness): the caller passes the MOUNTED trip's id and
 * a consumed record whose `tripId` differs is dropped SILENTLY — the same
 * posture as silent expiry. Without the check, a rail tap on trip A's screen
 * followed by a cold-start into trip B's settle surface would post the
 * stashed counterparty/amount against trip B's ledger in trip B's currency
 * (both confirm handlers post via `useCreateSettlement(trip.id)`). The
 * record is already consumed at that point (consume-once), so a drop never
 * re-stashes.
 */
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";

import { consumePendingSettleReturn, type SettleReturnRecord } from "./settle-return-store";

export interface SettleReturnPrompt {
  /** Non-null ⇒ the "Did you complete the payment?" sheet is presented. */
  record: SettleReturnRecord | null;
  dismiss(): void;
}

export function useSettleReturnPrompt(tripId: string): SettleReturnPrompt {
  const [record, setRecord] = useState<SettleReturnRecord | null>(null);

  useEffect(() => {
    // Consume + trip guard (module doc): a record stashed for ANOTHER trip
    // is dropped, not presented — and never re-stashed (consume-once).
    const consumeForTrip = (): SettleReturnRecord | null => {
      const pending = consumePendingSettleReturn();
      return pending !== null && pending.tripId === tripId ? pending : null;
    };

    // Mount check (cold-start return), scheduled — never a synchronous
    // setState in the effect body. Consume is idempotent: a StrictMode
    // second run reads an already-cleared slot and no-ops; unmount-before-
    // fire cancels WITHOUT consuming, so the record survives for the next
    // mount/foreground.
    const mountCheck = setTimeout(() => {
      const pending = consumeForTrip();
      if (pending !== null) setRecord(pending);
    }, 0);

    const subscription = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      const next = consumeForTrip();
      // Only ever set on a real record — a foreground with nothing pending
      // must not clobber a prompt the user is currently looking at.
      if (next !== null) setRecord(next);
    });
    return () => {
      clearTimeout(mountCheck);
      subscription.remove();
    };
  }, [tripId]);

  const dismiss = useCallback(() => setRecord(null), []);
  return { record, dismiss };
}
