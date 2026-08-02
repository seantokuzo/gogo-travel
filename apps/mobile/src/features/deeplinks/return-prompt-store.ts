/**
 * Deeplink-out → return-prompt record (T-7.8 / IT-8; itinerary spec §2.8,
 * navigation spec §2.3 capture-return): at button tap — BEFORE
 * `Linking.openURL` (R-itin-22) — record `{ partner, category, tripId,
 * timestamp }`. On the next foreground within 30 minutes the "Did you book
 * it?" prompt presents ONCE, then the record clears (R-nav-18 owns the
 * prompt's behavior; this store owns the record's lifecycle).
 *
 * MMKV per the established persistence pattern (last-viewed-trip.ts): the
 * default instance, a namespaced key, sync reads, validate-on-read with
 * corrupt → absent. ONE slot by design — a second deeplink-out before the
 * first return overwrites (the freshest tap is the one the user is coming
 * back from; nav §2.3 records "the" client store record, singular).
 */
import { BOOKING_CATEGORIES, type BookingCategory } from "@gogo/shared";
import { createMMKV } from "react-native-mmkv";

import type { DeeplinkPartnerId } from "./url-builders";

// Default instance (id "mmkv.default"), same as last-viewed-trip/theme
// storage — the key is namespaced. Jest substitutes the in-memory mock
// automatically, so tests exercise this real adapter.
const storage = createMMKV();

export const DEEPLINK_RETURN_KEY = "gogo.deeplinkReturn";

/** R-nav-18: prompt only when the return lands within 30 minutes of the tap. */
export const RETURN_PROMPT_WINDOW_MS = 30 * 60 * 1000;

export interface DeeplinkOutRecord {
  partner: DeeplinkPartnerId;
  category: BookingCategory;
  tripId: string;
  /** Epoch ms of the outbound tap. */
  timestamp: number;
}

/** R-itin-22: called at tap time, before the URL opens externally. */
export function recordDeeplinkOut(record: DeeplinkOutRecord): void {
  storage.set(DEEPLINK_RETURN_KEY, JSON.stringify(record));
}

/**
 * The persisted record, or null when absent/corrupt (corrupt = no pending
 * return — same fold as last-viewed-trip). No window logic here — that is
 * `consumePendingReturnPrompt`'s.
 */
export function readDeeplinkOutRecord(): DeeplinkOutRecord | null {
  const raw = storage.getString(DEEPLINK_RETURN_KEY);
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as DeeplinkOutRecord).partner === "string" &&
      (BOOKING_CATEGORIES as readonly string[]).includes((parsed as DeeplinkOutRecord).category) &&
      typeof (parsed as DeeplinkOutRecord).tripId === "string" &&
      typeof (parsed as DeeplinkOutRecord).timestamp === "number"
    ) {
      return parsed as DeeplinkOutRecord;
    }
  } catch {
    // Corrupt persisted value — fall through to "no pending return".
  }
  return null;
}

/** Clears the slot (open-failure rollback, sign-out hygiene, tests). */
export function clearDeeplinkOutRecord(): void {
  storage.remove(DEEPLINK_RETURN_KEY);
}

/**
 * The foreground read (nav §2.3: "present the Sheet once (then clear the
 * record)"): whatever the outcome, the slot is CLEARED — a prompt never
 * re-presents, and a stale (>30 min) or corrupt record silently expires.
 * Returns the record only when the return landed inside the window.
 */
export function consumePendingReturnPrompt(now: number = Date.now()): DeeplinkOutRecord | null {
  const record = readDeeplinkOutRecord();
  if (record === null) return null;
  clearDeeplinkOutRecord();
  const age = now - record.timestamp;
  if (age < 0 || age > RETURN_PROMPT_WINDOW_MS) return null;
  return record;
}
