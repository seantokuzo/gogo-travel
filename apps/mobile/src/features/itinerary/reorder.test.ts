/**
 * Drop-resolution pins (T-7.4 / IT-2 — R-itin-2/3, api R-ib-15/16).
 * `resolveDrop` is the geometry between the flat list and the day-order PUT;
 * every arm here is a behavior the screen relies on (commit shape, day lock,
 * clamping, no-op suppression).
 */
import { buildDayRows } from "./model";
import { resolveDrop } from "./reorder";

import type { Booking } from "@gogo/shared";

import {
  defaultBookings,
  defaultItineraryItems,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

const TRIP = { start_date: TRIP_START, end_date: TRIP_END };

function rowsFor(opts?: { timelessBookings?: boolean }) {
  const bookings = defaultBookings().map((b) =>
    opts?.timelessBookings === true ? { ...b, starts_at: null } : b,
  );
  const byId = new Map<string, Booking>(bookings.map((b) => [b.id, b]));
  return buildDayRows(TRIP, defaultItineraryItems(), byId);
}

// Default flat rows (model.test pins this exact shape):
// 0 day:Mar1 · 1 flight(A) · 2 custom(B) · 3 lodging-check-in ·
// 4 day:Mar2 · 5 empty:Mar2 · 6 day:Mar3 · 7 lodging-check-out · 8 place(C)
const rows = rowsFor();

describe("same-day reorder", () => {
  it("commits the day's FULL order with the moved item repositioned", () => {
    // Drag custom(B) above flight(A).
    const res = resolveDrop(rows, 2, 1);
    expect(res).toEqual(
      expect.objectContaining({
        kind: "commit",
        day: TRIP_START,
        itemIds: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID],
      }),
    );
  });

  it("a day-locked item may still reorder within its day (R-itin-3)", () => {
    // Flight A is locked (parent starts_at set) — same-day move is legal.
    const res = resolveDrop(rows, 1, 2);
    expect(res).toEqual(
      expect.objectContaining({
        kind: "commit",
        day: TRIP_START,
        itemIds: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID],
      }),
    );
  });

  it("a drop that leaves the order unchanged is a no-op (no PUT)", () => {
    expect(resolveDrop(rows, 1, 1)).toEqual({ kind: "noop" });
  });
});

describe("cross-day moves", () => {
  it("unlocked item dropped past a day header commits to the TARGET day's order", () => {
    // Drag custom(B) onto empty Mar 2 (past its header).
    const res = resolveDrop(rows, 2, 5);
    expect(res).toEqual(
      expect.objectContaining({ kind: "commit", day: TRIP_DAY_2, itemIds: [ITEM_B_ID] }),
    );
  });

  it("moving into a populated day slots the item into that day's id list", () => {
    // Drag custom(B) to the end of Mar 3.
    const res = resolveDrop(rows, 2, 8);
    expect(res).toEqual(
      expect.objectContaining({
        kind: "commit",
        day: TRIP_END,
        // Check-out row is render-only — its id must NOT ride the PUT
        // (listing it on end_day would REASSIGN the spanning item's day).
        itemIds: [ITEM_C_ID, ITEM_B_ID],
      }),
    );
  });

  it("timed-booking item refuses a cross-day drop (R-itin-3)", () => {
    const res = resolveDrop(rows, 1, 5);
    expect(res).toEqual(
      expect.objectContaining({ kind: "refused-day-lock" }),
    );
  });

  it("the same drop commits once the parent booking is timeless (falsification arm)", () => {
    const timeless = rowsFor({ timelessBookings: true });
    const res = resolveDrop(timeless, 1, 5);
    expect(res).toEqual(
      expect.objectContaining({ kind: "commit", day: TRIP_DAY_2, itemIds: [ITEM_A_ID] }),
    );
  });

  it("spanning lodging check-in row is day-locked too (times come from the booking)", () => {
    const res = resolveDrop(rows, 3, 5);
    expect(res).toEqual(expect.objectContaining({ kind: "refused-day-lock" }));
  });
});

describe("edges", () => {
  it("a drop above the first day header clamps to the first day", () => {
    const res = resolveDrop(rows, 2, 0);
    expect(res).toEqual(
      expect.objectContaining({
        kind: "commit",
        day: TRIP_START,
        itemIds: [ITEM_B_ID, ITEM_A_ID, ITEM_LODGING_ID],
      }),
    );
  });

  it("non-draggable rows resolve to no-op defensively", () => {
    expect(resolveDrop(rows, 0, 3)).toEqual({ kind: "noop" }); // day header
    expect(resolveDrop(rows, 5, 1)).toEqual({ kind: "noop" }); // empty-day row
    expect(resolveDrop(rows, 7, 8)).toEqual({ kind: "noop" }); // check-out row
  });
});
