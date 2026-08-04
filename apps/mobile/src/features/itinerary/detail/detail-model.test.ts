/**
 * Booking-detail model pins (T-7.9 / IT-9 — R-itin-24/26, API §3.2).
 *
 * The load-bearing one is `statusActionsFor`: it is a transcription of the
 * §3.2 transition table, and a transcription error ships a button whose only
 * possible outcome is a 400. It is checked EXHAUSTIVELY (every from-status,
 * every to-status) rather than by spot-checks, so a wrong cell cannot hide
 * behind a right one.
 */
import type { BookingDetails, BookingStatus, ItineraryItem } from "@gogo/shared";

import { makeItineraryItem } from "@/test-utils/itinerary-fixtures";

import {
  BOOKING_SOURCE_LABELS,
  detailFieldRows,
  detailStatusTone,
  scheduleSummary,
  statusActionsFor,
} from "./detail-model";

const ALL_STATUSES: BookingStatus[] = ["idea", "planned", "booked", "cancelled"];

/**
 * API §3.2, transcribed INDEPENDENTLY from the spec table (not from the
 * implementation) — `[from][to] = true` iff the table marks it ✔.
 *
 *   From \ To  | idea | planned | booked | cancelled
 *   idea       |  —   |    ✔    |   ✔    |     ✔
 *   planned    |  ✔   |    —    |   ✔    |     ✔
 *   booked     |  ✖   |    ✔    |   —    |     ✔
 *   cancelled  |  ✖   |    ✖    |   ✖    |     —
 */
const SPEC_TABLE: Record<BookingStatus, Record<BookingStatus, boolean>> = {
  idea: { idea: false, planned: true, booked: true, cancelled: true },
  planned: { idea: true, planned: false, booked: true, cancelled: true },
  booked: { idea: false, planned: true, booked: false, cancelled: true },
  cancelled: { idea: false, planned: false, booked: false, cancelled: false },
};

describe("statusActionsFor (§3.2 status machine)", () => {
  it.each(ALL_STATUSES)("offers exactly the legal non-cancel transitions from %s", (from) => {
    const offered = statusActionsFor(from);
    // R-itin-26 owns `→ cancelled` (ConfirmDialog), so the button list is the
    // spec row MINUS that column.
    const expected = ALL_STATUSES.filter(
      (to) => SPEC_TABLE[from][to] && to !== "cancelled",
    );
    expect(offered).toEqual(expected);
  });

  it("never offers a self-transition (the table's diagonal is '—')", () => {
    for (const status of ALL_STATUSES) {
      expect(statusActionsFor(status)).not.toContain(status);
    }
  });

  it("never offers `cancelled` as a plain status button (R-itin-26 owns it)", () => {
    for (const status of ALL_STATUSES) {
      expect(statusActionsFor(status)).not.toContain("cancelled");
    }
  });

  it("keeps booked → idea CLOSED (§3.2: demote to planned first — two-step friction)", () => {
    expect(statusActionsFor("booked")).toEqual(["planned"]);
  });

  it("treats cancelled as terminal — zero actions", () => {
    expect(statusActionsFor("cancelled")).toEqual([]);
  });
});

describe("detailStatusTone", () => {
  it("maps R-itin-8 tones and keeps the terminal state neutral", () => {
    expect(detailStatusTone("planned")).toBe("accent");
    expect(detailStatusTone("booked")).toBe("success");
    expect(detailStatusTone("idea")).toBe("neutral");
    expect(detailStatusTone("cancelled")).toBe("neutral");
  });
});

describe("detailFieldRows (R-itin-24 labeled grid)", () => {
  it("renders only POPULATED fields, in §2.4 form order, with the form's labels", () => {
    const details: BookingDetails = {
      category: "flight",
      airline: "United",
      flight_number: "UA837",
      origin_iata: "SFO",
      destination_iata: "NRT",
    };
    const rows = detailFieldRows(details);
    expect(rows.map((row) => row.key)).toEqual([
      "airline",
      "flight_number",
      "origin_iata",
      "destination_iata",
    ]);
    expect(rows[0]).toEqual({ key: "airline", label: "Airline", value: "United" });
    // CONTROL: the category's other fields exist in the inventory and are
    // simply absent from the output — so "only populated fields" is a real
    // filter, not an empty inventory.
    expect(detailFieldRows({ category: "flight", seat: "32A" })).toEqual([
      { key: "seat", label: "Seat", value: "32A" },
    ]);
  });

  it("renders a datetime as DESTINATION wall time — the offset is sliced, never applied", () => {
    // 10:00 in Tokyo is 01:00 UTC. A `Date`-based render would show 01:00 (or
    // whatever the runner's tz makes of it); the wall slice must show 10:00.
    const rows = detailFieldRows({ category: "flight", departs_at: "2027-03-01T10:00:00+09:00" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("Mon, Mar 1 · 10:00");
    expect(rows[0]?.value).not.toContain("01:00");
  });

  it("renders int fields as numbers and skips blank / whitespace-only strings", () => {
    const rows = detailFieldRows({
      category: "lodging",
      property_name: "   ",
      address: " 1-2-3 Nishi-Shinjuku ",
      guests: 2,
    });
    expect(rows).toEqual([
      { key: "address", label: "Address", value: "1-2-3 Nishi-Shinjuku" },
      { key: "guests", label: "Guests", value: "2" },
    ]);
  });

  it("ignores a key that is not in the category's inventory", () => {
    // The render walks CATEGORY_FIELDS, never Object.keys(details) — so a
    // stray/foreign key contributes nothing. CONTROL arm: the same object
    // with a REAL key of that category does render, proving the object is
    // reachable and the assertion above isn't passing on an empty read.
    const stray = { category: "restaurant", flight_number: "UA837" } as unknown as BookingDetails;
    expect(detailFieldRows(stray)).toEqual([]);
    const real = { category: "restaurant", party_size: 4 } as unknown as BookingDetails;
    expect(detailFieldRows(real)).toEqual([
      { key: "party_size", label: "Party size", value: "4" },
    ]);
  });
});

describe("scheduleSummary (R-itin-24 scheduled day/time row)", () => {
  const day1 = "2027-03-01";
  const day3 = "2027-03-03";

  it("returns null with zero items (idea / bucket / cancelled — I-1, I-3, I-4)", () => {
    expect(scheduleSummary([])).toBeNull();
  });

  it("names the day and the item's own wall times", () => {
    const item = makeItineraryItem({
      id: "i1",
      day: day1,
      start_time: "10:00",
      end_time: "12:30",
    });
    expect(scheduleSummary([item])).toEqual({
      day: day1,
      label: "Mon, Mar 1 · 10:00 – 12:30",
    });
  });

  it("omits the time clause entirely when the item is untimed", () => {
    const item = makeItineraryItem({ id: "i1", day: day1 });
    expect(scheduleSummary([item])).toEqual({ day: day1, label: "Mon, Mar 1" });
  });

  it("names the end day of a SPANNING item (lodging, §3.3)", () => {
    const item = makeItineraryItem({
      id: "i1",
      day: day1,
      end_day: day3,
      start_time: "15:00",
      end_time: "11:00",
    });
    const summary = scheduleSummary([item]);
    expect(summary?.day).toBe(day1);
    expect(summary?.label).toContain("through Wed, Mar 3");
    // CONTROL: the same item WITHOUT the span says nothing about a range —
    // so the clause tracks `end_day`, not the presence of two times.
    const single = makeItineraryItem({
      id: "i1",
      day: day1,
      start_time: "15:00",
      end_time: "11:00",
    });
    expect(scheduleSummary([single])?.label).not.toContain("through");
  });

  it("counts the pieces of a MULTI-ITEM booking and jumps to the EARLIEST (car rental, §3.3)", () => {
    const dropoff = makeItineraryItem({ id: "drop", day: day3, start_time: "09:00" });
    const pickup = makeItineraryItem({ id: "pick", day: day1, start_time: "14:00" });
    // Deliberately passed out of order — the summary sorts by (day, sort_order)
    // like the R-ib-13 read, it does not trust arrival order.
    const summary = scheduleSummary([dropoff, pickup] as ItineraryItem[]);
    expect(summary?.day).toBe(day1);
    expect(summary?.label).toContain("2 calendar entries");
    expect(summary?.label).toContain("Mon, Mar 1 · 14:00");
    // CONTROL: one item names no count.
    expect(scheduleSummary([pickup])?.label).not.toContain("calendar entries");
  });
});

describe("BOOKING_SOURCE_LABELS (R-itin-24 source label)", () => {
  it("covers every wire source, including the capture-only ones", () => {
    expect(Object.keys(BOOKING_SOURCE_LABELS).sort()).toEqual([
      "deeplink_return",
      "email",
      "manual",
      "share",
    ]);
  });
});
