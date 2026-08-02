/**
 * Drag-drop resolution (T-7.4 / IT-2 — R-itin-2/3, api R-ib-15/16).
 * Pure: `(flat rows, from, to)` → what the drop MEANS — commit (a single
 * day-order PUT for the target day, §2.2 "the PUT reassigns the day"),
 * refusal (R-itin-3 booking day lock), or no-op. The screen owns firing the
 * mutation / hint; this module owns the geometry.
 */
import type { ISODate } from "@gogo/shared";

import type { DayEntry, DayListRow } from "./model";

/** The R-itin-3 inline hint — spec copy, verbatim. */
export const BOOKING_DAY_LOCK_HINT = "Times come from the booking — edit the booking to move it";

export type DropResolution =
  | {
      kind: "commit";
      /** PUT param — the day the item landed on. */
      day: ISODate;
      /** The target day's FULL intended order (R-ib-15), moved item included. */
      itemIds: string[];
      moved: DayEntry;
    }
  | { kind: "refused-day-lock"; moved: DayEntry }
  | { kind: "noop" };

/** Nearest preceding day header of `index` in `rows`; null above the first. */
function dayAt(rows: readonly DayListRow[], index: number): ISODate | null {
  for (let i = index; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && row.type === "day") return row.date;
  }
  return null;
}

/** The day's REAL members, in row order: home items only — synthesized check-out rows are render-only. */
function dayOrderIds(rows: readonly DayListRow[], day: ISODate): string[] {
  const ids: string[] = [];
  let inDay = false;
  for (const row of rows) {
    if (row.type === "day") {
      if (inDay) break;
      inDay = row.date === day;
      continue;
    }
    if (!inDay || row.type !== "entry") continue;
    const e = row.entry;
    if (e.homeDay === day && e.checkpoint !== "check-out") ids.push(e.itemId);
  }
  return ids;
}

/**
 * Resolve a released drag. `from`/`to` are indices into `rows` (the
 * reorderable list's flat data). Rules:
 *
 * - Non-draggable rows can't start a drag (no drag handle), so `from` is
 *   always an entry row; anything else is a defensive no-op.
 * - Target day = nearest day header above the landing position (clamped to
 *   the first day when dropped above every header).
 * - Cross-day drop of a day-locked entry (parent booking has fixed times) →
 *   refusal with the R-itin-3 hint; same-day reorder stays allowed.
 * - A drop that leaves the target day's order unchanged → no-op (no PUT).
 */
export function resolveDrop(
  rows: readonly DayListRow[],
  from: number,
  to: number,
): DropResolution {
  const fromRow = rows[from];
  if (fromRow === undefined || fromRow.type !== "entry" || !fromRow.entry.draggable) {
    return { kind: "noop" };
  }
  const moved = fromRow.entry;

  // Simulate the move over the flat array.
  const next = [...rows];
  next.splice(from, 1);
  const clampedTo = Math.max(0, Math.min(to, next.length));
  next.splice(clampedTo, 0, fromRow);

  const firstDay = rows.find((row) => row.type === "day");
  const targetDay = dayAt(next, clampedTo) ?? (firstDay?.type === "day" ? firstDay.date : null);
  if (targetDay === null) return { kind: "noop" };

  if (targetDay !== moved.homeDay && moved.dayLocked) {
    return { kind: "refused-day-lock", moved };
  }

  // The target day's intended order after the move. `dayOrderIds` keys
  // membership on homeDay — the moved entry's homeDay only changes after the
  // commit, so include it positionally instead.
  const ids: string[] = [];
  let inDay = false;
  for (const row of next) {
    if (row.type === "day") {
      if (inDay) break;
      inDay = row.date === targetDay;
      continue;
    }
    if (!inDay || row.type !== "entry") continue;
    const e = row.entry;
    if (e.rowKey === moved.rowKey) ids.push(e.itemId);
    else if (e.homeDay === targetDay && e.checkpoint !== "check-out") ids.push(e.itemId);
  }

  // Clamp case: dropped ABOVE the first header, the moved row sits outside
  // every day section — it leads the first day by intent.
  if (!ids.includes(moved.itemId)) ids.unshift(moved.itemId);

  const before = dayOrderIds(rows, targetDay);
  if (before.length === ids.length && before.every((id, i) => id === ids[i])) {
    return { kind: "noop" };
  }

  return { kind: "commit", day: targetDay, itemIds: ids, moved };
}
