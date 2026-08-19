/**
 * Filled slot — the seam's contract, exercised end to end (T-8.3 / MAP-2 —
 * R-map-4, R-map-25 sheet path; T-8.7 lifted the search selection to the
 * screen — slot doc). Load-bearing:
 *  - `selectedPlaceId` (the screen's `onPinSelect` output) presents the
 *    sheet for the SAVED row it resolves to; null presents nothing;
 *  - an unresolvable id presents NOTHING (interim-limited coverage ruling
 *    — no improvised row source);
 *  - a search-result tap reports `onClose()` FIRST (clearing the screen's
 *    pin source), then `onSelectSearchPlace(row)` — the one-selection
 *    invariant's order half — and the harness legs prove the end-to-end
 *    presentation + precedence the screen's state machine yields;
 *  - every sheet dismissal clears BOTH sources
 *    (`onSelectSearchPlace(null)` + `onClose()`);
 *  - search + locate mount through the slot (the §2.8 map-root controls);
 *  - `onSearchResultsChange` forwards the search's visible rows — the
 *    screen's temp-pin feed (rider E1);
 *  - the slot NEVER drains the camera-intent store — the SCREEN's drain
 *    (wired by T-8.7; pinned in map-screen.test) is the only consumer.
 */
import type { Place } from "@gogo/shared";
import { itineraryEndpoints, placeEndpoints } from "@gogo/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { useState } from "react";

import { apiClient } from "@/auth";
import { MapPlaceSheetSlot } from "./MapPlaceSheetSlot";
import { setPendingCameraIntent, useMapCameraIntentStore } from "./camera-intent";
import { resetMapLocationForTests } from "./location";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { makePlace, makeSavedPlaceWithPlace, makeTrip } from "@/test-utils/trip-fixtures";

jest.mock("expo-linking", () => ({
  __esModule: true,
  openURL: jest.fn(async () => null),
  openSettings: jest.fn(async () => null),
}));

jest.mock("expo-router", () => {
  const push = jest.fn();
  return {
    useRouter: () => ({ push }),
    useNavigation: () => ({
      navigate: jest.fn(),
      getParent: () => undefined,
      getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
    }),
    __push: push,
  };
});

const PLACE_A = "44444444-4444-4444-8444-444444444441";
const SEARCH_PLACE = "44444444-4444-4444-8444-444444444447";
const UNKNOWN_PLACE = "99999999-9999-4999-8999-999999999999";

const saved = () => [
  makeSavedPlaceWithPlace({
    id: "55555555-5555-4555-8555-555555555551",
    place_id: PLACE_A,
    place: { id: PLACE_A, name: "Fushimi Inari", lat: 34.9671, lng: 135.7727 },
  }),
];

/** Deliberately NOT in the saved list — the search sheet's no-lookup path. */
const searchHit = makePlace({ id: SEARCH_PLACE, name: "Gion Teahouse", lat: 35.0037, lng: 135.775 });

const trip = makeTrip({
  id: TEST_TRIP_ID,
  destination_lat: 35.0116,
  destination_lng: 135.7681,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetMapLocationForTests();
  useMapCameraIntentStore.setState({ pending: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function mockRequests(): jest.Mock {
  return (jest.spyOn(apiClient, "request") as unknown as jest.Mock).mockImplementation(
    (descriptor: unknown) => {
      if (descriptor === placeEndpoints.listSavedPlaces) {
        return Promise.resolve({ items: saved(), nextCursor: null });
      }
      if (descriptor === placeEndpoints.searchPlaces) {
        return Promise.resolve({ items: [searchHit], nextCursor: null });
      }
      if (descriptor === itineraryEndpoints.getItinerary) {
        // The sheet's R-map-23 item resolution (T-8.7) — empty is fine here.
        return Promise.resolve({ items: [], legs: [] });
      }
      return Promise.reject(new Error("unexpected request"));
    },
  );
}

interface SlotHandlers {
  onClose: jest.Mock;
  onSelectSearchPlace: jest.Mock;
  onSearchResultsChange: jest.Mock;
}

function makeHandlers(): SlotHandlers {
  return {
    onClose: jest.fn(),
    onSelectSearchPlace: jest.fn(),
    onSearchResultsChange: jest.fn(),
  };
}

function slotElement(selectedPlaceId: string | null, handlers: SlotHandlers) {
  return (
    <TripProvider trip={trip}>
      <MapPlaceSheetSlot
        tripId={TEST_TRIP_ID}
        selectedPlaceId={selectedPlaceId}
        selectedItemId={null}
        searchPlace={null}
        onSelectSearchPlace={handlers.onSelectSearchPlace}
        onSearchResultsChange={handlers.onSearchResultsChange}
        onClose={handlers.onClose}
      />
    </TripProvider>
  );
}

/** Prop-driven render — the contract half (callbacks observed, state inert). */
async function renderSlot(selectedPlaceId: string | null = null) {
  mockRequests();
  const handlers = makeHandlers();
  const client = makeTestQueryClient();
  const view = await renderWithProviders(slotElement(selectedPlaceId, handlers), {
    queryClient: client,
  });
  // Drain the saved-places settle INSIDE act — a query resolving after the
  // test's last await is the B-2 floating-act class (settle.ts doc).
  await settle();
  return { ...handlers, view };
}

/**
 * Screen-mimicking harness — the end-to-end half: reproduces the screen's
 * T-8.7 state machine (one selection active; onClose clears both) so the
 * presentation/precedence pins survive the state lift honestly.
 */
let harnessSelectPin: ((placeId: string | null) => void) | null = null;

function Harness() {
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [searchPlace, setSearchPlace] = useState<Place | null>(null);
  harnessSelectPin = (placeId) => {
    setSearchPlace(null);
    setSelectedPlaceId(placeId);
  };
  return (
    <TripProvider trip={trip}>
      <MapPlaceSheetSlot
        tripId={TEST_TRIP_ID}
        selectedPlaceId={selectedPlaceId}
        selectedItemId={null}
        searchPlace={searchPlace}
        onSelectSearchPlace={(place) => {
          setSelectedPlaceId(null);
          setSearchPlace(place);
        }}
        onSearchResultsChange={() => undefined}
        onClose={() => {
          setSelectedPlaceId(null);
          setSearchPlace(null);
        }}
      />
    </TripProvider>
  );
}

async function renderHarness() {
  mockRequests();
  const client = makeTestQueryClient();
  await renderWithProviders(<Harness />, { queryClient: client });
  await settle();
}

afterEach(async () => {
  harnessSelectPin = null;
  await settle();
});

it("nothing selected: no sheet; search + locate ARE mounted through the slot", async () => {
  await renderSlot(null);

  expect(screen.queryByTestId("map-sheet-place")).toBeNull();
  expect(screen.getByTestId("map-search-input")).toBeTruthy();
  expect(screen.getByTestId("map-button-locate")).toBeTruthy();
});

it("R-map-4: a selected pin's placeId presents the sheet for its saved row", async () => {
  await renderSlot(PLACE_A);

  expect(await screen.findByTestId("map-sheet-place")).toBeTruthy();
  expect(screen.getByText("Fushimi Inari")).toBeOnTheScreen();
});

it("unresolvable placeId presents NOTHING (the ruling's degrade, not a crash)", async () => {
  await renderSlot(UNKNOWN_PLACE);

  expect(screen.queryByTestId("map-sheet-place")).toBeNull();
});

it("sheet dismissal clears BOTH sources through the seam", async () => {
  const { onClose, onSelectSearchPlace } = await renderSlot(PLACE_A);
  await screen.findByTestId("map-sheet-place");

  await fireEvent.press(screen.getByTestId("map-sheet-place-close"));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelectSearchPlace).toHaveBeenCalledWith(null);
});

it("R-map-25 contract: a result tap reports onClose FIRST, then the row (one-selection order)", async () => {
  const { onClose, onSelectSearchPlace } = await renderSlot(null);

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
  await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelectSearchPlace).toHaveBeenCalledTimes(1);
  expect(onSelectSearchPlace).toHaveBeenCalledWith(searchHit);
  // ORDER: the screen's pin source clears before the row lands.
  const closeOrder = onClose.mock.invocationCallOrder[0];
  const selectOrder = onSelectSearchPlace.mock.invocationCallOrder[0];
  expect(closeOrder).toBeDefined();
  expect(selectOrder).toBeDefined();
  expect(closeOrder as number).toBeLessThan(selectOrder as number);
});

it("E1 feed: the slot forwards the search's visible rows to onSearchResultsChange", async () => {
  const { onSearchResultsChange } = await renderSlot(null);

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
  await settle();

  expect(onSearchResultsChange).toHaveBeenCalledWith([searchHit]);

  // Clearing empties the feed (R-map-25 "clearing removes temporary pins").
  await fireEvent.press(screen.getByTestId("map-search-clear"));
  await settle();
  const lastCall = onSearchResultsChange.mock.calls.at(-1) as [readonly Place[]];
  expect(lastCall[0]).toEqual([]);
});

describe("end-to-end through the screen-mimicking harness (state lifted — T-8.7)", () => {
  it("a search-result tap presents the standard sheet from the RESULT row (no saved lookup)", async () => {
    await renderHarness();

    await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
    await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));

    // (Scoped `within`: the result LIST also carries the place name.)
    const sheet = within(await screen.findByTestId("map-sheet-place"));
    expect(sheet.getByText("Gion Teahouse")).toBeOnTheScreen();
    // Standard sheet: the R-map-8 navigate action is live on it.
    expect(screen.getByTestId("map-sheet-place-button-navigate")).toBeTruthy();
  });

  it("precedence: the screen's pin selection wins over a live search selection", async () => {
    await renderHarness();

    await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
    await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));
    expect(
      within(screen.getByTestId("map-sheet-place")).getByText("Gion Teahouse"),
    ).toBeOnTheScreen();

    // The screen selects a pin (its state feeds the same seam prop).
    // (await — RNTL v14 act is async; un-awaited = the B-2 floating class.)
    await act(async () => {
      harnessSelectPin?.(PLACE_A);
    });

    // Scoped to the SHEET — the result list behind it still shows the hit.
    const sheet = within(await screen.findByTestId("map-sheet-place"));
    expect(sheet.getByText("Fushimi Inari")).toBeOnTheScreen();
    expect(sheet.queryByText("Gion Teahouse")).toBeNull();
  });

  it("dismissing the search-selection sheet clears it (both sources, no resurrection)", async () => {
    await renderHarness();

    await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
    await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));
    await screen.findByTestId("map-sheet-place");

    await fireEvent.press(screen.getByTestId("map-sheet-place-close"));

    // The DS Sheet rides a ~200ms real-timer exit window (PR #16) — wait
    // for the unmount rather than asserting synchronously.
    await waitFor(() => expect(screen.queryByTestId("map-sheet-place")).toBeNull());
  });
});

it("camera-intent DORMANCY: rendering the slot does not drain an armed intent", async () => {
  // Armed (by a locate flow or any future writer) before the surface
  // mounts/re-renders…
  setPendingCameraIntent({ center: [135.77, 35.01], zoom: 14 });

  await renderSlot(null);

  // …and STILL armed after: the SCREEN's T-8.7 drain is the only consumer
  // (camera-intent.ts; the drain itself is pinned in map-screen.test). A
  // slot-side drain would eat the intent before the screen applies it —
  // locate fly-to silently dead (review A11 / probe N5).
  expect(useMapCameraIntentStore.getState().pending).toEqual({
    center: [135.77, 35.01],
    zoom: 14,
  });
});
