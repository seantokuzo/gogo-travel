/**
 * B-27 — the top safe area is claimed EXACTLY ONCE per screen, pinned against
 * the REAL route tree (renderApp → ExpoRoot → the actual layouts).
 *
 * The defect: `[tripId]/_layout` renders `TripSwitcherBar` above the tab
 * navigator, and both the bar and every screen's `PageHeader` padded for
 * `insets.top`. On a 59 pt notch device that was ~59 pt of dead space at the
 * top of every trip screen. Ownership now belongs to whichever element is
 * flush with the window: the bar inside the trip shell, the header everywhere
 * else (`components/top-inset.tsx`).
 *
 * WHY THE INSET IS MOCKED HERE rather than provided through context: with no
 * root `SafeAreaProvider`, expo-router's `NativeStackView` wraps the tree in
 * `SafeAreaProviderCompat`, which under jest installs the library mock's
 * `initialWindowMetrics` — all-zero insets. A 0 inset makes "one copy" and
 * "two copies" numerically identical, i.e. every assertion below would pass
 * with the bug restored. Pinning a fixed non-zero inset at the hook is what
 * makes these tests discriminating.
 *
 * Pure-URL renders only — no presses (renderApp harness quirk 3).
 */
import { screen } from "expo-router/testing-library";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { queryClient } from "@/data";
import { clearLastViewedTrip } from "@/navigation/last-viewed-trip";
import { resetTabMemory } from "@/navigation/tab-memory";
import { TEST_TRIP_ID } from "@/test-utils/ids";
import { lightTheme } from "@/test-utils/render";
import { renderApp } from "@/test-utils/render-app";
import { mockNavApi } from "@/test-utils/trip-fixtures";

/**
 * A notch device's top inset — the whole point of the suite. The literal is
 * repeated inside the `jest.mock` factory below because that factory is
 * hoisted above every binding in this file (referencing this const from it is
 * a TDZ crash, not a lint nit); the guard test asserts the two agree, so they
 * cannot drift into a silently vacuous suite.
 */
const DEVICE_TOP_INSET = 59;

jest.mock("react-native-safe-area-context", () => {
  const libraryMock = jest.requireActual("react-native-safe-area-context/jest/mock")
    .default as Record<string, unknown>;
  return {
    ...libraryMock,
    useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
  };
});

// Tab switches fire the DS TabNav's selection haptic — keep expo-haptics out.
jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

/** The single deliberate gap every header keeps, inset or not. */
const GAP = lightTheme.space[2];

function paddingTopOf(testID: string): number | undefined {
  const style = StyleSheet.flatten(screen.getByTestId(testID).props.style) as {
    paddingTop?: number;
  };
  return style.paddingTop;
}

beforeEach(() => {
  mockNavApi();
});

afterEach(() => {
  jest.restoreAllMocks();
  // Singleton client (real _layout) — drop cached trip state between tests.
  queryClient.clear();
  resetTabMemory();
  clearLastViewedTrip();
});

it("the mocked inset is actually non-zero (guards every assertion below)", () => {
  // The mock returns a literal object and holds no hook state — callable here.
  expect(useSafeAreaInsets().top).toBe(DEVICE_TOP_INSET);
  expect(DEVICE_TOP_INSET).toBeGreaterThan(0);
});

describe("inside the trip shell — the switcher bar owns the top inset", () => {
  it("bar pays the inset once; the itinerary header adds only its token gap", async () => {
    await renderApp(`/${TEST_TRIP_ID}/itinerary`);
    await screen.findByTestId("itinerary-screen");

    expect(paddingTopOf("trip-switcher-button")).toBe(DEVICE_TOP_INSET + GAP);
    expect(paddingTopOf("itinerary-header")).toBe(GAP);
    // The defect, stated as the thing that must never be true again: the two
    // surfaces summing to two copies of the inset.
    expect(
      (paddingTopOf("trip-switcher-button") ?? 0) + (paddingTopOf("itinerary-header") ?? 0),
    ).toBe(DEVICE_TOP_INSET + 2 * GAP);
  });

  it("money header adds only its token gap too (the shell, not the screen, decides)", async () => {
    await renderApp(`/${TEST_TRIP_ID}/money`);
    await screen.findByTestId("money-screen");

    expect(paddingTopOf("trip-switcher-button")).toBe(DEVICE_TOP_INSET + GAP);
    expect(paddingTopOf("money-header")).toBe(GAP);
  });

  it("the map's floating top chrome sits under the bar, not under a second inset", async () => {
    await renderApp(`/${TEST_TRIP_ID}/map`);
    await screen.findByTestId("map-screen");

    expect(paddingTopOf("trip-switcher-button")).toBe(DEVICE_TOP_INSET + GAP);
    expect(paddingTopOf("map-top-overlay")).toBe(GAP);
    // Same band, plus the day-filter strip allowance the slot documents.
    expect(paddingTopOf("map-search-overlay")).toBe(GAP + 48);
  });
});

describe("outside the trip shell — PageHeader still owns the top inset", () => {
  it("the trip list header claims the full inset (no switcher bar above it)", async () => {
    await renderApp("/");
    await screen.findByTestId("trip-list-screen");

    expect(screen.queryByTestId("trip-switcher-button")).toBeNull();
    expect(paddingTopOf("trip-list-header")).toBe(DEVICE_TOP_INSET + GAP);
  });

  it("the profile header claims the full inset", async () => {
    await renderApp("/profile");
    await screen.findByTestId("profile-screen");

    expect(paddingTopOf("profile-header")).toBe(DEVICE_TOP_INSET + GAP);
  });
});

describe("natively presented modals inside the trip shell are UNCHANGED", () => {
  /**
   * These routes are React descendants of the boundary but are presented by
   * `RNSScreenStackView` over the whole shell — the bar is not above them and
   * a pageSheet's top edge is not the window's. They re-open the boundary, so
   * their headers must still measure exactly what they measured before B-27.
   */
  it("itinerary item/new keeps the full inset", async () => {
    await renderApp(`/${TEST_TRIP_ID}/itinerary/item/new`);
    await screen.findByTestId("itinerary-item-new-screen");

    expect(paddingTopOf("itinerary-item-new-header")).toBe(DEVICE_TOP_INSET + GAP);
    // …while the shell underneath still claims it exactly once.
    expect(paddingTopOf("trip-switcher-button")).toBe(DEVICE_TOP_INSET + GAP);
  });

  it("money expense/new keeps the full inset", async () => {
    await renderApp(`/${TEST_TRIP_ID}/money/expense/new`);
    await screen.findByTestId("expense-new-screen");

    expect(paddingTopOf("expense-new-header")).toBe(DEVICE_TOP_INSET + GAP);
    expect(paddingTopOf("trip-switcher-button")).toBe(DEVICE_TOP_INSET + GAP);
  });
});
