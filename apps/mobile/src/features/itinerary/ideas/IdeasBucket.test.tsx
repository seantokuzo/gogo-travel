/**
 * Ideas bucket pins (T-7.6 / IT-5 — R-itin-10..12, §2.3) over the REAL data
 * hooks (network mocked by descriptor):
 *
 *  - hidden when empty (R-itin-10) — zero unscheduled AND zero cancelled;
 *  - B-13: Ideas and Cancelled are PEER BINS, each rendered only when it
 *    has contents — an empty bin hides entirely, and a cancelled booking
 *    stays reachable through the Cancelled bin (F-043 criterion 3);
 *  - collapsed entry with count Badge; expanded → grouped cards; idea badge
 *    vs "Needs a day" flag (R-itin-12); price caption (Law #2 text);
 *  - "Add to day" → day/time Sheet → the schedule wire body re-parsed with
 *    ScheduleBookingInputSchema (falsifiable pin), sheet closes on success;
 *  - failure surfaces the sheet's ErrorBanner and keeps it open;
 *  - cancelled never schedulable;
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

/** Deferred schedule requests still in flight — drained by afterEach. */
const heldRequests: ((error: Error) => void)[] = [];

afterEach(async () => {
  // Settle anything a failing test left in flight BEFORE the act drain, so a
  // red test can never leave jest hanging on a pending mutation.
  const outstanding = heldRequests.splice(0, heldRequests.length);
  if (outstanding.length > 0) {
    await act(async () => {
      for (const reject of outstanding) reject(new Error("test teardown"));
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
  mockOpenBooking.mockReset();
});

it("hidden when empty (R-itin-10): everything scheduled, nothing cancelled", async () => {
  await renderBucket(); // default universe: both bookings have items
  expect(screen.queryByTestId("itinerary-ideas")).toBeNull();
  expect(screen.queryByTestId("itinerary-cancelled")).toBeNull();
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

/**
 * Drive the bucket to a schedule request that is GENUINELY IN FLIGHT.
 *
 * Round-2 blocker: both failure tests previously used
 * `() => Promise.reject(...)`, an ALREADY-SETTLED promise — the optimistic
 * write and the rollback then flush in ONE notify batch, so the intermediate
 * "bucket emptied while the schedule is in flight" state never commits and
 * the guard under test is never consulted (proven: reverting the guard left
 * the suite 8/8 green). A deferred promise makes the mid-flight render real,
 * which is the only state the pre-fix code fails.
 */
async function scheduleWithHeldRequest(): Promise<(error: Error) => void> {
  let rejectRequest!: (error: Error) => void;
  // Exactly ONE unscheduled booking — the first-use state whose optimistic
  // write empties the bucket.
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
    overrides: {
      "POST /trips/:tripId/bookings/:bookingId/schedule": () =>
        new Promise<never>((_resolve, reject) => {
          rejectRequest = reject;
          // Settled by afterEach if a test fails before rejecting — an
          // in-flight mutation otherwise keeps jest alive past the run
          // ("Jest did not exit…"), turning one red test into a hung worker.
          heldRequests.push(reject);
        }),
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
  // `onMutate` awaits two cancelQueries before writing, so the optimistic
  // state lands a microtask AFTER the press settles. Wait for it: the card
  // leaving the bucket IS the optimistic write, and every caller below
  // asserts from that mid-flight state.
  await waitFor(() =>
    expect(screen.queryByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeNull(),
  );
  return (error: Error) => rejectRequest(error);
}

it("a failed schedule keeps the sheet open with the ErrorBanner (rollback is the hook's)", async () => {
  const rejectRequest = await scheduleWithHeldRequest();

  // MID-FLIGHT: the optimistic write has already emptied the bucket, and the
  // sheet must survive it — this is the assert the visibility hold makes
  // true and the pre-fix condition fails.
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await act(async () => rejectRequest(new Error("409")));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  // Close it ourselves and drain the exit (SHEET TAX).
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("scheduling the LAST idea keeps the sheet mounted so a failure is still visible (round-1 blocker)", async () => {
  const rejectRequest = await scheduleWithHeldRequest();

  // MID-FLIGHT, the round-1 blocker's exact state (the helper already waited
  // for the card to leave the bucket): the only unscheduled booking is gone,
  // yet bucket + sheet stay mounted so the failure has somewhere to land.
  // Pre-fix, `unscheduled.length === 0` returned null here and took the
  // in-flight sheet with it.
  expect(screen.getByTestId("itinerary-ideas")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await act(async () => rejectRequest(new Error("409")));

  // The failure is SEEN: banner rendered on the SAME (never unmounted) form.
  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  // …and the rolled-back card is back in the bucket behind it.
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("the sheet chrome is pending-gated: dismissing mid-mutation cannot drop the hold (round-2)", async () => {
  const rejectRequest = await scheduleWithHeldRequest();

  // The natural "get out of my way" gesture while the spinner is up. Ungated,
  // this cleared `scheduleTarget`, released the bucket's hold on a bucket the
  // optimistic write had just emptied, and unmounted the sheet mid-flight —
  // the round-1 blocker through the user-dismissal door.
  //
  // Driven through the close button, not the scrim: the scrim sits under an
  // `opacity: 0` Animated.View (its entrance animation doesn't advance the
  // JS value in jest), so RNTL treats it as hidden from accessibility and
  // excludes it from queries. Both affordances — plus swipe-release and
  // Android back — call the SAME gated `onDismiss`, so this covers the gate.
  const close = screen.getByTestId("itinerary-ideas-schedule-sheet-close");
  // The gate is LEGIBLE, not silent: a swallowed tap with no visible state
  // reads as a frozen app for the whole request window.
  expect(close).toBeDisabled();
  expect(close.props.accessibilityState).toMatchObject({ disabled: true });

  await fireEvent.press(close);
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await act(async () => rejectRequest(new Error("409")));
  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );

  // Settled ⇒ the gate releases and the chrome works again.
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet-close")).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("cancelled bookings live in their own PEER bin — collapsed by default, never schedulable (B-13, R-itin-12)", async () => {
  const cancelled = makeBooking({
    id: CANCELLED_ID,
    category: "flight",
    status: "cancelled",
    title: "Cancelled hop",
  });
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()], cancelled: [cancelled] },
  });

  // Both bins have contents ⇒ both render, as peers of the same shape.
  await screen.findByTestId("itinerary-ideas");
  await screen.findByTestId("itinerary-cancelled");

  // The Ideas bin holds NO cancelled card anywhere — expanded included.
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  expect(screen.queryByTestId(`itinerary-cancelled-item-${CANCELLED_ID}`)).toBeNull();

  // Expanding the Cancelled bin IS the show-cancelled affordance (the
  // collapsed default above is this assertion's control arm).
  await fireEvent.press(screen.getByTestId("itinerary-cancelled-toggle"));
  expect(screen.getByTestId(`itinerary-cancelled-item-${CANCELLED_ID}`)).toBeOnTheScreen();
  // Bin title + card badge both read "Cancelled".
  expect(screen.getAllByText("Cancelled")).toHaveLength(2);
  expect(screen.queryByTestId(`itinerary-ideas-schedule-${CANCELLED_ID}`)).toBeNull();
});

it("a cancelled-only trip grows ONLY the Cancelled bin — no empty Ideas box (B-13's exact repro)", async () => {
  const cancelled = makeBooking({ id: CANCELLED_ID, status: "cancelled" });
  await renderBucket({ api: { cancelled: [cancelled] } }); // default universe: all scheduled
  // Pre-B-13 this surfaced the Ideas container with a "0" badge — the bug.
  await screen.findByTestId("itinerary-cancelled");
  expect(screen.queryByTestId("itinerary-ideas")).toBeNull();
  expect(screen.getByText("1")).toBeOnTheScreen(); // the Cancelled bin's count
  // Still reachable (F-043 criterion 3): expand → the card is there.
  await fireEvent.press(screen.getByTestId("itinerary-cancelled-toggle"));
  expect(screen.getByTestId(`itinerary-cancelled-item-${CANCELLED_ID}`)).toBeOnTheScreen();
});

it("an ideas-only trip grows ONLY the Ideas bin (the mirror arm)", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await screen.findByTestId("itinerary-ideas");
  expect(screen.queryByTestId("itinerary-cancelled")).toBeNull();
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
