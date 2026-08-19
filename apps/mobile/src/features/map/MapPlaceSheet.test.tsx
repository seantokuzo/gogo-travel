/**
 * Place sheet (T-8.3 / MAP-2 — R-map-4 presentation, R-map-8 handoff).
 * Load-bearing:
 *  - spine content: name as title, category line with the coarse fallback,
 *    distance line present ONLY with a known position (§2.3/§2.6);
 *  - Navigate opens the EXACT nav-handoff URL; a failed open surfaces the
 *    inline error (deferred promise, released in finally — mobile.md);
 *  - Details dismisses then pushes the map stack's place route with typed
 *    params (same-tab — no cross-tab landmine);
 *  - the §2.3 actions owned by T-8.4's rows (save/add-to-day/
 *    view-itinerary) are ABSENT this PR — pinned so their later arrival is
 *    a deliberate diff, not drift.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { MapPlaceSheet } from "./MapPlaceSheet";
import { resetMapLocationForTests, useMapLocationStore } from "./location";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderWithTheme } from "@/test-utils/render";
import { makePlace } from "@/test-utils/trip-fixtures";

jest.mock("expo-linking", () => ({
  __esModule: true,
  openURL: jest.fn(async () => null),
  openSettings: jest.fn(async () => null),
}));

jest.mock("expo-router", () => {
  const push = jest.fn();
  return { useRouter: () => ({ push }), __push: push };
});

const { openURL: mockOpenUrl } = jest.requireMock("expo-linking") as { openURL: jest.Mock };
const { __push: mockPush } = jest.requireMock("expo-router") as { __push: jest.Mock };

const PLACE = makePlace({
  id: "44444444-4444-4444-8444-444444444441",
  name: "Fushimi Inari",
  lat: 34.9671,
  lng: 135.7727,
  category: "Shinto Shrine",
  coarse_category: "culture",
});

beforeEach(() => {
  jest.clearAllMocks();
  resetMapLocationForTests();
});

async function renderSheet(overrides?: Partial<Parameters<typeof makePlace>[0]>) {
  const place = overrides === undefined ? PLACE : makePlace({ ...PLACE, ...overrides });
  const onDismiss = jest.fn();
  await renderWithTheme(
    <MapPlaceSheet tripId={TEST_TRIP_ID} place={place} onDismiss={onDismiss} />,
  );
  return { onDismiss, place };
}

it("null place ⇒ hidden (the always-mounted LegModeSheet pattern)", async () => {
  await renderWithTheme(<MapPlaceSheet tripId={TEST_TRIP_ID} place={null} onDismiss={jest.fn()} />);
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
  await renderSheet({ category: null, coarse_category: "food" });
  expect(screen.getByText("Food")).toBeTruthy();
});

it("shows the on-device distance line when a position is known (§2.3)", async () => {
  useMapLocationStore.setState({ position: { lat: 34.9858, lng: 135.7588 } });
  await renderSheet();

  const distance = screen.getByTestId("map-sheet-place-distance");
  expect(distance.props.children).toMatch(/km away$/);
});

it("R-map-8: Navigate opens the coordinate handoff URL", async () => {
  await renderSheet();

  await fireEvent.press(screen.getByTestId("map-sheet-place-button-navigate"));

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

it("T-8.4-owned actions are absent this PR (deliberate, PR scope table)", async () => {
  await renderSheet();

  expect(screen.queryByTestId("map-sheet-place-button-save")).toBeNull();
  expect(screen.queryByTestId("map-sheet-place-button-add-to-day")).toBeNull();
  expect(screen.queryByTestId("map-sheet-place-button-view-itinerary")).toBeNull();
});
