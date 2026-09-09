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

import { ApiRequestError } from "@/auth";
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
const WITH_TIMES_IDEA_ID = "fffffff4-ffff-4fff-8fff-fffffffffff4";

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

/**
 * B-16 card class (Sean device QA 2026-09-06): an `idea` that already CARRIES
 * date/times in its details. I-1 pins ideas to zero itinerary items, so it
 * sits in the bucket like any other idea — but its derived `starts_at` is
 * known, which R-ib-8's third arm makes fatal to `POST …/schedule`.
 * Instants are wire-faithful: the UTC denormalization of the +09:00 locals.
 */
function ideaWithTimes(overrides?: Partial<Booking>): Booking {
  return makeBooking({
    id: WITH_TIMES_IDEA_ID,
    category: "activity",
    status: "idea",
    title: "Sumo tournament",
    details: {
      category: "activity",
      starts_at: "2027-03-02T14:30:00+09:00",
      ends_at: "2027-03-02T16:00:00+09:00",
    },
    starts_at: "2027-03-02T05:30:00.000Z",
    ends_at: "2027-03-02T07:00:00.000Z",
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

/**
 * PR #40 R1 (tests lane): the ScheduleSheet Day seed chain (IdeasBucket's
 * `contextDay={trip.start_date}` → ScheduleForm → DateField) was unpinned —
 * severing it left the suite green while the Add-to-day picker reverted to
 * opening on today. Red when any link of that chain is dropped: TRIP_START
 * (2027-03-01) is not today.
 */
it("the schedule sheet's Day picker seeds from the trip start (B-10 seed-chain pin)", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day-picker").props.date).toBe(
    new Date(2027, 2, 1, 12).getTime(),
  );
  // Close the picker card, then the sheet, draining its exit (SHEET TAX).
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day-sheet-close"));
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

/**
 * B-16 PREFILL (Sean device QA 2026-09-06): an idea that already carries
 * date/times opens the schedule sheet with them as the pickers' VALUES —
 * the field rows themselves display the carried wall date/times and the
 * confirm is immediately tappable. NOT the B-10b seed (where the picker
 * merely OPENS); severing the seed chain leaves the field reading "Select
 * date", which is exactly the pre-fix red of this pin. Wall values come
 * from the details' local strings (§3.3 — no tz math), the same derivation
 * I-2 would use, so what the user confirms is where the card would land.
 */
it("B-16 prefill: an idea that carries date/times opens the sheet with them as the pickers' VALUES, confirm tappable", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaWithTimes()] } });
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${WITH_TIMES_IDEA_ID}`));

  // VALUES, not seeds: the rows read back their set value (DateField /
  // TimeField expose `${label}, ${value}` once a value exists)…
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-start-time").props.accessibilityLabel,
  ).toBe("Start time (optional), 14:30");
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-end-time").props.accessibilityLabel,
  ).toBe("End time (optional), 16:00");
  // …visibly — no placeholder anywhere in the sheet…
  expect(screen.getByText("14:30")).toBeOnTheScreen();
  expect(screen.getByText("16:00")).toBeOnTheScreen();
  expect(screen.queryByText("Select date")).toBeNull();
  expect(screen.queryByText("Select time")).toBeNull();
  // …and "user taps Add": nothing to re-enter, confirm is live.
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

/**
 * Control arm: an idea with NO carried times keeps today's behavior — empty
 * fields (placeholders showing), confirm disabled until a day is picked.
 * Discriminates prefill-from-carried-times from "prefill everything":
 * a regression that stuffs values into every card turns THIS red.
 */
it("B-16 prefill control: an idea without carried times still opens empty, confirm disabled", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));

  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByText("Select date")).toBeOnTheScreen();
  expect(screen.getAllByText("Select time")).toHaveLength(2);
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

/**
 * PR #48 R1 (tests lane): per-booking prefill FRESHNESS. The mechanism that
 * applies each booking's prefill is the `key={booking.id}` remount — deleting
 * it left the suite green because freshness was double-guarded by the
 * null-unmount on close (booking → null unmounts the form, so a fresh mount
 * follows either way). Unpinned, a sheet-exit polish that retains the last
 * booking through the exit would let one card's day/times survive into the
 * next card's form — one tap then schedules booking B onto booking A's day,
 * silently, no red anywhere.
 *
 * Two legs, one render, the two fixtures fully distinct:
 *  - close → reopen (the user-reachable path): fresh state through the
 *    null-unmount — guards the retention scenario above end-to-end;
 *  - direct target switch WITHOUT passing through null (Sumo's sheet open,
 *    press TeamLab's row button): the one transition where the `key` is the
 *    ONLY guard — React reuses the same-type/same-position form instance
 *    unless the key changes, so THIS leg is what turns red when the key is
 *    deleted (mutation-verified). Unreachable by touch today (rows sit
 *    behind the open sheet) but it is the render-level contract the future
 *    polish relies on, pinned at the level where it can actually fail.
 */
it("B-16 prefill freshness: state never leaks across bookings — close/reopen AND a direct target switch both start clean (key remount pin)", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking(), ideaWithTimes()] },
  });
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));

  // Leg 1a: the with-times idea opens prefilled…
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${WITH_TIMES_IDEA_ID}`));
  expect(screen.getByText('Add "Sumo tournament" to a day')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );

  // …close (drain the exit — SHEET TAX)…
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());

  // Leg 1b: …and the timeless idea reopens EMPTY — nothing carried over.
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));
  expect(screen.getByText('Add "TeamLab Planets" to a day')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  // Leg 2: switch targets while the sheet is OPEN (no null pass-through).
  // Without the per-booking key this reuses the mounted form — TeamLab's
  // empty fields would show under Sumo's title, the exact cross-booking
  // leak class — so these assertions are the pin's discriminating arm.
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${WITH_TIMES_IDEA_ID}`));
  expect(screen.getByText('Add "Sumo tournament" to a day')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-start-time").props.accessibilityLabel,
  ).toBe("Start time (optional), 14:30");
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-end-time").props.accessibilityLabel,
  ).toBe("End time (optional), 16:00");
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

  // And back the other way: with-times → timeless, still no leak.
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`));
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

/**
 * B-16 ROOT-CAUSE REPRO (Sean device QA 2026-09-06: "entering a date in the
 * Add-to-day modal and pressing the button errors"). The erroring cards are
 * ideas that already CARRY date/times: their derived `starts_at` is known,
 * and the schedule endpoint's wire contract rejects known-times bookings
 * outright — R-ib-8: "WHEN the booking has known times THE SYSTEM SHALL
 * reject VALIDATION_FAILED (its calendar presence is automatic, R-ib-5)";
 * implemented at apps/server/src/bookings/service.ts `scheduleBooking`
 * (`current.startsAt !== null` → 400, before the body is even consulted).
 *
 * This test localizes the failure: the responder mirrors that server arm
 * verbatim and ASSERTS the client's body was a schema-valid
 * ScheduleBookingInput — so the error is NOT client validation and NOT wire
 * shape; it is the server's semantic rejection of this booking's state. The
 * client fix is the queued ideas-status rework (§3.2 status actions), not a
 * different request body — nothing this sheet can send makes the call legal.
 */
it("B-16 repro: 'Add to day' on an idea that carries date/times is rejected by the wire contract (R-ib-8) and surfaces the ErrorBanner", async () => {
  const scheduleBodies: unknown[] = [];
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaWithTimes()] },
    overrides: {
      "POST /trips/:tripId/bookings/:bookingId/schedule": (input) => {
        scheduleBodies.push(input.body);
        // Contract-faithful: the fixture booking's starts_at is known, so
        // the real server answers 400 VALIDATION_FAILED, always.
        return Promise.reject(
          new ApiRequestError(
            400,
            "VALIDATION_FAILED",
            "booking has known times — its calendar presence is automatic",
            { starts_at: "known" },
          ),
        );
      },
    },
  });

  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-schedule-${WITH_TIMES_IDEA_ID}`));

  // Sean's exact gesture: enter a day (even the booking's OWN day) and press.
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  await fireEvent(screen.getByTestId("itinerary-ideas-schedule-input-day-picker"), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 2, 2, 12).getTime(), utcOffset: 0 },
  });
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));

  await waitFor(() => expect(scheduleBodies).toHaveLength(1));
  // NOT client validation, NOT wire shape: the body the client sent is a
  // valid ScheduleBookingInput — the rejection is about the BOOKING's state.
  expect(ScheduleBookingInputSchema.safeParse(scheduleBodies[0]).success).toBe(true);

  // What Sean saw: the sheet's generic failure banner, flow dead-ended.
  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  // Rollback (hook-owned): the card is back in the bucket, unchanged.
  expect(screen.getByTestId(`itinerary-ideas-item-${WITH_TIMES_IDEA_ID}`)).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});
