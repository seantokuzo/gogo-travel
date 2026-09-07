/**
 * Add/edit form modal (T-7.6 / IT-7 — §2.4, R-itin-18/19/23, R-ib-11/18)
 * over the REAL data hooks (network mocked by descriptor). Wire bodies are
 * re-parsed with the SHARED schemas — falsifiable pins, not hope:
 *
 *  - category step renders the 10-option inventory when `?category=` is
 *    absent; picking one mounts that type's form + form-surface deeplink
 *    buttons (R-itin-21 enablement is DeeplinkPanel's, consumed as-is);
 *  - create body is a valid BookingCreate (status default, Law #2 cents,
 *    `source: 'deeplink_return'` when landed from the return prompt);
 *  - §2.4 save routing: day-only prefill → create THEN schedule (R-ib-8);
 *    day+time gap-tap prefill → primary start preset, auto-scheduled
 *    server-side (NO schedule call);
 *  - edit modes prefill from the wire and PATCH with no status self-loop;
 *  - place_visit uses the CT-2 typeahead against /places/search;
 *  - viewers get the read-only notice (R-ib-24).
 */
import {
  BookingCreateSchema,
  BookingUpdateSchema,
  deriveBookingInstants,
  ItineraryItemCreateSchema,
  ItineraryItemUpdateSchema,
  ScheduleBookingInputSchema,
  type BookingWithItems,
} from "@gogo/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ItineraryItemNewScreen from "@/app/[tripId]/itinerary/item/new";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_IDEA_ID,
  ITEM_B_ID,
  itineraryApiOverrides,
  makeBooking,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};

/**
 * `beforeRemove` listeners registered by the screen. Capturing them (rather
 * than swallowing them, as this mock originally did) is what makes the §2.6
 * dirty-guard / discard-confirm machinery reachable from a test at all.
 */
let mockBeforeRemoveListeners: ((event: BeforeRemoveEvent) => void)[] = [];

interface BeforeRemoveEvent {
  preventDefault(): void;
  data: { action: unknown };
}

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({
    addListener: (event: string, listener: (e: BeforeRemoveEvent) => void) => {
      if (event === "beforeRemove") mockBeforeRemoveListeners.push(listener);
      return () => {
        mockBeforeRemoveListeners = mockBeforeRemoveListeners.filter((l) => l !== listener);
      };
    },
    dispatch: jest.fn(),
  }),
}));

/** Fire the navigator event every dismissal route funnels through (nav §2.6). */
async function attemptDismiss(): Promise<{ prevented: boolean }> {
  let prevented = false;
  await act(async () => {
    for (const listener of mockBeforeRemoveListeners) {
      listener({
        preventDefault: () => {
          prevented = true;
        },
        data: { action: { type: "POP" } },
      });
    }
  });
  return { prevented };
}

const PLACE = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "Shibuya Crossing",
  lat: 35.6595,
  lng: 139.7005,
  category: "landmark",
};

async function renderScreen(
  params: Record<string, string>,
  opts?: {
    api?: ItineraryApiOptions;
    overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
    role?: "owner" | "viewer";
  },
) {
  mockParams = { tripId: TEST_TRIP_ID, ...params };
  seedAuthenticated();
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
  await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryItemNewScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { request, trip };
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockParams = {};
  mockBeforeRemoveListeners = [];
});

it("no ?category= → the 10-option step; picking flight mounts its form + partner buttons", async () => {
  await renderScreen({});
  expect(screen.getByTestId("itinerary-item-new-screen")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-add-option-place-visit")).toBeOnTheScreen();

  await fireEvent.press(screen.getByTestId("itinerary-add-option-flight"));
  // Picking the option MOUNTS the flight form (and its DeeplinkPanel, whose
  // members read fires now) — settle that query's notify batch inside act.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByTestId("itinerary-item-new-input-airline")).toBeOnTheScreen();
  expect(screen.getByTestId("itinerary-item-new-input-origin-iata")).toBeOnTheScreen();
  // Form-surface deeplink buttons (§2.9 partner slugs) — disabled until
  // their fields exist; enablement logic is DeeplinkPanel's own suite.
  expect(screen.getByTestId("itinerary-item-new-button-search-kayak")).toBeDisabled();
  expect(screen.getByTestId("itinerary-item-new-button-search-skyscanner")).toBeDisabled();
});

it("B-20: code fields uppercase as-you-type; a bad IATA code blocks save with a field error", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "flight" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "flight", status: "idea", starts_at: null }),
          );
        },
      },
    },
  );

  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "SFO to Tokyo");
  // As-you-type normalization — lowercase in, uppercase rendered.
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-origin-iata"), "sfo");
  expect(screen.getByTestId("itinerary-item-new-input-origin-iata").props.value).toBe("SFO");
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-flight-number"),
    "ua837",
  );
  expect(screen.getByTestId("itinerary-item-new-input-flight-number").props.value).toBe("UA837");
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-confirmation"),
    "abc123",
  );
  expect(screen.getByTestId("itinerary-item-new-input-confirmation").props.value).toBe("ABC123");

  // Save-time IATA gate: 2 letters → FIELD error (never the generic banner),
  // no wire call.
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-destination-iata"),
    "nr",
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  expect(created).toHaveLength(0);
  expect(screen.getByTestId("itinerary-item-new-input-destination-iata-error")).toBeOnTheScreen();

  // Fixing the code clears the gate; the body carries normalized values.
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-destination-iata"),
    "nrt",
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));
  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body.details).toMatchObject({
    origin_iata: "SFO",
    destination_iata: "NRT",
    flight_number: "UA837",
  });
  expect(body.confirmation_code).toBe("ABC123");
});

it("B-20 R1: field traits reach the rendered Inputs — prop pins on the traits→Input seam", async () => {
  // jest's fireEvent.changeText BYPASSES native maxLength (and keyboards
  // don't exist under jest at all), so prop assertions are the only
  // red-capable pin shape for this class — behavioral typing tests stay
  // green with the trait wiring dead (round-1 P5/P7 probes). These pins
  // kill P5: strip keyboardType/autoCapitalize/autoCorrect/maxLength from
  // BookingForm's detail Input and they go red.
  await renderScreen({ category: "flight" });

  const iata = screen.getByTestId("itinerary-item-new-input-origin-iata");
  // B-9 widened this cap from B-20's 3 to the WIRE cap (optionalString 200):
  // the field is now the airport typeahead, so "Narita International" has to
  // be typeable. Never tighter than the wire — the B-20 rule holds; the
  // 3-letter narrowing moved to the SAVE gate (pinned above) where a picked
  // airport, not a maxLength, is what produces a code.
  expect(iata.props.maxLength).toBe(200);
  expect(iata.props.autoCapitalize).toBe("characters");
  expect(iata.props.autoCorrect).toBe(false);

  // Plain text detail field — the optionalString(200) wire-cap mirror.
  expect(screen.getByTestId("itinerary-item-new-input-airline").props.maxLength).toBe(200);

  // Confirmation code — the shared ConfirmationCodeSchema max(100) mirror
  // plus its code-field casing traits (call-site literals, round-1 P7).
  const confirmation = screen.getByTestId("itinerary-item-new-input-confirmation");
  expect(confirmation.props.maxLength).toBe(100);
  expect(confirmation.props.autoCapitalize).toBe("characters");
  expect(confirmation.props.autoCorrect).toBe(false);
});

it("B-20 R1: int fields render the number pad — prop pin", async () => {
  await renderScreen({ category: "lodging" });
  const guests = screen.getByTestId("itinerary-item-new-input-guests");
  expect(guests.props.keyboardType).toBe("number-pad");
  expect(guests.props.maxLength).toBe(9);
});

it("B-20: lowercase currency normalizes as-you-type and reaches the wire uppercase", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "activity" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "activity", status: "idea", starts_at: null }),
          );
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Kaiseki");
  // R1 prop pin (round-1 P6 — the zero-decimal branch was invertible):
  // 2-decimal default (trip base USD) gets the decimal pad…
  expect(screen.getByTestId("itinerary-item-new-input-price").props.keyboardType).toBe(
    "decimal-pad",
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-currency"), "jpy");
  expect(screen.getByTestId("itinerary-item-new-input-currency").props.value).toBe("JPY");
  // …and a zero-decimal currency flips it to the plain number pad (the
  // decimal key's only product for JPY would be a parse error).
  expect(screen.getByTestId("itinerary-item-new-input-price").props.keyboardType).toBe(
    "number-pad",
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-price"), "1500");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(created).toHaveLength(1));
  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  // The zero-decimal parse consulted the NORMALIZED currency — 1500 minor
  // units, not a 100× corruption (Law #2 arm of the uppercase pin).
  expect(body.currency).toBe("JPY");
  expect(body.price_cents).toBe(1500);
});

it("booking create: body is a valid BookingCreate — default idea status, Law #2 cents", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "activity" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "activity", status: "idea", starts_at: null }),
          );
        },
      },
    },
  );

  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-title"),
    "TeamLab Planets",
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-price"), "89.99");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(created).toHaveLength(1));
  const input = created[0] as { params: unknown; body: unknown };
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID });
  const body = BookingCreateSchema.parse(input.body);
  expect(body.category).toBe("activity");
  expect(body.title).toBe("TeamLab Planets");
  expect(body.status).toBe("idea");
  expect(body.price_cents).toBe(8999); // integer cents — never a float parse
  expect(body.currency).toBe("USD"); // trip base_currency default
  expect(body.source).toBeUndefined(); // manual is the server default
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it("JPY price wires zero-decimal minor units WITH the picked currency (T-9.1 R1 — save-site wiring)", async () => {
  // R1 finding: the save-site currency argument had zero coverage — a
  // mutation hardwiring the parse to trip.base_currency stayed green
  // everywhere. The USD test above is the control arm (base-currency
  // default); this one PICKS a different, zero-decimal currency and pins
  // both halves of the wire body.
  const created: unknown[] = [];
  await renderScreen(
    { category: "activity" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "activity", status: "idea", starts_at: null }),
          );
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Kaiseki");
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-currency"), "JPY");
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-price"), "1500");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(created).toHaveLength(1));
  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body.price_cents).toBe(1500); // NOT 150000 — the parse consulted the typed currency
  expect(body.currency).toBe("JPY");
});

it("decimal input under JPY blocks the save with the price error — no wire call (T-9.1 R1)", async () => {
  // Control arm for the rejection: the USD test above saves "89.99" fine —
  // the block is the CURRENCY's, not a parser-wide regression.
  const created: unknown[] = [];
  await renderScreen(
    { category: "activity" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(makeBooking({ id: BOOKING_IDEA_ID }));
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Kaiseki");
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-currency"), "JPY");
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-price"), "15.00");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  expect(created).toHaveLength(0);
  expect(screen.getByTestId("itinerary-item-new-input-price-error")).toBeOnTheScreen();
});

it("edit prefill formats the price BY the booking's currency (JPY 1500 → '1500', not '15.00') — first priced edit-mode pin", async () => {
  const existing: BookingWithItems = {
    ...makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      starts_at: null,
      title: "Kaiseki",
      price_cents: 1500,
      currency: "JPY",
    }),
    items: [],
  };
  await renderScreen(
    { bookingId: BOOKING_IDEA_ID },
    {
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
      },
    },
  );
  const price = await screen.findByTestId("itinerary-item-new-input-price");
  expect(price.props.value).toBe("1500");
  expect(screen.getByTestId("itinerary-item-new-input-currency").props.value).toBe("JPY");
});

it("an invalid price blocks the save client-side (Law #2) — no wire call", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "activity" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(makeBooking({ id: BOOKING_IDEA_ID }));
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "X");
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-price"), "1.234");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  expect(created).toHaveLength(0);
  expect(screen.getByTestId("itinerary-item-new-input-price-error")).toBeOnTheScreen();
});

it("return-prompt landing pins source: 'deeplink_return' on the wire (R-ib-11)", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "lodging", source: "deeplink_return" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "lodging", status: "idea", starts_at: null }),
          );
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Park Hyatt");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));
  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body.source).toBe("deeplink_return");
});

it("day-only prefill: timeless create THEN schedule (§2.4 routing, R-ib-8)", async () => {
  const created: unknown[] = [];
  const scheduled: unknown[] = [];
  const idea = makeBooking({
    id: BOOKING_IDEA_ID,
    category: "activity",
    status: "idea",
    starts_at: null,
  });
  const postState: BookingWithItems = { ...idea, status: "planned", items: [] };
  await renderScreen(
    { category: "activity", day: TRIP_DAY_2 },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(idea);
        },
        "POST /trips/:tripId/bookings/:bookingId/schedule": (input) => {
          scheduled.push(input);
          return Promise.resolve(postState);
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(scheduled).toHaveLength(1));
  expect(created).toHaveLength(1);
  const scheduleInput = scheduled[0] as { params: unknown; body: unknown };
  expect(scheduleInput.params).toEqual({ tripId: TEST_TRIP_ID, bookingId: BOOKING_IDEA_ID });
  expect(ScheduleBookingInputSchema.parse(scheduleInput.body)).toEqual({ day: TRIP_DAY_2 });
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it("the chain input is day-only even when a TIME prefill is present (round-2: the previous pin had no ?time=)", async () => {
  // Round-2: the day-only pin above renders WITHOUT `?time=`, so `prefillTime`
  // is undefined there and the removed `start_time` spread was a no-op — the
  // pin passed pre-fix too. Here the time prefill IS present, so a
  // `...(prefillTime ? {start_time: prefillTime} : {})` in the chain input
  // would ride onto the wire.
  //
  // The branch is reached via SERVER TRUTH: the client chains on
  // `created.starts_at === null`, so a response reporting the booking as
  // timeless is exactly the state the code keys on — pinning the contract
  // ("whatever the prefills were, the chain schedules day-only") rather than
  // a UI path.
  const scheduled: unknown[] = [];
  const idea = makeBooking({
    id: BOOKING_IDEA_ID,
    category: "activity",
    status: "idea",
    starts_at: null,
  });
  await renderScreen(
    { category: "activity", day: TRIP_DAY_2, time: "14:00" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": () => Promise.resolve(idea),
        "POST /trips/:tripId/bookings/:bookingId/schedule": (input) => {
          scheduled.push(input);
          return Promise.resolve({ ...idea, status: "planned", items: [] });
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(scheduled).toHaveLength(1));
  const body = ScheduleBookingInputSchema.parse((scheduled[0] as { body: unknown }).body);
  expect(body).toEqual({ day: TRIP_DAY_2 });
  expect(body.start_time).toBeUndefined();
});

it("gap-tap prefill (day+time): primary start preset, auto-scheduled — NO schedule call (R-itin-14/I-2)", async () => {
  const created: unknown[] = [];
  const scheduled: unknown[] = [];
  await renderScreen(
    { category: "activity", day: TRIP_DAY_2, time: "14:00" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          // Server derives instants from the composed details (I-2).
          return Promise.resolve(
            makeBooking({
              id: BOOKING_IDEA_ID,
              category: "activity",
              status: "planned",
              starts_at: "2027-03-02T14:00:00.000Z",
            }),
          );
        },
        "POST /trips/:tripId/bookings/:bookingId/schedule": (input) => {
          scheduled.push(input);
          return Promise.resolve({});
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen");
  await fireEvent.press(
    screen.getByTestId("itinerary-item-new-segment-status-planned"),
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(created).toHaveLength(1));
  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body.details).toMatchObject({
    category: "activity",
    starts_at: `${TRIP_DAY_2}T14:00:00Z`,
  });
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(scheduled).toHaveLength(0);
});

it("booking edit: prefilled from the detail read; PATCH is a valid BookingUpdate with NO status self-loop", async () => {
  const patched: unknown[] = [];
  const existing: BookingWithItems = {
    ...makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      starts_at: null,
      title: "Old name",
      details: { category: "activity", venue_name: "TeamLab" },
    }),
    items: [],
  };
  await renderScreen(
    { bookingId: BOOKING_IDEA_ID },
    {
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
        "PATCH /trips/:tripId/bookings/:bookingId": (input) => {
          patched.push(input);
          return Promise.resolve({ ...existing, title: "New name" });
        },
      },
    },
  );

  const titleInput = await screen.findByTestId("itinerary-item-new-input-title");
  expect(titleInput.props.value).toBe("Old name");
  expect(screen.getByTestId("itinerary-item-new-input-venue-name").props.value).toBe("TeamLab");

  await fireEvent.changeText(titleInput, "New name");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(patched).toHaveLength(1));
  const input = patched[0] as { params: unknown; body: Record<string, unknown> };
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID, bookingId: BOOKING_IDEA_ID });
  const body = BookingUpdateSchema.parse(input.body);
  expect(body.title).toBe("New name");
  expect(body.details).toMatchObject({ category: "activity", venue_name: "TeamLab" });
  // Status untouched ⇒ absent (§3.2 has no self-loops).
  expect("status" in input.body).toBe(false);
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it("B-20 R1: a stored non-code IATA value never blocks a title-only edit — untouched prefill rides verbatim", async () => {
  // Pre-B-20 / AI-capture rows can legally store origin_iata "Narita"
  // (wire optionalString 200). The save-time gate guards what the USER
  // typed — an untouched prefill must neither error nor mutate (round-1
  // correctness lane). This pins the SCREEN threading: BookingForm must
  // hand its initial state to buildDetails or the gate strands the row.
  const patched: unknown[] = [];
  const existing: BookingWithItems = {
    ...makeBooking({
      id: BOOKING_IDEA_ID,
      category: "flight",
      status: "idea",
      starts_at: null,
      title: "Old name",
      details: { category: "flight", origin_iata: "Narita" },
    }),
    items: [],
  };
  await renderScreen(
    { bookingId: BOOKING_IDEA_ID },
    {
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
        "PATCH /trips/:tripId/bookings/:bookingId": (input) => {
          patched.push(input);
          return Promise.resolve({ ...existing, title: "New name" });
        },
      },
    },
  );

  const titleInput = await screen.findByTestId("itinerary-item-new-input-title");
  await fireEvent.changeText(titleInput, "New name");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(patched).toHaveLength(1));
  const body = BookingUpdateSchema.parse((patched[0] as { body: unknown }).body);
  expect(body.title).toBe("New name");
  expect(body.details).toMatchObject({ category: "flight", origin_iata: "Narita" });
  expect(screen.queryByTestId("itinerary-item-new-input-origin-iata-error")).toBeNull();
});

it("place visit: CT-2 typeahead against /places/search; create body is a valid ItineraryItemCreate (R-itin-23)", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "place-visit", day: TRIP_DAY_2 },
    {
      overrides: {
        "GET /places/search": () => Promise.resolve({ items: [PLACE], nextCursor: null }),
        "POST /trips/:tripId/itinerary/items": (input) => {
          created.push(input);
          return Promise.resolve({});
        },
      },
    },
  );

  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-place"),
    "Shibuya Crossing",
  );
  await fireEvent.press(
    await screen.findByTestId(`itinerary-item-new-input-place-result-${PLACE.id}`),
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));

  await waitFor(() => expect(created).toHaveLength(1));
  const body = ItineraryItemCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body).toEqual({ kind: "place_visit", place_id: PLACE.id, day: TRIP_DAY_2 });
});

it("?placeId= preselect (T-8.4 / R-map-12): the picker arrives filled and the create writes that place_id — no search round-trip", async () => {
  const created: unknown[] = [];
  const searched: unknown[] = [];
  await renderScreen(
    {
      category: "place-visit",
      day: TRIP_DAY_2,
      placeId: PLACE.id,
      placeName: "Shibuya Crossing",
    },
    {
      overrides: {
        "GET /places/search": (input) => {
          searched.push(input);
          return Promise.resolve({ items: [], nextCursor: null });
        },
        "POST /trips/:tripId/itinerary/items": (input) => {
          created.push(input);
          return Promise.resolve({});
        },
      },
    },
  );
  // The picker carries the preselected name — no typeahead needed.
  expect(screen.getByTestId("itinerary-item-new-input-place")).toHaveDisplayValue(
    "Shibuya Crossing",
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));
  const body = ItineraryItemCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body).toEqual({ kind: "place_visit", place_id: PLACE.id, day: TRIP_DAY_2 });
  // The preselect is REAL, not display-only: no search call was ever made.
  expect(searched).toEqual([]);
});

it("a malformed ?placeId= degrades to the empty picker (validated against the shared scalar — never a malformed write)", async () => {
  await renderScreen({ category: "place-visit", placeId: "not-a-uuid", placeName: "X" });
  expect(screen.getByTestId("itinerary-item-new-input-place")).toHaveDisplayValue("");
});

it("an oversized ?placeName= renders CAPPED at 100 chars (R1 security review — display-only, id-truth write)", async () => {
  // The param is attacker-shaped (any deep link): a multi-hundred-KB name
  // must never render unbounded. The cap is display-only — the create body
  // still carries place_id alone, pinned by the preselect test above.
  await renderScreen({
    category: "place-visit",
    placeId: PLACE.id,
    placeName: "x".repeat(500),
  });
  expect(screen.getByTestId("itinerary-item-new-input-place")).toHaveDisplayValue(
    "x".repeat(100),
  );
});

it("custom block consumes day+time prefills into a valid ItineraryItemCreate", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "custom", day: TRIP_DAY_2, time: "09:30" },
    {
      overrides: {
        "POST /trips/:tripId/itinerary/items": (input) => {
          created.push(input);
          return Promise.resolve({});
        },
      },
    },
  );
  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Walk");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(ItineraryItemCreateSchema.parse((created[0] as { body: unknown }).body)).toEqual({
    kind: "custom",
    title: "Walk",
    day: TRIP_DAY_2,
    start_time: "09:30",
  });
});

it("item edit resolves from the composite read and PATCHes a valid ItineraryItemUpdate (LWW)", async () => {
  const patched: unknown[] = [];
  await renderScreen(
    { itemId: ITEM_B_ID },
    {
      overrides: {
        "PATCH /trips/:tripId/itinerary/items/:itemId": (input) => {
          patched.push(input);
          return Promise.resolve({});
        },
      },
    },
  );
  const title = await screen.findByTestId("itinerary-item-new-input-title");
  expect(title.props.value).toBe("Walk Shibuya");
  await fireEvent.changeText(title, "Walk Shibuya at night");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(patched).toHaveLength(1));
  const input = patched[0] as { params: unknown; body: unknown };
  expect(input.params).toEqual({ tripId: TEST_TRIP_ID, itemId: ITEM_B_ID });
  const body = ItineraryItemUpdateSchema.parse(input.body);
  expect(body).toMatchObject({
    title: "Walk Shibuya at night",
    day: TRIP_START,
    start_time: null,
    end_time: null,
    notes: null,
  });
});

it("booking-kind items never edit here (R-itin-27)", async () => {
  await renderScreen({ itemId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1" });
  await screen.findByTestId("itinerary-item-new-uneditable");
  expect(screen.queryByTestId("itinerary-item-new-button-save")).toBeNull();
});

describe("discard guard copy (nav §2.6; round-2 N2)", () => {
  it("a clean form dismisses freely; a dirty one intercepts with the plain copy", async () => {
    await renderScreen({ category: "activity" });

    // Clean → no interception at all.
    expect((await attemptDismiss()).prevented).toBe(false);

    await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen");
    expect((await attemptDismiss()).prevented).toBe(true);
    expect(screen.getByText("Discard this entry?")).toBeOnTheScreen();
    expect(screen.getByText("Nothing you've entered will be saved.")).toBeOnTheScreen();
  });

  it("after a partial success the copy tells the truth: the booking is already in Ideas", async () => {
    // create succeeds, the schedule leg fails — the booking EXISTS. Claiming
    // "nothing will be saved" here reads as "your entry is gone" and invites
    // a duplicate re-create.
    const idea = makeBooking({
      id: BOOKING_IDEA_ID,
      category: "activity",
      status: "idea",
      starts_at: null,
    });
    await renderScreen(
      { category: "activity", day: TRIP_DAY_2 },
      {
        overrides: {
          "POST /trips/:tripId/bookings": () => Promise.resolve(idea),
          "POST /trips/:tripId/bookings/:bookingId/schedule": () =>
            Promise.reject(new Error("409")),
        },
      },
    );

    await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen");
    await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
    await waitFor(() =>
      expect(screen.getByTestId("itinerary-item-new-saved-to-ideas")).toBeOnTheScreen(),
    );

    // The write retired the guard, so a dismissal right now passes through.
    expect((await attemptDismiss()).prevented).toBe(false);

    // …but any later edit re-arms it (verifier N3: `dirty` correctly
    // re-arms — no data loss), and THEN the dialog must not lie.
    await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Onsen ryokan");
    expect((await attemptDismiss()).prevented).toBe(true);
    expect(screen.getByText("Discard these changes?")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Your booking is already saved in Ideas — only the edits you've made since then will be lost.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("Nothing you've entered will be saved.")).toBeNull();
  });
});

/**
 * PR #49 R1 (correctness lane) — Done on an UNCHANGED picker value must not
 * arm the §2.6 dirty guard. New with B-15a: before it, no same-value commit
 * path existed (change-only native events), so `touch`/`setDetailField`
 * could latch onDirty unconditionally. Scenario fixed: edit → peek at the
 * calendar → Done → swipe-dismiss showed "Discard changes?" with zero
 * changes. Compare-before-latch now lives at the picker call sites; the
 * settings form is comparison-derived and was never affected.
 */
describe("same-value Done leaves the dirty guard unarmed (PR #49 R1)", () => {
  // Kill-mutation: revert ItemForm's Day onSelect to `touch(setDay)` → the
  // first dismissal is intercepted → red. Control arm in the same test: a
  // REAL day change through the same picker still arms the guard.
  it("edit item: peek at the prefilled Day, Done — clean; a real change arms", async () => {
    await renderScreen({ itemId: ITEM_B_ID });
    await screen.findByTestId("itinerary-item-new-input-title");

    // Peek: open the Day picker (prefilled TRIP_START) and Done it shut.
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-day"));
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-day-sheet-done"));
    expect((await attemptDismiss()).prevented).toBe(false);

    // Control: a genuinely different day still arms.
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-day"));
    await fireEvent(screen.getByTestId("itinerary-item-new-input-day-picker"), "onChange", {
      nativeEvent: { timestamp: new Date(2027, 2, 2, 12).getTime(), utcOffset: 0 },
    });
    expect((await attemptDismiss()).prevented).toBe(true);
    // The discard confirm actually presented (copy wording is pinned by the
    // §2.6 copy describe above — here only the arming matters).
    expect(screen.getByTestId("itinerary-item-new-button-cancel-confirm")).toBeOnTheScreen();
  });

  // Kill-mutation: drop either same-value guard at BookingForm's datetime
  // call sites → the first dismissal is intercepted → red. Both halves are
  // peeked (date AND time) so each guard is individually load-bearing.
  it("edit booking: peek at a prefilled datetime (date + time), Done — clean; a real change arms", async () => {
    const existing: BookingWithItems = {
      ...makeBooking({
        id: BOOKING_IDEA_ID,
        category: "activity",
        status: "idea",
        starts_at: null,
        title: "Kaiseki",
        details: {
          category: "activity",
          venue_name: "TeamLab",
          starts_at: "2027-03-02T14:30:00+09:00",
        },
      }),
      items: [],
    };
    await renderScreen(
      { bookingId: BOOKING_IDEA_ID },
      {
        overrides: {
          "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
        },
      },
    );
    await screen.findByTestId("itinerary-item-new-input-starts-at-date");

    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-starts-at-date"));
    await fireEvent.press(
      screen.getByTestId("itinerary-item-new-input-starts-at-date-sheet-done"),
    );
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-starts-at-time"));
    await fireEvent.press(
      screen.getByTestId("itinerary-item-new-input-starts-at-time-sheet-done"),
    );
    expect((await attemptDismiss()).prevented).toBe(false);

    // Control: a genuinely different time still arms.
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-starts-at-time"));
    await fireEvent(
      screen.getByTestId("itinerary-item-new-input-starts-at-time-picker"),
      "onChange",
      { nativeEvent: { timestamp: new Date(2000, 0, 1, 15, 45).getTime(), utcOffset: 0 } },
    );
    expect((await attemptDismiss()).prevented).toBe(true);
  });
});

it("viewers get the read-only notice — no form, no save (R-ib-24)", async () => {
  await renderScreen({ category: "activity" }, { role: "viewer" });
  expect(screen.getByTestId("itinerary-item-new-viewer")).toBeOnTheScreen();
  expect(screen.queryByTestId("itinerary-item-new-button-save")).toBeNull();
});

/**
 * B-10b/c contextual picker seeds (device QA 2026-08-29): date pickers must
 * never open on TODAY inside a trip flow. The pairing is the CALLER's
 * (BookingForm maps each datetime field to its sibling, falling back to the
 * trip start), so it is pinned here through the real flight form. Seeds are
 * asserted through the picker wrapper's public `date` translation
 * (`dateToMilliseconds(value)` — the same channel the native side reads).
 * TRIP_START (2027-03-01) differs from any plausible "today", so the
 * no-departure arm genuinely discriminates trip-start from the old default.
 */
it("flight arrival seeds from the entered departure — trip start before that (B-10)", async () => {
  await renderScreen({ category: "flight" });

  // CONTROL ARM (no departure entered yet): the arrival DATE picker opens on
  // the trip's start date, not on today.
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-arrives-at-date"));
  expect(
    screen.getByTestId("itinerary-item-new-input-arrives-at-date-picker").props.date,
  ).toBe(new Date(2027, 2, 1, 12).getTime());
  await fireEvent.press(
    screen.getByTestId("itinerary-item-new-input-arrives-at-date-sheet-close"),
  );

  // Enter the departure date + time through their pickers.
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-departs-at-date"));
  await fireEvent(
    screen.getByTestId("itinerary-item-new-input-departs-at-date-picker"),
    "onChange",
    { nativeEvent: { timestamp: new Date(2027, 2, 2, 12).getTime(), utcOffset: 0 } },
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-departs-at-time"));
  await fireEvent(
    screen.getByTestId("itinerary-item-new-input-departs-at-time-picker"),
    "onChange",
    { nativeEvent: { timestamp: new Date(2027, 2, 2, 17, 5).getTime(), utcOffset: 0 } },
  );

  // Arrival DATE now seeds from the departure's day…
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-arrives-at-date"));
  expect(
    screen.getByTestId("itinerary-item-new-input-arrives-at-date-picker").props.date,
  ).toBe(new Date(2027, 2, 2, 12).getTime());
  await fireEvent.press(
    screen.getByTestId("itinerary-item-new-input-arrives-at-date-sheet-close"),
  );

  // …and the arrival TIME spinner from the departure's time (17:05 on the
  // TimeField's fixed 2000-01-01 carrier date).
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-arrives-at-time"));
  expect(
    screen.getByTestId("itinerary-item-new-input-arrives-at-time-picker").props.date,
  ).toBe(new Date(2000, 0, 1, 17, 5).getTime());
});

/**
 * PR #40 R1 (tests lane): the ItemForm Day seed chain (`contextDay=
 * {trip.start_date}` at item/new.tsx) was unpinned — severing it left the
 * suite green while the Day picker silently reverted to opening on today.
 * Red when that prop is removed: TRIP_START (2027-03-01) is not today.
 */
it("custom item Day picker seeds from the trip start when no day is prefilled (B-10 seed-chain pin)", async () => {
  await renderScreen({ category: "custom" });
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-day"));
  expect(screen.getByTestId("itinerary-item-new-input-day-picker").props.date).toBe(
    new Date(2027, 2, 1, 12).getTime(),
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-day-sheet-close"));
});

// ---------------------------------------------------------------------------
// B-9 client half — airport/airline pickers + the ZONED composition
// (the B-8 fix, end to end through the real screen)
// ---------------------------------------------------------------------------

/** Drive a DateField through its picker to a wall date. */
async function pickDate(testID: string, year: number, monthIndex: number, day: number) {
  await fireEvent.press(screen.getByTestId(testID));
  await fireEvent(screen.getByTestId(`${testID}-picker`), "onChange", {
    nativeEvent: { timestamp: new Date(year, monthIndex, day, 12).getTime(), utcOffset: 0 },
  });
}

/** Drive a TimeField through its picker to a wall time. */
async function pickTime(testID: string, hour: number, minute: number) {
  await fireEvent.press(screen.getByTestId(testID));
  await fireEvent(screen.getByTestId(`${testID}-picker`), "onChange", {
    nativeEvent: { timestamp: new Date(2000, 0, 1, hour, minute).getTime(), utcOffset: 0 },
  });
}

/** Type into an airport typeahead and pick the offered row. */
async function pickAirport(fieldTestID: string, query: string, iata: string) {
  await fireEvent.changeText(screen.getByTestId(fieldTestID), query);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await fireEvent.press(await screen.findByTestId(`${fieldTestID}-result-${iata}`));
}

it("B-9/B-8: the REAL Tokyo→LA flight — airport picks carry the zones and the wire gets correct offsets", async () => {
  // Sean's actual booking (device QA 2026-08-29), the entry B-8 made
  // impossible: depart NRT Apr 24 17:00 JST, arrive LAX Apr 24 10:00 PDT —
  // an arrival wall clock 7h "before" departure on the SAME date. Driven
  // through the real screen: pick each airport, type each wall time, save.
  const created: unknown[] = [];
  await renderScreen(
    { category: "flight" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "flight", starts_at: null }),
          );
        },
      },
    },
  );

  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "Tokyo to LA");
  await pickAirport("itinerary-item-new-input-origin-iata", "Narita", "NRT");
  await pickAirport("itinerary-item-new-input-destination-iata", "LAX", "LAX");

  // The picks are VISIBLE as zones — the whole point of the fix is that the
  // user can see what is about to be stamped. With no date entered yet the
  // label describes the TRIP START (2027-03-01), so LA reads GMT-8: US DST
  // has not begun. A label anchored on `Date.now()` would lie here.
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-tz")).toHaveTextContent(
    "Tokyo — GMT+9",
  );
  expect(screen.getByTestId("itinerary-item-new-input-arrives-at-tz")).toHaveTextContent(
    "Los Angeles — GMT-8",
  );

  await pickDate("itinerary-item-new-input-departs-at-date", 2027, 3, 24);
  await pickTime("itinerary-item-new-input-departs-at-time", 17, 0);
  await pickDate("itinerary-item-new-input-arrives-at-date", 2027, 3, 24);
  await pickTime("itinerary-item-new-input-arrives-at-time", 10, 0);

  // …and once the wall date IS April, the same zone reads GMT-7. Seasonal,
  // per endpoint, exactly what the composition below will use.
  expect(screen.getByTestId("itinerary-item-new-input-arrives-at-tz")).toHaveTextContent(
    "Los Angeles — GMT-7",
  );

  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));

  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  expect(body.details).toMatchObject({
    category: "flight",
    origin_iata: "NRT",
    destination_iata: "LAX",
    // Each endpoint's OWN offset — the fix, byte for byte.
    departs_at: "2027-04-24T17:00:00+09:00",
    departs_tz: "Asia/Tokyo",
    arrives_at: "2027-04-24T10:00:00-07:00",
    arrives_tz: "America/Los_Angeles",
  });
  // …and the instants the server derives are ordered, 9h apart. Under B-8's
  // `Z` composition this was a 7h INVERSION the 12h grace had to admit.
  expect(body.details).toBeDefined();
  if (body.details === undefined) return;
  const derived = deriveBookingInstants(body.details);
  expect(Date.parse(derived.ends_at ?? "") - Date.parse(derived.starts_at ?? "")).toBe(
    9 * 3_600_000,
  );
});

it("B-9: the flight number infers the airline — OFFERED, never auto-applied", async () => {
  await renderScreen({ category: "flight" });

  // Gate arm: input the SHARED parser rejects offers nothing (and, per
  // reference.test.tsx, fires no request — the PR #50 rider).
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-flight-number"),
    "ANA204",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    screen.queryByTestId("itinerary-item-new-input-flight-number-airline-suggestion"),
  ).toBeNull();

  // Parseable arm: the suggestion appears and the airline field stays
  // UNTOUCHED until the user takes it (no clobber, no spurious dirty guard).
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-flight-number"),
    "NH204",
  );
  const suggestion = await screen.findByTestId(
    "itinerary-item-new-input-flight-number-airline-suggestion",
  );
  expect(suggestion).toHaveTextContent(/Use All Nippon Airways/);
  expect(screen.getByTestId("itinerary-item-new-input-airline").props.value).toBe("");

  await fireEvent.press(suggestion);
  expect(screen.getByTestId("itinerary-item-new-input-airline").props.value).toBe(
    "All Nippon Airways",
  );
  // Taken ⇒ the offer retires (it only ever offers what isn't already there).
  await waitFor(() =>
    expect(
      screen.queryByTestId("itinerary-item-new-input-flight-number-airline-suggestion"),
    ).toBeNull(),
  );
});

it("B-9: trains reach a zone through the PICKER — no station table, same correct composition", async () => {
  const created: unknown[] = [];
  await renderScreen(
    { category: "train" },
    {
      overrides: {
        "POST /trips/:tripId/bookings": (input) => {
          created.push(input);
          return Promise.resolve(
            makeBooking({ id: BOOKING_IDEA_ID, category: "train", starts_at: null }),
          );
        },
      },
    },
  );

  await fireEvent.changeText(screen.getByTestId("itinerary-item-new-input-title"), "To Kyoto");
  // The picker is CITY-labelled, never a bare offset.
  await fireEvent.press(screen.getByTestId("itinerary-item-new-input-departs-at-tz"));
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-departs-at-tz-search"),
    "Athens",
  );
  const athens = await screen.findByTestId(
    "itinerary-item-new-input-departs-at-tz-result-europe-athens",
  );
  expect(athens).toHaveTextContent(/Athens — GMT\+\d/);
  await fireEvent.press(athens);
  // Labelled from the trip start (2027-03-01) until a date is entered — EET.
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-tz")).toHaveTextContent(
    "Athens — GMT+2",
  );

  await pickDate("itinerary-item-new-input-departs-at-date", 2027, 6, 4);
  await pickTime("itinerary-item-new-input-departs-at-time", 8, 20);
  // July ⇒ EEST. The label follows the entered date, not the device clock.
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-tz")).toHaveTextContent(
    "Athens — GMT+3",
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(created).toHaveLength(1));

  const body = BookingCreateSchema.parse((created[0] as { body: unknown }).body);
  // Athens is EEST (+03:00) in July — a fixed +02:00 table would be an hour out.
  expect(body.details).toMatchObject({
    category: "train",
    departs_at: "2027-07-04T08:20:00+03:00",
    departs_tz: "Europe/Athens",
  });
});

it("B-9: a title-only edit of a zoned booking re-emits its times BYTE-FOR-BYTE", async () => {
  // The edit-path guarantee: opening a stored booking reflects its zone and
  // wall time with NO re-offset, and a save that never touched the times
  // does not recompose them (seconds, rounding, or a re-resolved offset).
  const patched: unknown[] = [];
  const existing: BookingWithItems = {
    ...makeBooking({
      id: BOOKING_IDEA_ID,
      category: "flight",
      status: "idea",
      starts_at: null,
      title: "Old name",
      details: {
        category: "flight",
        origin_iata: "NRT",
        destination_iata: "LAX",
        departs_at: "2027-04-24T17:00:00+09:00",
        departs_tz: "Asia/Tokyo",
        arrives_at: "2027-04-24T10:00:00-07:00",
        arrives_tz: "America/Los_Angeles",
      },
    }),
    items: [],
  };
  await renderScreen(
    { bookingId: BOOKING_IDEA_ID },
    {
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
        "PATCH /trips/:tripId/bookings/:bookingId": (input) => {
          patched.push(input);
          return Promise.resolve(existing);
        },
      },
    },
  );

  // Display: the WALL clock the ticket says, in the zone it was stored with —
  // never re-offset into the device's zone.
  const titleInput = await screen.findByTestId("itinerary-item-new-input-title");
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-time")).toHaveTextContent(
    "17:00",
  );
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-tz")).toHaveTextContent(
    "Tokyo — GMT+9",
  );
  expect(screen.getByTestId("itinerary-item-new-input-arrives-at-tz")).toHaveTextContent(
    "Los Angeles — GMT-7",
  );

  await fireEvent.changeText(titleInput, "New name");
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(patched).toHaveLength(1));

  const body = BookingUpdateSchema.parse((patched[0] as { body: unknown }).body);
  expect(body.details).toEqual(existing.details);
});

it("B-9: editing a LEGACY unzoned booking's time DEMANDS a zone instead of Z-stamping it", async () => {
  // A row saved before zone capture has no `departs_tz`, so the picker says
  // so rather than inventing one. Touch the time and the save BLOCKS on a
  // field error — B-8's silent `Z` path is unreachable, not merely unused.
  const patched: unknown[] = [];
  const existing: BookingWithItems = {
    ...makeBooking({
      id: BOOKING_IDEA_ID,
      category: "flight",
      status: "idea",
      starts_at: null,
      title: "Legacy flight",
      details: { category: "flight", departs_at: "2027-04-24T17:00:00Z" },
    }),
    items: [],
  };
  await renderScreen(
    { bookingId: BOOKING_IDEA_ID },
    {
      overrides: {
        "GET /trips/:tripId/bookings/:bookingId": () => Promise.resolve(existing),
        "PATCH /trips/:tripId/bookings/:bookingId": (input) => {
          patched.push(input);
          return Promise.resolve(existing);
        },
      },
    },
  );

  const tzField = await screen.findByTestId("itinerary-item-new-input-departs-at-tz");
  expect(tzField).toHaveTextContent(/^Not set/);

  await pickTime("itinerary-item-new-input-departs-at-time", 18, 0);
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  expect(patched).toHaveLength(0);
  expect(screen.getByTestId("itinerary-item-new-input-departs-at-error")).toHaveTextContent(
    /Pick the time zone/,
  );

  // Choosing the zone unblocks it, composed in the zone the user picked.
  await fireEvent.press(tzField);
  await fireEvent.changeText(
    screen.getByTestId("itinerary-item-new-input-departs-at-tz-search"),
    "Tokyo",
  );
  await fireEvent.press(
    await screen.findByTestId("itinerary-item-new-input-departs-at-tz-result-asia-tokyo"),
  );
  await fireEvent.press(screen.getByTestId("itinerary-item-new-button-save"));
  await waitFor(() => expect(patched).toHaveLength(1));
  const body = BookingUpdateSchema.parse((patched[0] as { body: unknown }).body);
  expect(body.details).toMatchObject({
    departs_at: "2027-04-24T18:00:00+09:00",
    departs_tz: "Asia/Tokyo",
  });
});
