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
  defaultTravelLegs,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  makeItineraryItem,
  makeTravelLeg,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import { analyzeDayConflicts } from "./conflicts";
import {
  buildDayRows,
  buildDaySet,
  formatDayHeader,
  projectItem,
  statusBadgeTone,
  type DayListRow,
} from "./model";

const TRIP = { start_date: TRIP_START, end_date: TRIP_END };

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

/** A LOCATED day-1 item — `place_id` set, so R-ib-20 sees it in the chain. */
function located(id: string, startTime: string, sortOrder: number) {
  return makeItineraryItem({
    id,
    kind: "place_visit",
    place_id: PLACE_ID,
    title: null,
    start_time: startTime,
    sort_order: sortOrder,
  });
}

/** Flat row → a comparable label (exhaustive over the row union). */
function rowLabel(row: DayListRow): string {
  switch (row.type) {
    case "day":
      return `day:${row.date}`;
    case "empty-day":
      return `empty:${row.date}`;
    case "leg":
      return `leg:${row.leg.fromItemId}->${row.leg.toItemId}`;
    case "entry":
      return `entry:${row.entry.rowKey}`;
  }
}

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
      rows.map(rowLabel),
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

// ---------------------------------------------------------------------------
// T-7.5 / IT-3 — travel-time chip rows (R-itin-4/5/6)
// ---------------------------------------------------------------------------

describe("buildDayRows — leg rows (R-itin-4/6)", () => {
  it("NO legs ⇒ no leg rows at all — R-itin-6's 'no chip' arm", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById());
    expect(rows.filter((row) => row.type === "leg")).toHaveLength(0);
    // CONTROL: the identical items WITH the default legs emit one — so the
    // assertion above is about the absent legs, not about the fixture being
    // incapable of producing a chip.
    const withLegs = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(), {
      legs: defaultTravelLegs(),
    });
    expect(withLegs.filter((row) => row.type === "leg")).toHaveLength(1);
  });

  it("a partial leg set emits chips only for the pairs it covers", () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: "09:00", sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_B_ID, start_time: "11:00", sort_order: 2048 }),
      makeItineraryItem({ id: ITEM_C_ID, start_time: "13:00", sort_order: 3072 }),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [makeTravelLeg(ITEM_B_ID, ITEM_C_ID, "transit")],
    });
    expect(rows.map(rowLabel)).toEqual([
      `day:${TRIP_START}`,
      `entry:${ITEM_A_ID}`,
      `entry:${ITEM_B_ID}`,
      `leg:${ITEM_B_ID}->${ITEM_C_ID}`,
      `entry:${ITEM_C_ID}`,
      `day:${TRIP_DAY_2}`,
      `empty:${TRIP_DAY_2}`,
      `day:${TRIP_END}`,
      `empty:${TRIP_END}`,
    ]);
  });

  it("the chip follows its FROM row even when an UNLOCATED item sits between (R-ib-20)", () => {
    const items = [
      located(ITEM_A_ID, "09:00", 1024),
      // Unlocated middle item (no place_id) — transparent to the leg chain.
      makeItineraryItem({ id: ITEM_B_ID, start_time: "10:00", sort_order: 2048 }),
      located(ITEM_C_ID, "11:00", 3072),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")],
    });
    expect(rows.slice(0, 5).map(rowLabel)).toEqual([
      `day:${TRIP_START}`,
      `entry:${ITEM_A_ID}`,
      `leg:${ITEM_A_ID}->${ITEM_C_ID}`,
      `entry:${ITEM_B_ID}`,
      `entry:${ITEM_C_ID}`,
    ]);
  });

  it("CONTROL: a LOCATED item between them stops the scan — transparency is for unlocated only", () => {
    // Same three items, same single (A,C) leg — but the middle one now has a
    // place. The server would never store (A,C) for this chain; it is a stale
    // pair, and rendering it would draw "A → 10 min" directly above B.
    const items = [
      located(ITEM_A_ID, "09:00", 1024),
      located(ITEM_B_ID, "10:00", 2048),
      located(ITEM_C_ID, "11:00", 3072),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")],
    });
    expect(rows.filter((row) => row.type === "leg")).toHaveLength(0);
  });

  it("a stale leg surviving a same-day reorder degrades to ABSENT, never to a wrong hop", () => {
    // Legs (A,B) and (B,C) as the server computed them for order [A,B,C].
    const legs = [
      makeTravelLeg(ITEM_A_ID, ITEM_B_ID, "walking"),
      makeTravelLeg(ITEM_B_ID, ITEM_C_ID, "walking"),
    ];
    // CONTROL: in the original order both chips render.
    const before = buildDayRows(
      TRIP,
      [
        located(ITEM_A_ID, "09:00", 1024),
        located(ITEM_B_ID, "10:00", 2048),
        located(ITEM_C_ID, "11:00", 3072),
      ],
      bookingsById(),
      { legs },
    );
    expect(before.filter((row) => row.type === "leg")).toHaveLength(2);

    // B dragged above A. `reconcileDayOrder` deliberately leaves legs alone
    // and a successful reorder does not invalidate, so the client still holds
    // BOTH stale legs. Scanning past A from B would hit (B,C) and draw a chip
    // between B and A — a hop that was never computed.
    const after = buildDayRows(
      TRIP,
      [
        located(ITEM_B_ID, "10:00", 1024),
        located(ITEM_A_ID, "09:00", 2048),
        located(ITEM_C_ID, "11:00", 3072),
      ],
      bookingsById(),
      { legs },
    );
    expect(after.filter((row) => row.type === "leg")).toHaveLength(0);
  });

  it("the chip carries both titles, the mode set, and the R-itin-5 default", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(), {
      legs: [
        makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "walking", { duration_seconds: 300 }),
        makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "transit", { duration_seconds: 1080 }),
      ],
    });
    const leg = rows.flatMap((row) => (row.type === "leg" ? [row.leg] : []))[0];
    expect(leg?.fromTitle).toBe("UA 837 SFO→NRT");
    expect(leg?.toTitle).toBe("Park Hyatt Tokyo");
    expect(leg?.options.map((option) => option.mode)).toEqual(["walking", "transit"]);
    expect(leg?.defaultMode).toBe("walking");
  });

  it("a check-out row IS a leg endpoint — the server chains spanning items on end_day too", () => {
    // `travel-legs/adjacency.ts` `itemChainDays` puts a spanning lodging in
    // BOTH its check-in and check-out days' chains, so hotel → first-stop on
    // check-out morning is a leg the worker really computes. Dropping it lost
    // the most useful chip of that day.
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(), {
      legs: [makeTravelLeg(ITEM_LODGING_ID, ITEM_C_ID, "walking")],
    });
    const legRows = rows.filter((row) => row.type === "leg");
    expect(legRows).toHaveLength(1);
    // …and it renders on the CHECK-OUT day (day 3), between the two rows.
    const day3 = rows.slice(rows.findIndex((row) => row.type === "day" && row.date === TRIP_END));
    expect(day3.map(rowLabel)).toEqual([
      `day:${TRIP_END}`,
      `entry:${ITEM_LODGING_ID}-check-out`,
      `leg:${ITEM_LODGING_ID}->${ITEM_C_ID}`,
      `entry:${ITEM_C_ID}`,
    ]);
    // CONTROL: the same item pairs on its CHECK-IN day too, independently.
    const withDay1Pair = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "walking")],
    });
    expect(withDay1Pair.filter((row) => row.type === "leg")).toHaveLength(1);
  });

  it("leg row keys are day-scoped so a co-chained pair can't collide", () => {
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(), {
      legs: [
        makeTravelLeg(ITEM_A_ID, ITEM_LODGING_ID, "walking"),
        makeTravelLeg(ITEM_LODGING_ID, ITEM_C_ID, "walking"),
      ],
    });
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("booking endpoints prefer `details.address` over the title for the maps query", () => {
    const bookings = defaultBookings().map((booking) =>
      booking.id === BOOKING_LODGING_ID
        ? {
            ...booking,
            details: { category: "lodging" as const, address: "3-7-1-2 Nishi-Shinjuku" },
          }
        : booking,
    );
    const rows = buildDayRows(TRIP, defaultItineraryItems(), bookingsById(bookings), {
      legs: defaultTravelLegs(),
    });
    const leg = rows.flatMap((row) => (row.type === "leg" ? [row.leg] : []))[0];
    expect(leg?.toQuery).toBe("3-7-1-2 Nishi-Shinjuku");
    // The flight booking has no address — its title is the query.
    expect(leg?.fromQuery).toBe("UA 837 SFO→NRT");
  });

  it("an unnamed place_visit yields a null query (no place-name source yet)", () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: "09:00", sort_order: 1024 }),
      makeItineraryItem({
        id: ITEM_C_ID,
        kind: "place_visit",
        place_id: "44444444-4444-4444-8444-444444444444",
        title: null,
        start_time: "11:00",
        sort_order: 2048,
      }),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")],
    });
    const leg = rows.flatMap((row) => (row.type === "leg" ? [row.leg] : []))[0];
    expect(leg?.fromQuery).toBe("Custom block");
    expect(leg?.toQuery).toBeNull();
  });
});

describe("buildDayRows — conflict flags (R-itin-7)", () => {
  it("marks the overlapping entry rows and the unsorted day header", () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: "14:00", end_time: "16:00", sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_B_ID, start_time: "09:00", end_time: "15:00", sort_order: 2048 }),
    ];
    const conflicts = analyzeDayConflicts(items, bookingsById());
    const rows = buildDayRows(TRIP, items, bookingsById(), { conflicts });
    const day1 = rows.find((row) => row.type === "day" && row.date === TRIP_START);
    expect(day1?.type === "day" && day1.unsorted).toBe(true);
    const entries = rows.flatMap((row) => (row.type === "entry" ? [row] : []));
    expect(entries.map((row) => row.overlapping)).toEqual([true, true]);
  });

  it("CONTROL: without the conflicts option nothing is flagged", () => {
    const items = [
      makeItineraryItem({ id: ITEM_A_ID, start_time: "14:00", end_time: "16:00", sort_order: 1024 }),
      makeItineraryItem({ id: ITEM_B_ID, start_time: "09:00", end_time: "15:00", sort_order: 2048 }),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById());
    expect(rows.some((row) => row.type === "day" && row.unsorted)).toBe(false);
    expect(rows.some((row) => row.type === "entry" && row.overlapping)).toBe(false);
  });
});
