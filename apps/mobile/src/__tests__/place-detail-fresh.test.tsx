/**
 * Place detail — the FRESH seam with the v1 dormancy flag flipped ON
 * (T-8.4 / MAP-3 — R-map-9/10; the spec's "fresh details render when
 * stubbed, vanish silently when the stub errors" test bullet).
 *
 * `PLACE_FRESH_ENABLED` is a module const, so the flip rides a partial
 * module mock (requireActual spread — NOTHING else is mocked; the T-5.7
 * crash-masking class needs a WHOLESALE feature mock, which this is not).
 * The flag-off world is pinned in place-detail-screen.test.tsx ("no request
 * carries the fresh param").
 */
import type { PlaceDetails, TripListItem } from "@gogo/shared";
import { screen } from "@testing-library/react-native";

import PlaceDetailScreen from "@/app/[tripId]/map/place/[placeId]";
import { ApiRequestError } from "@/auth";
import { TripProvider } from "@/navigation/trip-context";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { itineraryApiOverrides, TRIP_END, TRIP_START } from "@/test-utils/itinerary-fixtures";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { seedAuthenticated } from "@/test-utils/session-fixtures";
import { makePlace, makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ placeId: "44444444-4444-4444-8444-444444444444" }),
  useNavigation: () => ({
    navigate: jest.fn(),
    getParent: () => undefined,
    getState: () => ({ routeNames: ["today", "itinerary", "map", "money", "more"] }),
  }),
}));

// The flag flip — everything else in the data layer stays REAL.
jest.mock("@/data/places", () => ({
  ...jest.requireActual<typeof import("@/data/places")>("@/data/places"),
  PLACE_FRESH_ENABLED: true,
}));

const PLACE = makePlace({ name: "Fushimi Inari", source: "fsq_os", source_id: "fsq-1" });

const FRESH_RESPONSE: PlaceDetails = {
  place: PLACE,
  fresh: {
    fetched_at: "2026-08-18T00:00:00.000Z",
    attribution: {
      text: "Powered by Foursquare",
      logo_required: false,
      url: "https://foursquare.com",
    },
    fields: { hours: "Mon–Fri 9:00–17:00", open_now: true },
  },
};

function trip(): TripListItem {
  return makeTrip({ id: TEST_TRIP_ID, start_date: TRIP_START, end_date: TRIP_END });
}

async function renderFlagOn(freshResponder: () => Promise<unknown>) {
  seedAuthenticated();
  const fixture = trip();
  mockNavApi({
    trips: [fixture],
    overrides: {
      ...itineraryApiOverrides(),
      "GET /trips/:tripId/saved-places": () => Promise.resolve({ items: [], nextCursor: null }),
      "GET /places/:placeId": (input) => {
        const query = input.query as { fresh?: string } | undefined;
        // The SPINE read (no fresh param) always succeeds; the FRESH read is
        // the responder under test — exactly the two-query §2.3/§2.4 split.
        return query?.fresh === "true"
          ? freshResponder()
          : Promise.resolve({ place: PLACE } satisfies PlaceDetails);
      },
    },
  });
  await renderWithProviders(
    <TripProvider trip={fixture}>
      <PlaceDetailScreen />
    </TripProvider>,
    { queryClient: makeTestQueryClient() },
  );
  await settle();
}

afterEach(async () => {
  await settle();
  jest.restoreAllMocks();
});

it("renders the fresh block when the seam answers (R-map-9 — flag-on world)", async () => {
  await renderFlagOn(() => Promise.resolve(FRESH_RESPONSE));
  expect(await screen.findByTestId("place-detail-fresh")).toBeTruthy();
  expect(screen.getByTestId("place-detail-fresh-field-hours")).toHaveTextContent(
    /Mon–Fri 9:00–17:00/,
  );
  // R-places-17: the FSQ attribution rides the block.
  expect(screen.getByTestId("place-detail-fresh-attribution")).toHaveTextContent(
    /Powered by Foursquare/,
  );
});

it("a FAILING fresh call vanishes silently — full spine view, no error surface (R-map-10)", async () => {
  await renderFlagOn(() => Promise.reject(new ApiRequestError(502, "UNKNOWN", "upstream")));
  expect(await screen.findByText("Fushimi Inari")).toBeTruthy();
  expect(screen.queryByTestId("place-detail-fresh")).toBeNull();
  // Absence is SILENT: neither the load-error surface nor any banner fires
  // for the premium block (the spine read is fine).
  expect(screen.queryByTestId("place-detail-error")).toBeNull();
  expect(screen.queryByTestId("place-detail-banner-refresh")).toBeNull();
  expect(screen.queryByTestId("place-detail-banner-action")).toBeNull();
});

it("a fresh block ABSENT with a reason renders the same silent spine view (dormant-seam wire shape)", async () => {
  await renderFlagOn(() =>
    Promise.resolve({ place: PLACE, fresh_unavailable_reason: "disabled" } satisfies PlaceDetails),
  );
  expect(await screen.findByText("Fushimi Inari")).toBeTruthy();
  expect(screen.queryByTestId("place-detail-fresh")).toBeNull();
  expect(screen.queryByTestId("place-detail-error")).toBeNull();
});
