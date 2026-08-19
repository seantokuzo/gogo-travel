/**
 * Filled slot — the frozen seam's contract, exercised end to end
 * (T-8.3 / MAP-2 — R-map-4, R-map-25 sheet path). Load-bearing:
 *  - `selectedPlaceId` (the screen's `onPinSelect` output) presents the
 *    sheet for the SAVED row it resolves to; null presents nothing;
 *  - an unresolvable id presents NOTHING (interim-limited coverage ruling
 *    — no improvised row source);
 *  - every sheet dismissal routes through `onClose` (the seam's only
 *    write-back);
 *  - a search-result tap presents the standard sheet from the RESULT ROW
 *    (a place deliberately NOT in the saved list — the no-lookup path) and
 *    clears the screen's selection first;
 *  - the screen's pin selection takes precedence over a live search
 *    selection;
 *  - search + locate mount through the slot (the §2.8 map-root controls
 *    exist without touching the frozen screen);
 *  - the slot NEVER drains the camera-intent store — the screen's rider
 *    drain is the only consumer (dormant-emitter contract).
 */
import { placeEndpoints } from "@gogo/shared";
import { fireEvent, screen, within } from "@testing-library/react-native";

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
  return { useRouter: () => ({ push }), __push: push };
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
      return Promise.reject(new Error("unexpected request"));
    },
  );
}

function slotElement(selectedPlaceId: string | null, onClose: jest.Mock) {
  return (
    <TripProvider trip={trip}>
      <MapPlaceSheetSlot
        tripId={TEST_TRIP_ID}
        selectedPlaceId={selectedPlaceId}
        onClose={onClose}
      />
    </TripProvider>
  );
}

async function renderSlot(selectedPlaceId: string | null = null) {
  mockRequests();
  const onClose = jest.fn();
  const client = makeTestQueryClient();
  const view = await renderWithProviders(slotElement(selectedPlaceId, onClose), {
    queryClient: client,
  });
  // Drain the saved-places settle INSIDE act — a query resolving after the
  // test's last await is the B-2 floating-act class (settle.ts doc).
  await settle();
  return { onClose, view };
}

afterEach(async () => {
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

it("sheet dismissal routes through the seam's onClose", async () => {
  const { onClose } = await renderSlot(PLACE_A);
  await screen.findByTestId("map-sheet-place");

  await fireEvent.press(screen.getByTestId("map-sheet-place-close"));

  expect(onClose).toHaveBeenCalledTimes(1);
});

it("R-map-25: a search-result tap clears the screen selection and presents the RESULT row", async () => {
  const { onClose } = await renderSlot(null);

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
  await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));

  // The screen's source is cleared first (the one-selection invariant)…
  expect(onClose).toHaveBeenCalledTimes(1);
  // …and the sheet presents from the result row — NOT the saved lookup.
  // (Scoped `within`: the result LIST also carries the place name.)
  const sheet = within(await screen.findByTestId("map-sheet-place"));
  expect(sheet.getByText("Gion Teahouse")).toBeOnTheScreen();

  // Standard sheet: the R-map-8 navigate action is live on it.
  expect(screen.getByTestId("map-sheet-place-button-navigate")).toBeTruthy();
});

it("precedence: the screen's pin selection wins over a live search selection", async () => {
  const { onClose, view } = await renderSlot(null);

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
  await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));
  expect(within(screen.getByTestId("map-sheet-place")).getByText("Gion Teahouse")).toBeOnTheScreen();

  // The screen selects a pin (its state feeds the same seam prop).
  await view.rerender(slotElement(PLACE_A, onClose));

  // Scoped to the SHEET — the result list behind it still shows the hit.
  const sheet = within(await screen.findByTestId("map-sheet-place"));
  expect(sheet.getByText("Fushimi Inari")).toBeOnTheScreen();
  expect(sheet.queryByText("Gion Teahouse")).toBeNull();
});

it("dismissing the search-selection sheet clears it and still reports onClose", async () => {
  const { onClose } = await renderSlot(null);

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Gion");
  await fireEvent.press(await screen.findByTestId(`map-search-list-item-${SEARCH_PLACE}`));
  await screen.findByTestId("map-sheet-place");

  await fireEvent.press(screen.getByTestId("map-sheet-place-close"));

  // onClose fired for the result tap AND the dismissal (both routes clear).
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("camera-intent DORMANCY: rendering the slot does not drain an armed intent", async () => {
  // Armed (by a locate flow or any future writer) before the surface
  // mounts/re-renders…
  setPendingCameraIntent({ center: [135.77, 35.01], zoom: 14 });

  await renderSlot(null);

  // …and STILL armed after: the screen's rider drain is the only consumer
  // (camera-intent.ts dormant-emitter contract). A slot-side drain would
  // eat the intent before the screen applies it — locate fly-to silently
  // dead the day the rider wires it (review A11 / probe N5).
  expect(useMapCameraIntentStore.getState().pending).toEqual({
    center: [135.77, 35.01],
    zoom: 14,
  });
});
