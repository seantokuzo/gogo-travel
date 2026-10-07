/**
 * Ideas bucket pins (T-7.6 / IT-5 — R-itin-10..12, §2.3; reworked by T-7.15 —
 * R-itin-11/40/41, the Planned / Booked status actions) over the REAL data
 * hooks (network mocked by descriptor):
 *
 *  - hidden when empty (R-itin-10) — zero unscheduled AND zero cancelled;
 *  - B-13: Ideas and Cancelled are PEER BINS, each rendered only when it
 *    has contents — an empty bin hides entirely, and a cancelled booking
 *    stays reachable through the Cancelled bin (F-043 criterion 3);
 *  - collapsed entry with count Badge; expanded → grouped cards; idea badge
 *    vs "Needs a day" flag (R-itin-12); price caption (Law #2 text);
 *  - T-7.15: "Planned" / "Booked" (replacing "Add to day") → status-action
 *    Sheet. TIMELESS cards route through the schedule endpoint with the
 *    tapped status; KNOWN-TIMES cards (the B-16 dead end) through a
 *    status-only PATCH; the bucket never demotes (the
 *    [NEEDS CLARIFICATION: T-7.15 bucket-card demotion] pins);
 *  - inline day/time validation (R-itin-41) and server refusals mapped onto
 *    the field that owns them;
 *  - failure surfaces on the sheet and keeps it open, on BOTH routes;
 *  - cancelled never actionable; viewers see no write affordances (R-ib-24).
 *
 * SHEET TAX (STATE "T-7.8 landmine"): every path that exits the sheet
 * drains its ~200ms exit inside an act window (waitFor on unmount).
 */
import {
  ScheduleBookingInputSchema,
  type Booking,
  type BookingStatus,
  type BookingWithItems,
  type ItineraryItem,
  type ScheduleBookingInput,
} from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import { ApiRequestError } from "@/auth";
import { IdeasBucket } from "@/features/itinerary";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_IDEA_ID,
  defaultBookings,
  defaultItineraryItems,
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
const SERVER_ITEM_ID = "fffffff3-ffff-4fff-8fff-fffffffffff3";
const WITH_TIMES_IDEA_ID = "fffffff4-ffff-4fff-8fff-fffffffffff4";
const BOOKED_TIMELESS_ID = "fffffff5-ffff-4fff-8fff-fffffffffff5";
const END_ONLY_IDEA_ID = "fffffff6-ffff-4fff-8fff-fffffffffff6";

const SCHEDULE_ROUTE = "POST /trips/:tripId/bookings/:bookingId/schedule";
const STATUS_ROUTE = "PATCH /trips/:tripId/bookings/:bookingId";

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
 * (The EXACT fixture the pre-T-7.15 repro used — it dead-ended then.)
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

/** Timeless to the SERVER (`starts_at` null) though the details carry an end. */
function ideaEndOnly(): Booking {
  return makeBooking({
    id: END_ONLY_IDEA_ID,
    category: "activity",
    status: "idea",
    title: "Closing ceremony",
    details: { category: "activity", ends_at: "2027-03-02T16:00:00+09:00" },
    starts_at: null,
    ends_at: "2027-03-02T07:00:00.000Z",
  });
}

function timelessWithStatus(id: string, status: "planned" | "booked", title: string): Booking {
  return makeBooking({ id, category: "lodging", status, title, starts_at: null });
}

type Responder = (input: Record<string, unknown>) => Promise<unknown>;

async function renderBucket(opts?: {
  api?: ItineraryApiOptions;
  overrides?: Record<string, Responder>;
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

/** Requests of one descriptor, from the mocked transport. */
function callsTo(request: jest.Mock, method: string): unknown[] {
  return request.mock.calls
    .filter(([descriptor]) => (descriptor as { method: string }).method === method)
    .map(([, input]) => input);
}

/** Deferred requests still in flight — drained by afterEach. */
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

// --- gesture helpers (every one awaited — RNTL v14 / act-warning law) -------

async function expandIdeas(): Promise<void> {
  await screen.findByTestId("itinerary-ideas");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-toggle"));
}

async function openSheet(bookingId: string, target: "planned" | "booked"): Promise<void> {
  await expandIdeas();
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-${target}-${bookingId}`));
}

async function pickDay(date = new Date(2027, 2, 2, 12)): Promise<void> {
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  await fireEvent(screen.getByTestId("itinerary-ideas-schedule-input-day-picker"), "onChange", {
    nativeEvent: { timestamp: date.getTime(), utcOffset: 0 },
  });
}

async function pickTime(which: "start-time" | "end-time", hour: number, minute: number) {
  const id = `itinerary-ideas-schedule-input-${which}`;
  await fireEvent.press(screen.getByTestId(id));
  await fireEvent(screen.getByTestId(`${id}-picker`), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 2, 2, hour, minute).getTime(), utcOffset: 0 },
  });
}

async function closeSheet(): Promise<void> {
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-sheet-close"));
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
}

function scheduledItem(bookingId: string, overrides?: Partial<ItineraryItem>): ItineraryItem {
  return makeItineraryItem({
    id: SERVER_ITEM_ID,
    kind: "booking",
    booking_id: bookingId,
    title: null,
    day: TRIP_DAY_2,
    start_time: "14:30",
    sort_order: 1024,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

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

it("each idea card shows 'Planned' and 'Booked' — and the old single 'Add to day' card button is gone (R-itin-11/40)", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await expandIdeas();
  expect(screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-booked-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.getByText("Planned")).toBeOnTheScreen();
  expect(screen.getByText("Booked")).toBeOnTheScreen();
  expect(screen.queryByTestId(`itinerary-ideas-schedule-${BOOKING_IDEA_ID}`)).toBeNull();
  expect(screen.queryByText("Add to day")).toBeNull();
});

// --- a11y (R-itin-30) -------------------------------------------------------

// Falsify: drop the per-card `accessibilityLabel` on the action buttons ⇒ the
// Button falls back to its bare title, so two cards' "Planned" read
// identically to VoiceOver ("Planned, button" ×2 — which card?) ⇒ RED.
it("a11y (R-itin-30): each action is a button whose label NAMES its card — two cards' identical 'Planned' captions stay distinguishable", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking(), ideaWithTimes()] },
  });
  await expandIdeas();
  const teamLab = screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`);
  const sumo = screen.getByTestId(`itinerary-ideas-planned-${WITH_TIMES_IDEA_ID}`);
  expect(teamLab.props.accessibilityRole).toBe("button");
  expect(teamLab.props.accessibilityLabel).toBe("Mark TeamLab Planets as Planned");
  expect(sumo.props.accessibilityLabel).toBe("Mark Sumo tournament as Planned");
  expect(
    screen.getByTestId(`itinerary-ideas-booked-${WITH_TIMES_IDEA_ID}`).props.accessibilityLabel,
  ).toBe("Mark Sumo tournament as Booked");
});

// Falsify: drop `accessible` / the combined `accessibilityLabel` on the
// read-only rows ⇒ VoiceOver reads "Starts" and "Mar 2, 2027 · 14:30" as two
// unrelated fragments (or skips the row) ⇒ RED.
it("a11y (R-itin-30): the known-times read-only rows are ONE accessible element each, with the full date + time in the label", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaWithTimes()] },
  });
  await openSheet(WITH_TIMES_IDEA_ID, "booked");
  const start = screen.getByTestId("itinerary-ideas-schedule-readonly-start");
  const end = screen.getByTestId("itinerary-ideas-schedule-readonly-end");
  expect(start.props.accessible).toBe(true);
  expect(start.props.accessibilityLabel).toBe("Starts, Mar 2, 2027 at 14:30");
  expect(end.props.accessible).toBe(true);
  expect(end.props.accessibilityLabel).toBe("Ends, Mar 2, 2027 at 16:00");
  await closeSheet();
});

// --- happy: timeless idea → schedule endpoint WITH status ------------------

/**
 * Drive a timeless idea through a status action to a confirmed schedule call
 * and return the recorded request inputs. The responder is STATEFUL (mutates
 * the fixture arrays the GET responders read), so the post-success world is
 * what the server would say.
 */
async function scheduleTimelessIdea(target: "planned" | "booked") {
  const scheduleRequests: unknown[] = [];
  const idea = ideaBooking();
  const bookings = [...defaultBookings(), idea];
  const items = defaultItineraryItems();
  const postState: BookingWithItems = {
    ...idea,
    status: target,
    items: [scheduledItem(BOOKING_IDEA_ID)],
  };
  const { request } = await renderBucket({
    api: { bookings, items },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        scheduleRequests.push(input);
        return Promise.resolve(postState);
      },
    },
  });

  await openSheet(BOOKING_IDEA_ID, target);
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  // Day required — confirm disabled until picked.
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();
  await pickDay();
  await pickTime("start-time", 14, 30);
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));

  await waitFor(() => expect(scheduleRequests).toHaveLength(1));
  return { scheduleRequests, request };
}

it("happy: 'Planned' on a timeless idea schedules with `status` OMITTED (the server's idea → planned); the wire body parses; sheet closes", async () => {
  const { scheduleRequests, request } = await scheduleTimelessIdea("planned");
  const input = scheduleRequests[0] as { params: unknown; body: unknown };
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID, bookingId: BOOKING_IDEA_ID });
  // Falsifiable wire pin: the body IS a valid ScheduleBookingInput, and
  // Planned never rides it (server-true never-demote, see the pin below).
  expect(ScheduleBookingInputSchema.parse(input.body)).toEqual({
    day: TRIP_DAY_2,
    start_time: "14:30",
  });
  expect(input.body).not.toHaveProperty("status");
  // Timeless ⇒ the schedule route ONLY: no status PATCH rode along.
  expect(callsTo(request, "PATCH")).toHaveLength(0);

  // Success closes the sheet — and this waitFor doubles as the exit-timer
  // drain (SHEET TAX): setExiting(false) resolves inside an act window.
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

// Falsify: drop `status` from the schedule candidate in
// `buildStatusActionRequest` ⇒ the body loses `status: "booked"` (the server
// would then advance `idea → planned` — Booked silently ignored) ⇒ RED.
it("happy: 'Booked' on a timeless idea schedules with status 'booked' — the timeless-booked pin", async () => {
  const { scheduleRequests } = await scheduleTimelessIdea("booked");
  const input = scheduleRequests[0] as { body: unknown };
  expect(ScheduleBookingInputSchema.parse(input.body)).toEqual({
    day: TRIP_DAY_2,
    start_time: "14:30",
    status: "booked",
  });
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

// --- happy / adversarial: known-times idea → STATUS-ONLY PATCH (B-16) -------

/**
 * The B-16 dead end, fixed. The schedule responder mirrors the REAL server
 * arm verbatim (`current.startsAt !== null` ⇒ 400, before the body is even
 * consulted), so a client that still routes a known-times card there dead-ends
 * in the pre-existing VALIDATION_FAILED banner — exactly what Sean saw. The
 * PATCH responder is stateful: it applies the status + the I-2 auto-item.
 */
async function statusPatchKnownTimes(target: "planned" | "booked") {
  const scheduleBodies: unknown[] = [];
  const patchInputs: { params: unknown; body: unknown }[] = [];
  const sumo = ideaWithTimes();
  const bookings = [...defaultBookings(), sumo];
  const items = defaultItineraryItems();
  const { request } = await renderBucket({
    api: { bookings, items },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        scheduleBodies.push(input.body);
        return Promise.reject(
          new ApiRequestError(
            400,
            "VALIDATION_FAILED",
            "booking has known times — its calendar presence is automatic",
            { starts_at: "known" },
          ),
        );
      },
      [STATUS_ROUTE]: (input) => {
        patchInputs.push(input as { params: unknown; body: unknown });
        const item = scheduledItem(WITH_TIMES_IDEA_ID, { end_time: "16:00" });
        const post: BookingWithItems = { ...sumo, status: target, items: [item] };
        // Server truth for the refetch the success path triggers.
        bookings[bookings.findIndex((row) => row.id === sumo.id)] = { ...sumo, status: target };
        items.push(item);
        return Promise.resolve(post);
      },
    },
  });
  return { scheduleBodies, patchInputs, request };
}

// Falsify: revert the routing branch (`statusActionRoute` always "schedule")
// ⇒ the confirm hits the schedule endpoint, the responder answers the
// pre-existing VALIDATION_FAILED, the banner shows and no PATCH is sent ⇒ RED.
it.each(["planned", "booked"] as const)(
  "adversarial: the EXACT B-16 known-times fixture + '%s' now SUCCEEDS via a status-only PATCH — no schedule call, no dead-end banner",
  async (target) => {
    const { scheduleBodies, patchInputs, request } = await statusPatchKnownTimes(target);
    await openSheet(WITH_TIMES_IDEA_ID, target);

    // R-itin-41: the booking's own times render READ-ONLY with the hint —
    // no pickers, no day input.
    expect(screen.getByTestId("itinerary-ideas-schedule-readonly-start")).toBeOnTheScreen();
    expect(screen.getByText("Mar 2, 2027 · 14:30")).toBeOnTheScreen();
    expect(screen.getByText("Mar 2, 2027 · 16:00")).toBeOnTheScreen();
    expect(screen.getByTestId("itinerary-ideas-schedule-hint")).toBeOnTheScreen();
    expect(screen.queryByTestId("itinerary-ideas-schedule-input-day")).toBeNull();
    // Nothing to pick ⇒ confirm is live immediately.
    expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

    await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
    await waitFor(() =>
      expect(patchInputs.length + scheduleBodies.length).toBeGreaterThanOrEqual(1),
    );
    // Flush: a reverted route's rejection lands as the banner a tick later.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The pre-existing dead end: the generic failure banner. Must NOT appear.
    expect(screen.queryByTestId("itinerary-ideas-schedule-error")).toBeNull();
    expect(scheduleBodies).toHaveLength(0);
    // The ONLY write is the status PATCH, body exactly `{ status }` — no
    // day, no times.
    expect(patchInputs).toHaveLength(1);
    expect(patchInputs[0]).toEqual({
      params: { tripId: TEST_TRIP_ID, bookingId: WITH_TIMES_IDEA_ID },
      body: { status: target },
    });
    expect(callsTo(request, "POST")).toHaveLength(0);

    // Success closes the sheet (SHEET TAX drain) and — the refetch having
    // been served the server's post-state — the card is out of the bucket.
    await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("itinerary-ideas")).toBeNull());
  },
);

// --- directive pins: the bucket never demotes ------------------------------

// Falsify: make `isStatusActionOffered` return true for every non-cancelled
// status (the literal R-itin-11 reading) ⇒ the booked card grows a "Planned"
// button ⇒ RED. Sean's ruling on the open question is a ONE-LINE flip there
// plus an update of THIS test.
it("[NEEDS CLARIFICATION: T-7.15 bucket-card demotion] a timeless BOOKED card is never demoted — Planned is not offered; Booked (same status) schedules with NO status field", async () => {
  const scheduleRequests: unknown[] = [];
  const booked = timelessWithStatus(BOOKED_TIMELESS_ID, "booked", "Ryokan (paid)");
  const planned = timelessWithStatus(PLANNED_TIMELESS_ID, "planned", "Ryokan (pencilled)");
  await renderBucket({
    api: { bookings: [...defaultBookings(), booked, planned] },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        scheduleRequests.push(input);
        return Promise.resolve({ ...booked, items: [scheduledItem(BOOKED_TIMELESS_ID)] });
      },
    },
  });
  await expandIdeas();

  // The booked card: Booked only. The control arms: a PLANNED card offers
  // both (Planned = give it a day, stay planned; Booked advances).
  expect(screen.queryByTestId(`itinerary-ideas-planned-${BOOKED_TIMELESS_ID}`)).toBeNull();
  expect(screen.getByTestId(`itinerary-ideas-booked-${BOOKED_TIMELESS_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-planned-${PLANNED_TIMELESS_ID}`)).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-booked-${PLANNED_TIMELESS_ID}`)).toBeOnTheScreen();

  // The only action on the booked card gives it a day and sends NO status —
  // the server's pre-change path ("omitted ⇒ booked stays booked").
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-booked-${BOOKED_TIMELESS_ID}`));
  expect(screen.getByText('Add "Ryokan (paid)" to a day')).toBeOnTheScreen();
  await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  await waitFor(() => expect(scheduleRequests).toHaveLength(1));
  const body = (scheduleRequests[0] as { body: Record<string, unknown> }).body;
  expect(body).toEqual({ day: TRIP_DAY_2 });
  expect(body).not.toHaveProperty("status");

  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

it("a timeless PLANNED card's Booked advances it: the schedule body carries status 'booked'", async () => {
  const scheduleRequests: unknown[] = [];
  const planned = timelessWithStatus(PLANNED_TIMELESS_ID, "planned", "Ryokan (pencilled)");
  await renderBucket({
    api: { bookings: [...defaultBookings(), planned] },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        scheduleRequests.push(input);
        return Promise.resolve({
          ...planned,
          status: "booked",
          items: [scheduledItem(PLANNED_TIMELESS_ID)],
        });
      },
    },
  });
  await openSheet(PLANNED_TIMELESS_ID, "booked");
  expect(screen.getByText('Mark "Ryokan (pencilled)" as Booked')).toBeOnTheScreen();
  await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  await waitFor(() => expect(scheduleRequests).toHaveLength(1));
  expect((scheduleRequests[0] as { body: unknown }).body).toEqual({
    day: TRIP_DAY_2,
    status: "booked",
  });
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

// Falsify: send `status: target` for Planned again ⇒ the body carries
// `status: "planned"` ⇒ the responder (R-ib-8 verbatim) legally demotes
// `booked → planned` ⇒ `serverStatus` ends "planned" ⇒ RED.
it("[NEEDS CLARIFICATION: T-7.15 bucket-card demotion] a stale-cache 'Planned' cannot demote — B already marked it booked server-side while A's cache says idea; the body carries NO status, so the server keeps it booked", async () => {
  const bodies: ScheduleBookingInput[] = [];
  const idea = ideaBooking(); // A's cache: idea
  let serverStatus: BookingStatus = "booked"; // server truth: B's write landed first
  await renderBucket({
    api: { bookings: [...defaultBookings(), idea] },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        const body = input.body as ScheduleBookingInput;
        bodies.push(body);
        // R-ib-8: an explicit status is validated against §3.2 from the
        // CURRENT status (`booked → planned` is a legal demotion); omitted
        // advances only `idea → planned` and leaves planned/booked alone.
        serverStatus = body.status ?? (serverStatus === "idea" ? "planned" : serverStatus);
        return Promise.resolve({
          ...idea,
          status: serverStatus,
          items: [scheduledItem(BOOKING_IDEA_ID)],
        });
      },
    },
  });
  await openSheet(BOOKING_IDEA_ID, "planned");
  await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  await waitFor(() => expect(bodies).toHaveLength(1));

  expect(bodies[0]).toEqual({ day: TRIP_DAY_2 });
  expect(serverStatus).toBe("booked");
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

// --- error: inline validation (R-itin-41) ----------------------------------

it("error: an empty day and an end before the start each show an INLINE error and block confirm (R-itin-41)", async () => {
  const { request } = await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
  });
  await openSheet(BOOKING_IDEA_ID, "planned");

  // Empty day: its own inline error; confirm blocked.
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day-error")).toHaveTextContent(
    "Choose a day.",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  // Day picked ⇒ the day error clears; with no times the form is valid.
  await pickDay();
  expect(screen.queryByTestId("itinerary-ideas-schedule-input-day-error")).toBeNull();
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

  // End before start ⇒ the end-time error; confirm blocked again.
  await pickTime("start-time", 16, 0);
  await pickTime("end-time", 14, 30);
  expect(screen.getByTestId("itinerary-ideas-schedule-input-end-time-error")).toHaveTextContent(
    "End time can't be before the start time.",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  // Nothing was ever sent, on either route.
  expect(callsTo(request, "POST")).toHaveLength(0);
  expect(callsTo(request, "PATCH")).toHaveLength(0);

  await closeSheet();
});

it("boundary: an end time EQUAL to the start time is valid — no error, confirm live, both times ride the body", async () => {
  const scheduleRequests: unknown[] = [];
  const idea = ideaBooking();
  await renderBucket({
    api: { bookings: [...defaultBookings(), idea] },
    overrides: {
      [SCHEDULE_ROUTE]: (input) => {
        scheduleRequests.push(input);
        return Promise.resolve({
          ...idea,
          status: "planned",
          items: [scheduledItem(BOOKING_IDEA_ID, { end_time: "14:30" })],
        });
      },
    },
  });
  await openSheet(BOOKING_IDEA_ID, "planned");
  await pickDay();
  await pickTime("start-time", 14, 30);
  await pickTime("end-time", 14, 30);

  expect(screen.queryByTestId("itinerary-ideas-schedule-input-end-time-error")).toBeNull();
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  await waitFor(() => expect(scheduleRequests).toHaveLength(1));
  expect((scheduleRequests[0] as { body: unknown }).body).toEqual({
    day: TRIP_DAY_2,
    start_time: "14:30",
    end_time: "14:30",
  });
  await waitFor(() => expect(screen.queryByTestId("itinerary-ideas-schedule-sheet")).toBeNull());
});

// --- empty: an undated idea stays untouched --------------------------------

it("empty (R-itin-40): an idea with no date stays untouched when the sheet is dismissed — nothing sent, card and badge unchanged", async () => {
  const { request } = await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
  });
  await openSheet(BOOKING_IDEA_ID, "booked");
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  await closeSheet();

  // No write on either route…
  expect(callsTo(request, "POST")).toHaveLength(0);
  expect(callsTo(request, "PATCH")).toHaveLength(0);
  // …and the card is exactly where it was, still an idea, still counted.
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.getByText("Idea")).toBeOnTheScreen();
  expect(screen.getByText("1")).toBeOnTheScreen();
});

// --- in-flight: the optimistic move + the visibility hold, both routes ------

/**
 * Drive the bucket to a request that is GENUINELY IN FLIGHT.
 *
 * Round-2 blocker (T-7.6): the failure tests previously used
 * `() => Promise.reject(...)`, an ALREADY-SETTLED promise — the optimistic
 * write and the rollback then flush in ONE notify batch, so the intermediate
 * "bucket emptied while the request is in flight" state never commits and the
 * guard under test is never consulted. A deferred promise makes the
 * mid-flight render real, which is the only state the pre-fix code fails.
 */
async function holdRequest(route: "schedule" | "status") {
  let rejectRequest!: (error: Error) => void;
  const hold: Responder = () =>
    new Promise<never>((_resolve, reject) => {
      rejectRequest = reject;
      // Settled by afterEach if a test fails before rejecting — an in-flight
      // mutation otherwise keeps jest alive past the run.
      heldRequests.push(reject);
    });
  // Exactly ONE unscheduled booking — the first-use state whose optimistic
  // write empties the bucket.
  const idea = route === "schedule" ? ideaBooking() : ideaWithTimes();
  await renderBucket({
    api: { bookings: [...defaultBookings(), idea] },
    overrides: { [route === "schedule" ? SCHEDULE_ROUTE : STATUS_ROUTE]: hold },
  });

  await openSheet(idea.id, "planned");
  if (route === "schedule") await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  // `onMutate` awaits two cancelQueries before writing, so the optimistic
  // state lands a microtask AFTER the press settles. Wait for it: the card
  // leaving the bucket IS the optimistic write, and every caller below
  // asserts from that mid-flight state.
  await waitFor(() => expect(screen.queryByTestId(`itinerary-ideas-item-${idea.id}`)).toBeNull());
  return { reject: (error: Error) => rejectRequest(error), bookingId: idea.id };
}

it("a failed schedule keeps the sheet open with the ErrorBanner (rollback is the hook's)", async () => {
  const { reject } = await holdRequest("schedule");

  // MID-FLIGHT: the optimistic write has already emptied the bucket, and the
  // sheet must survive it.
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  expect(screen.queryByTestId("itinerary-ideas-schedule-error")).toBeNull();

  await act(async () => reject(new Error("409")));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await closeSheet();
});

it("a failed status PATCH keeps the sheet open with the ErrorBanner and rolls the card back (the known-times route has the same hold)", async () => {
  const { reject, bookingId } = await holdRequest("status");

  // MID-FLIGHT, the round-1 blocker's exact state on the NEW route: the only
  // unscheduled booking is gone, yet bucket + sheet stay mounted so the
  // failure has somewhere to land.
  expect(screen.getByTestId("itinerary-ideas")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await act(async () => reject(new ApiRequestError(403, "FORBIDDEN", "not an editor")));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  // …and the rolled-back card is back in the bucket behind it.
  expect(screen.getByTestId(`itinerary-ideas-item-${bookingId}`)).toBeOnTheScreen();

  await closeSheet();
});

it("scheduling the LAST idea keeps the sheet mounted so a failure is still visible (round-1 blocker)", async () => {
  const { reject, bookingId } = await holdRequest("schedule");

  // MID-FLIGHT, the round-1 blocker's exact state (the helper already waited
  // for the card to leave the bucket): the only unscheduled booking is gone,
  // yet bucket + sheet stay mounted so the failure has somewhere to land.
  expect(screen.getByTestId("itinerary-ideas")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();

  await act(async () => reject(new Error("409")));

  // The failure is SEEN: banner rendered on the SAME (never unmounted) form.
  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-item-${bookingId}`)).toBeOnTheScreen();

  await closeSheet();
});

/**
 * The sheet chrome is pending-gated — pinned per ROUTE: the pending flag is
 * the OR of both mutations, so a status PATCH mid-flight gates dismissal
 * exactly like a schedule does. Falsify: `pending = schedule.isPending` only
 * ⇒ the PATCH leg's close button is enabled mid-flight ⇒ RED.
 */
it.each(["schedule", "status"] as const)(
  "the sheet chrome is pending-gated on the %s route: dismissing mid-mutation cannot drop the hold (round-2)",
  async (route) => {
    const { reject } = await holdRequest(route);

    // The natural "get out of my way" gesture while the spinner is up. Ungated,
    // this cleared the action, released the bucket's hold on a bucket the
    // optimistic write had just emptied, and unmounted the sheet mid-flight.
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

    await act(async () => reject(new Error("409")));
    await waitFor(() =>
      expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
    );

    // Settled ⇒ the gate releases and the chrome works again.
    expect(screen.getByTestId("itinerary-ideas-schedule-sheet-close")).not.toBeDisabled();
    await closeSheet();
  },
);

// --- error: server refusals map onto the owning field ----------------------

it("error: a server 400 VALIDATION_FAILED with `details.fieldErrors.status` lands on the STATUS field — not a generic banner; the card rolls back", async () => {
  let rejectRequest!: (error: Error) => void;
  const idea = ideaBooking();
  await renderBucket({
    api: { bookings: [...defaultBookings(), idea] },
    overrides: {
      [SCHEDULE_ROUTE]: () =>
        new Promise<never>((_resolve, reject) => {
          rejectRequest = reject;
          heldRequests.push(reject);
        }),
    },
  });
  await openSheet(BOOKING_IDEA_ID, "booked");
  await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));
  await waitFor(() =>
    expect(screen.queryByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeNull(),
  );
  // Mid-flight: no refusal yet.
  expect(screen.queryByTestId("itinerary-ideas-schedule-status-error")).toBeNull();

  await act(async () =>
    rejectRequest(
      new ApiRequestError(400, "VALIDATION_FAILED", "request body failed validation", {
        formErrors: [],
        fieldErrors: { status: ["illegal status transition"] },
      }),
    ),
  );

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-status-error")).toHaveTextContent(
      "illegal status transition",
    ),
  );
  // Announced when it lands (R-itin-30): a polite live region, not silent text.
  expect(
    screen.getByTestId("itinerary-ideas-schedule-status-error").props.accessibilityLiveRegion,
  ).toBe("polite");
  // The reason lives on the field — NO generic banner repeats it.
  expect(screen.queryByTestId("itinerary-ideas-schedule-error")).toBeNull();
  expect(screen.getByTestId("itinerary-ideas-schedule-sheet")).toBeOnTheScreen();
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();

  // Editing a field retires the previous attempt's server reason.
  await pickDay(new Date(2027, 2, 3, 12));
  expect(screen.queryByTestId("itinerary-ideas-schedule-status-error")).toBeNull();

  await closeSheet();
});

it("error: a refusal that maps to no field (the stale 'known times' 400) is the generic banner, with no field error", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking()] },
    overrides: {
      [SCHEDULE_ROUTE]: () =>
        Promise.reject(
          new ApiRequestError(
            400,
            "VALIDATION_FAILED",
            "booking has known times — its calendar presence is automatic",
            { starts_at: "known" },
          ),
        ),
    },
  });
  await openSheet(BOOKING_IDEA_ID, "planned");
  await pickDay();
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-button-confirm"));

  await waitFor(() =>
    expect(screen.getByTestId("itinerary-ideas-schedule-error")).toBeOnTheScreen(),
  );
  expect(screen.queryByTestId("itinerary-ideas-schedule-status-error")).toBeNull();
  await closeSheet();
});

// --- cancelled / viewers ----------------------------------------------------

it("cancelled bookings live in their own PEER bin — collapsed by default, never actionable (B-13, R-itin-12)", async () => {
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
  // Control: the idea card in the SAME render does carry its actions…
  expect(screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  // …the cancelled card carries neither (transitions out of cancelled are ✖).
  expect(screen.queryByTestId(`itinerary-ideas-planned-${CANCELLED_ID}`)).toBeNull();
  expect(screen.queryByTestId(`itinerary-ideas-booked-${CANCELLED_ID}`)).toBeNull();
});

// Falsify: give `cancelled` a rank in `isStatusActionOffered` (drop its
// guard) ⇒ the leaked cancelled card grows Planned/Booked ⇒ RED. The
// Cancelled-bin test above can't catch this: that bin never renders actions.
it("adversarial: a CANCELLED row that leaks into the Ideas bin (stale list) still offers no actions", async () => {
  const leaked = makeBooking({
    id: CANCELLED_ID,
    category: "flight",
    status: "cancelled",
    title: "Leaked cancelled",
    starts_at: null,
  });
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking(), leaked] } });
  await expandIdeas();
  expect(screen.getByTestId(`itinerary-ideas-item-${CANCELLED_ID}`)).toBeOnTheScreen();
  expect(screen.queryByTestId(`itinerary-ideas-planned-${CANCELLED_ID}`)).toBeNull();
  expect(screen.queryByTestId(`itinerary-ideas-booked-${CANCELLED_ID}`)).toBeNull();
  // Control: the sibling idea card is actionable.
  expect(screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
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
  await expandIdeas();
  expect(screen.getByTestId(`itinerary-ideas-item-${BOOKING_IDEA_ID}`)).toBeOnTheScreen();
  expect(screen.queryByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`)).toBeNull();
  expect(screen.queryByTestId(`itinerary-ideas-booked-${BOOKING_IDEA_ID}`)).toBeNull();
});

// --- seeds, prefill, freshness (pre-existing B-10/B-16 pins, re-pointed) -----

/**
 * PR #40 R1 (tests lane): the sheet Day seed chain (IdeasBucket's
 * `contextDay={trip.start_date}` → form → DateField) was unpinned — severing
 * it left the suite green while the picker reverted to opening on today. Red
 * when any link of that chain is dropped: TRIP_START (2027-03-01) is not
 * today.
 */
it("the schedule sheet's Day picker seeds from the trip start (B-10 seed-chain pin)", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await openSheet(BOOKING_IDEA_ID, "planned");
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day"));
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day-picker").props.date).toBe(
    new Date(2027, 2, 1, 12).getTime(),
  );
  // Close the picker card, then the sheet, draining its exit (SHEET TAX).
  await fireEvent.press(screen.getByTestId("itinerary-ideas-schedule-input-day-sheet-close"));
  await closeSheet();
});

/**
 * B-16 PREFILL, re-pointed (T-7.15): a booking whose details carry a PARTIAL
 * time that the server still treats as timeless (an END with no start —
 * `starts_at` null) opens the schedule sheet with it as the pickers' VALUES;
 * the field rows themselves display the carried wall values and the confirm is
 * immediately tappable. (A start-bearing booking no longer reaches the
 * pickers at all — it takes the read-only status route, pinned above.)
 */
it("B-16 prefill: a timeless booking carrying an end time opens with it as the pickers' VALUES, confirm tappable", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaEndOnly()] } });
  await openSheet(END_ONLY_IDEA_ID, "planned");

  // VALUES, not seeds: the rows read back their set value…
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-end-time").props.accessibilityLabel,
  ).toBe("End time (optional), 16:00");
  // …start was never carried, so it stays a placeholder.
  expect(
    screen.getByTestId("itinerary-ideas-schedule-input-start-time").props.accessibilityLabel,
  ).toBe("Start time (optional), select time");
  expect(screen.getByText("16:00")).toBeOnTheScreen();
  expect(screen.queryByText("Select date")).toBeNull();
  // …and "user taps confirm": nothing to re-enter.
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

  await closeSheet();
});

/**
 * Control arm: an idea with NO carried times keeps empty fields (placeholders
 * showing), confirm disabled until a day is picked. Discriminates
 * prefill-from-carried-times from "prefill everything".
 */
it("B-16 prefill control: an idea without carried times still opens empty, confirm disabled", async () => {
  await renderBucket({ api: { bookings: [...defaultBookings(), ideaBooking()] } });
  await openSheet(BOOKING_IDEA_ID, "planned");

  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByText("Select date")).toBeOnTheScreen();
  expect(screen.getAllByText("Select time")).toHaveLength(2);
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  await closeSheet();
});

/**
 * PR #48 R1 (tests lane): per-action state FRESHNESS. The mechanism that
 * applies each card's prefill is the per-action `key` remount — deleting it
 * left the suite green while a card's day/times could leak into the next
 * card's form (one tap then schedules booking B onto booking A's day).
 *
 * Two legs, one render, three fixtures:
 *  - close → reopen (the user-reachable path): fresh state through the
 *    null-unmount;
 *  - direct target switch WITHOUT passing through null (the end-only sheet
 *    open, press the timeless idea's row button, then the known-times card's —
 *    which also flips the sheet between its schedule and status ROUTES): the
 *    one transition where the `key` is the ONLY guard. Unreachable by touch
 *    today (rows sit behind the open sheet) but it is the render-level
 *    contract the future polish relies on, pinned at the level where it can
 *    actually fail.
 */
it("B-16 prefill freshness: state never leaks across cards or routes — close/reopen AND a direct target switch both start clean (key remount pin)", async () => {
  await renderBucket({
    api: { bookings: [...defaultBookings(), ideaBooking(), ideaEndOnly(), ideaWithTimes()] },
  });
  await expandIdeas();

  // Leg 1a: the end-only booking opens prefilled…
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-planned-${END_ONLY_IDEA_ID}`));
  expect(screen.getByText('Mark "Closing ceremony" as Planned')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );

  // …close (drain the exit — SHEET TAX)…
  await closeSheet();

  // Leg 1b: …and the timeless idea reopens EMPTY — nothing carried over.
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`));
  expect(screen.getByText('Mark "TeamLab Planets" as Planned')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();

  // Leg 2: switch targets while the sheet is OPEN (no null pass-through).
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-planned-${END_ONLY_IDEA_ID}`));
  expect(screen.getByText('Mark "Closing ceremony" as Planned')).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, 2027-03-02",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).not.toBeDisabled();

  // …to the known-times card: the form flips to the read-only status route…
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-planned-${WITH_TIMES_IDEA_ID}`));
  expect(screen.getByText('Mark "Sumo tournament" as Planned')).toBeOnTheScreen();
  expect(screen.queryByTestId("itinerary-ideas-schedule-input-day")).toBeNull();
  expect(screen.getByTestId("itinerary-ideas-schedule-readonly-start")).toBeOnTheScreen();

  // …and back to the timeless idea: empty again, no leak either direction.
  await fireEvent.press(screen.getByTestId(`itinerary-ideas-planned-${BOOKING_IDEA_ID}`));
  expect(screen.getByTestId("itinerary-ideas-schedule-input-day").props.accessibilityLabel).toBe(
    "Day, select date",
  );
  expect(screen.getByTestId("itinerary-ideas-schedule-button-confirm")).toBeDisabled();
  expect(screen.queryByTestId("itinerary-ideas-schedule-readonly-start")).toBeNull();

  await closeSheet();
});
