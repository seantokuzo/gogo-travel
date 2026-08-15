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
import { ATTRIBUTION, type TripListItem } from "@gogo/shared";
import { mapColors } from "@gogo/tokens";
import { act, fireEvent, screen } from "@testing-library/react-native";

import MapScreen from "@/app/[tripId]/map/index";
import { queryKeys } from "@/data/query-client";
import {
  DEFAULT_MAP_STYLE_URLS,
  resetMapboxAccessTokenForTests,
  setPendingMapFocus,
  usePendingMapFocusStore,
} from "@/features/map";
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
import { makeSavedPlaceWithPlace, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("expo-router", () => ({
  // Mirrors the real hook's mount-focus semantics (trip-list test pattern):
  // the always-focused test screen runs the effect on mount.
  useFocusEffect: (effect: () => undefined | void | (() => void)) => {
    const { useEffect: reactUseEffect } = jest.requireActual<typeof import("react")>("react");
    reactUseEffect(() => effect(), [effect]);
  },
}));

// Frozen-seam prop probe (module doc).
jest.mock("@/features/map/MapPlaceSheetSlot", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  // Loosely-typed host so the probe can carry the contract props verbatim.
  const Probe = View as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    MapPlaceSheetSlot: (props: { selectedPlaceId: string | null; tripId: string }) =>
      React.createElement(Probe, {
        testID: "map-place-sheet-slot",
        selectedPlaceId: props.selectedPlaceId,
        tripId: props.tripId,
      }),
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
