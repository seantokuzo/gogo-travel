/**
 * Most-recently-viewed trip stamp (T-6.6 / NAV-3; R-nav-23, spec §2.2).
 *
 * `[tripId]/_layout` stamps `{ tripId, viewedAt }` into MMKV under
 * `gogo.lastViewedTrip` on mount (AFTER the membership guard admits the
 * trip — a no-access bounce must never become "most recently viewed"); the
 * entry redirect reads it synchronously at boot (MMKV reads are sync — the
 * same no-flash posture as R-nav-3).
 *
 * ONE slot by spec. The entry redirect only honors it when the stamped trip
 * is still in the caller's ACTIVE set (see entry-redirect.ts), so a stale
 * stamp — or another account's, after a user switch — can never navigate
 * blindly into a trip the current user can't open.
 */
import { createMMKV } from "react-native-mmkv";

// Default instance (id "mmkv.default"), same as theme storage — the key is
// already namespaced per the spec. Under jest, react-native-mmkv substitutes
// its in-memory mock automatically, so tests exercise this real adapter.
const storage = createMMKV();

export const LAST_VIEWED_TRIP_KEY = "gogo.lastViewedTrip";

export interface LastViewedTrip {
  tripId: string;
  /** Epoch ms of the stamp — recency metadata (spec §2.2: "trip id + timestamp"). */
  viewedAt: number;
}

export function stampLastViewedTrip(tripId: string): void {
  const stamp: LastViewedTrip = { tripId, viewedAt: Date.now() };
  storage.set(LAST_VIEWED_TRIP_KEY, JSON.stringify(stamp));
}

/** The persisted stamp, or null when absent/corrupt (corrupt = never viewed). */
export function readLastViewedTrip(): LastViewedTrip | null {
  const raw = storage.getString(LAST_VIEWED_TRIP_KEY);
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LastViewedTrip).tripId === "string" &&
      typeof (parsed as LastViewedTrip).viewedAt === "number"
    ) {
      return parsed as LastViewedTrip;
    }
  } catch {
    // Corrupt persisted value — fall through to "never viewed".
  }
  return null;
}

/** Test isolation; no product flow clears the stamp (stale stamps are inert). */
export function clearLastViewedTrip(): void {
  storage.remove(LAST_VIEWED_TRIP_KEY);
}
