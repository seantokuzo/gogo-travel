/**
 * Map tab shell — composition through the global `@rnmapbox/maps` mock
 * (T-8.2 / MAP-1; R-map-1..3, R-map-6, R-map-7).
 *
 * The mock renders SDK components as prop-forwarding Views (jest never
 * renders the native MapView — P-8 prep ruling), so this suite proves the
 * SCREEN's composition and wiring: themed style URL, three clustered
 * sources fed by the real builders over the real data hooks (network mocked
 * by descriptor), day-filter chips driving source data + camera refits,
 * cluster-vs-pin press routing, the three frozen seams, and the tokenless
 * boot arm. Pin/camera/filter LOGIC pins live in `features/map/*.test.ts`.
 *
 * The place-sheet slot (frozen seam a) is mocked to a prop probe: the slot
 * renders null by design, so the SEAM CONTRACT — which placeId T-8.3's
 * sheet would receive — is otherwise unobservable. The slot has zero
 * behavior to mask (T-5.7 crash-masking class does not apply to a null
 * component).
 */
import { ATTRIBUTION, type Place, type TripListItem } from "@gogo/shared";
import { mapColors } from "@gogo/tokens";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { AppState } from "react-native";

import MapScreen from "@/app/[tripId]/map/index";
import { queryKeys } from "@/data/query-client";
import {
  CAMERA_ANIMATION_MS,
  DEFAULT_MAP_STYLE_URLS,
  LOCATE_CAMERA_ZOOM,
  resetMapboxAccessTokenForTests,
  resetMapLocationForTests,
  setPendingCameraIntent,
  setPendingMapFocus,
  SINGLE_PIN_ZOOM,
  useMapCameraIntentStore,
  useMapLocationStore,
  usePendingMapFocusStore,
} from "@/features/map";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import {
  itineraryApiOverrides,
  makeItineraryItem,
  TRIP_END,
  TRIP_START,
} from "@/test-utils/itinerary-fixtures";
import { lightTheme, makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { settle } from "@/test-utils/settle";
import { makePlace, makeSavedPlaceWithPlace, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

/** Ordered cross-tab call log (E4) — the two-step contract is an ORDER claim. */
const mockCallSequence: [string, unknown][] = [];
const mockRouterPush = jest.fn((target: unknown) => mockCallSequence.push(["push", target]));
const mockTabNavigate = jest.fn((tab: unknown) => mockCallSequence.push(["tab", tab]));
jest.mock("expo-router", () => ({
  // Mirrors the real hook's mount-focus semantics (trip-list test pattern):
  // the always-focused test screen runs the effect on mount.
  useFocusEffect: (effect: () => undefined | void | (() => void)) => {
    const { useEffect: reactUseEffect } = jest.requireActual<typeof import("react")>("react");
    reactUseEffect(() => effect(), [effect]);
  },
  useRouter: () => ({ push: mockRouterPush }),
  useNavigation: () => ({
    navigate: mockTabNavigate,
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

// Seam prop probe (module doc) — forwards the WHOLE T-8.7 contract so the
// rider pins can read state props and drive the callback props.
jest.mock("@/features/map/MapPlaceSheetSlot", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  // Loosely-typed host so the probe can carry the contract props verbatim.
  const Probe = View as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    MapPlaceSheetSlot: (props: Record<string, unknown>) =>
      React.createElement(Probe, { ...props, testID: "map-place-sheet-slot" }),
  };
});

const mapboxMock = jest.requireMock("@rnmapbox/maps") as {
  __mock: {
    setAccessToken: jest.Mock;
    camera: { setCamera: jest.Mock };
    shapeSource: { getClusterExpansionZoom: jest.Mock };
  };
};

const PLACE_A = "44444444-4444-4444-8444-444444444441";
const PLACE_B = "44444444-4444-4444-8444-444444444442";
const PLACE_C = "44444444-4444-4444-8444-444444444443";
const ITEM_ID = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ITEM_DAY0_ID = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const FOREIGN_TRIP_ID = "99999999-9999-4999-8999-999999999999";

/** Fushimi Inari + Nishiki Market — the known coordinate fixtures. */
const savedFixtures = () => [
  makeSavedPlaceWithPlace({
    id: "55555555-5555-4555-8555-555555555551",
    place_id: PLACE_A,
    place: { id: PLACE_A, name: "Fushimi Inari", lat: 34.9671, lng: 135.7727 },
  }),
  makeSavedPlaceWithPlace({
    id: "55555555-5555-4555-8555-555555555552",
    place_id: PLACE_B,
    place: { id: PLACE_B, name: "Nishiki Market", lat: 35.005, lng: 135.7646 },
  }),
];

/** One place_visit on the trip's LAST day (dayIndex 2) at Fushimi Inari. */
const itemFixtures = () => [
  makeItineraryItem({
    id: ITEM_ID,
    kind: "place_visit",
    place_id: PLACE_A,
    title: null,
    day: TRIP_END,
  }),
];

function tripFixture(overrides?: Partial<TripListItem>): TripListItem {
  return makeTrip({
    id: TEST_TRIP_ID,
    start_date: TRIP_START,
    end_date: TRIP_END,
    destination_lat: 35.0116,
    destination_lng: 135.7681,
    ...overrides,
  });
}

async function renderMap(opts?: {
  trip?: TripListItem;
  saved?: ReturnType<typeof savedFixtures>;
  items?: ReturnType<typeof itemFixtures>;
  scheme?: "light" | "dark";
  overrides?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
}) {
  seedAuthenticated();
  const trip = opts?.trip ?? tripFixture();
  const saved = opts?.saved ?? savedFixtures();
  const request = mockNavApi({
    trips: [trip],
    overrides: {
      ...itineraryApiOverrides({ items: opts?.items ?? itemFixtures(), bookings: [] }),
      "GET /trips/:tripId/saved-places": () =>
        Promise.resolve({ items: saved, nextCursor: null }),
      ...opts?.overrides,
    },
  });
  const client = makeTestQueryClient();
  const view = await renderWithProviders(
    <TripProvider trip={trip}>
      <MapScreen />
    </TripProvider>,
    { queryClient: client, ...(opts?.scheme ? { scheme: opts.scheme } : {}) },
  );
  await settle();
  return { request, trip, view, client };
}

/** The mocked source View exposes the screen-built collection as `shape`. */
function sourceShape(testID: string): { features: { properties: Record<string, unknown> }[] } {
  return screen.getByTestId(testID).props.shape;
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
  mapboxMock.__mock.setAccessToken.mockClear();
  mapboxMock.__mock.camera.setCamera.mockClear();
  mapboxMock.__mock.shapeSource.getClusterExpansionZoom.mockClear();
  usePendingMapFocusStore.setState({ pending: null });
  // T-8.7 rider stores + nav mocks — same cross-test hygiene.
  useMapCameraIntentStore.setState({ pending: null });
  resetMapLocationForTests();
  resetTabMemory();
  mockRouterPush.mockClear();
  mockTabNavigate.mockClear();
  mockCallSequence.length = 0;
  // Latch hygiene (R1 review, tests A7): the module-level token latch must
  // never leak across tests — a stale `true` masks the deletion direction.
  resetMapboxAccessTokenForTests();
});

describe("shell composition (R-map-1, R-map-7)", () => {
  it("renders the themed MapView with three clustered sources fed by real builders", async () => {
    await renderMap();

    expect(screen.getByTestId("map-screen")).toBeTruthy();
    const mapView = screen.getByTestId("map-view");
    expect(mapView.props.styleURL).toBe(DEFAULT_MAP_STYLE_URLS.light);
    // R-map-6: SDK attribution + wordmark ON (positions are phase-QA visual).
    expect(mapView.props.attributionEnabled).toBe(true);
    expect(mapView.props.logoEnabled).toBe(true);

    for (const source of ["map-source-photo", "map-source-saved", "map-source-itinerary"]) {
      expect(screen.getByTestId(source).props.cluster).toBe(true);
    }
    expect(sourceShape("map-source-saved").features).toHaveLength(2);
    expect(sourceShape("map-source-itinerary").features).toHaveLength(1);
    // Photo family: wired, EMPTY-IN-PROD until P-12 (prep ruling).
    expect(sourceShape("map-source-photo").features).toHaveLength(0);

    expect(sourceShape("map-source-saved").features[0]?.properties["testID"]).toBe(
      `map-pin-saved-${PLACE_A}`,
    );
    expect(sourceShape("map-source-itinerary").features[0]?.properties["testID"]).toBe(
      `map-pin-itinerary-${ITEM_ID}`,
    );
  });

  it("loads the dark style under the dark scheme (R-map-7)", async () => {
    await renderMap({ scheme: "dark" });
    expect(screen.getByTestId("map-view").props.styleURL).toBe(DEFAULT_MAP_STYLE_URLS.dark);
  });

  /**
   * The token seam is a MODULE-SCOPE call in the screen file (R1 review,
   * corr A4: a post-mount effect races native MapView creation). Each pin
   * evaluates the screen module in a FRESH registry (fresh token latch, the
   * jest.setup mock factory re-runs) so the module-scope hand-off itself is
   * what's under test — the pair closes probe N1's deletion direction.
   */
  function importScreenFresh(): { setAccessToken: jest.Mock } {
    let fresh: { __mock: { setAccessToken: jest.Mock } } | undefined;
    jest.isolateModules(() => {
      jest.requireActual("@/app/[tripId]/map/index");
      fresh = jest.requireMock("@rnmapbox/maps") as { __mock: { setAccessToken: jest.Mock } };
    });
    if (fresh === undefined) throw new Error("isolateModules did not run");
    return fresh.__mock;
  }

  function withAccessTokenEnv(value: string | undefined, run: () => void): void {
    const previous = process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
    if (value === undefined) delete process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
    else process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN;
      else process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN = previous;
    }
  }

  it("boots TOKENLESS: no access token handed to the SDK without env config", () => {
    withAccessTokenEnv(undefined, () => {
      expect(importScreenFresh().setAccessToken).not.toHaveBeenCalled();
    });
  });

  it("WITH-TOKEN control: the screen module hands the env token to the SDK at module scope", () => {
    withAccessTokenEnv("pk.screen-env-token", () => {
      const setAccessToken = importScreenFresh().setAccessToken;
      expect(setAccessToken).toHaveBeenCalledTimes(1);
      expect(setAccessToken).toHaveBeenCalledWith("pk.screen-env-token");
    });
  });

  it("module scope disables SDK telemetry — false, exactly once (T-8.7 rider)", () => {
    // The global jest mock omits `setTelemetryEnabled` (jest.setup.js is
    // T-8.5-owned — mock addition ESCALATED); inject the prod-shape fn into
    // the FRESH registry's mock BEFORE the screen module evaluates, so the
    // module-scope call is what's under test. Every OTHER test in this file
    // doubles as the omitted-API arm: the screen imports without throwing.
    let telemetrySpy: jest.Mock | undefined;
    jest.isolateModules(() => {
      const fresh = jest.requireMock("@rnmapbox/maps") as {
        default: { setTelemetryEnabled?: jest.Mock };
      };
      telemetrySpy = jest.fn();
      fresh.default.setTelemetryEnabled = telemetrySpy;
      jest.requireActual("@/app/[tripId]/map/index");
    });
    expect(telemetrySpy).toBeDefined();
    expect(telemetrySpy).toHaveBeenCalledTimes(1);
    expect(telemetrySpy).toHaveBeenCalledWith(false);
  });
});

describe("camera (§2.1)", () => {
  it("fits all pins once when the pin data settles", async () => {
    await renderMap();
    const setCamera = mapboxMock.__mock.camera.setCamera;
    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        bounds: { ne: [135.7727, 35.005], sw: [135.7646, 34.9671] },
        animationDuration: 0,
      }),
    );
  });

  it("later refetches NEVER yank the camera — the fit-once guard survives invalidation (R1 review)", async () => {
    // T-8.3's spec'd job is invalidating tripSavedPlaces after a save; new
    // rows mean new feature identities — the camera must hold mid-browse.
    let calls = 0;
    const extra = makeSavedPlaceWithPlace({
      id: "55555555-5555-4555-8555-555555555553",
      place_id: PLACE_C,
      place: { id: PLACE_C, name: "Kyoto Station", lat: 34.9858, lng: 135.7588 },
    });
    const { client } = await renderMap({
      overrides: {
        "GET /trips/:tripId/saved-places": () => {
          calls += 1;
          return Promise.resolve({
            items: calls === 1 ? savedFixtures() : [...savedFixtures(), extra],
            nextCursor: null,
          });
        },
      },
    });
    const setCamera = mapboxMock.__mock.camera.setCamera;
    expect(setCamera).toHaveBeenCalledTimes(1);

    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.tripSavedPlaces(TEST_TRIP_ID) });
    });
    await settle();

    // Applied-proof: the refetch really landed NEW pin identities…
    expect(sourceShape("map-source-saved").features).toHaveLength(3);
    // …and the initial fit stayed the ONLY setCamera call.
    expect(setCamera).toHaveBeenCalledTimes(1);
  });
});

describe("day filter (R-map-3)", () => {
  it("renders All + one chip per trip day", async () => {
    await renderMap();
    expect(screen.getByTestId("map-day-filter")).toBeTruthy();
    expect(screen.getByTestId("map-day-filter-chip-all")).toBeTruthy();
    for (const dayIndex of [0, 1, 2]) {
      expect(screen.getByTestId(`map-day-filter-chip-${dayIndex}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("map-day-filter-chip-3")).toBeNull();
  });

  it("selecting a day keeps ONLY that day's itinerary pins (strict subset), dims context pins, refits camera", async () => {
    // Two items on DIFFERENT days (R1 review, tests A9): filtered must be a
    // STRICT subset of unfiltered, so an unfiltered-passthrough goes RED.
    await renderMap({
      items: [
        ...itemFixtures(),
        makeItineraryItem({
          id: ITEM_DAY0_ID,
          kind: "place_visit",
          place_id: PLACE_B,
          title: null,
          day: TRIP_START, // dayIndex 0 — dropped by the day-2 filter
        }),
      ],
    });
    const setCamera = mapboxMock.__mock.camera.setCamera;
    setCamera.mockClear();
    expect(sourceShape("map-source-itinerary").features).toHaveLength(2);

    await fireEvent.press(screen.getByTestId("map-day-filter-chip-2"));

    // Only the dayIndex-2 item survives — 2 → 1, the strict subset.
    const filtered = sourceShape("map-source-itinerary").features;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.properties["testID"]).toBe(`map-pin-itinerary-${ITEM_ID}`);
    // Saved pins REMAIN, dimmed to the token opacity.
    const savedLayer = screen.getByTestId("map-layer-saved-pin");
    expect(savedLayer.props.layerStyle.circleOpacity).toBe(mapColors(lightTheme).dimOpacity);
    // Camera refit to the single matching pin — animated center stop.
    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith(
      expect.objectContaining({ centerCoordinate: [135.7727, 34.9671] }),
    );
  });

  it("a day with no pins filters to empty and moves the camera nowhere", async () => {
    await renderMap();
    const setCamera = mapboxMock.__mock.camera.setCamera;
    setCamera.mockClear();

    await fireEvent.press(screen.getByTestId("map-day-filter-chip-0"));

    expect(sourceShape("map-source-itinerary").features).toHaveLength(0);
    expect(setCamera).not.toHaveBeenCalled();

    // Back to All: every pin returns, camera refits (interpretation arm).
    await fireEvent.press(screen.getByTestId("map-day-filter-chip-all"));
    expect(sourceShape("map-source-itinerary").features).toHaveLength(1);
    expect(screen.getByTestId("map-layer-saved-pin").props.layerStyle.circleOpacity).toBe(1);
    expect(setCamera).toHaveBeenCalledTimes(1);
  });
});

describe("press routing (R-map-2 + frozen seam a)", () => {
  it("cluster tap expands via getClusterExpansionZoom — NEVER selects", async () => {
    await renderMap();
    const clusterFeature = { properties: { point_count: 3, cluster: true } };

    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [clusterFeature],
      coordinates: { latitude: 35.0, longitude: 135.75 },
    });
    await settle();

    expect(mapboxMock.__mock.shapeSource.getClusterExpansionZoom).toHaveBeenCalledWith(
      clusterFeature,
    );
    expect(mapboxMock.__mock.camera.setCamera).toHaveBeenCalledWith(
      expect.objectContaining({ centerCoordinate: [135.75, 35.0], zoomLevel: 12 }),
    );
    // The seam contract: a cluster press selects NOTHING.
    expect(screen.getByTestId("map-place-sheet-slot").props.selectedPlaceId).toBeNull();
  });

  it("pin tap feeds onPinSelect → the sheet slot; map tap clears (seam a contract)", async () => {
    await renderMap();
    const slot = () => screen.getByTestId("map-place-sheet-slot");
    expect(slot().props.selectedPlaceId).toBeNull();
    expect(slot().props.tripId).toBe(TEST_TRIP_ID);

    const savedFeature = sourceShape("map-source-saved").features[0];
    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [savedFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });
    expect(slot().props.selectedPlaceId).toBe(PLACE_A);

    // §2.3 "tapping the map dismisses" — wired shell-side.
    await fireEvent(screen.getByTestId("map-view"), "press");
    expect(slot().props.selectedPlaceId).toBeNull();
  });

  it("itinerary pin tap selects its PLACE (the sheet is place-keyed)", async () => {
    await renderMap();
    const itineraryFeature = sourceShape("map-source-itinerary").features[0];
    await fireEvent(screen.getByTestId("map-source-itinerary"), "press", {
      features: [itineraryFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });
    expect(screen.getByTestId("map-place-sheet-slot").props.selectedPlaceId).toBe(PLACE_A);
  });
});

describe("pending focus (frozen seam c)", () => {
  it("drains the store on focus into the selection seam — consumed once", async () => {
    setPendingMapFocus(TEST_TRIP_ID, PLACE_B);
    await renderMap();
    expect(screen.getByTestId("map-place-sheet-slot").props.selectedPlaceId).toBe(PLACE_B);
    // Consumed: nothing pending for the next focus.
    expect(usePendingMapFocusStore.getState().pending).toBeNull();
  });

  it("a focus armed for ANOTHER trip is discarded-and-cleared, never presented (R1 review)", async () => {
    // Scenario: trip-A sender arms, the jump is interrupted; this trip's map
    // focuses later — the stale foreign id must not open a sheet here.
    setPendingMapFocus(FOREIGN_TRIP_ID, PLACE_B);
    await renderMap();
    expect(screen.getByTestId("map-place-sheet-slot").props.selectedPlaceId).toBeNull();
    // Discard-and-CLEAR: the stale focus is gone entirely.
    expect(usePendingMapFocusStore.getState().pending).toBeNull();
  });

  it("no pending focus → nothing selected on mount (control arm)", async () => {
    await renderMap();
    expect(screen.getByTestId("map-place-sheet-slot").props.selectedPlaceId).toBeNull();
  });
});

describe("attribution (R-map-6)", () => {
  it("the info button opens the spine-attribution sheet with the shared registry strings", async () => {
    await renderMap();
    await fireEvent.press(screen.getByTestId("map-button-attribution"));
    await settle();
    expect(screen.getByTestId("map-sheet-attribution")).toBeTruthy();
    expect(screen.getByText(ATTRIBUTION.overture.text)).toBeTruthy();
    expect(screen.getByText(ATTRIBUTION.fsq_os.text)).toBeTruthy();
  });
});

describe("degrade states", () => {
  it("shows a retryable banner when a pin query fails; pins from healthy queries still render", async () => {
    let calls = 0;
    await renderMap({
      overrides: {
        "GET /trips/:tripId/saved-places": () => {
          calls += 1;
          return Promise.reject(new Error("boom"));
        },
      },
    });
    expect(screen.getByTestId("map-error")).toBeTruthy();
    // The itinerary source lost its coordinate index (saved places feed it),
    // but the screen itself stays functional.
    expect(screen.getByTestId("map-screen")).toBeTruthy();
    expect(calls).toBe(1);

    await fireEvent.press(screen.getByTestId("map-error-retry"));
    await settle();
    expect(calls).toBe(2);
  });

  it("EmptyState only on the world arm (dormant while destination coords are guaranteed)", async () => {
    await renderMap();
    expect(screen.queryByTestId("map-empty-state")).toBeNull();
  });

  it("CONTROL: zero pins + unusable destination coords → world arm EmptyState", async () => {
    await renderMap({
      trip: tripFixture({ destination_lat: Number.NaN, destination_lng: Number.NaN }),
      saved: [],
      items: [],
    });
    expect(screen.getByTestId("map-empty-state")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T-8.7 integration rider (E1–E4, R-map-24) — the sanctioned screen wiring.
// ---------------------------------------------------------------------------

const SEARCH_HIT_A = makePlace({
  id: "44444444-4444-4444-8444-444444444447",
  name: "Gion Teahouse",
  lat: 35.0037,
  lng: 135.775,
});
const SEARCH_HIT_B = makePlace({
  id: "44444444-4444-4444-8444-444444444448",
  name: "Gion Corner",
  lat: 35.0031,
  lng: 135.7748,
});

const slotProps = () =>
  screen.getByTestId("map-place-sheet-slot").props as {
    selectedPlaceId: string | null;
    selectedItemId: string | null;
    searchPlace: Place | null;
    onSearchResultsChange(places: readonly Place[]): void;
    onSelectSearchPlace(place: Place | null): void;
  };

describe("search temp pins (E1 — R-map-25)", () => {
  it("rows reported through the seam render the NON-clustered search source; clearing empties it", async () => {
    await renderMap();
    expect(sourceShape("map-source-search").features).toHaveLength(0);

    await act(async () => {
      slotProps().onSearchResultsChange([SEARCH_HIT_A, SEARCH_HIT_B]);
    });

    const source = screen.getByTestId("map-source-search");
    // Never clustered (≤ page limit — search-pins doc).
    expect(source.props.cluster).toBeUndefined();
    const features = sourceShape("map-source-search").features;
    expect(features).toHaveLength(2);
    expect(features[0]?.properties["testID"]).toBe(`map-pin-search-${SEARCH_HIT_A.id}`);
    // Token-only color: the focus-ring semantic (search-pins interp).
    expect(features[0]?.properties["color"]).toBe(mapColors(lightTheme).pinSelectedRing);

    // R-map-25 "clearing the search removes temporary pins".
    await act(async () => {
      slotProps().onSearchResultsChange([]);
    });
    expect(sourceShape("map-source-search").features).toHaveLength(0);
  });

  it("the search source renders TOPMOST — the LAST source in the map's z-order (interp 1, R1 tests A5)", async () => {
    // A silent reorder ships the transient highlight UNDER pins/clusters
    // exactly where the map is densest — pin the whole bottom-up order.
    await renderMap();
    await act(async () => {
      slotProps().onSearchResultsChange([SEARCH_HIT_A]);
    });

    // Host-order query: getAllBy* returns document (render) order, which for
    // sibling sources IS the Mapbox z-order (later child renders on top).
    const sourceIds = screen
      .getAllByTestId(/^map-source-/)
      .map((node) => node.props.testID as string);
    expect(sourceIds).toEqual([
      "map-source-photo",
      "map-source-saved",
      "map-source-itinerary",
      "map-source-search",
    ]);
  });

  it("a search-pin tap lands on the SEARCH-selection path and clears the pin selection", async () => {
    await renderMap();
    // A pin selection is active first…
    const savedFeature = sourceShape("map-source-saved").features[0];
    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [savedFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });
    expect(slotProps().selectedPlaceId).toBe(PLACE_A);

    await act(async () => {
      slotProps().onSearchResultsChange([SEARCH_HIT_A]);
    });
    await fireEvent(screen.getByTestId("map-source-search"), "press", {
      features: [
        {
          properties: {
            family: "search",
            placeId: SEARCH_HIT_A.id,
            testID: `map-pin-search-${SEARCH_HIT_A.id}`,
          },
        },
      ],
      coordinates: { latitude: 35.0037, longitude: 135.775 },
    });

    // One selection active: the search row IS the sheet's source now.
    expect(slotProps().searchPlace).toEqual(SEARCH_HIT_A);
    expect(slotProps().selectedPlaceId).toBeNull();
  });

  it("a later PIN tap wins back: search selection clears (precedence)", async () => {
    await renderMap();
    await act(async () => {
      slotProps().onSearchResultsChange([SEARCH_HIT_A]);
      slotProps().onSelectSearchPlace(SEARCH_HIT_A);
    });
    expect(slotProps().searchPlace).toEqual(SEARCH_HIT_A);

    const savedFeature = sourceShape("map-source-saved").features[0];
    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [savedFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });

    expect(slotProps().selectedPlaceId).toBe(PLACE_A);
    expect(slotProps().searchPlace).toBeNull();
  });
});

describe("location puck + permission re-sync (E2 — R-map-15, corr A2)", () => {
  // The real LocationPuck Props carry no testID, so the global mock renders
  // unqueryably — swap in a queryable probe for this describe (the screen's
  // compiled import reads `LocationPuck` off the module at RENDER time, so
  // the assignment takes effect without re-importing).
  const mapboxModule = jest.requireMock("@rnmapbox/maps") as { LocationPuck: unknown };
  const originalPuck = mapboxModule.LocationPuck;
  beforeEach(() => {
    const React = jest.requireActual<typeof import("react")>("react");
    const { View } = jest.requireActual<typeof import("react-native")>("react-native");
    mapboxModule.LocationPuck = function PuckProbe() {
      return React.createElement(View, { testID: "map-location-puck" });
    };
  });
  afterEach(() => {
    mapboxModule.LocationPuck = originalPuck;
  });

  it("the puck mounts ONLY under a granted permission (gate probed both directions)", async () => {
    await renderMap();
    expect(screen.queryByTestId("map-location-puck")).toBeNull();

    await act(async () => {
      useMapLocationStore.setState({ permission: "granted" });
    });
    expect(screen.getByTestId("map-location-puck")).toBeTruthy();

    // The revoke direction (Settings revoke → re-sync flips the store).
    await act(async () => {
      useMapLocationStore.setState({ permission: "denied" });
    });
    expect(screen.queryByTestId("map-location-puck")).toBeNull();
  });

  it("an app-ACTIVE transition re-reads the system permission — a Settings grant is observed", async () => {
    const addListener = jest.spyOn(AppState, "addEventListener");
    const locationMock = jest.requireMock("expo-location") as {
      __mock: { getForegroundPermissionsAsync: jest.Mock };
    };
    locationMock.__mock.getForegroundPermissionsAsync.mockClear();

    await renderMap();
    // Mounting registers the listener but reads NOTHING (the lazy pin's
    // screen-level extension).
    expect(locationMock.__mock.getForegroundPermissionsAsync).not.toHaveBeenCalled();

    const changeHandlers = addListener.mock.calls
      .filter(([type]) => type === "change")
      .map(([, handler]) => handler as (state: string) => void);
    expect(changeHandlers.length).toBeGreaterThan(0);

    // CONTROL: a background transition reads nothing.
    await act(async () => {
      for (const handler of changeHandlers) handler("background");
    });
    expect(locationMock.__mock.getForegroundPermissionsAsync).not.toHaveBeenCalled();

    // The user granted in Settings; the app returns to the foreground.
    // (mockResolvedValue, not Once: the AppState jest emitter fans a single
    // invocation out through every registered wrapper, so the read can fire
    // more than once — the load-bearing claims are fired-at-all on ACTIVE,
    // NOT-fired on mount/background, and the store following the read.)
    locationMock.__mock.getForegroundPermissionsAsync.mockResolvedValue({
      status: "granted",
      granted: true,
      canAskAgain: true,
      expires: "never",
    });
    await act(async () => {
      for (const handler of changeHandlers) handler("active");
    });

    expect(locationMock.__mock.getForegroundPermissionsAsync).toHaveBeenCalled();
    expect(useMapLocationStore.getState().permission).toBe("granted");
  });

  it("unmount REMOVES the AppState listener (R1 tests A4 — no dead-closure re-reads)", async () => {
    // Without the cleanup, N map visits leave N leaked listeners re-reading
    // permissions through dead closures on every foreground return.
    const subs: { type: string; handler: (state: string) => void; remove: jest.Mock }[] = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
      const sub = {
        type: type as string,
        handler: handler as (state: string) => void,
        remove: jest.fn(),
      };
      subs.push(sub);
      return sub as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    const locationMock = jest.requireMock("expo-location") as {
      __mock: { getForegroundPermissionsAsync: jest.Mock };
    };
    locationMock.__mock.getForegroundPermissionsAsync.mockClear();

    const { view } = await renderMap();

    // Identify the SCREEN's subscription by behavior — the change-listener
    // whose "active" dispatch triggers the permission re-read — so another
    // consumer's own subscribe/unsubscribe can never satisfy this pin.
    const ours: typeof subs = [];
    for (const sub of subs.filter((candidate) => candidate.type === "change")) {
      const before = locationMock.__mock.getForegroundPermissionsAsync.mock.calls.length;
      await act(async () => {
        sub.handler("active");
      });
      if (locationMock.__mock.getForegroundPermissionsAsync.mock.calls.length > before) {
        ours.push(sub);
      }
    }
    expect(ours).toHaveLength(1);
    expect(ours[0]?.remove).not.toHaveBeenCalled();

    await view.unmount();
    expect(ours[0]?.remove).toHaveBeenCalledTimes(1);
  });
});

describe("camera-intent drain (E3 — R-map-17)", () => {
  it("an intent armed BEFORE mount drains on mount: fly-to applied, store cleared", async () => {
    setPendingCameraIntent({ center: [135.77, 35.01], zoom: LOCATE_CAMERA_ZOOM });
    await renderMap();

    expect(mapboxMock.__mock.camera.setCamera).toHaveBeenCalledWith({
      centerCoordinate: [135.77, 35.01],
      zoomLevel: LOCATE_CAMERA_ZOOM,
      animationDuration: CAMERA_ANIMATION_MS,
    });
    // Consumed — a tab revisit can never replay it (store contract).
    expect(useMapCameraIntentStore.getState().pending).toBeNull();
  });

  it("an intent armed WHILE mounted drains reactively — exactly once", async () => {
    await renderMap();
    const setCamera = mapboxMock.__mock.camera.setCamera;
    setCamera.mockClear();

    await act(async () => {
      setPendingCameraIntent({ center: [139.7, 35.66], zoom: LOCATE_CAMERA_ZOOM });
    });

    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(setCamera).toHaveBeenCalledWith({
      centerCoordinate: [139.7, 35.66],
      zoomLevel: LOCATE_CAMERA_ZOOM,
      animationDuration: CAMERA_ANIMATION_MS,
    });
    expect(useMapCameraIntentStore.getState().pending).toBeNull();

    await settle();
    expect(setCamera).toHaveBeenCalledTimes(1); // no replay
  });
});

describe("focus-originated camera centering (R-map-24)", () => {
  it("a drained focus CENTERS the camera on its pin once the coordinate resolves", async () => {
    setPendingMapFocus(TEST_TRIP_ID, PLACE_B);
    await renderMap();

    // Beyond the initial fit: an ANIMATED center stop at the focused pin
    // (Nishiki Market), single-pin zoom — the §2.1 recipe.
    expect(mapboxMock.__mock.camera.setCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        centerCoordinate: [135.7646, 35.005],
        zoomLevel: SINGLE_PIN_ZOOM,
        animationDuration: CAMERA_ANIMATION_MS,
      }),
    );
  });

  it("CONTROL: a plain pin tap presents the sheet but does NOT recenter", async () => {
    await renderMap();
    const setCamera = mapboxMock.__mock.camera.setCamera;
    setCamera.mockClear();

    const savedFeature = sourceShape("map-source-saved").features[0];
    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [savedFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });

    expect(slotProps().selectedPlaceId).toBe(PLACE_A);
    expect(setCamera).not.toHaveBeenCalled();
  });
});

describe("deliberate camera writes vs the initial fit (R1 corr B1)", () => {
  // The three pin queries settle in NO guaranteed order; the initial-fit
  // effect fires whenever they do. Any DELIBERATE camera write that lands
  // first must satisfy the fit — otherwise the late settle teleport-yanks
  // the camera with the all-pins envelope (non-animated). The pre-fit view
  // is never blank: the Camera's defaultSettings destination stop covers it.

  it("locate fly-to, then LATE settle: exactly ONE deliberate setCamera, no envelope yank", async () => {
    // Slow trip queries — hold saved-places in flight (deferred, released
    // in `finally` per mobile.md) so `settled` stays false past the locate.
    const releases: ((value: unknown) => void)[] = [];
    await renderMap({
      overrides: {
        "GET /trips/:tripId/saved-places": () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      },
    });
    const setCamera = mapboxMock.__mock.camera.setCamera;

    try {
      // Nothing settled and nothing armed — no camera write yet.
      expect(setCamera).not.toHaveBeenCalled();

      // The user taps locate mid-flight: the drain applies the fly-to.
      await act(async () => {
        setPendingCameraIntent({ center: [135.77, 35.01], zoom: LOCATE_CAMERA_ZOOM });
      });
      expect(setCamera).toHaveBeenCalledTimes(1);
      expect(setCamera).toHaveBeenCalledWith(
        expect.objectContaining({ centerCoordinate: [135.77, 35.01], zoomLevel: LOCATE_CAMERA_ZOOM }),
      );
    } finally {
      // The slow query settles LATE.
      await act(async () => {
        for (const release of releases) release({ items: savedFixtures(), nextCursor: null });
      });
    }
    await settle();

    // Applied-proof: the late rows really landed as pins…
    expect(sourceShape("map-source-saved").features).toHaveLength(2);
    // …and the locate write stayed the ONLY setCamera — no envelope stomp.
    expect(setCamera).toHaveBeenCalledTimes(1);
  });

  it("focus-centering, then LATE settle: the centering survives with the sheet open", async () => {
    // itinerary→place link: savedQuery resolves first (coordinate resolves,
    // centering fires, sheet opens), itinerary settles later — the fit must
    // not stomp the centering (R-map-24 visibly undone otherwise).
    const releases: ((value: unknown) => void)[] = [];
    setPendingMapFocus(TEST_TRIP_ID, PLACE_B);
    await renderMap({
      overrides: {
        "GET /trips/:tripId/itinerary": () =>
          new Promise((resolve) => {
            releases.push(resolve);
          }),
      },
    });
    const setCamera = mapboxMock.__mock.camera.setCamera;

    try {
      // The focus drain selected PLACE_B and the centering already fired.
      expect(slotProps().selectedPlaceId).toBe(PLACE_B);
      expect(setCamera).toHaveBeenCalledTimes(1);
      expect(setCamera).toHaveBeenCalledWith(
        expect.objectContaining({
          centerCoordinate: [135.7646, 35.005],
          zoomLevel: SINGLE_PIN_ZOOM,
          animationDuration: CAMERA_ANIMATION_MS,
        }),
      );
    } finally {
      await act(async () => {
        for (const release of releases) release({ items: itemFixtures(), legs: [] });
      });
    }
    await settle();

    // Applied-proof: the late itinerary rows landed as pins…
    expect(sourceShape("map-source-itinerary").features).toHaveLength(1);
    // …the centering stood (no second write), the sheet is still open.
    expect(setCamera).toHaveBeenCalledTimes(1);
    expect(slotProps().selectedPlaceId).toBe(PLACE_B);
  });
});

describe("itinerary item context on the seam (E5 — R-map-23, R1 tests B2)", () => {
  it("an itinerary-pin press carries THAT pin's itemId; a saved press clears it (CONTROL)", async () => {
    // TWO visits to the SAME place on different days — the seam must carry
    // the PRESSED pin's item, not merely some item of the place (interp 5's
    // multi-visit disambiguation; place-keyed state alone can't tell them
    // apart).
    await renderMap({
      items: [
        ...itemFixtures(),
        makeItineraryItem({
          id: ITEM_DAY0_ID,
          kind: "place_visit",
          place_id: PLACE_A,
          title: null,
          day: TRIP_START,
        }),
      ],
    });
    expect(slotProps().selectedItemId).toBeNull();

    // Press the day-3 pin (ITEM_ID's feature, found by its testID).
    const dayThree = sourceShape("map-source-itinerary").features.find(
      (feature) => feature.properties["testID"] === `map-pin-itinerary-${ITEM_ID}`,
    );
    expect(dayThree).toBeDefined();
    await fireEvent(screen.getByTestId("map-source-itinerary"), "press", {
      features: [dayThree],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });

    expect(slotProps().selectedPlaceId).toBe(PLACE_A);
    // THAT pin's item — not the day-1 visit's.
    expect(slotProps().selectedItemId).toBe(ITEM_ID);

    // CONTROL: a saved-pin press on the SAME place is item-less — the
    // context clears (the sheet must not keep offering the stale item).
    const savedFeature = sourceShape("map-source-saved").features[0];
    await fireEvent(screen.getByTestId("map-source-saved"), "press", {
      features: [savedFeature],
      coordinates: { latitude: 34.9671, longitude: 135.7727 },
    });
    expect(slotProps().selectedPlaceId).toBe(PLACE_A);
    expect(slotProps().selectedItemId).toBeNull();
  });
});

describe("photo-pin routing (E4 — R-map-4)", () => {
  it("a photo-pin tap cross-tab pushes the photo viewer — tab jump FIRST, never the sheet", async () => {
    await renderMap();
    const PHOTO_ID = "77777777-7777-4777-8777-777777777771";

    await fireEvent(screen.getByTestId("map-source-photo"), "press", {
      features: [
        {
          properties: {
            family: "photo",
            placeId: null,
            itemId: null,
            photoId: PHOTO_ID,
            testID: `map-pin-photo-${PHOTO_ID}`,
          },
        },
      ],
      coordinates: { latitude: 35.0, longitude: 135.7 },
    });

    expect(mockCallSequence).toEqual([
      ["tab", "more"],
      [
        "push",
        {
          pathname: "/[tripId]/more/photos/[photoId]",
          params: { tripId: TEST_TRIP_ID, photoId: PHOTO_ID },
        },
      ],
    ]);
    // R-map-4's fork: the viewer, never the place sheet.
    expect(slotProps().selectedPlaceId).toBeNull();
  });
});
