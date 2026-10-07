/**
 * ItineraryDayList — overnight flight Departs/Arrives rows (T-7.11, R-itin-36;
 * a11y R-itin-30). The REAL list over rows from the REAL `buildDayRows`, so a
 * fault anywhere between the projection and the pixels fails here.
 *
 * Coverage map: both rows render under their own day with the LOCAL wall time
 * and their own caption · each row reaches VoiceOver as a DISTINCT element
 * naming its leg (the container label suppresses the Badge subtree, B-23) ·
 * both route to ONE booking · only Departs lifts for a drag · a same-day
 * flight is untouched · lodging rows are untouched · GRID mode (a flight,
 * specifically) still draws one clipped block with a "+1" tail.
 *
 * File-scope fake timers + `settleFake`: the real reorderable list leaves
 * VirtualizedList's 50 ms cell batch pending (the itinerary-screen suite's
 * B-22 mechanism) — advanced only inside act, so no floating-act race.
 */
import {
  deriveAutoItems,
  deriveBookingInstants,
  type FlightDetails,
  type ItineraryItem,
} from "@gogo/shared";
import { localISO, NAIVE_CONTROL_FLIGHT } from "@gogo/shared/testing";
import { fireEvent, screen, within } from "@testing-library/react-native";

import {
  defaultBookings,
  defaultItineraryItems,
  ITEM_LODGING_ID,
  makeBooking,
  makeItineraryItem,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { renderWithTheme } from "@/test-utils/render";
import { settleFake as settle } from "@/test-utils/settle";
import { makeTrip } from "@/test-utils/trip-fixtures";
import { triggerHaptic } from "@/theme/haptics";

import { GridSurface } from "./GridSurface";
import { ItineraryDayList } from "./ItineraryDayList";
import { buildDayRows, type DayEntry } from "./model";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

jest.useFakeTimers();

const FLIGHT_ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLIGHT_BOOKING_ID = "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
const FLIGHT_TITLE = "BA 178 JFK→LHR";

/** JFK → LHR red-eye: depart Jun 10 19:30 EDT, land Jun 11 07:45 BST. */
const RED_EYE: FlightDetails = {
  category: "flight",
  origin_iata: "JFK",
  destination_iata: "LHR",
  departs_at: localISO("2027-06-10", "19:30", "-04:00"),
  departs_tz: "America/New_York",
  arrives_at: localISO("2027-06-11", "07:45", "+01:00"),
  arrives_tz: "Europe/London",
};

const OVERNIGHT_TRIP = { start_date: "2027-06-10", end_date: "2027-06-11" };

/** Flight booking + its §3.3-derived item — what the server would write. */
function flight(details: FlightDetails, title = FLIGHT_TITLE) {
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
  const item: ItineraryItem = makeItineraryItem({
    id: FLIGHT_ITEM_ID,
    kind: "booking",
    booking_id: booking.id,
    title: null,
    ...placement,
  });
  return { booking, item, byId: new Map([[booking.id, booking]]) };
}

async function renderList(rows: ReturnType<typeof buildDayRows>) {
  const handlers = {
    onReorder: jest.fn(),
    onOpenEntry: jest.fn<void, [DayEntry]>(),
    onAddToDay: jest.fn(),
    onOpenLeg: jest.fn(),
  };
  await renderWithTheme(<ItineraryDayList rows={rows} dragEnabled {...handlers} />);
  await settle();
  return handlers;
}

async function renderOvernight() {
  const { item, byId } = flight(RED_EYE);
  return renderList(buildDayRows(OVERNIGHT_TRIP, [item], byId));
}

const departsId = `itinerary-list-item-${FLIGHT_ITEM_ID}-departs`;
const arrivesId = `itinerary-list-item-${FLIGHT_ITEM_ID}-arrives`;

describe("ItineraryDayList — overnight flight rows (T-7.11, R-itin-36)", () => {
  beforeEach(() => {
    jest.mocked(triggerHaptic).mockClear();
  });

  it("happy: Departs and Arrives both render, each under its own day, at its LOCAL wall time", async () => {
    await renderOvernight();
    expect(screen.getByTestId(departsId)).toBeOnTheScreen();
    expect(screen.getByTestId(arrivesId)).toBeOnTheScreen();
    // The bare itemId testID is the UN-split row's — it must not exist here.
    expect(screen.queryByTestId(`itinerary-list-item-${FLIGHT_ITEM_ID}`)).toBeNull();
    // Each row carries ITS OWN caption + local wall time (19:30 in New York,
    // 07:45 in London) — scoped `within` the row, so a swapped caption or a
    // time on the wrong row cannot hide behind the other row's text.
    const departs = within(screen.getByTestId(departsId));
    expect(departs.getByText("Departs")).toBeOnTheScreen();
    expect(departs.getByText("19:30")).toBeOnTheScreen();
    expect(departs.queryByText("Arrives")).toBeNull();
    const arrives = within(screen.getByTestId(arrivesId));
    expect(arrives.getByText("Arrives")).toBeOnTheScreen();
    expect(arrives.getByText("07:45")).toBeOnTheScreen();
    expect(arrives.queryByText("Departs")).toBeNull();
    // Under the right day headers: Departs after Jun 10's, Arrives after Jun 11's.
    expect(
      screen
        .getAllByTestId(/^itinerary-(day-header-\d|list-item-)/)
        .map((node) => node.props.testID),
    ).toEqual([
      "itinerary-day-header-2027-06-10",
      departsId,
      "itinerary-day-header-2027-06-11",
      arrivesId,
    ]);
    // The overnight flight no longer carries the single-row "+1" chip.
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("a11y (R-itin-30): the two rows reach VoiceOver DISTINCTLY, each naming its leg", async () => {
    await renderOvernight();
    const departs = screen.getByTestId(departsId).props.accessibilityLabel;
    const arrives = screen.getByTestId(arrivesId).props.accessibilityLabel;
    expect(departs).toBe(`${FLIGHT_TITLE} Departs`);
    expect(arrives).toBe(`${FLIGHT_TITLE} Arrives`);
    expect(departs).not.toBe(arrives);
    // And a screen-reader query resolves each to exactly ONE element.
    expect(screen.getAllByLabelText(`${FLIGHT_TITLE} Departs`)).toHaveLength(1);
    expect(screen.getAllByLabelText(`${FLIGHT_TITLE} Arrives`)).toHaveLength(1);
  });

  it("both rows route to the SAME booking detail (R-itin-36)", async () => {
    const { onOpenEntry } = await renderOvernight();
    await fireEvent.press(screen.getByTestId(departsId));
    await fireEvent.press(screen.getByTestId(arrivesId));
    expect(onOpenEntry).toHaveBeenCalledTimes(2);
    const [first, second] = onOpenEntry.mock.calls.map(([entry]) => entry);
    expect(first?.bookingId).toBe(FLIGHT_BOOKING_ID);
    expect(second?.bookingId).toBe(FLIGHT_BOOKING_ID);
    expect(first?.itemId).toBe(second?.itemId);
    expect(first?.rowKey).not.toBe(second?.rowKey);
  });

  it("only Departs lifts for a drag; the render-only Arrives row gives no lift and no haptic", async () => {
    await renderOvernight();
    // Guarded-handler assertion (mobile.md: assert the handler's EFFECT, not
    // "nothing happened" on a disabled element). Falsify: drop the
    // `!entry.draggable` guard in EntryCard → the Arrives press fires the haptic.
    await fireEvent(screen.getByTestId(arrivesId), "longPress");
    expect(triggerHaptic).not.toHaveBeenCalled();
    await fireEvent(screen.getByTestId(departsId), "longPress");
    expect(triggerHaptic).toHaveBeenCalledWith("dragLift");
  });

  it("boundary: a same-day flight renders ONE un-split row — no Departs/Arrives, no +1", async () => {
    const { item, byId } = flight(NAIVE_CONTROL_FLIGHT.details, "UA 415 SFO→LAX");
    await renderList(
      buildDayRows({ start_date: "2027-04-24", end_date: "2027-04-24" }, [item], byId),
    );
    expect(screen.getByTestId(`itinerary-list-item-${FLIGHT_ITEM_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(departsId)).toBeNull();
    expect(screen.queryByTestId(arrivesId)).toBeNull();
    expect(screen.queryByText("Departs")).toBeNull();
    expect(screen.queryByText("Arrives")).toBeNull();
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.getByText("10:00 – 11:30")).toBeOnTheScreen();
    expect(
      screen.getByTestId(`itinerary-list-item-${FLIGHT_ITEM_ID}`).props.accessibilityLabel,
    ).toBe("UA 415 SFO→LAX");
  });

  it("regression: lodging check-in / check-out rows are exactly as before", async () => {
    const lodgingOnly = defaultItineraryItems().filter((i) => i.id === ITEM_LODGING_ID);
    const byId = new Map(defaultBookings().map((b) => [b.id, b]));
    await renderList(
      buildDayRows({ start_date: TRIP_START, end_date: "2027-03-03" }, lodgingOnly, byId),
    );
    const checkIn = screen.getByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-in`);
    const checkOut = screen.getByTestId(`itinerary-list-item-${ITEM_LODGING_ID}-check-out`);
    expect(checkIn.props.accessibilityLabel).toBe("Park Hyatt Tokyo Check-in");
    expect(checkOut.props.accessibilityLabel).toBe("Park Hyatt Tokyo Check-out");
    expect(screen.getByText("Check-in")).toBeOnTheScreen();
    expect(screen.getByText("Check-out")).toBeOnTheScreen();
    expect(screen.queryByText("Departs")).toBeNull();
    expect(screen.queryByText("Arrives")).toBeNull();
  });

  it("regression: an overnight TRAIN keeps its single row + the +1 chip (R-itin-36 names flight only)", async () => {
    const booking = makeBooking({
      id: FLIGHT_BOOKING_ID,
      category: "train",
      title: "Caledonian Sleeper",
      details: { category: "train" },
    });
    const item = makeItineraryItem({
      id: FLIGHT_ITEM_ID,
      kind: "booking",
      booking_id: booking.id,
      title: null,
      day: "2027-06-10",
      end_day: "2027-06-11",
      start_time: "21:15",
      end_time: "07:30",
    });
    await renderList(buildDayRows(OVERNIGHT_TRIP, [item], new Map([[booking.id, booking]])));
    expect(screen.getByTestId(`itinerary-list-item-${FLIGHT_ITEM_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(arrivesId)).toBeNull();
    expect(screen.getByText("+1")).toBeOnTheScreen();
  });
});

describe("GRID mode is unchanged for an overnight flight (R-itin-36 — list view only)", () => {
  it("renders ONE clipped block with a +1 tail — no Departs/Arrives, no check-in/out indicators", async () => {
    const { item, byId } = flight(RED_EYE);
    await renderWithTheme(
      <GridSurface
        trip={makeTrip({ id: "trip-1", ...OVERNIGHT_TRIP })}
        items={[item]}
        bookingsById={byId}
        onAddAt={jest.fn()}
        onOpenBooking={jest.fn()}
        onOpenItem={jest.fn()}
      />,
    );
    await settle();
    expect(screen.getByTestId(`itinerary-grid-item-${FLIGHT_ITEM_ID}`)).toBeOnTheScreen();
    for (const qualifier of ["departs", "arrives", "check-in", "check-out"]) {
      expect(screen.queryByTestId(`itinerary-grid-item-${FLIGHT_ITEM_ID}-${qualifier}`)).toBeNull();
    }
    expect(screen.getByText("+1")).toBeOnTheScreen();
    expect(screen.queryByText("Departs")).toBeNull();
    expect(screen.queryByText("Arrives")).toBeNull();
  });
});
