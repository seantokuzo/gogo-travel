/**
 * Day-list model pins (T-7.4 / IT-1 — R-itin-1/8/31, §2.2/§2.6).
 * Pure-function suite: the projection IS the list's behavior, so these pins
 * are the falsifiable half of the rendering tests (delete the spanning
 * synthesis and the check-in/check-out pins go red, not just a snapshot).
 */
import {
  deriveAutoItems,
  deriveBookingInstants,
  type Booking,
  type BookingDetails,
  type FlightDetails,
  type ItineraryItem,
} from "@gogo/shared";
import {
  DATE_LINE_EASTBOUND,
  DATE_LINE_WESTBOUND,
  NAIVE_CONTROL_FLIGHT,
  localISO,
} from "@gogo/shared/testing";

import {
  BOOKING_FLIGHT_ID,
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  defaultTravelLegs,
  makeBooking,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  makeItineraryItem,
  makeTravelLeg,
  rentalBooking,
  rentalItems,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";

import { analyzeDayConflicts } from "./conflicts";
import { buildGridDays } from "./grid/model";
import { legChipTestID } from "./legs/legs-model";
import {
  buildDayRows,
  buildDaySet,
  formatDayHeader,
  projectItem,
  statusBadgeTone,
  type DayListRow,
} from "./model";
import { resolveDrop } from "./reorder";

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

  it("cross-midnight non-lodging span, DEFAULT (grid-facing) projection → ONE row on the departure day with +1", () => {
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

describe("B-18 — rental pickup/drop-off subtext (§3.3 dual-point derivation)", () => {
  const rentalMap = () => bookingsById([rentalBooking(), ...defaultBookings()]);

  it("the rental's two derived rows carry DISTINCT subtexts, matched by §3.3 wall values", () => {
    const [pickupItem, dropoffItem] = rentalItems();
    if (pickupItem === undefined || dropoffItem === undefined) {
      throw new Error("fixture missing rental items");
    }
    const [pickup] = projectItem(pickupItem, rentalMap());
    const [dropoff] = projectItem(dropoffItem, rentalMap());
    expect(pickup?.subtext).toBe("Pickup");
    expect(dropoff?.subtext).toBe("Drop off");
    // Same title on both — the subtext is the ONLY row-level discriminator,
    // which is exactly the device-QA gap.
    expect(pickup?.title).toBe(dropoff?.title);
  });

  it("CONTROL: non-derived rows carry no subtext (flight booking, custom, lodging checkpoints)", () => {
    const flightItem = defaultItineraryItems()[0];
    if (flightItem === undefined) throw new Error("fixture missing flight item");
    expect(projectItem(flightItem, rentalMap())[0]?.subtext).toBeNull();
    const custom = makeItineraryItem({ id: "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7" });
    expect(projectItem(custom, rentalMap())[0]?.subtext).toBeNull();
    // A spanning lodging's synthesized rows keep the CHECKPOINT vocabulary,
    // never the rental one.
    const lodgingItem = defaultItineraryItems().find((i) => i.id === ITEM_LODGING_ID);
    if (lodgingItem === undefined) throw new Error("fixture missing lodging item");
    for (const entry of projectItem(lodgingItem, rentalMap())) {
      expect(entry.subtext).toBeNull();
    }
  });

  it("an item-owned rental row (walls no longer §3.3-derived) degrades to NO caption", () => {
    const [pickupItem] = rentalItems();
    if (pickupItem === undefined) throw new Error("fixture missing rental items");
    // The user dragged/edited the row: its times are item-owned (I-3) and no
    // longer match either edge — a wrong caption would be worse than none.
    const moved = { ...pickupItem, start_time: "11:30" };
    expect(projectItem(moved, rentalMap())[0]?.subtext).toBeNull();
  });

  it("an unknown parent booking yields no subtext (enrichment-gap fail-safe)", () => {
    const [pickupItem] = rentalItems();
    if (pickupItem === undefined) throw new Error("fixture missing rental items");
    expect(projectItem(pickupItem, new Map())[0]?.subtext).toBeNull();
  });

  it("keys off the PARENT booking id, never a wall-time scan: a flight-parented row at the rental edge's exact walls gets no caption (R1)", () => {
    // Same day + start_time as the rental's pickup edge, but parented to the
    // FLIGHT booking — with the rental PRESENT in the map. A scan-all-
    // bookings-for-wall-time-match implementation captions this row
    // "Pickup"; the id-keyed one reads the flight's details and yields null.
    const flightAtPickupWalls = makeItineraryItem({
      id: "aaaaaab1-aaaa-4aaa-8aaa-aaaaaaaaaab1",
      kind: "booking",
      booking_id: BOOKING_FLIGHT_ID,
      title: null,
      day: TRIP_START,
      start_time: "09:00",
    });
    expect(projectItem(flightAtPickupWalls, rentalMap())[0]?.subtext).toBeNull();
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
    expect(rows.map(rowLabel)).toEqual([
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

  it("an UNKNOWN parent booking fails safe to LOCATED — it stops the scan", () => {
    // The enrichment gap is reachable: `useItineraryBookings` is a SEPARATE
    // query from `useItinerary`, capped at 100 rows, so a just-added booking
    // can be in `items` while `bookingsById` still lacks its parent.
    //
    // Locatedness is only ever used to STOP the scan, so reading the unknown
    // row as UNLOCATED would make the scan skip it and match the stale (A,C)
    // pair — drawing a chip directly above the item that was just inserted
    // between them. That is round 1's blocking bug wearing a different hat.
    const items = [
      located(ITEM_A_ID, "09:00", 1024),
      makeItineraryItem({
        id: ITEM_B_ID,
        kind: "booking",
        booking_id: "bbbbbbb8-bbbb-4bbb-8bbb-bbbbbbbbbbb8", // not in bookingsById
        title: null,
        start_time: "10:00",
        sort_order: 2048,
      }),
      located(ITEM_C_ID, "11:00", 3072),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")],
    });
    expect(rows.filter((row) => row.type === "leg")).toHaveLength(0);

    // CONTROL: the same shape with a KNOWN, genuinely place-less parent is a
    // real R-ib-20 unlocated item — transparent, so the chip DOES render.
    const knownUnlocated = [
      located(ITEM_A_ID, "09:00", 1024),
      makeItineraryItem({
        id: ITEM_B_ID,
        kind: "booking",
        booking_id: BOOKING_FLIGHT_ID,
        title: null,
        start_time: "10:00",
        sort_order: 2048,
      }),
      located(ITEM_C_ID, "11:00", 3072),
    ];
    const withKnown = buildDayRows(TRIP, knownUnlocated, bookingsById(), {
      legs: [makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "walking")],
    });
    expect(withKnown.filter((row) => row.type === "leg")).toHaveLength(1);
  });

  it("a SAME-PLACE pair renders no chip — there is no travel to time (R-itin-6)", () => {
    // The server writes these on purpose: two consecutive located items
    // resolving to one `place_id` are marked `samePlace` and upserted for
    // EVERY mode with 0s/0m and `provider: "same_place"`, no provider call.
    // Rendering that as "Walk 1 min" over a Sheet reading "0 m · same_place"
    // is a chip that contradicts itself.
    const samePlace = (mode: Parameters<typeof makeTravelLeg>[2]) =>
      makeTravelLeg(ITEM_A_ID, ITEM_C_ID, mode, {
        duration_seconds: 0,
        distance_meters: 0,
        provider: "same_place",
      });
    const items = [located(ITEM_A_ID, "09:00", 1024), located(ITEM_C_ID, "11:00", 2048)];
    const rows = buildDayRows(TRIP, items, bookingsById(), {
      legs: [
        samePlace("walking"),
        samePlace("driving"),
        samePlace("cycling"),
        samePlace("transit"),
      ],
    });
    expect(rows.filter((row) => row.type === "leg")).toHaveLength(0);

    // CONTROL: one real mode and the chip is back — the suppression is about
    // zero-travel data, not about the fixture being unable to emit a chip.
    const withRealMode = buildDayRows(TRIP, items, bookingsById(), {
      legs: [
        samePlace("walking"),
        makeTravelLeg(ITEM_A_ID, ITEM_C_ID, "transit", { duration_seconds: 600 }),
      ],
    });
    expect(withRealMode.filter((row) => row.type === "leg")).toHaveLength(1);
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

  /**
   * The REAL co-chain collision: two lodgings spanning the SAME two days.
   * Both chain into D1 and D3, so the single stored `(L1,L2)` leg row is
   * adjacent on both — one leg, two rendered chips. The previous version of
   * this pin used two DIFFERENT pairs, whose keys stay distinct with the day
   * scoping stripped, so it could not fail.
   */
  function twoSpanningLodgings() {
    const l2 = "aaaaaab1-aaaa-4aaa-8aaa-aaaaaaaaaab1";
    const booking2 = "bbbbbbb9-bbbb-4bbb-8bbb-bbbbbbbbbbb9";
    const items = [
      makeItineraryItem({
        id: ITEM_LODGING_ID,
        kind: "booking",
        booking_id: BOOKING_LODGING_ID,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "15:00",
        end_time: "11:00",
        sort_order: 1024,
      }),
      makeItineraryItem({
        id: l2,
        kind: "booking",
        booking_id: booking2,
        title: null,
        day: TRIP_START,
        end_day: TRIP_END,
        start_time: "16:00",
        end_time: "10:00",
        sort_order: 2048,
      }),
    ];
    const bookings = [
      ...defaultBookings(),
      makeBooking({
        id: booking2,
        category: "lodging",
        status: "planned",
        title: "Second stay",
        details: { category: "lodging" },
        place_id: "55555555-5555-4555-8555-555555555555",
      }),
    ];
    return { items, bookings, l2 };
  }

  it("a co-chained pair renders on BOTH days with DISTINCT row keys", () => {
    const { items, bookings, l2 } = twoSpanningLodgings();
    const rows = buildDayRows(TRIP, items, bookingsById(bookings), {
      legs: [makeTravelLeg(ITEM_LODGING_ID, l2, "walking")],
    });
    const legRows = rows.flatMap((row) => (row.type === "leg" ? [row] : []));
    // ONE stored leg, TWO chips — that is the collision's precondition.
    expect(legRows).toHaveLength(2);
    expect(legRows.map((row) => row.leg.renderDay)).toEqual([TRIP_START, TRIP_END]);
    // Same pair on both, so `${from}-${to}` alone would be identical.
    expect(new Set(legRows.map((row) => `${row.leg.fromItemId}-${row.leg.toItemId}`)).size).toBe(1);
    // …and yet every key in the whole list is unique.
    const keys = rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the same collision applies to the chip testID (§2.9 day-scoping)", () => {
    const { items, bookings, l2 } = twoSpanningLodgings();
    const rows = buildDayRows(TRIP, items, bookingsById(bookings), {
      legs: [makeTravelLeg(ITEM_LODGING_ID, l2, "walking")],
    });
    const ids = rows.flatMap((row) => (row.type === "leg" ? [legChipTestID(row.leg)] : []));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
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
      makeItineraryItem({
        id: ITEM_A_ID,
        start_time: "14:00",
        end_time: "16:00",
        sort_order: 1024,
      }),
      makeItineraryItem({
        id: ITEM_B_ID,
        start_time: "09:00",
        end_time: "15:00",
        sort_order: 2048,
      }),
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
      makeItineraryItem({
        id: ITEM_A_ID,
        start_time: "14:00",
        end_time: "16:00",
        sort_order: 1024,
      }),
      makeItineraryItem({
        id: ITEM_B_ID,
        start_time: "09:00",
        end_time: "15:00",
        sort_order: 2048,
      }),
    ];
    const rows = buildDayRows(TRIP, items, bookingsById());
    expect(rows.some((row) => row.type === "day" && row.unsorted)).toBe(false);
    expect(rows.some((row) => row.type === "entry" && row.overlapping)).toBe(false);
  });
});
// ---------------------------------------------------------------------------
// T-7.11 — overnight flight Departs/Arrives list rows (R-itin-36)
//
// Fixtures are DERIVED, not hand-typed: each flight's item comes out of the
// shared `deriveAutoItems` (the exact §3.3 placement the server writes) from
// real two-zone `FlightDetails`, so a drift between what the server derives
// and what these pins assume goes red here instead of on a device.
// ---------------------------------------------------------------------------

const FLIGHT_BOOKING_ID = "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
const FLIGHT_ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** JFK → LHR red-eye: depart Jun 10 19:30 EDT, land Jun 11 07:45 BST (7h15m real). */
const RED_EYE_JFK_LHR: FlightDetails = {
  category: "flight",
  airline: "British Airways",
  flight_number: "BA 178",
  origin_iata: "JFK",
  destination_iata: "LHR",
  departs_at: localISO("2027-06-10", "19:30", "-04:00"),
  departs_tz: "America/New_York",
  arrives_at: localISO("2027-06-11", "07:45", "+01:00"),
  arrives_tz: "Europe/London",
};

/**
 * LAX → AKL (13h15m real): depart Apr 20 22:00 PDT, land Apr 22 06:15 NZST —
 * the arrival wall date is TWO days on (Apr 21 is skipped by the date line),
 * a flight spanning THREE calendar days.
 */
const LAX_AKL_THREE_DAYS: FlightDetails = {
  category: "flight",
  airline: "Air New Zealand",
  flight_number: "NZ 7",
  origin_iata: "LAX",
  destination_iata: "AKL",
  departs_at: localISO("2027-04-20", "22:00", "-07:00"),
  departs_tz: "America/Los_Angeles",
  arrives_at: localISO("2027-04-22", "06:15", "+12:00"),
  arrives_tz: "Pacific/Auckland",
};

/**
 * AKL → PPT shifted past midnight: depart Apr 25 00:30 NZST, land Apr 24
 * 08:20 Tahiti (5h50m real) — the arrival WALL DATE is EARLIER than the
 * departure's. `deriveAutoItems` emits `end_day: null` for it (end <= day).
 */
const ARRIVAL_DATE_BEFORE_DEPARTURE: FlightDetails = {
  category: "flight",
  airline: "Air Tahiti Nui",
  flight_number: "TN 102",
  origin_iata: "AKL",
  destination_iata: "PPT",
  departs_at: localISO("2027-04-25", "00:30", "+12:00"),
  departs_tz: "Pacific/Auckland",
  arrives_at: localISO("2027-04-24", "08:20", "-10:00"),
  arrives_tz: "Pacific/Tahiti",
};

/** A flight whose booking carries NO arrival at all → `ends_at` NULL, no `end_day`. */
const NO_ARRIVAL_FLIGHT: FlightDetails = {
  category: "flight",
  origin_iata: "SFO",
  destination_iata: "NRT",
  departs_at: localISO("2027-06-10", "23:15", "-07:00"),
  departs_tz: "America/Los_Angeles",
};

const LIST = { listMode: true } as const;
const OWN_CLASH_ID = "aaaaaaad-aaaa-4aaa-8aaa-aaaaaaaaaaad";

interface FlightFixture {
  item: ItineraryItem;
  booking: Booking;
  byId: Map<string, Booking>;
}

function flightFixture(details: FlightDetails, title: string): FlightFixture {
  const { starts_at, ends_at } = deriveBookingInstants(details);
  const booking = makeBooking({
    id: FLIGHT_BOOKING_ID,
    category: "flight",
    title,
    details,
    starts_at,
    ends_at,
  });
  const placement = deriveAutoItems(details)[0];
  if (placement === undefined) throw new Error("flight fixture derives no auto-item");
  const item = makeItineraryItem({
    id: FLIGHT_ITEM_ID,
    kind: "booking",
    booking_id: booking.id,
    title: null,
    ...placement,
  });
  return { item, booking, byId: new Map([[booking.id, booking]]) };
}

describe("T-7.11 — overnight flights render Departs/Arrives point rows (R-itin-36)", () => {
  // The three spanning fixtures: +1 wall day (transatlantic red-eye), +1 wall
  // day across the date line (B-8/B-9's westbound hostile fixture, 11h50m
  // real), and +2 wall days (three calendar days touched).
  const SPANNING: {
    name: string;
    details: FlightDetails;
    departs: [string, string];
    arrives: [string, string];
  }[] = [
    {
      name: "JFK→LHR red-eye (+1 wall day, 2 zones)",
      details: RED_EYE_JFK_LHR,
      departs: ["2027-06-10", "19:30"],
      arrives: ["2027-06-11", "07:45"],
    },
    {
      name: "LAX→NRT westbound date-line (B-8/B-9 shared fixture)",
      details: DATE_LINE_WESTBOUND.details,
      departs: ["2027-04-20", "11:35"],
      arrives: ["2027-04-21", "15:25"],
    },
    {
      name: "LAX→AKL (+2 wall days — spans three calendar days)",
      details: LAX_AKL_THREE_DAYS,
      departs: ["2027-04-20", "22:00"],
      arrives: ["2027-04-22", "06:15"],
    },
  ];

  describe("happy — a spanning flight splits into two point rows in LIST mode", () => {
    it.each(SPANNING)(
      "$name → Departs on day, Arrives on end_day, each at its LOCAL wall time",
      (c) => {
        const { item, byId } = flightFixture(c.details, "Flight");
        const entries = projectItem(item, byId, LIST);
        expect(entries.map((e) => [e.checkpoint, e.renderDay, e.timeLabel])).toEqual([
          ["departs", ...c.departs],
          ["arrives", ...c.arrives],
        ]);
      },
    );

    it("both rows are ONE itinerary item and ONE booking (F-051-class single-row invariant)", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178 JFK→LHR");
      const [departs, arrives] = projectItem(item, byId, LIST);
      expect(departs?.rowKey).toBe(`${FLIGHT_ITEM_ID}-departs`);
      expect(arrives?.rowKey).toBe(`${FLIGHT_ITEM_ID}-arrives`);
      for (const row of [departs, arrives]) {
        expect(row?.itemId).toBe(FLIGHT_ITEM_ID);
        expect(row?.bookingId).toBe(FLIGHT_BOOKING_ID);
        expect(row?.homeDay).toBe("2027-06-10");
        expect(row?.title).toBe("BA 178 JFK→LHR");
        expect(row?.plusOne).toBe(false);
        expect(row?.dayLocked).toBe(true);
      }
      // Departs keeps the item's drag identity; Arrives is render-only —
      // listing its id in end_day's order PUT would REASSIGN the flight's day.
      expect(departs?.draggable).toBe(true);
      expect(arrives?.draggable).toBe(false);
    });

    it("buildDayRows lands each row under its OWN day header — nothing else between", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178 JFK→LHR");
      const trip = { start_date: "2027-06-10", end_date: "2027-06-11" };
      const rows = buildDayRows(trip, [item], byId);
      expect(rows.map(rowLabel)).toEqual([
        "day:2027-06-10",
        `entry:${FLIGHT_ITEM_ID}-departs`,
        "day:2027-06-11",
        `entry:${FLIGHT_ITEM_ID}-arrives`,
      ]);
      const counts = rows.flatMap((row) => (row.type === "day" ? [row.count] : []));
      expect(counts).toEqual([1, 1]);
    });

    it("a three-calendar-day flight renders NOTHING on the middle day (R-itin-31 'nights between')", () => {
      const { item, byId } = flightFixture(LAX_AKL_THREE_DAYS, "NZ 7 LAX→AKL");
      const trip = { start_date: "2027-04-20", end_date: "2027-04-22" };
      const rows = buildDayRows(trip, [item], byId);
      expect(rows.map(rowLabel)).toEqual([
        "day:2027-04-20",
        `entry:${FLIGHT_ITEM_ID}-departs`,
        "day:2027-04-21",
        "empty:2027-04-21",
        "day:2027-04-22",
        `entry:${FLIGHT_ITEM_ID}-arrives`,
      ]);
    });
  });

  describe("empty/boundary — a flight that does NOT span two wall dates is unchanged", () => {
    it("same-day flight (SFO→LAX control) → one row, no split, no +1", () => {
      const { item, byId } = flightFixture(NAIVE_CONTROL_FLIGHT.details, "UA 415 SFO→LAX");
      expect(item.end_day).toBeNull();
      const entries = projectItem(item, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.rowKey).toBe(FLIGHT_ITEM_ID);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(false);
      expect(entries[0]?.timeLabel).toBe("10:00 – 11:30");
      // …and the whole list model agrees: exactly one entry row for it.
      const rows = buildDayRows({ start_date: "2027-04-24", end_date: "2027-04-24" }, [item], byId);
      expect(rows.filter((row) => row.type === "entry")).toHaveLength(1);
    });

    it("`end_day` equal to `day` (explicit) is not spanning either", () => {
      const { item, byId } = flightFixture(NAIVE_CONTROL_FLIGHT.details, "UA 415 SFO→LAX");
      const entries = projectItem({ ...item, end_day: item.day }, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(false);
    });
  });

  describe("adversarial — date-line geometry and missing times", () => {
    it("eastbound date-line (NRT→LAX): arrival WALL time precedes departure on the SAME date → one row, no split", () => {
      const { item, byId } = flightFixture(DATE_LINE_EASTBOUND.details, "ZG 24 NRT→LAX");
      // Honesty pin: the fixture really is the inverted-wall shape.
      expect(item.end_day).toBeNull();
      expect(item.start_time).toBe("17:00");
      expect(item.end_time).toBe("10:00");
      const entries = projectItem(item, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(false);
      // As-derived, unchanged from before T-7.11 (physics-faithful derivation).
      expect(entries[0]?.timeLabel).toBe("17:00 – 10:00");
    });

    it("arrival wall DATE earlier than departure's (AKL→PPT past midnight): derivation emits no end_day → one row, no split", () => {
      const { item, byId } = flightFixture(ARRIVAL_DATE_BEFORE_DEPARTURE, "TN 102 AKL→PPT");
      expect(item.day).toBe("2027-04-25");
      expect(item.end_day).toBeNull();
      const entries = projectItem(item, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(false);
    });

    it("a hand-written wire-invalid end_day BEFORE day never splits (spanning needs end_day > day)", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const entries = projectItem({ ...item, end_day: "2027-06-09" }, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
    });

    it("NULL ends_at (booking carries no arrival) → one row at the departure time, no split", () => {
      const { item, booking, byId } = flightFixture(NO_ARRIVAL_FLIGHT, "SFO→NRT");
      expect(booking.ends_at).toBeNull();
      expect(item.end_day).toBeNull();
      expect(item.end_time).toBeNull();
      const entries = projectItem(item, byId, LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(false);
      expect(entries[0]?.timeLabel).toBe("23:15");
    });

    it("a spanning flight whose item times were cleared (I-3 item-owned) → 'No time' on each missing edge, same as lodging", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const noArrivalTime = projectItem({ ...item, end_time: null }, byId, LIST);
      expect(noArrivalTime.map((e) => [e.checkpoint, e.timeLabel])).toEqual([
        ["departs", "19:30"],
        ["arrives", "No time"],
      ]);
      const noDepartureTime = projectItem({ ...item, start_time: null }, byId, LIST);
      expect(noDepartureTime.map((e) => [e.checkpoint, e.timeLabel])).toEqual([
        ["departs", "No time"],
        ["arrives", "07:45"],
      ]);
    });

    it("an arrival day OUTSIDE the trip range adds one sparse section carrying the Arrives row (R-itin-45)", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      // Trip ends on the departure day; the flight lands the morning after.
      const rows = buildDayRows({ start_date: "2027-06-10", end_date: "2027-06-10" }, [item], byId);
      expect(rows.map(rowLabel)).toEqual([
        "day:2027-06-10",
        `entry:${FLIGHT_ITEM_ID}-departs`,
        "day:2027-06-11",
        `entry:${FLIGHT_ITEM_ID}-arrives`,
      ]);
    });
  });

  describe("Arrives placement + drag safety (R-itin-36 / R-itin-46 precedent)", () => {
    const TWO_DAYS = { start_date: "2027-06-10", end_date: "2027-06-11" };
    const OWN_ARRIVAL_DAY = "aaaaaaab-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const OWN_DEPARTURE_DAY = "aaaaaaac-aaaa-4aaa-8aaa-aaaaaaaaaaac";

    function twoDayRows() {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178 JFK→LHR");
      const items = [
        item,
        makeItineraryItem({
          id: OWN_ARRIVAL_DAY,
          title: "Borough Market",
          day: "2027-06-11",
          start_time: "09:00",
          // BELOW the flight's own sort_order (1024) on purpose: the Arrives row
          // must lead because it is a leading point row, not because a
          // sort_order/rowKey tie happened to break its way (M7 probe: a
          // tie-break-only placement passed the first draft of this pin).
          sort_order: 512,
        }),
        makeItineraryItem({
          id: OWN_DEPARTURE_DAY,
          title: "Last dinner",
          day: "2027-06-10",
          start_time: "17:00",
          sort_order: 2048,
        }),
      ];
      return buildDayRows(TWO_DAYS, items, byId);
    }

    it("the Arrives row FIRST in its end-day section, ahead of the day's own sort_ordered items", () => {
      expect(twoDayRows().map(rowLabel)).toEqual([
        "day:2027-06-10",
        // Departure day: own items by sort_order — Departs (flight's own
        // sort_order, the fixture default 1024) then Last dinner (2048).
        `entry:${FLIGHT_ITEM_ID}-departs`,
        `entry:${OWN_DEPARTURE_DAY}`,
        "day:2027-06-11",
        `entry:${FLIGHT_ITEM_ID}-arrives`,
        `entry:${OWN_ARRIVAL_DAY}`,
      ]);
    });

    it("an Arrives row leads WITH a lodging check-out, both ahead of the day's own items", () => {
      const { item: flightItem, byId: flightMap } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const hotel = defaultItineraryItems().find((i) => i.id === ITEM_LODGING_ID);
      if (hotel === undefined) throw new Error("fixture missing lodging item");
      // Hotel stay Jun 9 → Jun 11 so its check-out lands on the arrival day.
      const stay = { ...hotel, day: "2027-06-09", end_day: "2027-06-11" };
      const own = makeItineraryItem({
        id: OWN_ARRIVAL_DAY,
        title: "Borough Market",
        day: "2027-06-11",
        sort_order: 512, // below the flight's 1024 — see the pin above
      });
      const byId = new Map([...flightMap, ...bookingsById()]);
      const rows = buildDayRows(
        { start_date: "2027-06-09", end_date: "2027-06-11" },
        [own, stay, flightItem],
        byId,
      );
      const day3 = rows.findIndex((row) => row.type === "day" && row.date === "2027-06-11");
      const labels = rows.slice(day3 + 1).map(rowLabel);
      expect(labels.slice(0, 2).sort()).toEqual(
        [`entry:${FLIGHT_ITEM_ID}-arrives`, `entry:${ITEM_LODGING_ID}-check-out`].sort(),
      );
      expect(labels[2]).toBe(`entry:${OWN_ARRIVAL_DAY}`);
    });

    it("dropping another item onto the arrival day NEVER lists the flight in that day's order PUT", () => {
      const rows = twoDayRows();
      const from = rows.findIndex(
        (row) => row.type === "entry" && row.entry.itemId === OWN_DEPARTURE_DAY,
      );
      const to = rows.length - 1; // past the end of the arrival day
      const drop = resolveDrop(rows, from, to);
      expect(drop.kind).toBe("commit");
      if (drop.kind !== "commit") return;
      expect(drop.day).toBe("2027-06-11");
      // Listing FLIGHT_ITEM_ID here would REASSIGN the flight's day (R-ib-15/16).
      expect(drop.itemIds).not.toContain(FLIGHT_ITEM_ID);
      expect(drop.itemIds).toEqual([OWN_ARRIVAL_DAY, OWN_DEPARTURE_DAY]);
    });

    it("the Arrives row cannot START a drag; the Departs row can", () => {
      const rows = twoDayRows();
      const arrivesAt = rows.findIndex(
        (row) => row.type === "entry" && row.entry.checkpoint === "arrives",
      );
      const departsAt = rows.findIndex(
        (row) => row.type === "entry" && row.entry.checkpoint === "departs",
      );
      // Falsify: make the Arrives row `draggable: true` → each target below goes
      // RED (refused-day-lock / a commit listing the flight twice). NOT index 0:
      // a drop at the very top re-lands on the departure day with an unchanged
      // order, which resolves to "noop" even for a draggable row — a vacuous
      // target that would let the mutation pass.
      const betweenDepartureRows = rows.findIndex(
        (row) => row.type === "entry" && row.entry.itemId === OWN_DEPARTURE_DAY,
      );
      expect(resolveDrop(rows, arrivesAt, betweenDepartureRows)).toEqual({ kind: "noop" });
      expect(resolveDrop(rows, arrivesAt, rows.length - 1)).toEqual({ kind: "noop" });
      // Departs is draggable, but the booking is day-locked: a cross-day drop is refused.
      expect(resolveDrop(rows, departsAt, rows.length - 1).kind).toBe("refused-day-lock");
    });
  });

  describe("R-itin-7 overlap chip belongs to the DEPARTURE day only", () => {
    it("a collision on the departure evening flags Departs, never Arrives", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const clash = makeItineraryItem({
        id: OWN_CLASH_ID,
        title: "Late drinks",
        day: "2027-06-10",
        start_time: "20:00",
        end_time: "21:00",
        sort_order: 2048,
      });
      const items = [item, clash];
      const conflicts = analyzeDayConflicts(items, byId);
      // Precondition: the analysis really does flag the flight (clipped at midnight).
      expect(conflicts.overlappingItemIds.has(FLIGHT_ITEM_ID)).toBe(true);
      const rows = buildDayRows({ start_date: "2027-06-10", end_date: "2027-06-11" }, items, byId, {
        conflicts,
      });
      const overlapOf = (rowKey: string): boolean | undefined => {
        const row = rows.find((r) => r.type === "entry" && r.entry.rowKey === rowKey);
        return row?.type === "entry" ? row.overlapping : undefined;
      };
      expect(overlapOf(`${FLIGHT_ITEM_ID}-departs`)).toBe(true);
      expect(overlapOf(`${OWN_CLASH_ID}`)).toBe(true);
      expect(overlapOf(`${FLIGHT_ITEM_ID}-arrives`)).toBe(false);
    });
  });

  describe("regression — what must NOT change", () => {
    it("lodging rows are byte-identical in list mode vs the default projection", () => {
      const lodging = defaultItineraryItems().find((i) => i.id === ITEM_LODGING_ID);
      if (lodging === undefined) throw new Error("fixture missing lodging item");
      const listed = projectItem(lodging, bookingsById(), LIST);
      expect(listed).toEqual(projectItem(lodging, bookingsById()));
      expect(listed.map((e) => [e.rowKey, e.checkpoint, e.renderDay, e.timeLabel])).toEqual([
        [`${ITEM_LODGING_ID}-check-in`, "check-in", TRIP_START, "15:00"],
        [`${ITEM_LODGING_ID}-check-out`, "check-out", TRIP_END, "11:00"],
      ]);
    });

    it.each(["train", "activity", "other", "car_rental", "moped_rental", "restaurant"] as const)(
      "a spanning %s is NOT split — one row + the +1 chip, in list mode too (R-itin-36 names flight only)",
      (category) => {
        const booking = makeBooking({
          id: FLIGHT_BOOKING_ID,
          category,
          title: `A ${category}`,
          // `category` is the union here, so the literal can't narrow to one
          // BookingDetails member — the cast is the honest spelling.
          details: { category } as BookingDetails,
        });
        const item = makeItineraryItem({
          id: FLIGHT_ITEM_ID,
          kind: "booking",
          booking_id: booking.id,
          title: null,
          day: "2027-06-10",
          end_day: "2027-06-11",
          start_time: "22:00",
          end_time: "06:00",
        });
        const entries = projectItem(item, new Map([[booking.id, booking]]), LIST);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.rowKey).toBe(FLIGHT_ITEM_ID);
        expect(entries[0]?.checkpoint).toBeNull();
        expect(entries[0]?.plusOne).toBe(true);
        expect(entries[0]?.timeLabel).toBe("22:00 – 06:00");
      },
    );

    it("a spanning item with an UNKNOWN parent booking (enrichment gap) fails safe to one row + +1", () => {
      const { item } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const entries = projectItem(item, new Map(), LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.plusOne).toBe(true);
      expect(entries[0]?.checkpoint).toBeNull();
    });

    it("a spanning non-booking (custom) item stays one row + +1", () => {
      const custom = makeItineraryItem({
        id: FLIGHT_ITEM_ID,
        title: "Ferry",
        day: "2027-06-10",
        end_day: "2027-06-11",
        start_time: "22:00",
        end_time: "06:00",
      });
      const entries = projectItem(custom, new Map(), LIST);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.plusOne).toBe(true);
    });
  });

  describe("GRID mode is explicitly UNCHANGED (R-itin-36 — list view only)", () => {
    it("the DEFAULT projection (what grid/model.ts + conflicts.ts call) keeps an overnight flight as ONE row + +1", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      // `entries.length === 2` ⟺ spanning lodging, in BOTH grid/model.ts and
      // conflicts.ts — a flight returning two here would hijack both.
      const entries = projectItem(item, byId);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.checkpoint).toBeNull();
      expect(entries[0]?.plusOne).toBe(true);
      expect(projectItem(item, byId, { listMode: false })).toEqual(entries);
    });

    it("buildGridDays draws the flight as ONE clipped block with a +1 tail — no span lane, no check-in/out indicators", () => {
      const { item, byId } = flightFixture(RED_EYE_JFK_LHR, "BA 178");
      const grid = buildGridDays(
        { start_date: "2027-06-10", end_date: "2027-06-11" },
        [item],
        byId,
      );
      expect(grid.laneCount).toBe(0);
      expect(grid.days.flatMap((day) => day.spans)).toEqual([]);
      const blocks = grid.days.flatMap((day) => day.blocks.map((block) => [day.date, block]));
      expect(blocks).toHaveLength(1);
      const [date, block] = blocks[0] ?? [];
      expect(date).toBe("2027-06-10");
      expect(block).toMatchObject({
        itemId: FLIGHT_ITEM_ID,
        plusOne: true,
        checkpoint: null,
        endMinutes: 24 * 60,
      });
    });

    it("CONTROL: the SAME builder still draws spanning LODGING as a lane + indicators (the assertions above can fail)", () => {
      const grid = buildGridDays(
        TRIP,
        defaultItineraryItems().filter((i) => i.id === ITEM_LODGING_ID),
        bookingsById(),
      );
      expect(grid.days.flatMap((day) => day.spans).length).toBeGreaterThan(0);
      expect(grid.days.flatMap((day) => day.blocks).map((block) => block.checkpoint)).toEqual([
        "check-in",
        "check-out",
      ]);
    });
  });
});
// ---------------------------------------------------------------------------
// T-7.11 round 1 (A1) — Arrives rows anchor no travel-time chip
// ---------------------------------------------------------------------------

describe("[NEEDS CLARIFICATION: T-7.11 Arrives-row travel-time chip]", () => {
  // The spec is silent on which airport a flight's single `place_id` means, and
  // the server chains a spanning item on `end_day` too, so legs touching the
  // Arrives row exist in the composite read. Until Sean rules, an Arrives row
  // is never a chip endpoint — option (b). Options: (a) lodging-parity chips
  // from Arrives (needs a rule for which airport `place_id` means) /
  // (b) suppressed — BUILT. Falsify: delete the `from.checkpoint === "arrives"`
  // guard (from-pin red) or the `to.checkpoint !== "arrives"` clause (to-pin red).
  const TWO_DAYS = { start_date: "2027-06-10", end_date: "2027-06-11" };
  const DEPARTURE_STOP = "aaaaaaae-aaaa-4aaa-8aaa-aaaaaaaaaaae";
  const ARRIVAL_STOP = "aaaaaaaf-aaaa-4aaa-8aaa-aaaaaaaaaaaf";

  /** The red-eye with a `place_id` attached — LOCATED, so the server chains it. */
  function locatedFlight() {
    const { item, booking } = flightFixture(RED_EYE_JFK_LHR, "BA 178 JFK→LHR");
    const located = { ...booking, place_id: PLACE_ID };
    return { item, byId: new Map([[located.id, located]]) };
  }

  function stop(id: string, day: string, sortOrder: number) {
    return makeItineraryItem({
      id,
      kind: "place_visit",
      place_id: PLACE_ID,
      title: null,
      day,
      start_time: "09:00",
      sort_order: sortOrder,
    });
  }

  it("FROM: no chip hangs off the Arrives row (the '42 h drive from the departure airport' scenario); Departs still anchors its chip", () => {
    const { item, byId } = locatedFlight();
    const items = [
      item,
      stop(DEPARTURE_STOP, "2027-06-10", 2048),
      stop(ARRIVAL_STOP, "2027-06-11", 2048),
    ];
    const legs = [
      // CONTROL — a leg from the flight on its DEPARTURE day renders as it always did.
      makeTravelLeg(FLIGHT_ITEM_ID, DEPARTURE_STOP, "driving"),
      // The scenario: the SAME flight → a stop on the ARRIVAL day.
      makeTravelLeg(FLIGHT_ITEM_ID, ARRIVAL_STOP, "driving", {
        duration_seconds: 42 * 3600,
      }),
    ];
    const rows = buildDayRows(TWO_DAYS, items, byId, { legs });
    expect(rows.map(rowLabel)).toEqual([
      "day:2027-06-10",
      `entry:${FLIGHT_ITEM_ID}-departs`,
      `leg:${FLIGHT_ITEM_ID}->${DEPARTURE_STOP}`,
      `entry:${DEPARTURE_STOP}`,
      "day:2027-06-11",
      `entry:${FLIGHT_ITEM_ID}-arrives`,
      `entry:${ARRIVAL_STOP}`,
    ]);
  });

  it("TO: no chip ENDS on the Arrives row (a check-out → flight pair stays absent); a stop → Departs chip still renders", () => {
    const { item: flightItem, byId: flightMap } = locatedFlight();
    const hotel = defaultItineraryItems().find((i) => i.id === ITEM_LODGING_ID);
    if (hotel === undefined) throw new Error("fixture missing lodging item");
    // sort_order 512 < the flight's 1024: the check-out row precedes Arrives on
    // Jun 11, so the pair (hotel → flight) is a forward scan that ends ON Arrives.
    const stay = {
      ...hotel,
      day: "2027-06-09",
      end_day: "2027-06-11",
      sort_order: 512,
    };
    const items = [stay, flightItem, stop(DEPARTURE_STOP, "2027-06-10", 512)];
    const legs = [
      // CONTROL — a stop → Departs leg on the departure day renders as it always did.
      makeTravelLeg(DEPARTURE_STOP, FLIGHT_ITEM_ID, "driving"),
      // The pair: the lodging's check-out row → the flight's Arrives row.
      makeTravelLeg(ITEM_LODGING_ID, FLIGHT_ITEM_ID, "driving"),
    ];
    const byId = new Map([...bookingsById(), ...flightMap]);
    const rows = buildDayRows({ start_date: "2027-06-09", end_date: "2027-06-11" }, items, byId, {
      legs,
    });
    expect(rows.map(rowLabel)).toEqual([
      "day:2027-06-09",
      `entry:${ITEM_LODGING_ID}-check-in`,
      "day:2027-06-10",
      `entry:${DEPARTURE_STOP}`,
      `leg:${DEPARTURE_STOP}->${FLIGHT_ITEM_ID}`,
      `entry:${FLIGHT_ITEM_ID}-departs`,
      "day:2027-06-11",
      `entry:${ITEM_LODGING_ID}-check-out`,
      `entry:${FLIGHT_ITEM_ID}-arrives`,
    ]);
  });
});
