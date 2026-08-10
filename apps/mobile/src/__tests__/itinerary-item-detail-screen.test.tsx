/**
 * Itinerary item detail (T-7.9 / IT-10 — R-itin-27).
 * Component-level over the REAL data hooks, network mocked by descriptor.
 *
 * The pin that earns this file: a `booking`-kind item REPLACES itself with
 * booking detail (§2.1) — the one routing path the day list and grid don't
 * already cover, reachable by deep link and by a stale/racing read.
 */
import type { ItineraryItem, TripListItem } from "@gogo/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";

import ItineraryItemScreen from "@/app/[tripId]/itinerary/item/[itemId]";
import { ApiRequestError } from "@/auth";
import { queryKeys } from "@/data";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_FLIGHT_ID,
  ITEM_A_ID,
  ITEM_B_ID,
  ITEM_C_ID,
  defaultBookings,
  defaultItineraryItems,
  itineraryApiOverrides,
  makeItineraryItem,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockTabNavigate = jest.fn();
const mockItemIdParam: { value: unknown } = { value: ITEM_B_ID };
jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: mockPush,
    back: mockBack,
    replace: mockReplace,
    navigate: mockNavigate,
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ itemId: mockItemIdParam.value }),
  useNavigation: () => ({
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

function tripFixture(overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    ...overrides,
  });
}

interface RenderOpts {
  itemId?: string;
  items?: ItineraryItem[];
  trip?: TripListItem;
  getItinerary?: () => Promise<unknown>;
  deleteItem?: (input: Record<string, unknown>) => Promise<unknown>;
  /** Pre-seeded client for the retained-cache pins (default: fresh + empty). */
  queryClient?: QueryClient;
}

async function renderItem(opts: RenderOpts = {}) {
  seedAuthenticated();
  mockItemIdParam.value = opts.itemId ?? ITEM_B_ID;
  const trip = opts.trip ?? tripFixture();
  const items = opts.items ?? defaultItineraryItems();
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      ...itineraryApiOverrides({ items, bookings: defaultBookings() }),
      ...(opts.getItinerary === undefined
        ? {}
        : { "GET /trips/:tripId/itinerary": opts.getItinerary }),
      "DELETE /trips/:tripId/itinerary/items/:itemId":
        opts.deleteItem ?? (() => Promise.resolve(undefined)),
    },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <ItineraryItemScreen />
    </TripProvider>,
    { queryClient: opts.queryClient ?? makeTestQueryClient() },
  );
  await settle();
  return { request, trip, view };
}

/**
 * A client whose seeded composite read SURVIVES to the render (gcTime
 * `Infinity` — the default test client GCs an unobserved entry on a 0 ms
 * timer) — the "cache warm from the tab the user came from" shape the
 * retained-cache pins need. `staleTime: 0` still forces the mount refetch.
 */
function seededItineraryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  client.setQueryData(queryKeys.tripItinerary(TEST_TRIP_ID), {
    items: defaultItineraryItems(),
    legs: [],
  });
  return client;
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mockPush.mockReset();
  mockBack.mockReset();
  mockReplace.mockReset();
  mockNavigate.mockReset();
  mockTabNavigate.mockReset();
});

describe("R-itin-27 — the item surface", () => {
  it("renders title, day + times, and the edit/delete actions for a custom item", async () => {
    await renderItem({ itemId: ITEM_B_ID });
    expect(await screen.findByTestId("itinerary-item-screen")).toBeTruthy();
    expect(screen.getByText("Walk Shibuya")).toBeTruthy();
    expect(screen.getByTestId("itinerary-item-when")).toHaveTextContent(/Mon, Mar 1/);
    expect(screen.getByTestId("itinerary-item-button-edit")).toBeTruthy();
    expect(screen.getByTestId("itinerary-item-button-delete")).toBeTruthy();
  });

  it("renders notes when the item has them, and omits the block when it doesn't", async () => {
    await renderItem({
      itemId: ITEM_B_ID,
      items: [makeItineraryItem({ id: ITEM_B_ID, title: "Walk Shibuya", notes: "Bring a jacket" })],
    });
    expect(await screen.findByTestId("itinerary-item-notes")).toHaveTextContent(/Bring a jacket/);

    // CONTROL: same item, whitespace-only notes — the block disappears, so the
    // assertion above is reading the notes and not a permanently-present view.
    await renderItem({
      itemId: ITEM_B_ID,
      items: [makeItineraryItem({ id: ITEM_B_ID, title: "Walk Shibuya", notes: "   " })],
    });
    await screen.findByTestId("itinerary-item-screen");
    expect(screen.queryByTestId("itinerary-item-notes")).toBeNull();
  });

  it("names the time range, and says so when there is none", async () => {
    await renderItem({
      itemId: ITEM_B_ID,
      items: [
        makeItineraryItem({ id: ITEM_B_ID, title: "Walk", start_time: "09:00", end_time: "11:30" }),
      ],
    });
    expect(await screen.findByTestId("itinerary-item-when")).toHaveTextContent(/09:00 – 11:30/);

    await renderItem({
      itemId: ITEM_B_ID,
      items: [makeItineraryItem({ id: ITEM_B_ID, title: "Walk" })],
    });
    expect(await screen.findByTestId("itinerary-item-when")).toHaveTextContent(/No time set/);
  });

  it("shows the place row for a place_visit and jumps to the map TAB (never a URL push)", async () => {
    await renderItem({ itemId: ITEM_C_ID });
    await fireEvent.press(await screen.findByTestId("itinerary-item-row-place"));
    await settle();
    expect(mockTabNavigate).toHaveBeenCalledWith("map");
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("hides the place row on an item with no place (CONTROL for the row above)", async () => {
    await renderItem({ itemId: ITEM_B_ID });
    await screen.findByTestId("itinerary-item-screen");
    expect(screen.queryByTestId("itinerary-item-row-place")).toBeNull();
  });

  it("routes Edit back into the form modal prefilled with this item", async () => {
    await renderItem({ itemId: ITEM_B_ID });
    await fireEvent.press(await screen.findByTestId("itinerary-item-button-edit"));
    await settle();
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/item/new",
      params: { tripId: TEST_TRIP_ID, itemId: ITEM_B_ID },
    });
  });
});

describe("R-itin-27 — booking-kind hand-off", () => {
  it("REPLACES itself with booking detail (never a push — Back would bounce)", async () => {
    await renderItem({ itemId: ITEM_A_ID });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: "/[tripId]/itinerary/booking/[bookingId]",
      params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_FLIGHT_ID },
    });
    // Booking content is never duplicated across two screens — this screen
    // renders no item body while the hand-off lands.
    expect(screen.queryByTestId("itinerary-item-button-delete")).toBeNull();
    expect(screen.queryByTestId("itinerary-item-when")).toBeNull();
  });

  it("CONTROL: a non-booking item does NOT replace", async () => {
    await renderItem({ itemId: ITEM_B_ID });
    await screen.findByTestId("itinerary-item-when");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe("delete (R-ib-9 endpoint)", () => {
  it("requires the ConfirmDialog, then DELETEs and leaves the screen", async () => {
    const del = jest.fn((_input: Record<string, unknown>) => Promise.resolve(undefined));
    await renderItem({ itemId: ITEM_B_ID, deleteItem: del });

    await fireEvent.press(await screen.findByTestId("itinerary-item-button-delete"));
    await settle();
    expect(del).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("itinerary-item-button-delete-confirm"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await settle();
    expect(del.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ params: { tripId: TEST_TRIP_ID, itemId: ITEM_B_ID } }),
    );
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed delete and stays put", async () => {
    const del = jest.fn(() => Promise.reject(new ApiRequestError(409, "CONFLICT", "nope")));
    await renderItem({ itemId: ITEM_B_ID, deleteItem: del });
    await fireEvent.press(await screen.findByTestId("itinerary-item-button-delete"));
    await settle();
    await fireEvent.press(screen.getByTestId("itinerary-item-button-delete-confirm"));
    await waitFor(() => expect(screen.queryByTestId("itinerary-item-banner-action")).toBeTruthy());
    await settle();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("a second Delete CONFIRM while the DELETE is held in flight fires exactly ONE request", async () => {
    // R1 A8: ConfirmDialog confirms are not `disabled`-gated, so this route is
    // guarded in the HANDLER — and the request must be held genuinely in
    // flight (deferred, released in `finally`) or the second press races a
    // settled mutation and the pin proves nothing (T-7.6 landmine).
    // Resolvers COLLECT (not a single slot): in the mutated world this pin
    // exists to kill, the second press fires a second request — a lone
    // `release` var would strand the first promise and wedge the file
    // instead of failing (the booking suite's probe hung before the array).
    const releases: ((value: unknown) => void)[] = [];
    const del = jest.fn(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    await renderItem({ itemId: ITEM_B_ID, deleteItem: del });
    await fireEvent.press(await screen.findByTestId("itinerary-item-button-delete"));
    await settle();
    await fireEvent.press(screen.getByTestId("itinerary-item-button-delete-confirm"));
    await settle();
    try {
      await fireEvent.press(screen.getByTestId("itinerary-item-button-delete-confirm"));
      await settle();
      expect(del).toHaveBeenCalledTimes(1);
    } finally {
      // ALWAYS settle every held request — a mutation left in flight wedges
      // the whole file (found by the mutation probe for this pin class).
      await act(async () => {
        for (const release of releases) release(undefined);
      });
    }
    await settle();
  });
});

describe("states", () => {
  it("renders read-only for a viewer (R-ib-24) — no edit, no delete", async () => {
    await renderItem({ itemId: ITEM_B_ID, trip: tripFixture({ role: "viewer" }) });
    await screen.findByTestId("itinerary-item-screen");
    expect(screen.queryByTestId("itinerary-item-button-edit")).toBeNull();
    expect(screen.queryByTestId("itinerary-item-button-delete")).toBeNull();
    // The read surface stays — read-only, not access-denied.
    expect(screen.getByTestId("itinerary-item-when")).toBeTruthy();
  });

  it("renders not-found for an id the composite read doesn't contain", async () => {
    await renderItem({ itemId: "99999999-9999-4999-8999-999999999999" });
    expect(await screen.findByTestId("itinerary-item-missing")).toBeTruthy();
  });

  it("renders the retry surface when the composite read fails with nothing cached", async () => {
    await renderItem({
      itemId: ITEM_B_ID,
      getItinerary: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    expect(await screen.findByTestId("itinerary-item-error")).toBeTruthy();
    // Not "missing": a failed read is not a verdict that the item is gone.
    expect(screen.queryByTestId("itinerary-item-missing")).toBeNull();
  });

  it("a fresh 404 OUTRANKS retained cache — the missing state, not yesterday's item (R1 A4)", async () => {
    // Law #3 client half (booking detail's `is404` posture): a 404 on the
    // composite read is a membership verdict — a removed member's warm cache
    // must not keep rendering title/times/notes under a refresh banner.
    await renderItem({
      itemId: ITEM_B_ID,
      queryClient: seededItineraryClient(),
      getItinerary: () => Promise.reject(new ApiRequestError(404, "NOT_FOUND", "not found")),
    });
    expect(await screen.findByTestId("itinerary-item-missing")).toBeTruthy();
    expect(screen.queryByTestId("itinerary-item-when")).toBeNull();
    expect(screen.queryByTestId("itinerary-item-banner-refresh")).toBeNull();
  });

  it("CONTROL: a non-404 failure over the SAME cache keeps the retained render + refresh banner", async () => {
    // Proves the pin above reads the STATUS, not "any error blanks the
    // screen" — and that the seeded cache genuinely survives to the render.
    await renderItem({
      itemId: ITEM_B_ID,
      queryClient: seededItineraryClient(),
      getItinerary: () => Promise.reject(new ApiRequestError(500, "UNKNOWN", "boom")),
    });
    expect(await screen.findByTestId("itinerary-item-when")).toBeTruthy();
    expect(await screen.findByTestId("itinerary-item-banner-refresh")).toBeTruthy();
    expect(screen.queryByTestId("itinerary-item-missing")).toBeNull();
  });

  it("degrades a malformed (repeated) itemId param to not-found instead of throwing", async () => {
    // expo-router hands back `string[]` for a repeated query key and the
    // `useLocalSearchParams<…>()` generic is an unchecked assertion — indexing
    // into that array is how a crafted link red-screens a route.
    seedAuthenticated();
    const trip = tripFixture();
    mockNavApi({ trips: [trip], overrides: itineraryApiOverrides({}) });
    mockItemIdParam.value = [ITEM_B_ID, ITEM_B_ID];
    await renderWithProviders(
      <TripProvider trip={trip}>
        <ItineraryItemScreen />
      </TripProvider>,
      { queryClient: makeTestQueryClient() },
    );
    await settle();
    expect(screen.getByTestId("itinerary-item-missing")).toBeTruthy();
  });
});
