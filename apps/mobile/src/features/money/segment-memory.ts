/**
 * In-session per-trip money-segment memory (T-9.5 / R-cmoney-1, mirroring
 * the R-nav-9 no-snap-back pattern — tab-memory.ts is the template).
 *
 * A plain module-level Map IS the "in-session, never persisted" store:
 * process lifetime = session lifetime, so the cold-launch re-default to
 * `budget` is structural, not managed. Nothing reactive reads it (only the
 * money screen's `useState` initializer at mount), so a store library would
 * add subscription machinery with no subscriber.
 *
 * `resetMoneySegmentMemory` exists for test isolation standing in for a
 * process relaunch (and any future sign-out reset wiring, R-nav-4 kin).
 */

export const MONEY_SEGMENTS = ["budget", "expenses", "balances"] as const;
export type MoneySegment = (typeof MONEY_SEGMENTS)[number];

const memory = new Map<string, MoneySegment>();

/** Record a manual segment selection for the rest of the session. */
export function rememberMoneySegment(tripId: string, segment: MoneySegment): void {
  memory.set(tripId, segment);
}

/** The session's choice for this trip, if any (wins over the `budget` default). */
export function recallMoneySegment(tripId: string): MoneySegment | undefined {
  return memory.get(tripId);
}

/** Test stand-in for a cold relaunch (R-cmoney-1: cold launch re-defaults). */
export function resetMoneySegmentMemory(): void {
  memory.clear();
}
