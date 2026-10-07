/**
 * GridSurface (T-7.7 / IT-6) — the real calendar grid behind the frozen W4
 * seam. The one assertion that SURVIVED the placeholder era: the root
 * `itinerary-grid-surface` testID (the screen test pins the seam).
 *
 * Coverage map: hour axis + timed blocks (R-itin-13) · gap-tap prefill with
 * 30-min rounding (R-itin-14) · side-by-side overlap split + Badge
 * (R-itin-15) · all-day chips (R-itin-16) · landing column + 08:00 band
 * constants (R-itin-17) · spanning-lodging lane across covered columns,
 * edge-labeled (R-itin-31 grid half, §2.6) · cross-midnight "+1" clip
 * (§2.6) · viewer gap-layer gating (R-ib-24).
 */
import type { TripWithRole } from "@gogo/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Dimensions, FlatList, Pressable, ScrollView } from "react-native";

import { localTodayISO } from "@/navigation/trip-defaults";
import {
  BOOKING_FLIGHT_ID,
  BOOKING_LODGING_ID,
  defaultBookings,
  defaultItineraryItems,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  ITEM_RENTAL_DROPOFF_ID,
  ITEM_RENTAL_PICKUP_ID,
  makeItineraryItem,
  rentalBooking,
  rentalItems,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { renderWithTheme } from "@/test-utils/render";
import { addDays, makeTrip } from "@/test-utils/trip-fixtures";

import { GridSurface } from "./GridSurface";
import {
  COLUMN_FRACTION,
  GUTTER_WIDTH,
  MIN_BLOCK_HEIGHT,
  MIN_COLUMN_WIDTH,
} from "./grid/constants";
import type { GridSurfaceDensity } from "./grid/grid-density";

const trip: TripWithRole = makeTrip({
  id: "trip-1",
  start_date: TRIP_START,
  end_date: TRIP_END,
});

function makeHandlers() {
  return {
    onAddAt: jest.fn(),
    onOpenBooking: jest.fn(),
    onOpenItem: jest.fn(),
  };
}

function bookingsById() {
  return new Map(defaultBookings().map((b) => [b.id, b]));
}

async function renderGrid(
  overrides: Partial<Parameters<typeof GridSurface>[0]> = {},
): Promise<ReturnType<typeof makeHandlers>> {
  const handlers = makeHandlers();
  await renderWithTheme(
    <GridSurface
      trip={trip}
      items={defaultItineraryItems()}
      bookingsById={bookingsById()}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("GridSurface", () => {
  it("keeps the frozen seam root and retires the placeholder", async () => {
    await renderGrid();
    expect(screen.getByTestId("itinerary-grid-surface")).toBeOnTheScreen();
    expect(screen.queryByTestId("itinerary-grid-placeholder")).toBeNull();
  });

  it("renders the shared hour axis (R-itin-13)", async () => {
    await renderGrid();
    expect(screen.getByTestId("itinerary-grid-hours")).toBeOnTheScreen();
    expect(screen.getByText("08:00")).toBeOnTheScreen();
    expect(screen.getByText("23:00")).toBeOnTheScreen();
  });

  it("positions timed items as blocks and routes booking blocks to booking detail", async () => {
    const handlers = await renderGrid();
    const block = screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`);
    expect(block).toBeOnTheScreen();
    await fireEvent.press(block);
    expect(handlers.onOpenBooking).toHaveBeenCalledWith(BOOKING_FLIGHT_ID);
    expect(handlers.onOpenItem).not.toHaveBeenCalled();
  });

  it("positions blocks by wall minutes — top/height derive from start/end (R-itin-13)", async () => {
    await renderGrid();
    // ITEM_A 10:00–12:30 at DEFAULT_HOUR_HEIGHT 60 (1pt/min pre-layout):
    // top = 600, height = 150. Round-1 blocking pin — a `top = 0` mutation
    // previously left the whole suite green.
    expect(screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`)).toHaveStyle({
      top: 600,
      height: 150,
    });
  });

  it("captions a rental's derived blocks Pickup / Drop off — and nothing else (B-18)", async () => {
    await renderGrid({
      items: [...defaultItineraryItems(), ...rentalItems()],
      bookingsById: new Map([...defaultBookings(), rentalBooking()].map((b) => [b.id, b])),
    });
    // Two blocks, one booking title — the caption is the discriminator.
    expect(
      screen.getByTestId(`itinerary-grid-item-${ITEM_RENTAL_PICKUP_ID}-subtext`),
    ).toHaveTextContent("Pickup");
    expect(
      screen.getByTestId(`itinerary-grid-item-${ITEM_RENTAL_DROPOFF_ID}-subtext`),
    ).toHaveTextContent("Drop off");
    // R1: the a11y label carries the discriminator on the grid surface too.
    expect(
      screen.getByTestId(`itinerary-grid-item-${ITEM_RENTAL_PICKUP_ID}`).props.accessibilityLabel,
    ).toBe("Toyota Rent a Car Pickup");
    // CONTROL: a non-derived booking block renders no caption element.
    expect(screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`itinerary-grid-item-${ITEM_A_ID}-subtext`)).toBeNull();
  });

  it("floors tiny blocks at MIN_BLOCK_HEIGHT so they stay readable/tappable", async () => {
    const tiny = makeItineraryItem({
      id: "tiny-1",
      title: "Espresso",
      start_time: "09:00",
      end_time: "09:05",
    });
    await renderGrid({ items: [tiny] });
    // True span is 5pt at 1pt/min — the render floor takes over; top stays exact.
    expect(screen.getByTestId("itinerary-grid-item-tiny-1")).toHaveStyle({
      top: 540,
      height: MIN_BLOCK_HEIGHT,
    });
  });

  it("fits the 08:00–20:00 band to the measured viewport and lands at 08:00 (R-itin-17)", async () => {
    const scrollSpy = jest.spyOn(ScrollView.prototype, "scrollTo");
    await renderGrid();
    await fireEvent(screen.getByTestId("itinerary-grid-scroll"), "layout", {
      nativeEvent: { layout: { x: 0, y: 0, width: 375, height: 528 } },
    });
    // 528pt viewport / 12 visible hours = 44pt rows (the MIN clamp edge);
    // the landing effect scrolls the shared axis to 08:00 exactly once.
    expect(scrollSpy).toHaveBeenCalledWith({ y: 8 * 44, animated: false });
    // Block geometry re-derives from the fitted hour height (44/60 pt/min).
    expect(screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`)).toHaveStyle({
      top: 600 * (44 / 60),
      height: 150 * (44 / 60),
    });
    scrollSpy.mockRestore();
  });

  it("keeps the pinned header strip in lockstep with the day pager", async () => {
    const offsetSpy = jest.spyOn(FlatList.prototype, "scrollToOffset");
    await renderGrid();
    await fireEvent.scroll(screen.getByTestId("itinerary-grid-pager"), {
      nativeEvent: { contentOffset: { x: 123, y: 0 } },
    });
    expect(offsetSpy).toHaveBeenCalledWith({ offset: 123, animated: false });
    offsetSpy.mockRestore();
  });

  it("routes non-booking blocks to item detail (R-itin-27)", async () => {
    const timedCustom = makeItineraryItem({
      id: "custom-timed",
      title: "Museum",
      start_time: "14:00",
      end_time: "15:00",
    });
    const handlers = await renderGrid({ items: [timedCustom] });
    await fireEvent.press(screen.getByTestId("itinerary-grid-item-custom-timed"));
    expect(handlers.onOpenItem).toHaveBeenCalledWith("custom-timed");
    expect(handlers.onOpenBooking).not.toHaveBeenCalled();
  });

  it("leaves empty ranges as tappable gap slots — 24 per day column (R-itin-14)", async () => {
    await renderGrid();
    const day2Slots = screen.getAllByTestId(new RegExp(`itinerary-grid-slot-${TRIP_DAY_2}-`));
    expect(day2Slots).toHaveLength(24);
  });

  it("gap tap prefills the day and the slot's half-hour (R-itin-14)", async () => {
    const handlers = await renderGrid();
    const slot = screen.getByTestId(`itinerary-grid-slot-${TRIP_DAY_2}-10`);
    // Default hour height is 60pt pre-layout: 10pt into the row = top half.
    await fireEvent.press(slot, { nativeEvent: { locationY: 10 } });
    expect(handlers.onAddAt).toHaveBeenCalledWith(TRIP_DAY_2, "10:00");
    await fireEvent.press(slot, { nativeEvent: { locationY: 45 } });
    expect(handlers.onAddAt).toHaveBeenCalledWith(TRIP_DAY_2, "10:30");
  });

  it("prefills :00 when the press event carries no location", async () => {
    const handlers = await renderGrid();
    await fireEvent.press(screen.getByTestId(`itinerary-grid-slot-${TRIP_DAY_2}-07`));
    expect(handlers.onAddAt).toHaveBeenCalledWith(TRIP_DAY_2, "07:00");
  });

  it("renders untimed items as all-day chips that route like their kind (R-itin-16)", async () => {
    const handlers = await renderGrid();
    const chip = screen.getByTestId(`itinerary-grid-allday-${ITEM_B_ID}`);
    expect(chip).toBeOnTheScreen();
    await fireEvent.press(chip);
    expect(handlers.onOpenItem).toHaveBeenCalledWith(ITEM_B_ID);
    // place_visit chip on the last day rides the same lane.
    expect(screen.getByTestId(`itinerary-grid-allday-${ITEM_C_ID}`)).toBeOnTheScreen();
  });

  it("renders spanning lodging as ONE lane across covered columns, edge-labeled (R-itin-31)", async () => {
    const handlers = await renderGrid();
    for (const date of [TRIP_START, TRIP_DAY_2, TRIP_END]) {
      expect(
        screen.getByTestId(`itinerary-grid-span-${ITEM_LODGING_ID}-${date}`),
      ).toBeOnTheScreen();
    }
    // Never a full-height band: no UNQUALIFIED block for the lodging item
    // (the B-12 checkpoint indicators below are the only timed-grid render).
    expect(screen.queryByTestId(`itinerary-grid-item-${ITEM_LODGING_ID}`)).toBeNull();
    // Labeled at the check-in/check-out edges only (§2.6).
    expect(screen.getAllByText("Park Hyatt Tokyo")).toHaveLength(2);
    // Every segment routes to the SAME booking detail.
    await fireEvent.press(
      screen.getByTestId(`itinerary-grid-span-${ITEM_LODGING_ID}-${TRIP_DAY_2}`),
    );
    expect(handlers.onOpenBooking).toHaveBeenCalledWith(BOOKING_LODGING_ID);
  });

  it("draws derived check-in/check-out indicators at the real times, routing like the span (B-12)", async () => {
    const handlers = await renderGrid();
    // Default lodging: check-in 15:00 on TRIP_START, check-out 11:00 on
    // TRIP_END. At DEFAULT_HOUR_HEIGHT (1pt/min) a 15-min indicator's true
    // span is 15pt — the MIN_BLOCK_HEIGHT floor keeps it tappable, which IS
    // the "~15-min-item size" ask.
    const checkIn = screen.getByTestId(`itinerary-grid-item-${ITEM_LODGING_ID}-check-in`);
    expect(checkIn).toHaveStyle({ top: 900, height: MIN_BLOCK_HEIGHT });
    expect(screen.getByTestId(`itinerary-grid-item-${ITEM_LODGING_ID}-check-out`)).toHaveStyle({
      top: 660,
      height: MIN_BLOCK_HEIGHT,
    });
    expect(screen.getByText("Check-in")).toBeOnTheScreen();
    expect(screen.getByText("Check-out")).toBeOnTheScreen();
    // Same destination as the all-day lane segment — booking detail.
    await fireEvent.press(checkIn);
    expect(handlers.onOpenBooking).toHaveBeenCalledWith(BOOKING_LODGING_ID);
    expect(handlers.onOpenItem).not.toHaveBeenCalled();
  });

  it("splits overlapping blocks side-by-side with an overlap Badge on each (R-itin-15)", async () => {
    const a = makeItineraryItem({
      id: "ov-a",
      title: "Brunch",
      start_time: "09:00",
      end_time: "11:00",
    });
    const b = makeItineraryItem({
      id: "ov-b",
      title: "Tour",
      start_time: "10:00",
      end_time: "12:00",
    });
    await renderGrid({ items: [a, b] });
    expect(screen.getByTestId("itinerary-grid-item-ov-a")).toHaveStyle({ width: "50%" });
    expect(screen.getByTestId("itinerary-grid-item-ov-b")).toHaveStyle({ width: "50%" });
    expect(screen.getAllByText("Overlap")).toHaveLength(2);
  });

  it("clips a cross-midnight span at midnight with a +1 tail (§2.6)", async () => {
    const redEye = makeItineraryItem({
      id: "red-eye",
      kind: "booking",
      booking_id: BOOKING_FLIGHT_ID,
      title: null,
      day: TRIP_START,
      end_day: TRIP_DAY_2,
      start_time: "22:00",
      end_time: "06:15",
    });
    await renderGrid({ items: [redEye] });
    expect(screen.getByTestId("itinerary-grid-item-red-eye")).toBeOnTheScreen();
    expect(screen.getByText("+1")).toBeOnTheScreen();
  });

  it("lands on the first day when today is outside the trip (R-itin-17)", async () => {
    await renderGrid();
    expect(screen.getByTestId("itinerary-grid-pager").props.initialScrollIndex).toBe(0);
  });

  it("lands on today's column when today is in range (R-itin-17)", async () => {
    const today = localTodayISO();
    const activeTrip = makeTrip({
      id: "trip-live",
      start_date: addDays(today, -1),
      end_date: addDays(today, 1),
    });
    await renderGrid({ trip: activeTrip, items: [] });
    expect(screen.getByTestId("itinerary-grid-pager").props.initialScrollIndex).toBe(1);
  });

  it("pages day columns on a virtualized horizontal list (never ScrollView+map)", async () => {
    await renderGrid();
    const pager = screen.getByTestId("itinerary-grid-pager");
    expect(pager.props.horizontal).toBe(true);
    expect(typeof pager.props.snapToInterval).toBe("number");
    expect(pager.props.snapToInterval).toBeGreaterThan(0);
  });

  describe("viewer gating (R-ib-24)", () => {
    const viewerTrip: TripWithRole = makeTrip({
      id: "trip-1",
      start_date: TRIP_START,
      end_date: TRIP_END,
      role: "viewer",
    });

    it("renders NO gap-tap affordance for viewers", async () => {
      const handlers = await renderGrid({ trip: viewerTrip });
      expect(screen.queryAllByTestId(/itinerary-grid-slot-/)).toHaveLength(0);
      expect(handlers.onAddAt).not.toHaveBeenCalled();
    });

    it("keeps read affordances — blocks still open detail for viewers", async () => {
      const handlers = await renderGrid({ trip: viewerTrip });
      await fireEvent.press(screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`));
      expect(handlers.onOpenBooking).toHaveBeenCalledWith(BOOKING_FLIGHT_ID);
    });
  });
});

/**
 * Density (T-7.13, R-itin-33/34) — the `density` prop varies ONLY the
 * simultaneous day-column count/width; the hour timeline is untouched.
 *
 * Expectations are computed from the SPEC'S arithmetic here, never through
 * `gridColumnLayout` (that would be the module grading itself). The jest
 * window is `Dimensions.get("window")`; the pager is that minus the gutter.
 *
 * What change makes these red (mutation-verified in the PR body):
 * - collapsing the density branching to the single COLUMN_FRACTION width →
 *   every 3-day / Trip-span width + visible-column pin;
 * - `snap` always true → the Trip-span continuous-scroll pin;
 * - dropping `key={density}` → the re-landing pin;
 * - dropping the landing clamp → the last-day landing pins;
 * - a constant `initialNumToRender` → the Trip-span "every day at once" pin.
 */
describe("GridSurface density (R-itin-33/34)", () => {
  const WINDOW_WIDTH = Dimensions.get("window").width;
  const PAGER = WINDOW_WIDTH - GUTTER_WIDTH;

  /** A trip of exactly `count` days starting at the fixture TRIP_START. */
  function tripOfDays(count: number): TripWithRole {
    return makeTrip({
      id: `trip-${count}d`,
      start_date: TRIP_START,
      end_date: addDays(TRIP_START, count - 1),
    });
  }

  function pager() {
    return screen.getByTestId("itinerary-grid-pager");
  }

  /** The width the surface lays ONE day column out at (header strip + pager share it). */
  function columnWidth(): number {
    const header = screen.getByTestId("itinerary-grid-allday-lane").props.getItemLayout;
    const body = pager().props.getItemLayout;
    const fromHeader = header(null, 0).length as number;
    // The strip and the pager must never disagree (two FlatLists, one width).
    expect(body(null, 0).length).toBe(fromHeader);
    return fromHeader;
  }

  /** Whole day columns that fit the pager at once. */
  const visibleColumns = () => Math.floor(PAGER / columnWidth());

  function dayHeaders() {
    return screen.queryAllByTestId(/^itinerary-grid-day-/);
  }

  /** Re-renders the SAME mounted surface with a new density (a real prop change). */
  function DensityHarness({
    initial,
    trip: harnessTrip,
  }: {
    initial: GridSurfaceDensity;
    trip: TripWithRole;
  }) {
    const [density, setDensity] = useState<GridSurfaceDensity>(initial);
    const [, setRenders] = useState(0);
    return (
      <>
        <Pressable testID="harness-rerender" onPress={() => setRenders((n) => n + 1)} />
        <Pressable testID="harness-density-trip-span" onPress={() => setDensity("trip-span")} />
        <Pressable testID="harness-density-3-day" onPress={() => setDensity("3-day")} />
        <Pressable testID="harness-density-day" onPress={() => setDensity("day")} />
        <GridSurface
          trip={harnessTrip}
          density={density}
          items={[]}
          bookingsById={new Map()}
          {...makeHandlers()}
        />
      </>
    );
  }

  describe("happy — each density renders its column count", () => {
    it("Day: one column plus a neighbor peek, page-snapped", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [], density: "day" });
      expect(columnWidth()).toBe(Math.round(PAGER * COLUMN_FRACTION));
      expect(visibleColumns()).toBe(1);
      expect(columnWidth()).toBeLessThan(PAGER); // the peek
      expect(pager().props.snapToInterval).toBe(columnWidth());
    });

    it("3-day: three columns share the pager — no peek, still page-snapped per column", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [], density: "3-day" });
      expect(columnWidth()).toBe(Math.floor(PAGER / 3));
      expect(visibleColumns()).toBe(3);
      expect(columnWidth() * 3).toBeLessThanOrEqual(PAGER);
      expect(pager().props.snapToInterval).toBe(columnWidth());
      // Every one of the three on-screen columns is painted in the first frame.
      expect(screen.getAllByTestId(/^itinerary-grid-slot-.*-10$/).length).toBeGreaterThanOrEqual(3);
    });

    it("Trip-span: EVERY day of a 7-day trip is on screen at once, no scroll needed", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [], density: "trip-span" });
      expect(columnWidth()).toBe(Math.floor(PAGER / 7));
      expect(visibleColumns()).toBe(7);
      // All seven day headers AND all seven pager columns are mounted in the
      // first frame (the first paint covers every on-screen column — no
      // blank columns). The pager's window is its own `initialNumToRender`,
      // separate from the header strip's, so it gets its own pin.
      expect(dayHeaders()).toHaveLength(7);
      expect(screen.getAllByTestId(/^itinerary-grid-slot-.*-10$/)).toHaveLength(7);
      expect(columnWidth() * 7).toBeLessThanOrEqual(PAGER);
    });

    it("the three densities lay the SAME trip out at three different widths", async () => {
      const widths: number[] = [];
      for (const density of ["day", "3-day", "trip-span"] as const) {
        await renderGrid({ trip: tripOfDays(7), items: [], density });
        widths.push(columnWidth());
        await screen.unmount();
      }
      expect(new Set(widths).size).toBe(3);
    });

    it("renders the column at the width it advertises (the rendered View, not just getItemLayout)", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [], density: "3-day" });
      const slot = screen.getByTestId(`itinerary-grid-slot-${TRIP_START}-10`);
      expect(slot.parent).toHaveStyle({ width: Math.floor(PAGER / 3) });
    });
  });

  describe("boundary", () => {
    it("a 1-day trip in Trip-span is ONE full-width column", async () => {
      await renderGrid({ trip: tripOfDays(1), items: [], density: "trip-span" });
      expect(dayHeaders()).toHaveLength(1);
      expect(columnWidth()).toBe(PAGER);
      expect(pager().props.snapToInterval).toBeUndefined();
      expect(screen.getByTestId(`itinerary-grid-slot-${TRIP_START}-10`).parent).toHaveStyle({
        width: PAGER,
      });
    });

    it("a 60-day trip in Trip-span does not crash and holds the floor width (bounded, scrolls)", async () => {
      await renderGrid({ trip: tripOfDays(60), items: [], density: "trip-span" });
      expect(columnWidth()).toBe(MIN_COLUMN_WIDTH);
      // Past the floor the content is wider than the pager ⇒ horizontal scroll.
      const layout = pager().props.getItemLayout;
      expect(layout(null, 59)).toEqual({
        length: MIN_COLUMN_WIDTH,
        offset: MIN_COLUMN_WIDTH * 59,
        index: 59,
      });
      expect(MIN_COLUMN_WIDTH * 60).toBeGreaterThan(PAGER);
      expect(pager().props.horizontal).toBe(true);
      expect(pager().props.scrollEnabled).not.toBe(false);
      // Continuous scroll — no page-snap — once the trip outgrows the floor.
      expect(pager().props.snapToInterval).toBeUndefined();
    });

    it("a 60-day trip is virtualized, not mounted wholesale (never ScrollView + map)", async () => {
      await renderGrid({ trip: tripOfDays(60), items: [], density: "trip-span" });
      // Header strip (its own FlatList)…
      expect(dayHeaders().length).toBeGreaterThan(0);
      expect(dayHeaders().length).toBeLessThan(60);
      // …AND the pager, which is the heavy list (24 slot Pressables per
      // column) and has its own windowing props — the header count alone
      // cannot see the pager mounting everything (round-1 probe 6d).
      const pagerColumns = screen.queryAllByTestId(/^itinerary-grid-slot-.*-10$/);
      expect(pagerColumns.length).toBeGreaterThan(0);
      expect(pagerColumns.length).toBeLessThan(60);
    });

    it("Trip-span stays continuous on a trip that fits too (no snap at any length)", async () => {
      await renderGrid({ trip: tripOfDays(3), items: [], density: "trip-span" });
      expect(pager().props.snapToInterval).toBeUndefined();
    });

    it("3-day on a 1-day trip does not crash and keeps the third-width column", async () => {
      await renderGrid({ trip: tripOfDays(1), items: [], density: "3-day" });
      expect(dayHeaders()).toHaveLength(1);
      expect(columnWidth()).toBe(Math.floor(PAGER / 3));
      expect(pager().props.initialScrollIndex).toBe(0);
    });

    it("an empty item list in every density still renders the full hour timeline", async () => {
      for (const density of ["day", "3-day", "trip-span"] as const) {
        await renderGrid({ trip: tripOfDays(3), items: [], density });
        expect(screen.getByTestId("itinerary-grid-hours")).toBeOnTheScreen();
        expect(screen.getByText("08:00")).toBeOnTheScreen();
        await screen.unmount();
      }
    });
  });

  describe("landing (R-itin-17 per density)", () => {
    const today = localTodayISO();
    const liveTrip = (daysBefore: number, daysAfter: number): TripWithRole =>
      makeTrip({
        id: `trip-live-${daysBefore}-${daysAfter}`,
        start_date: addDays(today, -daysBefore),
        end_date: addDays(today, daysAfter),
      });

    it("lands on today's column in the middle of a trip, in every density", async () => {
      for (const density of ["day", "3-day", "trip-span"] as const) {
        await renderGrid({ trip: liveTrip(20, 20), items: [], density });
        const expected = Math.min(20, 41 - visibleColumns());
        expect(pager().props.initialScrollIndex).toBe(expected);
        expect(screen.getByTestId("itinerary-grid-allday-lane").props.initialScrollIndex).toBe(
          expected,
        );
        await screen.unmount();
      }
    });

    it("3-day: today = the LAST day lands on the last full window, today still on screen", async () => {
      await renderGrid({ trip: liveTrip(9, 0), items: [], density: "3-day" });
      // 10 days, today is index 9 — a window starting there would be 2/3 blank.
      expect(pager().props.initialScrollIndex).toBe(7);
    });

    it("Day: today = the last day still lands ON it (unchanged behavior)", async () => {
      await renderGrid({ trip: liveTrip(9, 0), items: [], density: "day" });
      expect(pager().props.initialScrollIndex).toBe(9);
    });

    it("Trip-span that fits lands at the first column (nothing to scroll to)", async () => {
      await renderGrid({ trip: liveTrip(9, 0), items: [], density: "trip-span" });
      expect(pager().props.initialScrollIndex).toBe(0);
    });

    // NATIVE-CLAMP DEPENDENCY: this pins the JS-side WHOLE-column clamp
    // (`60 - visibleColumns`), which overshoots the true max scroll offset by
    // the partial column whenever the pager isn't a multiple of the column
    // width (390pt/60 days: landing offset 2332 vs max 2298). The device is
    // right only because the platform ScrollView clamps a programmatic scroll
    // to its content bounds (iOS Fabric `RCTScrollViewComponentView.mm`
    // `scrollTo:`), leaving the leftmost column partial (34pt of 44pt here —
    // cosmetic). Jest can't see that clamp; see `clampLandingIndex`'s docstring.
    it("Trip-span past the floor: today = the last day lands on the last full window", async () => {
      await renderGrid({ trip: liveTrip(59, 0), items: [], density: "trip-span" });
      expect(pager().props.initialScrollIndex).toBe(60 - visibleColumns());
    });
  });

  describe("regression — the default prop changes nothing", () => {
    // The pre-T-7.13 literals, frozen here: if the default drifts, THESE go red.
    it("omitting `density` is exactly `day`, at the legacy geometry", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [] });
      const legacy = Math.max(1, Math.round((WINDOW_WIDTH - GUTTER_WIDTH) * COLUMN_FRACTION));
      expect(columnWidth()).toBe(legacy);
      expect(pager().props.snapToInterval).toBe(legacy);
      expect(pager().props.decelerationRate).toBe("fast");
      expect(pager().props.disableIntervalMomentum).toBe(true);
      expect(pager().props.initialNumToRender).toBe(3);
      expect(pager().props.maxToRenderPerBatch).toBe(3);
      expect(pager().props.windowSize).toBe(5);
    });

    it("explicit `day` renders the same pager props as omitting it", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [] });
      const omitted = pager().props;
      const pick = (props: typeof omitted) => ({
        width: props.getItemLayout(null, 0).length,
        snap: props.snapToInterval,
        decel: props.decelerationRate,
        momentum: props.disableIntervalMomentum,
        initial: props.initialNumToRender,
        batch: props.maxToRenderPerBatch,
        index: props.initialScrollIndex,
      });
      const before = pick(omitted);
      await screen.unmount();
      await renderGrid({ trip: tripOfDays(7), items: [], density: "day" });
      expect(pick(pager().props)).toEqual(before);
    });

    it("the hour timeline is density-blind — blocks sit at the same top/height in every density", async () => {
      for (const density of ["day", "3-day", "trip-span"] as const) {
        await renderGrid({ density });
        expect(screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`)).toHaveStyle({
          top: 600,
          height: 150,
        });
        expect(
          screen.getAllByTestId(new RegExp(`itinerary-grid-slot-${TRIP_DAY_2}-`)),
        ).toHaveLength(24);
        await screen.unmount();
      }
    });
  });

  describe("switching density on a mounted surface (R-itin-34 re-landing)", () => {
    it("re-derives column width, snap, and the first-paint window from the new density", async () => {
      await renderWithTheme(<DensityHarness initial="day" trip={tripOfDays(7)} />);
      expect(columnWidth()).toBe(Math.round(PAGER * COLUMN_FRACTION));
      await fireEvent.press(screen.getByTestId("harness-density-trip-span"));
      expect(columnWidth()).toBe(Math.floor(PAGER / 7));
      expect(pager().props.snapToInterval).toBeUndefined();
      expect(dayHeaders()).toHaveLength(7);
      await fireEvent.press(screen.getByTestId("harness-density-3-day"));
      expect(columnWidth()).toBe(Math.floor(PAGER / 3));
      expect(pager().props.snapToInterval).toBe(columnWidth());
    });

    // Remount probe: a queried host element keeps its identity across plain
    // re-renders (react-test-renderer caches the wrapper per fiber, alternate
    // included) and changes when React mounts a NEW fiber — so identity
    // separates "re-rendered" from "remounted". The CONTROL pin proves the
    // probe can tell the two apart before the remount pin leans on it.
    it("CONTROL: a plain re-render keeps the day lists mounted (the probe can see 'not remounted')", async () => {
      await renderWithTheme(<DensityHarness initial="day" trip={tripOfDays(7)} />);
      const pagerBefore = pager();
      const stripBefore = screen.getByTestId("itinerary-grid-allday-lane");
      await fireEvent.press(screen.getByTestId("harness-rerender"));
      expect(pager()).toBe(pagerBefore);
      expect(screen.getByTestId("itinerary-grid-allday-lane")).toBe(stripBefore);
    });

    it("remounts BOTH day lists on a density change — no scroll offset is carried across widths", async () => {
      await renderWithTheme(<DensityHarness initial="day" trip={tripOfDays(7)} />);
      const pagerBefore = pager();
      const stripBefore = screen.getByTestId("itinerary-grid-allday-lane");
      await fireEvent.press(screen.getByTestId("harness-density-3-day"));
      expect(pager()).not.toBe(pagerBefore);
      expect(screen.getByTestId("itinerary-grid-allday-lane")).not.toBe(stripBefore);
    });

    it("re-landing follows the new density's rule (Day lands ON the last day, 3-day clamps)", async () => {
      const live = makeTrip({
        id: "trip-switch",
        start_date: addDays(localTodayISO(), -9),
        end_date: localTodayISO(),
      });
      await renderWithTheme(<DensityHarness initial="day" trip={live} />);
      expect(pager().props.initialScrollIndex).toBe(9);
      await fireEvent.press(screen.getByTestId("harness-density-3-day"));
      expect(pager().props.initialScrollIndex).toBe(7);
    });

    it("the vertical hour scroller is NOT remounted by a density change (hour timeline unchanged)", async () => {
      await renderWithTheme(<DensityHarness initial="day" trip={tripOfDays(7)} />);
      const before = screen.getByTestId("itinerary-grid-scroll");
      await fireEvent.press(screen.getByTestId("harness-density-trip-span"));
      // The shared vertical scroller keeps its identity — only the two
      // horizontal day lists remount (a remount would drop the 08:00 landing).
      expect(screen.getByTestId("itinerary-grid-scroll")).toBe(before);
    });
  });

  describe("a11y — columns stay reachable in every density (R-itin-30)", () => {
    it("Trip-span: every day's 10:00 slot is on screen at once with a distinct accessible label", async () => {
      await renderGrid({ trip: tripOfDays(7), items: [], density: "trip-span" });
      const slots = screen.getAllByRole("button", { name: /^Add on .* at 10:00$/ });
      expect(slots).toHaveLength(7);
      const labels = slots.map((slot) => slot.props.accessibilityLabel);
      expect(new Set(labels).size).toBe(7);
      expect(labels[0]).toBe(`Add on ${TRIP_START} at 10:00`);
      expect(labels[6]).toBe(`Add on ${addDays(TRIP_START, 6)} at 10:00`);
    });

    it("a block keeps its accessible name in every density (density never relabels content)", async () => {
      // Baseline = the density-less default render (pre-T-7.13 behavior).
      await renderGrid();
      const baseline = screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`).props
        .accessibilityLabel as string;
      expect(baseline.length).toBeGreaterThan(0);
      await screen.unmount();
      for (const density of ["day", "3-day", "trip-span"] as const) {
        await renderGrid({ density });
        expect(
          screen.getByTestId(`itinerary-grid-item-${ITEM_A_ID}`).props.accessibilityLabel,
        ).toBe(baseline);
        await screen.unmount();
      }
    });

    it("Trip-span, 60 days: the LAST day is unreachable until scrolled to, then reachable (can-reach-item-N)", async () => {
      await renderGrid({ trip: tripOfDays(60), items: [], density: "trip-span" });
      const lastDate = addDays(TRIP_START, 59);
      // The probe can find the thing only if it can also find its absence:
      // before scrolling, day 60's column is virtualized away…
      expect(screen.queryByTestId(`itinerary-grid-slot-${lastDate}-10`)).toBeNull();
      const contentWidth = MIN_COLUMN_WIDTH * 60;
      await fireEvent(pager(), "layout", {
        nativeEvent: { layout: { x: 0, y: 0, width: PAGER, height: 800 } },
      });
      await fireEvent(pager(), "contentSizeChange", contentWidth, 800);
      await fireEvent.scroll(pager(), {
        nativeEvent: {
          contentOffset: { x: contentWidth - PAGER, y: 0 },
          contentSize: { width: contentWidth, height: 800 },
          layoutMeasurement: { width: PAGER, height: 800 },
        },
      });
      // …and the scroll windowing brings its tappable column on screen. The
      // anchor is the PAGER's slot, not the day label: the label lives in the
      // header strip, which only follows via a native `scrollToOffset` that
      // jest never turns into scroll events (existing T-7.7 behavior).
      // VirtualizedList renders the new window on a batching timer → findBy.
      expect(await screen.findByTestId(`itinerary-grid-slot-${lastDate}-10`)).toBeOnTheScreen();
    });

    it("viewers still get NO gap-tap slots in the multi-column densities (R-ib-24 holds)", async () => {
      const viewer = makeTrip({
        id: "trip-viewer-span",
        start_date: TRIP_START,
        end_date: addDays(TRIP_START, 6),
        role: "viewer",
      });
      for (const density of ["3-day", "trip-span"] as const) {
        await renderGrid({ trip: viewer, items: [], density });
        expect(screen.queryAllByTestId(/itinerary-grid-slot-/)).toHaveLength(0);
        await screen.unmount();
      }
    });
  });
});
