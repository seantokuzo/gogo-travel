/**
 * Place sheet (T-8.3 / MAP-2 — R-map-4 presentation, R-map-8 handoff;
 * T-8.7 rider — the full §2.3 action row, closing escalation E5).
 * Load-bearing:
 *  - spine content: name as title, category line with the coarse fallback,
 *    distance line present ONLY with a known position (§2.3/§2.6);
 *  - R-map-11: save toggle wired to the optimistic data layer (save POSTs
 *    and lands "Saved"; unsave DELETEs the settled row); viewers get STATE
 *    (badge), never the control — editor CONTROL alongside;
 *  - R-map-12: Add to day dismisses, jumps the tab FIRST, then pushes the
 *    prefilled item/new modal (order claim — mobile.md landmine);
 *  - R-map-23: View in itinerary exists ONLY for an itinerary-pin origin
 *    and lands PER KIND — item-kind → item/[itemId], booking-kind →
 *    booking/[bookingId] directly (T-8.4's rerouted convention, MAP-6
 *    bullet 386);
 *  - Navigate opens the EXACT nav-handoff URL; a failed open surfaces the
 *    inline error (deferred promise, released in finally — mobile.md);
 *    Navigate carries NO offline gate (the T-8.7 reconciliation posture —
 *    the detail screen's suite pins the enabled-offline behavior);
 *  - Details dismisses then pushes the map stack's place route with typed
 *    params (same-tab — no cross-tab landmine).
 *
 * NOTE (honest pin evolution, T-8.7): T-8.3's "T-8.4-owned actions are
 * ABSENT this PR" pin is retired here — this rider IS the "deliberate
 * diff" that pin existed to force. Its successor is the presence +
 * viewer-gating + per-kind suite below.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { MapPlaceSheet } from "./MapPlaceSheet";
import { resetMapLocationForTests, useMapLocationStore } from "./location";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  BOOKING_LODGING_ID,
  ITEM_C_ID,
  ITEM_LODGING_ID,
  itineraryApiOverrides,
} from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import {
  makePlace,
  makeSavedPlaceWithPlace,
  makeTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

jest.mock("expo-linking", () => ({
  __esModule: true,
  openURL: jest.fn(async () => null),
  openSettings: jest.fn(async () => null),
}));

/** Ordered cross-tab call log — the two-step contract is an ORDER claim. */
const callSequence: [string, unknown][] = [];
const mockPush = jest.fn((target: unknown) => callSequence.push(["push", target]));
const mockTabNavigate = jest.fn((tab: unknown) => callSequence.push(["tab", tab]));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useNavigation: () => ({
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

const { openURL: mockOpenUrl } = jest.requireMock("expo-linking") as { openURL: jest.Mock };

const PLACE = makePlace({
  id: "44444444-4444-4444-8444-444444444444",
  name: "Fushimi Inari",
  lat: 34.9671,
  lng: 135.7727,
  category: "Shinto Shrine",
  coarse_category: "culture",
});
const SAVED_ROW_ID = "55555555-5555-4555-8555-555555555551";

beforeEach(() => {
  jest.clearAllMocks();
  resetMapLocationForTests();
});

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  callSequence.length = 0;
});

interface RenderOpts {
  place?: Partial<Parameters<typeof makePlace>[0]>;
  role?: "owner" | "editor" | "viewer";
  itineraryItemId?: string | null;
  savedRows?: ReturnType<typeof makeSavedPlaceWithPlace>[];
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}

async function renderSheet(opts: RenderOpts = {}) {
  const place = opts.place === undefined ? PLACE : makePlace({ ...PLACE, ...opts.place });
  const trip = makeTrip({ id: TEST_TRIP_ID, ...(opts.role ? { role: opts.role } : {}) });
  const onDismiss = jest.fn();
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      ...itineraryApiOverrides(),
      "GET /trips/:tripId/saved-places": () =>
        Promise.resolve({ items: opts.savedRows ?? [], nextCursor: null }),
      "POST /trips/:tripId/saved-places": () =>
        Promise.resolve(
          makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: place.id, place }),
        ),
      "DELETE /trips/:tripId/saved-places/:savedPlaceId": () => Promise.resolve(undefined),
      ...opts.overrides,
    },
  });
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <MapPlaceSheet
        tripId={TEST_TRIP_ID}
        place={place}
        itineraryItemId={opts.itineraryItemId ?? null}
        onDismiss={onDismiss}
      />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  return { onDismiss, place, request, view };
}

it("null place ⇒ hidden (the always-mounted LegModeSheet pattern)", async () => {
  mockNavApi({
    trips: [makeTrip({ id: TEST_TRIP_ID })],
    overrides: {
      ...itineraryApiOverrides(),
      "GET /trips/:tripId/saved-places": () => Promise.resolve({ items: [], nextCursor: null }),
    },
  });
  await renderWithProviders(
    <TripProvider trip={makeTrip({ id: TEST_TRIP_ID })}>
      <MapPlaceSheet
        tripId={TEST_TRIP_ID}
        place={null}
        itineraryItemId={null}
        onDismiss={jest.fn()}
      />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
  expect(screen.queryByTestId("map-sheet-place")).toBeNull();
});

it("presents spine content: title, category, no distance without a position", async () => {
  await renderSheet();

  expect(screen.getByTestId("map-sheet-place")).toBeTruthy();
  expect(screen.getByText("Fushimi Inari")).toBeTruthy();
  expect(screen.getByText("Shinto Shrine")).toBeTruthy();
  expect(screen.queryByTestId("map-sheet-place-distance")).toBeNull();
});

it("falls back to the coarse-category label when the source taxonomy is null", async () => {
  await renderSheet({ place: { category: null, coarse_category: "food" } });
  expect(screen.getByText("Food")).toBeTruthy();
});

it("shows the on-device distance line when a position is known (§2.3)", async () => {
  useMapLocationStore.setState({ position: { lat: 34.9858, lng: 135.7588 } });
  await renderSheet();

  const distance = screen.getByTestId("map-sheet-place-distance");
  expect(distance.props.children).toMatch(/km away$/);
});

describe("R-map-11 save toggle (E5)", () => {
  it("editor: Save place POSTs through the optimistic layer and lands 'Saved'", async () => {
    const { request } = await renderSheet();

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-save"));
    await settle();

    const saveCalls = request.mock.calls.filter(
      (call: unknown[]) =>
        (call[0] as { method: string; path: string }).method === "POST" &&
        (call[0] as { path: string }).path === "/trips/:tripId/saved-places",
    );
    expect(saveCalls).toHaveLength(1);
    expect((saveCalls[0]?.[1] as { body: { place_id: string } }).body.place_id).toBe(PLACE.id);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("editor: a SAVED settled row unsaves (DELETE with the real row id)", async () => {
    const { request } = await renderSheet({
      savedRows: [
        makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: PLACE.id, place: PLACE }),
      ],
    });
    expect(screen.getByText("Saved")).toBeTruthy();

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-save"));
    await settle();

    const deleteCalls = request.mock.calls.filter(
      (call: unknown[]) => (call[0] as { method: string }).method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]?.[1] as { params: { savedPlaceId: string } }).params.savedPlaceId).toBe(
      SAVED_ROW_ID,
    );
    expect(screen.getByText("Save place")).toBeTruthy();
  });

  it("save failure surfaces the inline action error (hook-level seam)", async () => {
    await renderSheet({
      overrides: {
        "POST /trips/:tripId/saved-places": () => Promise.reject(new Error("boom")),
      },
    });

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-save"));
    await settle();

    expect(await screen.findByTestId("map-sheet-place-action-error")).toBeTruthy();
  });

  it("viewer: STATE (badge when saved), never the control — editor CONTROL alongside", async () => {
    await renderSheet({
      role: "viewer",
      savedRows: [
        makeSavedPlaceWithPlace({ id: SAVED_ROW_ID, place_id: PLACE.id, place: PLACE }),
      ],
    });
    expect(screen.queryByTestId("map-sheet-place-button-save")).toBeNull();
    expect(screen.queryByTestId("map-sheet-place-button-add-to-day")).toBeNull();
    expect(screen.getByTestId("map-sheet-place-badge-saved")).toBeTruthy();
    // Read-only surface keeps the non-write actions.
    expect(screen.getByTestId("map-sheet-place-button-navigate")).toBeTruthy();
    expect(screen.getByTestId("map-sheet-place-button-details")).toBeTruthy();
  });

  it("viewer + unsaved: no badge either (state, not ornament)", async () => {
    await renderSheet({ role: "viewer" });
    expect(screen.queryByTestId("map-sheet-place-badge-saved")).toBeNull();
  });
});

describe("R-map-12 Add to day (E5)", () => {
  it("dismisses, jumps the itinerary tab FIRST, then pushes the prefilled item/new modal", async () => {
    const { onDismiss } = await renderSheet();

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-add-to-day"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/item/new",
          params: {
            tripId: TEST_TRIP_ID,
            category: "place_visit",
            placeId: PLACE.id,
            placeName: PLACE.name,
          },
        },
      ],
    ]);
  });
});

describe("R-map-23 View in itinerary (E5 — per-kind, itinerary pins only)", () => {
  it("ABSENT without an itinerary-pin origin (CONTROL: §2.3 'itinerary pins only')", async () => {
    await renderSheet({ itineraryItemId: null });
    expect(screen.queryByTestId("map-sheet-place-button-view-itinerary")).toBeNull();
  });

  it("item-kind: dismisses, jumps, then pushes item/[itemId]", async () => {
    const { onDismiss } = await renderSheet({ itineraryItemId: ITEM_C_ID });

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-view-itinerary"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/item/[itemId]",
          params: { tripId: TEST_TRIP_ID, itemId: ITEM_C_ID },
        },
      ],
    ]);
  });

  it("booking-kind: pushes booking/[bookingId] DIRECTLY (bullet-386 convention)", async () => {
    await renderSheet({ itineraryItemId: ITEM_LODGING_ID });

    await fireEvent.press(screen.getByTestId("map-sheet-place-button-view-itinerary"));

    expect(callSequence).toEqual([
      ["tab", "itinerary"],
      [
        "push",
        {
          pathname: "/[tripId]/itinerary/booking/[bookingId]",
          params: { tripId: TEST_TRIP_ID, bookingId: BOOKING_LODGING_ID },
        },
      ],
    ]);
  });

  it("an unresolvable itemId renders no action (no dead tap)", async () => {
    await renderSheet({ itineraryItemId: "99999999-9999-4999-8999-999999999999" });
    expect(screen.queryByTestId("map-sheet-place-button-view-itinerary")).toBeNull();
  });
});

it("R-map-8: Navigate opens the coordinate handoff URL — and carries no offline gate", async () => {
  await renderSheet();

  const navigate = screen.getByTestId("map-sheet-place-button-navigate");
  // The T-8.7 reconciliation posture: no disabled prop exists on this
  // surface at all (the detail suite pins the behavioral half).
  expect(navigate).not.toBeDisabled();
  await fireEvent.press(navigate);

  expect(mockOpenUrl).toHaveBeenCalledTimes(1);
  expect(mockOpenUrl).toHaveBeenCalledWith(
    "https://www.google.com/maps/dir/?api=1&destination=34.9671%2C135.7727",
  );
});

it("a failed open surfaces the inline error and stays retryable", async () => {
  // Deferred rejection, resolvers collected + released in finally
  // (mobile.md deferred-promise rules).
  const rejecters: ((reason: Error) => void)[] = [];
  mockOpenUrl.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejecters.push(reject);
      }),
  );
  await renderSheet();

  try {
    await fireEvent.press(screen.getByTestId("map-sheet-place-button-navigate"));
    // Still in flight — no premature error.
    expect(screen.queryByTestId("map-sheet-place-error")).toBeNull();
  } finally {
    for (const reject of rejecters) reject(new Error("no handler"));
  }
  expect(await screen.findByTestId("map-sheet-place-error")).toBeTruthy();
  // The button is still live (no disabled gate) — a retry can succeed.
  mockOpenUrl.mockResolvedValueOnce(null);
  await fireEvent.press(screen.getByTestId("map-sheet-place-button-navigate"));
  expect(mockOpenUrl).toHaveBeenCalledTimes(2);
});

it("Details dismisses then pushes the map stack's place route (typed params)", async () => {
  const { onDismiss } = await renderSheet();

  await fireEvent.press(screen.getByTestId("map-sheet-place-button-details"));

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith({
    pathname: "/[tripId]/map/place/[placeId]",
    params: { tripId: TEST_TRIP_ID, placeId: PLACE.id },
  });
});

it("close button routes through onDismiss (scrim is RNTL-unqueryable — mobile.md)", async () => {
  const { onDismiss } = await renderSheet();

  await fireEvent.press(screen.getByTestId("map-sheet-place-close"));

  expect(onDismiss).toHaveBeenCalledTimes(1);
});
