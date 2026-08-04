/**
 * Form conflict notice (T-7.5 / IT-4 — R-itin-20) on the REAL add/edit modal
 * over the REAL data hooks. R-itin-20 is a two-clause rule and BOTH clauses
 * are pinned: the notice appears when the chosen day/times overlap, AND save
 * remains allowed (overlaps are legal — API R-ib-17).
 *
 * The day/time reach the form through the `?day=`/`?time=` prefill route —
 * the same path the grid gap-tap uses — so no picker gesture is needed and
 * the pin exercises real form state, not injected props.
 *
 * Every "no notice" assertion carries a CONTROL arm rendering the identical
 * screen at a time that DOES overlap, so a notice that never renders at all
 * cannot pass this suite.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import ItineraryItemNewScreen from "@/app/[tripId]/itinerary/item/new";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_FLIGHT_ID,
  BOOKING_LODGING_ID,
  ITEM_A_ID,
  ITEM_B_ID,
  itineraryApiOverrides,
  makeBooking,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

let mockParams: Record<string, string> = {};

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
}));

/** One timed item to collide with: 10:00–12:30 on day 1. */
function existingMorningItem() {
  return [
    makeItineraryItem({
      id: ITEM_A_ID,
      title: "Museum",
      start_time: "10:00",
      end_time: "12:30",
      sort_order: 1024,
    }),
  ];
}

async function renderForm(
  params: Record<string, string>,
  api?: ItineraryApiOptions,
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>,
) {
  mockParams = { tripId: TEST_TRIP_ID, ...params };
  seedAuthenticated();
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    role: "owner",
  });
  mockNavApi({ trips: [trip], overrides: { ...itineraryApiOverrides(api), ...overrides } });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryItemNewScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { view };
}

/**
 * A CONTROL arm re-renders the screen inside the SAME test. Tear the first
 * tree down and drain its notify batch FIRST: leaving two mounted screens
 * (and two query observers) lets the loser's tail `setTimeout(0)` land after
 * this file finishes, which surfaces as an un-acted update inside whichever
 * suite the worker picks up next (the B-2 class — it cost this suite a
 * cross-file act warning before the drain went in).
 */
async function remount(
  view: { unmount(): Promise<void> | void },
  ...args: Parameters<typeof renderForm>
): Promise<void> {
  // RNTL v14 made `unmount` async like the rest — an un-awaited one leaves a
  // floating act promise that resolves inside a LATER test.
  await view.unmount();
  await settle();
  await renderForm(...args);
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockParams = {};
});

describe("place_visit / custom form (R-itin-20)", () => {
  it("names the overlapping item and leaves save enabled", async () => {
    await renderForm(
      { category: "custom", day: TRIP_START, time: "11:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    const notice = await screen.findByTestId("itinerary-item-new-conflict");
    expect(notice).toHaveTextContent(/Overlaps Museum \(10:00 – 12:30\)/);
    // R-itin-20's second clause: NON-blocking.
    expect(screen.getByTestId("itinerary-item-new-button-save")).not.toBeDisabled();
  });

  it("CONTROL: the same form at a clear time shows nothing", async () => {
    await renderForm(
      { category: "custom", day: TRIP_START, time: "16:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-input-title");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("a day-only prefill (no time) can't conflict — an untimed item has no span", async () => {
    await renderForm(
      { category: "custom", day: TRIP_START },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-input-title");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("a prefill on another day sees that day's items, not day one's", async () => {
    await renderForm(
      { category: "custom", day: TRIP_DAY_2, time: "11:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-input-title");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("clearing the start time retires the notice live", async () => {
    await renderForm(
      { category: "custom", day: TRIP_START, time: "11:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-conflict");
    await fireEvent.press(screen.getByTestId("itinerary-item-new-input-start-time-clear"));
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("edit mode: the item being edited never conflicts with itself", async () => {
    const items = [
      makeItineraryItem({
        id: ITEM_B_ID,
        title: "Walk Shibuya",
        start_time: "11:00",
        end_time: "12:00",
        sort_order: 1024,
      }),
    ];
    const first = await renderForm({ itemId: ITEM_B_ID }, { items, bookings: [] });
    await screen.findByTestId("itinerary-item-new-input-title");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();

    // CONTROL: add a DIFFERENT item in the same window and the notice fires,
    // proving the silence above is the self-exclusion, not a dead code path.
    await remount(
      first.view,
      { itemId: ITEM_B_ID },
      { items: [...items, ...existingMorningItem()], bookings: [] },
    );
    expect(await screen.findByTestId("itinerary-item-new-conflict")).toHaveTextContent(/Museum/);
  });
});

describe("booking form (R-itin-20)", () => {
  it("warns from the DERIVED placement — what the calendar will actually show", async () => {
    await renderForm(
      { category: "activity", day: TRIP_START, time: "11:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    const notice = await screen.findByTestId("itinerary-item-new-conflict");
    expect(notice).toHaveTextContent(/Overlaps Museum \(10:00 – 12:30\)/);
    expect(screen.getByTestId("itinerary-item-new-button-save")).not.toBeDisabled();
  });

  it("CONTROL: the same category at a clear time is silent", async () => {
    await renderForm(
      { category: "activity", day: TRIP_START, time: "16:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-input-venue-name");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("a timeless booking (Ideas-bound) never warns — it has no placement", async () => {
    await renderForm({ category: "activity" }, { items: existingMorningItem(), bookings: [] });
    await screen.findByTestId("itinerary-item-new-input-venue-name");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("editing a booking excludes ITS OWN auto-items from the check", async () => {
    const booking = makeBooking({
      id: BOOKING_FLIGHT_ID,
      category: "activity",
      status: "planned",
      title: "Teamlab",
      details: { category: "activity", starts_at: "2027-03-01T11:00:00Z" },
      starts_at: "2027-03-01T11:00:00.000Z",
    });
    const items = [
      makeItineraryItem({
        id: ITEM_A_ID,
        kind: "booking",
        booking_id: BOOKING_FLIGHT_ID,
        title: null,
        start_time: "11:00",
        end_time: null,
        sort_order: 1024,
      }),
    ];
    const bookingRead = {
      "GET /trips/:tripId/bookings/:bookingId": () =>
        Promise.resolve({ ...booking, items }),
    };
    const first = await renderForm(
      { bookingId: BOOKING_FLIGHT_ID },
      { items, bookings: [booking] },
      bookingRead,
    );
    await screen.findByTestId("itinerary-item-new-input-venue-name");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();

    // CONTROL: a second, unrelated item in the same window DOES surface.
    await remount(
      first.view,
      { bookingId: BOOKING_FLIGHT_ID },
      { items: [...items, ...existingMorningItem()], bookings: [booking] },
      bookingRead,
    );
    expect(await screen.findByTestId("itinerary-item-new-conflict")).toHaveTextContent(/Museum/);
  });

  it("a SAME-DAY lodging derives a normal block and DOES warn", async () => {
    // Renamed from "a spanning lodging is ambient — check-in warns about
    // nothing", which asserted the notice IS shown and so proved the exact
    // opposite of its title. A lodging with only a check-in is not spanning.
    await renderForm(
      { category: "lodging", day: TRIP_START, time: "11:00" },
      { items: existingMorningItem(), bookings: [] },
    );
    await screen.findByTestId("itinerary-item-new-input-property-name");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeOnTheScreen();
  });

  it("a genuinely SPANNING lodging is ambient and warns about nothing", async () => {
    // The `spanning` flag BookingForm derives is what routes a booking around
    // the overlap check. Nothing else in the suite renders a form whose
    // candidate carries `spanning: true`, so the producer was unpinned:
    // dropping its `category === "lodging"` clause, or loosening `>` to `>=`,
    // left every suite green while silently killing the notice for same-day
    // lodgings and for every multi-day booking.
    const spanningStay = makeBooking({
      id: BOOKING_LODGING_ID,
      category: "lodging",
      status: "planned",
      title: "Park Hyatt",
      details: {
        category: "lodging",
        check_in: `${TRIP_START}T11:00:00Z`,
        check_out: `${TRIP_END}T10:00:00Z`,
      },
      starts_at: `${TRIP_START}T11:00:00.000Z`,
      ends_at: `${TRIP_END}T10:00:00.000Z`,
    });
    const bookingRead = {
      "GET /trips/:tripId/bookings/:bookingId": () =>
        Promise.resolve({ ...spanningStay, items: [] }),
    };
    // An existing 10:00-12:30 item sits right across the 11:00 check-in.
    await renderForm(
      { bookingId: BOOKING_LODGING_ID },
      { items: existingMorningItem(), bookings: [spanningStay] },
      bookingRead,
    );
    await screen.findByTestId("itinerary-item-new-input-property-name");
    expect(screen.queryByTestId("itinerary-item-new-conflict")).toBeNull();
  });

  it("CONTROL for the above: the same stay checking out the SAME day does warn", async () => {
    // Byte-for-byte the previous fixture with `check_out` moved onto the
    // check-in date — the ONLY difference is `end_day > day`. If the notice
    // still stays silent here, the ambient rule is over-firing.
    const sameDayStay = makeBooking({
      id: BOOKING_LODGING_ID,
      category: "lodging",
      status: "planned",
      title: "Park Hyatt",
      details: {
        category: "lodging",
        check_in: `${TRIP_START}T11:00:00Z`,
        check_out: `${TRIP_START}T18:00:00Z`,
      },
      starts_at: `${TRIP_START}T11:00:00.000Z`,
      ends_at: `${TRIP_START}T18:00:00.000Z`,
    });
    await renderForm(
      { bookingId: BOOKING_LODGING_ID },
      { items: existingMorningItem(), bookings: [sameDayStay] },
      {
        "GET /trips/:tripId/bookings/:bookingId": () =>
          Promise.resolve({ ...sameDayStay, items: [] }),
      },
    );
    expect(await screen.findByTestId("itinerary-item-new-conflict")).toHaveTextContent(/Museum/);
  });

  it("a cross-midnight NON-lodging booking is not ambient — an overnight flight still warns", async () => {
    // The `category === "lodging"` half of the producer. Only a booking whose
    // DERIVED placement carries `end_day > day` can reach that clause, and
    // `deriveAutoItems` only sets `end_day` for lodging and for the
    // cross-midnight `default` arm — a car rental derives two point
    // placements with `end_day: null` and so cannot exercise it at all.
    // An overnight flight can: drop the lodging clause and it is classified
    // ambient, silently losing the notice.
    const redEye = makeBooking({
      id: BOOKING_LODGING_ID,
      category: "flight",
      status: "planned",
      title: "NH 106",
      details: {
        category: "flight",
        departs_at: `${TRIP_START}T22:00:00Z`,
        arrives_at: `${TRIP_DAY_2}T06:00:00Z`,
      },
      starts_at: `${TRIP_START}T22:00:00.000Z`,
      ends_at: `${TRIP_DAY_2}T06:00:00.000Z`,
    });
    const lateItem = [
      makeItineraryItem({
        id: ITEM_A_ID,
        title: "Airport transfer",
        start_time: "21:30",
        end_time: "23:00",
        sort_order: 1024,
      }),
    ];
    await renderForm(
      { bookingId: BOOKING_LODGING_ID },
      { items: lateItem, bookings: [redEye] },
      {
        "GET /trips/:tripId/bookings/:bookingId": () =>
          Promise.resolve({ ...redEye, items: [] }),
      },
    );
    expect(await screen.findByTestId("itinerary-item-new-conflict")).toHaveTextContent(
      /Airport transfer/,
    );
  });
});
