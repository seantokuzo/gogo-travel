/**
 * Create-trip walkthrough against the REAL tree (T-6.7 / CT-2 acceptance:
 * "success lands itinerary tab"). One interactive test only (renderRouter
 * quirk 3) driving the full path: modal form → destination pick → submit →
 * replace-navigation through the [tripId] guard → default-tab landing
 * (planning trip → itinerary, R-nav-8) — with the schema-shaped POST body
 * pinned and the dirty-dismiss guard proven bypassed by the submit.
 *
 * renderRouter suite ⇒ prod-singleton reset recipe (mobile.md): restore
 * mocks, clear the prod queryClient, reset tab memory + MRV stamp; NO
 * useRealTimers here (renderApp hands real timers back pre-mount).
 */
import { fireEvent, screen } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import { TEST_USER } from "@/test-utils/session-fixtures";
import { makePlace, makePlanningTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("CT-2: fill → pick destination → create → land inside the new trip on the itinerary tab", async () => {
  const kyoto = makePlace();
  const created = makePlanningTrip(TEST_TRIP_ID);
  let postedBody: unknown;
  const request = mockNavApi({
    // The created trip is the guard's universe — the post-create replace
    // must verify membership (R-nav-20) before the shell mounts.
    trips: [created],
    overrides: {
      "GET /users/me": () => Promise.resolve(TEST_USER),
      "GET /places/search": () => Promise.resolve({ items: [kyoto], nextCursor: null }),
      "POST /trips": (input) => {
        postedBody = (input as { body?: unknown }).body;
        return Promise.resolve(created);
      },
    },
  });

  // The real user path: land on the list (planning trip → R-nav-5 default),
  // open the modal via the FAB — the list mounts beneath, so the walkthrough
  // also pins the ONE-list-RTT budget below.
  const result = await renderApp("/");
  await screen.findByTestId("trip-list-screen");
  await fireEvent.press(screen.getByTestId("trip-list-fab-create"));
  expect(await screen.findByTestId("trip-new-screen")).toBeOnTheScreen();

  await fireEvent.changeText(screen.getByTestId("trip-new-input-name"), "Kyoto Spring");
  await fireEvent.changeText(screen.getByTestId("trip-new-input-destination"), "Kyoto");
  await fireEvent.press(await screen.findByTestId(`trip-new-list-item-${kyoto.id}`));
  // The §2.3 range picker: reveal each platform picker and fire its native
  // change event (local-noon timestamps keep the calendar day tz-stable).
  await fireEvent.press(screen.getByTestId("trip-new-input-dates-start"));
  await fireEvent(screen.getByTestId("trip-new-input-dates-start-picker"), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 4, 1, 12).getTime(), utcOffset: 0 },
  });
  await fireEvent.press(screen.getByTestId("trip-new-input-dates-end"));
  await fireEvent(screen.getByTestId("trip-new-input-dates-end-picker"), "onChange", {
    nativeEvent: { timestamp: new Date(2027, 4, 8, 12).getTime(), utcOffset: 0 },
  });
  await fireEvent.press(screen.getByTestId("trip-new-button-create"));

  // Landed: guard verified, shell mounted, planning default = itinerary.
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary`);

  // The POST body is the structured-form shape: picked place fills
  // destination lat/lng; base_currency omitted (TEST_USER has no
  // home_currency → server defaults USD, R-tripui-6).
  expect(postedBody).toEqual({
    name: "Kyoto Spring",
    destination_name: "Kyoto",
    destination_lat: kyoto.lat,
    destination_lng: kyoto.lng,
    start_date: "2027-05-01",
    end_date: "2027-05-08",
  });

  // The dirty-form guard did NOT intercept the submit's replace (bypass).
  expect(screen.queryByTestId("trip-new-button-cancel-confirm")).toBeNull();

  // List RTT budget (R1): the LIST SCREEN paid ZERO fetches — the entry
  // redirect's ["trips"] page seeded its infinite cache (initialData), and
  // the create's invalidate is refetchType "none", so no eager refetch rode
  // the mutation. The two limit-100 GETs are the entry redirect's launch
  // read and the trip switcher's mount refetch of the (now stale) active
  // set inside the new trip's shell — each a distinct consumer, one RTT.
  const listGets = request.mock.calls.filter(
    ([descriptor]) =>
      (descriptor as { path: string; method: string }).path === "/trips" &&
      (descriptor as { path: string; method: string }).method === "GET",
  );
  const infiniteListGets = listGets.filter(
    ([, input]) => !("limit" in ((input as { query: object }).query ?? {})),
  );
  expect(infiniteListGets).toHaveLength(0);
  expect(listGets).toHaveLength(2);
});
