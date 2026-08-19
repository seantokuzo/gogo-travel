/**
 * Map search overlay (T-8.3 / MAP-2 — R-map-25 + the R-map-22 offline
 * degrade). Load-bearing:
 *  - under the 2-char floor NOTHING fires (helper text, zero requests);
 *  - at the floor the results list renders and a row tap hands the FULL
 *    place row up (the sheet's search-selection path);
 *  - clear empties input + list (the temp-pin builder input with it);
 *  - offline degrades to the NOTICE, both arms: proactive (trip cache
 *    already failed at transport) fires no request at all; reactive (this
 *    request dies status-0) swaps the generic error for the notice;
 *  - a real server error keeps the retryable ErrorBanner.
 */
import { placeEndpoints, type Place } from "@gogo/shared";
import { fireEvent, screen } from "@testing-library/react-native";

import { apiClient } from "@/auth";
import { ApiRequestError } from "@/auth/api-client";
import { MapSearch } from "./MapSearch";
import { queryKeys } from "@/data/query-client";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { makeTestQueryClient, renderWithProviders } from "@/test-utils/render";
import { settle } from "@/test-utils/settle";
import { makePlace } from "@/test-utils/trip-fixtures";

const DESTINATION = { lat: 35.0116, lng: 135.7681 };
const KYOTO = makePlace();

function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function searchCalls(request: jest.Mock): unknown[][] {
  return request.mock.calls.filter(([descriptor]) => descriptor === placeEndpoints.searchPlaces);
}

afterEach(async () => {
  // Drain query settles INSIDE act before teardown — the B-2 floating-act
  // class (settle.ts doc).
  await settle();
  jest.restoreAllMocks();
});

async function renderSearch(opts?: {
  results?: Place[];
  reject?: Error;
  seedTripOffline?: boolean;
}) {
  const request = spyRequest();
  if (opts?.reject !== undefined) {
    request.mockRejectedValue(opts.reject);
  } else {
    request.mockResolvedValue({ items: opts?.results ?? [KYOTO], nextCursor: null });
  }
  const client = makeTestQueryClient();
  if (opts?.seedTripOffline === true) {
    // The trip subtree already holds a transport failure — the
    // `useTripOffline` proactive arm (offline.ts: status 0 is the marker).
    // Per-query gcTime: the test client's default gcTime 0 would collect
    // the observerless failed query before the component ever mounts;
    // Infinity keeps it WITHOUT scheduling a GC timer (a finite gcTime is
    // an open handle that blocks jest's clean exit — mobile.md).
    await client
      .prefetchQuery({
        queryKey: queryKeys.trip(TEST_TRIP_ID),
        queryFn: () => Promise.reject(new ApiRequestError(0, "NETWORK", "offline")),
        gcTime: Infinity,
        retry: false,
      })
      .catch(() => undefined);
  }
  const onSelectResult = jest.fn();
  await renderWithProviders(
    <MapSearch tripId={TEST_TRIP_ID} destination={DESTINATION} onSelectResult={onSelectResult} />,
    { queryClient: client },
  );
  return { request, onSelectResult };
}

it("stays quiet under the 2-char floor: helper text, zero requests", async () => {
  const { request } = await renderSearch();

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "k");

  expect(screen.getByText("Keep typing — search starts at 2 characters.")).toBeOnTheScreen();
  expect(searchCalls(request)).toHaveLength(0);
});

it("R-map-25: at the floor the result list renders; a row tap hands the full row up", async () => {
  const { request, onSelectResult } = await renderSearch();

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Ky");
  const row = await screen.findByTestId(`map-search-list-item-${KYOTO.id}`);

  expect(searchCalls(request).length).toBeGreaterThan(0);
  await fireEvent.press(row);
  expect(onSelectResult).toHaveBeenCalledTimes(1);
  expect(onSelectResult).toHaveBeenCalledWith(KYOTO);
});

it("clear empties the input and removes the list", async () => {
  await renderSearch();

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Ky");
  await screen.findByTestId(`map-search-list-item-${KYOTO.id}`);

  await fireEvent.press(screen.getByTestId("map-search-clear"));

  expect(screen.getByTestId("map-search-input").props.value).toBe("");
  expect(screen.queryByTestId(`map-search-list-item-${KYOTO.id}`)).toBeNull();
});

it("no matches: the empty arm, not a broken list", async () => {
  await renderSearch({ results: [] });

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "zz");

  expect(await screen.findByText("No places matched — try a different spelling.")).toBeOnTheScreen();
});

it("R-map-22 proactive: trip already offline ⇒ notice, NO request, no spinner", async () => {
  const { request } = await renderSearch({ seedTripOffline: true });

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Ky");

  expect(await screen.findByTestId("map-search-offline")).toBeOnTheScreen();
  expect(searchCalls(request)).toHaveLength(0);
});

it("R-map-22 reactive: a transport-dead search shows the notice, not the error banner", async () => {
  await renderSearch({ reject: new ApiRequestError(0, "NETWORK", "offline") });

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Ky");

  expect(await screen.findByTestId("map-search-offline")).toBeOnTheScreen();
  expect(screen.queryByTestId("map-search-error")).toBeNull();
});

it("a real server error keeps the retryable banner (R-ds-17 posture)", async () => {
  const { request } = await renderSearch({ reject: new ApiRequestError(500, "UNKNOWN", "boom") });

  await fireEvent.changeText(screen.getByTestId("map-search-input"), "Ky");

  expect(await screen.findByTestId("map-search-error")).toBeOnTheScreen();
  expect(screen.queryByTestId("map-search-offline")).toBeNull();

  request.mockResolvedValue({ items: [KYOTO], nextCursor: null });
  await fireEvent.press(screen.getByTestId("map-search-error-retry"));
  expect(await screen.findByTestId(`map-search-list-item-${KYOTO.id}`)).toBeOnTheScreen();
});
