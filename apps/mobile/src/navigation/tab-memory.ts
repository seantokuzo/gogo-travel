/**
 * In-session per-trip tab memory (T-6.6 / NAV-3; R-nav-9, spec §2.5).
 *
 * "In-session manual tab choice is held in a per-trip, in-memory store slot —
 * never persisted, so every cold launch re-applies `initialTab`." A plain
 * module-level Map IS that store slot: process lifetime = session lifetime,
 * so relaunch-reset is structural, not managed. Nothing reactive reads it
 * (only `[tripId]/_layout` at tab-navigator mount), so Zustand would add
 * subscription machinery with no subscriber.
 *
 * `resetTabMemory` exists for the two real resets: sign-out (R-nav-4 "reset
 * the entire navigation state" — wired in the session-store singleton) and
 * test isolation standing in for a process relaunch.
 */
const memory = new Map<string, string>();

/** Record a MANUAL tab selection (tab-bar press) for the rest of the session. */
export function rememberTab(tripId: string, tabKey: string): void {
  memory.set(tripId, tabKey);
}

/** The session's manual choice for this trip, if any (wins over `initialTab`). */
export function recallTab(tripId: string): string | undefined {
  return memory.get(tripId);
}

/** Sign-out reset (R-nav-4) / test stand-in for a cold relaunch (R-nav-9). */
export function resetTabMemory(): void {
  memory.clear();
}
