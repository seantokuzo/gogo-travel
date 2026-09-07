/**
 * Rail deeplink-out → settle return-prompt record (T-9.7 / CMON-5 —
 * R-cmoney-21: "same mechanics as the R-nav-18 booking-return pattern").
 * At rail tap — BEFORE `Linking.openURL` — stash the pending settlement
 * shape; on the next foreground within 30 minutes the "Did you complete the
 * payment?" Sheet presents ONCE prefilled from the stash, then the record
 * clears (confirm posts it via S1; decline just dismisses — the slot is
 * already consumed).
 *
 * MMKV per the established persistence pattern (return-prompt-store.ts is
 * the direct precedent): default instance, namespaced key, sync reads,
 * validate-on-read with corrupt → absent, ONE slot by design (a second
 * rail tap before the first return overwrites — the freshest tap is the one
 * the user is coming back from).
 *
 * Direction is implicit: rails render ONLY where the caller is the debtor
 * (settle debtor view + request recipient view), so the recorded settlement
 * is always caller → counterparty. Zelle never stashes — copy is not a
 * deeplink-out (R-cmoney-21 scopes the prompt to rail deeplink-outs).
 */
import { SETTLEMENT_METHODS, type SettlementMethod } from "@gogo/shared";
import { createMMKV } from "react-native-mmkv";

const storage = createMMKV();

export const SETTLE_RETURN_KEY = "gogo.settleReturn";

/** R-cmoney-21: prompt only when the return lands within 30 minutes. */
export const SETTLE_RETURN_WINDOW_MS = 30 * 60 * 1000;

export interface SettleReturnRecord {
  tripId: string;
  /** The payee (creditor) — `to_user_id` on the confirmed settlement. */
  counterpartyId: string;
  /** The rail that was opened — the prefilled `method`. */
  method: SettlementMethod;
  /** Integer minor units in trip base currency (Law #2). */
  amountCents: number;
  /**
   * Present when the rail tap came from a settle-request screen — the
   * confirm's `request_id`, linking + settling the request (R-money-18).
   */
  requestId?: string;
  /** Epoch ms of the outbound tap. */
  timestamp: number;
}

/**
 * Called at rail-tap time, before the URL opens externally. The tap
 * instant stamps HERE (callers may omit it) — an impure `Date.now()` in a
 * component body trips the compiler's purity lint; the store is the
 * natural clock owner anyway.
 */
export function recordSettleDeeplinkOut(
  record: Omit<SettleReturnRecord, "timestamp"> & { timestamp?: number },
): void {
  storage.set(
    SETTLE_RETURN_KEY,
    JSON.stringify({ ...record, timestamp: record.timestamp ?? Date.now() }),
  );
}

/** Clears the slot (open-failure rollback, sign-out hygiene, tests). */
export function clearSettleReturnRecord(): void {
  storage.remove(SETTLE_RETURN_KEY);
}

function isRecord(parsed: unknown): parsed is SettleReturnRecord {
  if (typeof parsed !== "object" || parsed === null) return false;
  const r = parsed as SettleReturnRecord;
  return (
    typeof r.tripId === "string" &&
    typeof r.counterpartyId === "string" &&
    (SETTLEMENT_METHODS as readonly string[]).includes(r.method) &&
    Number.isSafeInteger(r.amountCents) &&
    r.amountCents > 0 &&
    (r.requestId === undefined || typeof r.requestId === "string") &&
    typeof r.timestamp === "number"
  );
}

/**
 * The foreground read: whatever the outcome the slot is CLEARED — the
 * prompt never re-presents, and a stale (>30 min) or corrupt record
 * silently expires (R-cmoney-21 "exactly once"). Returns the record only
 * when the return landed inside the window.
 */
export function consumePendingSettleReturn(now: number = Date.now()): SettleReturnRecord | null {
  const raw = storage.getString(SETTLE_RETURN_KEY);
  if (raw === undefined) return null;
  clearSettleReturnRecord();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Corrupt persisted value — no pending return.
  }
  if (!isRecord(parsed)) return null;
  const age = now - parsed.timestamp;
  if (age < 0 || age > SETTLE_RETURN_WINDOW_MS) return null;
  return parsed;
}
