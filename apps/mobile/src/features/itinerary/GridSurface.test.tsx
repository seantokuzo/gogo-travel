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
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { renderWithTheme } from "@/test-utils/render";
import { addDays, makeTrip } from "@/test-utils/trip-fixtures";

import { GridSurface } from "./GridSurface";

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
    // Never a full-height band: no block for the lodging item.
    expect(screen.queryByTestId(`itinerary-grid-item-${ITEM_LODGING_ID}`)).toBeNull();
    // Labeled at the check-in/check-out edges only (§2.6).
    expect(screen.getAllByText("Park Hyatt Tokyo")).toHaveLength(2);
    // Every segment routes to the SAME booking detail.
    await fireEvent.press(screen.getByTestId(`itinerary-grid-span-${ITEM_LODGING_ID}-${TRIP_DAY_2}`));
    expect(handlers.onOpenBooking).toHaveBeenCalledWith(BOOKING_LODGING_ID);
  });

  it("splits overlapping blocks side-by-side with an overlap Badge on each (R-itin-15)", async () => {
    const a = makeItineraryItem({ id: "ov-a", title: "Brunch", start_time: "09:00", end_time: "11:00" });
    const b = makeItineraryItem({ id: "ov-b", title: "Tour", start_time: "10:00", end_time: "12:00" });
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
