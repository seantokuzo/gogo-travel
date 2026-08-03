/**
 * Conflict surfacing on the plan surface (T-7.5 / IT-4 — R-itin-7) over the
 * REAL screen and REAL data hooks: overlap chips on the involved cards, the
 * one-tap "Sort day by time" affordance (a day-order PUT), and the promise
 * that nothing ever auto-resorts.
 *
 * The negative pins all carry CONTROL arms — an "affordance absent" test
 * over a day that is already sorted would pass with the whole feature
 * deleted, so each one shows the same screen producing the affordance under
 * the condition that should produce it.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ItineraryScreen from "@/app/[tripId]/itinerary/index";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  itineraryApiOverrides,
  makeItineraryItem,
  TRIP_DAY_2,
  TRIP_END,
  TRIP_START,
  type ItineraryApiOptions,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

/** Day 1: two overlapping items listed OUT of time order (14:00 before 09:00). */
function unsortedOverlappingDay() {
  return [
    makeItineraryItem({
      id: ITEM_A_ID,
      title: "Museum",
      start_time: "14:00",
      end_time: "16:00",
      sort_order: 1024,
    }),
    makeItineraryItem({
      id: ITEM_B_ID,
      title: "Walk Shibuya",
      start_time: "09:00",
      end_time: "15:00",
      sort_order: 2048,
    }),
  ];
}

/** The same two items, in time order and not overlapping. */
function tidyDay() {
  return [
    makeItineraryItem({
      id: ITEM_A_ID,
      title: "Museum",
      start_time: "09:00",
      end_time: "10:00",
      sort_order: 1024,
    }),
    makeItineraryItem({
      id: ITEM_B_ID,
      title: "Walk Shibuya",
      start_time: "14:00",
      end_time: "15:00",
      sort_order: 2048,
    }),
  ];
}

async function renderItinerary(opts?: { api?: ItineraryApiOptions; role?: "owner" | "viewer" }) {
  seedAuthenticated();
  const trip = makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    role: opts?.role ?? "owner",
  });
  mockNavApi({ trips: [trip], overrides: itineraryApiOverrides(opts?.api) });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { trip, view };
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  jest.restoreAllMocks();
});

describe("overlap chips (R-itin-7)", () => {
  it("badges EVERY item involved in the overlap", async () => {
    await renderItinerary({ api: { items: unsortedOverlappingDay(), bookings: [] } });
    expect(await screen.findByTestId(`itinerary-list-item-${ITEM_A_ID}-overlap`)).toBeOnTheScreen();
    expect(screen.getByTestId(`itinerary-list-item-${ITEM_B_ID}-overlap`)).toBeOnTheScreen();
    expect(screen.getAllByText("Overlap")).toHaveLength(2);
  });

  it("CONTROL: the same two items, moved apart, carry no chip", async () => {
    await renderItinerary({ api: { items: tidyDay(), bookings: [] } });
    await screen.findByTestId(`itinerary-list-item-${ITEM_A_ID}`);
    expect(screen.queryByTestId(`itinerary-list-item-${ITEM_A_ID}-overlap`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-list-item-${ITEM_B_ID}-overlap`)).toBeNull();
    expect(screen.queryByText("Overlap")).toBeNull();
  });

  it("an item overlapping nothing stays clean while its neighbours are badged", async () => {
    const items = [
      ...unsortedOverlappingDay(),
      makeItineraryItem({
        id: ITEM_C_ID,
        title: "Late dinner",
        start_time: "20:00",
        end_time: "21:00",
        sort_order: 3072,
      }),
    ];
    await renderItinerary({ api: { items, bookings: [] } });
    await screen.findByTestId(`itinerary-list-item-${ITEM_A_ID}-overlap`);
    expect(screen.queryByTestId(`itinerary-list-item-${ITEM_C_ID}-overlap`)).toBeNull();
  });

  it("viewers see overlap chips — read-only information, not a write affordance", async () => {
    await renderItinerary({ api: { items: unsortedOverlappingDay(), bookings: [] }, role: "viewer" });
    expect(await screen.findByTestId(`itinerary-list-item-${ITEM_A_ID}-overlap`)).toBeOnTheScreen();
  });

  it("list and grid surface the SAME overlap for the same data (R-itin-7 ⇔ R-itin-15)", async () => {
    await renderItinerary({ api: { items: unsortedOverlappingDay(), bookings: [] } });
    await screen.findByTestId(`itinerary-list-item-${ITEM_A_ID}-overlap`);
    expect(screen.getAllByText("Overlap")).toHaveLength(2);

    await fireEvent.press(screen.getByTestId("itinerary-view-toggle"));
    await screen.findByTestId("itinerary-grid-surface");
    // The grid draws the same two blocks side-by-side, each badged.
    expect(screen.getAllByText("Overlap")).toHaveLength(2);

    // Restore list mode — the toggle persists per trip in MMKV.
    await fireEvent.press(screen.getByTestId("itinerary-view-toggle"));
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
  });
});

describe("sort by time (R-itin-7)", () => {
  it("offers the affordance ONLY on the day whose order disagrees with its times", async () => {
    const items = [
      ...unsortedOverlappingDay(),
      makeItineraryItem({ id: ITEM_C_ID, day: TRIP_END, start_time: "09:00", sort_order: 1024 }),
    ];
    await renderItinerary({ api: { items, bookings: [] } });
    expect(await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_DAY_2}`)).toBeNull();
    expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_END}`)).toBeNull();
  });

  it("CONTROL: an already-sorted day offers nothing anywhere", async () => {
    await renderItinerary({ api: { items: tidyDay(), bookings: [] } });
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeNull();
  });

  it("NEVER auto-resorts — the out-of-order rows stay put until the tap", async () => {
    await renderItinerary({ api: { items: unsortedOverlappingDay(), bookings: [] } });
    await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`);
    const rendered = screen
      .getAllByText(/Museum|Walk Shibuya/)
      .map((node) => node.props.children as string);
    // 14:00 "Museum" is still listed first, exactly as `sort_order` says.
    expect(rendered).toEqual(["Museum", "Walk Shibuya"]);
  });

  it("one tap PUTs the time-sorted order for that day and clears the affordance", async () => {
    const bodies: unknown[] = [];
    await renderItinerary({
      api: {
        items: unsortedOverlappingDay(),
        bookings: [],
        putDayOrder: (input) => {
          bodies.push({ params: input.params, body: input.body });
          const ids = (input.body as { item_ids: string[] }).item_ids;
          const byId = new Map(unsortedOverlappingDay().map((item) => [item.id, item]));
          return Promise.resolve({
            items: ids.flatMap((id, index) => {
              const item = byId.get(id);
              return item === undefined ? [] : [{ ...item, sort_order: 1024 * (index + 1) }];
            }),
          });
        },
      },
    });

    await fireEvent.press(await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      params: { tripId: TEST_TRIP_ID, day: TRIP_START },
      // 09:00 "Walk Shibuya" leads after the sort.
      body: { item_ids: [ITEM_B_ID, ITEM_A_ID] },
    });

    // The day is now in order, so the affordance retires itself.
    await waitFor(() =>
      expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeNull(),
    );
    const rendered = screen
      .getAllByText(/Museum|Walk Shibuya/)
      .map((node) => node.props.children as string);
    expect(rendered).toEqual(["Walk Shibuya", "Museum"]);
  });

  it("a failed sort rolls back visibly and shows the reorder banner", async () => {
    await renderItinerary({
      api: {
        items: unsortedOverlappingDay(),
        bookings: [],
        putDayOrder: () => Promise.reject(new Error("boom")),
      },
    });
    await fireEvent.press(await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`));

    expect(await screen.findByTestId("itinerary-reorder-error")).toBeOnTheScreen();
    await waitFor(() => {
      const rendered = screen
        .getAllByText(/Museum|Walk Shibuya/)
        .map((node) => node.props.children as string);
      expect(rendered).toEqual(["Museum", "Walk Shibuya"]);
    });
    // …and the affordance is back, because the day is still out of order.
    expect(screen.getByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeOnTheScreen();
  });

  it("is pending-gated: the affordance is gone while the PUT is genuinely in flight", async () => {
    let resolvePut: ((value: unknown) => void) | undefined;
    await renderItinerary({
      api: {
        items: unsortedOverlappingDay(),
        bookings: [],
        // A DEFERRED promise — a pre-settled one would let the optimistic
        // write and its reconcile flush in one notify batch, so the in-flight
        // state would never commit and this pin would pass ungated.
        putDayOrder: () =>
          new Promise((resolve) => {
            resolvePut = resolve;
          }),
      },
    });

    await fireEvent.press(await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`));
    await waitFor(() =>
      expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeNull(),
    );

    await act(async () => {
      resolvePut?.({ items: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Settling with an empty post-state leaves the optimistic order in place,
    // which IS sorted — so the affordance stays retired for the right reason.
    expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeNull();
  });

  it("viewers never get the affordance — it issues a write (R-ib-24)", async () => {
    await renderItinerary({
      api: { items: unsortedOverlappingDay(), bookings: [] },
      role: "viewer",
    });
    await screen.findByTestId(`itinerary-day-header-${TRIP_START}`);
    expect(screen.queryByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeNull();
    // CONTROL: the same universe as an editor DOES offer it.
    await renderItinerary({ api: { items: unsortedOverlappingDay(), bookings: [] } });
    expect(await screen.findByTestId(`itinerary-sort-by-time-${TRIP_START}`)).toBeOnTheScreen();
  });
});
