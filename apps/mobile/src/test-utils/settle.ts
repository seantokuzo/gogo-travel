/**
 * Drain every pending update batch inside ONE `act` window (T-7.5).
 *
 * Two schedulers keep a screen test busy after the last `await` returns, and
 * they are independent:
 *
 *  - TanStack Query's notify batch, on a `setTimeout(0)`;
 *  - `VirtualizedList._updateCellsToRender`, behind RN's
 *    `updateCellsBatchingPeriod` — 50 ms by default, which a `setTimeout(0)`
 *    drain can never reach.
 *
 * A single 0 ms cycle absorbs the first and leaves the second pending; it then
 * lands at the next `await` in a test body (a `findBy*` that resolves on its
 * first synchronous check opens no `act` window of its own) or, worse, after
 * the file finishes — surfacing as an un-acted update inside whichever suite
 * the worker picks up next. That is the B-2 floating-act class: green locally,
 * red only under CI's 2-core contention.
 *
 * Successive cycles INSIDE one `act` window absorb whatever each previous
 * cycle scheduled, and the window outlasts the list's batching period.
 *
 * ONE HOME on purpose: this lived as a byte-identical copy in four itinerary
 * suites. The failure mode of that is a fifth suite seeded from a stale copy,
 * or `updateCellsBatchingPeriod` changing and three of four files getting the
 * update — silently reintroducing exactly the class the act-warning gate in
 * `.claude/rules/mobile.md` exists to catch.
 */
import { act } from "@testing-library/react-native";

/**
 * RN's `updateCellsBatchingPeriod` default is 50 ms; 60 clears it with a
 * little headroom without making suites noticeably slower.
 */
export const VIRTUALIZED_LIST_BATCH_MS = 60;

const SETTLE_DELAYS = [0, 0, VIRTUALIZED_LIST_BATCH_MS, 0] as const;

export async function settle(): Promise<void> {
  await act(async () => {
    for (const delay of SETTLE_DELAYS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  });
}
