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

it("viewers get the read-only notice — no form, no save (R-ib-24)", async () => {
  await renderScreen({ category: "activity" }, { role: "viewer" });
  expect(screen.getByTestId("itinerary-item-new-viewer")).toBeOnTheScreen();
  expect(screen.queryByTestId("itinerary-item-new-button-save")).toBeNull();
});
