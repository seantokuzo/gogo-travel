/**
 * Day-list model pins (T-7.4 / IT-1 — R-itin-1/8/31, §2.2/§2.6).
 * Pure-function suite: the projection IS the list's behavior, so these pins
 * are the falsifiable half of the rendering tests (delete the spanning
 * synthesis and the check-in/check-out pins go red, not just a snapshot).
 */
import type { Booking } from "@gogo/shared";

import {
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  ITEM_LODGING_ID,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import { buildDayRows, buildDaySet, formatDayHeader, projectItem, statusBadgeTone } from "./model";

const TRIP = { start_date: TRIP_START, end_date: TRIP_END };

function bookingsById(bookings: Booking[] = defaultBookings()): Map<string, Booking> {
  return new Map(bookings.map((b) => [b.id, b]));
}

describe("buildDaySet (R-itin-1 range union)", () => {
  it("covers every trip day continuously, including empty ones", () => {
    expect(buildDaySet(TRIP, [])).toEqual([TRIP_START, TRIP_DAY_2, TRIP_END]);
  });

  it("unions item days outside the trip range as sparse extra sections", () => {
    const days = buildDaySet(TRIP, ["2027-03-10", "2027-02-27"]);
    expect(days).toEqual(["2027-02-27", TRIP_START, TRIP_DAY_2, TRIP_END, "2027-03-10"]);
    // Sparse, not filled: no sections between Mar 3 and Mar 10.
    expect(days).not.toContain("2027-03-05");
  });
});

describe("formatDayHeader", () => {
  it("renders weekday + date, tz-free (2027-03-01 is a Monday)", () => {
    expect(formatDayHeader(TRIP_START)).toBe("Mon, Mar 1");
    expect(formatDayHeader(TRIP_END)).toBe("Wed, Mar 3");
  });
});

describe("projectItem (R-itin-31 spanning synthesis)", () => {
  const lodgingItem = defaultItineraryItems().find((i) => i.id === ITEM_LODGING_ID);
  if (lodgingItem === undefined) throw new Error("fixture missing lodging item");

  it("spanning lodging → check-in on day + check-out on end_day, same booking id", () => {
    const entries = projectItem(lodgingItem, bookingsById());
    expect(entries).toHaveLength(2);
    const [checkIn, checkOut] = entries;
    expect(checkIn?.checkpoint).toBe("check-in");
    expect(checkIn?.renderDay).toBe(TRIP_START);
    expect(checkIn?.timeLabel).toBe("15:00");
    expect(checkIn?.draggable).toBe(true);
    expect(checkOut?.checkpoint).toBe("check-out");
    expect(checkOut?.renderDay).toBe(TRIP_END);
    expect(checkOut?.timeLabel).toBe("11:00");
    // Render-only: listing it in end_day's order PUT would reassign the day.
    expect(checkOut?.draggable).toBe(false);
    // ONE data row, one detail target (R-itin-31).
    expect(checkIn?.bookingId).toBe(BOOKING_LODGING_ID);
    expect(checkOut?.bookingId).toBe(BOOKING_LODGING_ID);
    expect(checkIn?.itemId).toBe(ITEM_LODGING_ID);
    expect(checkOut?.itemId).toBe(ITEM_LODGING_ID);
  });

  it("nights between render nothing — no entry lands on the middle day", () => {
    const entries = projectItem(lodgingItem, bookingsById());
    expect(entries.map((e) => e.renderDay)).not.toContain(TRIP_DAY_2);
  });

  it("cross-midnight non-lodging span → ONE row on the departure day with +1", () => {
    const redEye = makeItineraryItem({
      id: "aaaaaaa9-aaaa-4aaa-8aaa-aaaaaaaaaaa9",
      kind: "booking",
      booking_id: defaultBookings()[0]?.id ?? null,
      title: null,
      day: TRIP_START,
      end_day: TRIP_DAY_2,
      start_time: "23:15",
      end_time: "05:40",
    });
    const entries = projectItem(redEye, bookingsById());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.renderDay).toBe(TRIP_START);
    expect(entries[0]?.plusOne).toBe(true);
    expect(entries[0]?.checkpoint).toBeNull();
  });

  it("booking enrichment: title/status from the parent; fixed times → dayLocked", () => {
    const flightItem = defaultItineraryItems()[0];
    if (flightItem === undefined) throw new Error("fixture missing flight item");
    const [entry] = projectItem(flightItem, bookingsById());
    expect(entry?.title).toBe("UA 837 SFO→NRT");
    expect(entry?.status).toBe("booked");
    expect(entry?.dayLocked).toBe(true);
  });

  it("timeless parent booking → cross-day movable (dayLocked false)", () => {
    const flightItem = defaultItineraryItems()[0];
    if (flightItem === undefined) throw new Error("fixture missing flight item");
    const timeless = defaultBookings().map((b) => ({ ...b, starts_at: null }));
    const [entry] = projectItem(flightItem, bookingsById(timeless));
    expect(entry?.dayLocked).toBe(false);
  });

  it("unknown parent booking fails safe: generic title, LOCKED", () => {
    const flightItem = defaultItineraryItems()[0];
    if (flightItem === undefined) throw new Error("fixture missing flight item");
    const [entry] = projectItem(flightItem, new Map());
    expect(entry?.title).toBe("Booking");
    expect(entry?.dayLocked).toBe(true);
  });

  it("place_visit without a place source falls back generically; custom uses its title", () => {
    const place = makeItineraryItem({
      id: "aaaaaaa8-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
      kind: "place_visit",
      place_id: "44444444-4444-4444-8444-444444444444",
      title: null,
    });
    expect(projectItem(place, new Map())[0]?.title).toBe("Place visit");
    const custom = makeItineraryItem({ id: "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7" });
    expect(projectItem(custom, new Map())[0]?.title).toBe("Custom block");
  });
});

describe("statusBadgeTone (R-itin-8)", () => {
  it("planned = accent, booked = success", () => {
    expect(statusBadgeTone("planned")).toBe("accent");
    expect(statusBadgeTone("booked")).toBe("success");
  });
});

describe("buildDayRows (§2.2 flat model)", () => {
  it("emits header/entry/empty-day rows in calendar order", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById());
    expect(
      rows.map((row) =>
        row.type === "day"
          ? `day:${row.date}`
          : row.type === "empty-day"
            ? `empty:${row.date}`
            : `entry:${row.entry.rowKey}`,
      ),
    ).toEqual([
      `day:${TRIP_START}`,
      "entry:aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "entry:aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      `entry:${ITEM_LODGING_ID}-check-in`,
      `day:${TRIP_DAY_2}`,
      `empty:${TRIP_DAY_2}`,
      `day:${TRIP_END}`,
      `entry:${ITEM_LODGING_ID}-check-out`,
      "entry:aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    ]);
  });

  it("day header counts include synthesized rows; empty day counts zero", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById());
    const counts = rows.flatMap((row) => (row.type === "day" ? [[row.date, row.count]] : []));
    expect(counts).toEqual([
      [TRIP_START, 3],
      [TRIP_DAY_2, 0],
      [TRIP_END, 2],
    ]);
  });

  it("an empty day renders the add row, never a blank section (R-itin-1)", () => {
    const rows = buildDayRows(TRIP, [], new Map());
    expect(rows.filter((row) => row.type === "empty-day")).toHaveLength(3);
  });

  it("check-out rows precede the end day's own sort_ordered items", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById());
    const day3 = rows.findIndex((row) => row.type === "day" && row.date === TRIP_END);
    const after = rows.slice(day3 + 1);
    expect(after[0]?.type).toBe("entry");
    expect(after[0]?.type === "entry" && after[0].entry.checkpoint).toBe("check-out");
  });
});
