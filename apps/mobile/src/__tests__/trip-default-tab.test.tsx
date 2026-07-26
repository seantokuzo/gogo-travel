/**
 * Default-tab + in-session tab memory against the REAL tree (T-6.6 / NAV-3).
 * Named per acceptance line:
 *   - active trip open → today default              (R-nav-7)
 *   - planning/past trip open → itinerary default   (R-nav-8)
 *   - manual choice sticky in session               (R-nav-9)
 *   - reset on relaunch (memory empty → default)    (R-nav-9)
 *
 * Pure-URL renders first; the single pressing walkthrough is LAST (quirk 3).
 * "Relaunch" is a fresh process — module state gone — which resetTabMemory
 * stands in for (session = module lifetime by construction).
 */
import { router } from "expo-router";
import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { recallTab, rememberTab, resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID, TRIP_B_ID } from "@/test-utils/ids";
import { renderApp } from "@/test-utils/render-app";
import {
  makeActiveTrip,
  makePastTrip,
  makePlanningTrip,
  mockNavApi,
} from "@/test-utils/trip-fixtures";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

beforeEach(() => {
  mockNavApi({
    trips: [makeActiveTrip(TRIP_B_ID), makePlanningTrip(TEST_TRIP_ID)],
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("R-nav-7: opening an ACTIVE trip defaults to the today tab", async () => {
  const result = await renderApp(`/${TRIP_B_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TRIP_B_ID}/today`);
});

it("R-nav-8: opening a PLANNING trip defaults to the itinerary tab", async () => {
  const result = await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary`);
});

it("R-nav-8: opening a PAST trip defaults to the itinerary tab", async () => {
  mockNavApi({ trips: [makePastTrip(TEST_TRIP_ID)] });
  const result = await renderApp(`/${TEST_TRIP_ID}`);
  expect(await screen.findByTestId("itinerary-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TEST_TRIP_ID}/itinerary`);
});

it("R-nav-9: a session's manual choice wins over the default at trip open", async () => {
  rememberTab(TRIP_B_ID, "map"); // the session chose map earlier
  const result = await renderApp(`/${TRIP_B_ID}`);
  expect(await screen.findByTestId("map-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TRIP_B_ID}/map`);
});

it("R-nav-9: relaunch resets the memory — the default rules re-apply", async () => {
  rememberTab(TRIP_B_ID, "map");
  resetTabMemory(); // ← the cold relaunch (module state dies with the process)
  const result = await renderApp(`/${TRIP_B_ID}`);
  expect(await screen.findByTestId("today-screen")).toBeOnTheScreen();
  expect(result.getPathname()).toBe(`/${TRIP_B_ID}/today`);
});

it("R-nav-9 sticky: a manual tab press is remembered and survives leaving + re-entering the trip", async () => {
  // Interactive — LAST test in the file (harness quirk 3).
  const result = await renderApp(`/${TRIP_B_ID}`);
  await screen.findByTestId("today-screen");

  // Manual selection through the REAL tab bar records the session choice.
  await fireEvent.press(screen.getByTestId("tab-bar-map"));
  await screen.findByTestId("map-screen");
  expect(recallTab(TRIP_B_ID)).toBe("map");

  // Leave the trip, then PUSH a fresh trip instance — a new tab navigator
  // mount whose initialRouteName must come from the session memory, not the
  // today default (no snap-back, R-nav-9).
  await act(async () => {
    router.navigate("/(trips)");
  });
  await screen.findByTestId("trip-list-screen");
  await act(async () => {
    router.push(`/${TRIP_B_ID}` as Parameters<typeof router.push>[0]);
  });
  await waitFor(() => expect(result.getPathname()).toBe(`/${TRIP_B_ID}/map`));
  expect(await screen.findByTestId("map-screen")).toBeOnTheScreen();
});
