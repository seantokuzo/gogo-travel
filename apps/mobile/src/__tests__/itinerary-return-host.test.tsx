/**
 * DeeplinkReturnHost mount (T-7.6 QUEUE assignment — §2.8, R-itin-22 /
 * R-ib-11) against the REAL tree: the host lives in the itinerary stack's
 * `_layout`, so a recorded deeplink-out presents "Did you book it?" when
 * the tab mounts, and "add manually" routes to the REAL form modal with the
 * recorded category + `source=deeplink_return` — T-7.8's built-in stopgap
 * sheet must NOT mount.
 *
 * renderRouter suite: prod queryClient + sanctioned reset recipe (T-6.6 R1);
 * fake timers stay (mobile.md); one interactive walkthrough, placed last by
 * construction (single test).
 */
import { fireEvent, screen } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearDeeplinkOutRecord, recordDeeplinkOut } from "@/features/deeplinks";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { itineraryApiOverrides } from "@/test-utils/itinerary-fixtures";
import { renderApp } from "@/test-utils/render-app";
import { makeTrip, mockNavApi } from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
  clearDeeplinkOutRecord();
});

it("a pending return record prompts in the itinerary stack; 'add manually' lands on item/new with category + deeplink-return source", async () => {
  mockNavApi({
    trips: [makeTrip({ id: TEST_TRIP_ID })],
    overrides: itineraryApiOverrides(),
  });
  recordDeeplinkOut({
    partner: "booking",
    category: "lodging",
    tripId: TEST_TRIP_ID,
    timestamp: Date.now(),
  });

  const result = await renderApp(`/${TEST_TRIP_ID}/itinerary`);
  await screen.findByTestId("itinerary-screen");

  // The layout-mounted host consumed the record and presented the prompt.
  const manual = await screen.findByTestId("booking-return-button-manual");
  await fireEvent.press(manual);

  // Routed to the REAL form modal — category preset, deeplink-return source.
  await screen.findByTestId("itinerary-item-new-screen");
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary/item/new`);
  // SEARCH PARAMS are the QUEUE-assigned contract of this mount ("category +
  // source=deeplink_return") and `getPathname()` excludes them — without
  // this assert, dropping `source` from the layout push leaves every
  // deeplink-return booking attributed `manual` (R-ib-11) with CI green.
  expect(result.getSearchParams()).toMatchObject({
    tripId: TEST_TRIP_ID,
    category: "lodging",
    source: "deeplink_return",
  });
  expect(screen.getByTestId("itinerary-item-new-input-title")).toBeOnTheScreen();
  // The lodging form (recorded category) — its check-in field proves the
  // category preset reached the form, not just the route.
  expect(screen.getByTestId("itinerary-item-new-input-check-in-date")).toBeOnTheScreen();
  // T-7.8's stopgap landing must NOT mount once the override is wired.
  expect(screen.queryByTestId("booking-manual-add-sheet")).toBeNull();

  // NO exit-timer drain here, deliberately: this suite runs under
  // renderRouter's FAKE timers (mobile.md — keep them), which HOLD the
  // sheet's ~200ms exit callback instead of leaking it into a later suite;
  // waitFor-ing the unmount under fake timers is the hang, not the fix.
  // The real-timer drain posture lives in the DeeplinkReturnHost suite.
});
