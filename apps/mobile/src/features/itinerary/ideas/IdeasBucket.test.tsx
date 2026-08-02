/**
 * Ideas bucket pins (T-7.6 / IT-5 — R-itin-10..12, §2.3) over the REAL data
 * hooks (network mocked by descriptor):
 *
 *  - hidden when empty (R-itin-10) — zero unscheduled AND zero cancelled;
 *  - collapsed entry with count Badge; expanded → grouped cards; idea badge
 *    vs "Needs a day" flag (R-itin-12); price caption (Law #2 text);
 *  - "Add to day" → day/time Sheet → the schedule wire body re-parsed with
 *    ScheduleBookingInputSchema (falsifiable pin), sheet closes on success;
 *  - failure surfaces the sheet's ErrorBanner and keeps it open;
 *  - cancelled hidden behind the foot toggle, never schedulable;
 *  - viewer sees no write affordances (R-ib-24).
 *
 * SHEET TAX (STATE "T-7.8 landmine"): every path that exits the sheet
 * drains its ~200ms exit inside an act window (waitFor on unmount).
 */
import { ScheduleBookingInputSchema, type Booking, type BookingWithItems } from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { IdeasBucket } from "@/features/itinerary";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_IDEA_ID,
  defaultBookings,
  itineraryApiOverrides,
  makeBooking,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

const CANCELLED_ID = "fffffff1-ffff-4fff-8fff-fffffffffff1";
const PLANNED_TIMELESS_ID = "fffffff2-ffff-4fff-8fff-fffffffffff2";

const mockOpenBooking = jest.fn();

function ideaBooking(overrides?: Partial<Booking>): Booking {
  return makeBooking({
    id: BOOKING_IDEA_ID,
    category: "activity",
    status: "idea",
    title: "TeamLab Planets",
    starts_at: null,
    price_cents: 3200,
    currency: "USD",
    ...overrides,
  });
}

async function renderBucket(opts?: {
  api?: ItineraryApiOptions;
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
  role?: "owner" | "viewer";
}) {
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    role: opts?.role ?? "owner",
  });
  const request = mockNavApi({
    trips: [trip],
    overrides: { ...itineraryApiOverrides(opts?.api), ...opts?.overrides },
  });
  const view = await renderWithProviders(
    <IdeasBucket trip={trip} onOpenBooking={mockOpenBooking} />,
    { queryClient: makeTestQueryClient() },
  );
  // Settle the three mounted queries' notify batches inside act (B-2 class).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { request, view };
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
  mockOpenBooking.mockReset();
});

it("hidden when empty (R-itin-10): everything scheduled, nothing cancelled", async () => {
  await renderBucket(); // default universe: both bookings have items
  expect(screen.queryByTestId("itinerary-ideas")).toBeNull();
});

it("collapsed entry shows the unscheduled count; expanding lists grouped cards with the R-itin-12 flags", async () => {
  const timelessPlanned = makeBooking({
    id: PLANNED_TIMELESS_ID,
    category: "lodging",
    status: "planned",
    title: "Ryokan idea",
    starts_at: null,
  });
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking(), timelessPlanned] },
  });

  await screen.findByTestId("itinerary-ideas");
  expect(screen.getByText("2")).toBeOnTheScreen(); // count badge: unscheduled only
  // Collapsed by default — no cards yet.
  expect(screen.queryByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeNull();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-item-${PLANNED_TIMELESS_ID}`)).toBeOnTheScreen();
  // Group headers in tuple order; badges per status class.
  expect(screen.getByText("Lodging")).toBeOnTheScreen();
  expect(screen.getByText("Activities")).toBeOnTheScreen();
  expect(screen.getByText("Idea")).toBeOnTheScreen();
  expect(screen.getByText("Needs a day")).toBeOnTheScreen();
  expect(screen.getByText("USD 32.00")).toBeOnTheScreen();

  // Card press routes to booking detail (§2.3).
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`));
  expect(mockOpenBooking).toHaveBeenCalledWith(BOOKING_IDEA_ID);
});

it("'Add to day' schedules through the wire (R-itin-11): body parses as ScheduleBookingInput, sheet closes", async () => {
  const scheduleRequests: unknown[] = [];
  const postState: BookingWithItems = {
    ...ideaBooking(),
    status: "planned",
    items: [
      makeItineraryItem({
        id: "fffffff3-ffff-4fff-8fff-fffffffffff3",
        kind: "booking",
        booking_id: BOOKING_IDEA_ID,
        title: null,
        day: TRIP_DAY_2,
        start_time: "14:30",
        sort_order: 1024,
      }),
    ],
  };
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
    overrides: {
      "POST /trips/:tripId/bookings/:bookingId/schedule": (input) => {
        scheduleRequests.push(input);
        return Promise.resolve(postState);
      },
    },
  });

  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  // Day required — confirm disabled until picked.
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  await fireEvent(screen.getByTestId("itinerary-ideas-schedule-input-day-picker"), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 2, 2, 12).getTime(), utcOffset: 0 },
  });
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-start-time"));
  await fireEvent(
    screen.getByTestId("itinerary-ideas-schedule-input-start-time-picker"),
    "onChange",
    { nativeEvent: { timestamp: new Date(2027, 2, 2, 14, 30).getTime(), utcOffset: 0 } },
  );
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));

  await waitFor(() => expect(scheduleRequests).toHaveLength(1));
  const input = scheduleRequests[0] as { params: unknown; body: unknown };
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID, bookingId: BOOKING_IDEA_ID });
  // Falsifiable wire pin: the body IS a valid ScheduleBookingInput.
  const body = ScheduleBookingInputSchema.parse(input.body);
  expect(body).toEqual({ day: TRIP_DAY_2, start_time: "14:30" });

  // Success closes the sheet — and this waitFor doubles as the exit-timer
  // drain (SHEET TAX): setExiting(false) resolves inside an act window.
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("a failed schedule keeps the sheet open with the ErrorBanner (rollback is the hook's)", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
    overrides: {
      "POST /trips/:tripId/bookings/:bookingId/schedule": () =>
        Promise.reject(new Error("409")),
    },
  });

  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  await fireEvent(screen.getByTestId("itinerary-ideas-schedule-input-day-picker"), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 2, 2, 12).getTime(), utcOffset: 0 },
  });
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  // Close it ourselves and drain the exit (SHEET TAX).
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("cancelled bookings hide behind the foot toggle and never offer scheduling (R-itin-12)", async () => {
  const cancelled = makeBooking({
    id: CANCELLED_ID,
    category: "flight",
    status: "cancelled",
    title: "Cancelled hop",
  });
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()], cancelled: [cancelled] },
  });

  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  expect(screen.queryByTestId(`itinerary-ideas-item-${CANCELLED_ID}`)).toBeNull();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-show-cancelled"));
  expect(screen.getByTestId(`itinerary-ideas-item-${CANCELLED_ID}`)).toBeOnTheScreen();
  // Group header + card badge both read "Cancelled".
  expect(screen.getAllByText("Cancelled")).toHaveLength(2);
  expect(screen.queryByTestId(`itinerary-ideas-schedule-${CANCELLED_ID}`)).toBeNull();
});

it("a cancelled-only trip still grows the entry (their ONLY surface)", async () => {
  const cancelled = makeBooking({ id: CANCELLED_ID, status: "cancelled" });
  await renderBucket({ api: { cancelled: [cancelled] } }); // default universe: all scheduled
  await screen.findByTestId("itinerary-ideas");
  expect(screen.getByText("0")).toBeOnTheScreen(); // count = unscheduled only
});

it("viewers get no write affordances (R-ib-24)", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
    role: "viewer",
  });
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.queryByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`)).toBeNull();
});
