/**
 * DensitySegment (T-7.13 — R-itin-33, §2.5b, R-itin-30): the Day · 3-day ·
 * (Month) · Trip-span control. A controlled wrapper over the DS
 * SegmentedControl that persists a selection per trip before calling back.
 *
 * What change makes each pin red (mutation-verified in the PR body):
 * - selected state: `selectedKey` stops following `value` (pinned / inverted)
 *   → the selected-state, announced-after-change and restore pins;
 * - persistence: the `storeGridDensity` call is dropped or the key is wrong
 *   → the persist, ordering, per-trip and restore pins;
 * - reachability: the control is hidden from the a11y tree → every role query;
 * - option set: the default grows a Month tab, or `options` is ignored →
 *   the three-vs-four pins.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";

import { triggerHaptic } from "@/theme/haptics";
import { renderWithTheme } from "@/test-utils/render";

import { DensitySegment } from "./DensitySegment";
import { DENSITIES, readGridDensity, storeGridDensity, type Density } from "./grid-density";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
const mockTriggerHaptic = triggerHaptic as jest.Mock;

let tripCounter = 0;
let tripId = "";

beforeEach(() => {
  jest.clearAllMocks();
  // A fresh trip per test: the MMKV jest mock is per-process-module, so a
  // unique key is the isolation (nothing here depends on cross-test state).
  tripCounter += 1;
  tripId = `density-segment-trip-${tripCounter}`;
});

/** The real wiring T-7.16 will do: persisted value in, controlled state out. */
function Wired({
  initial = readGridDensity(tripId),
  onChange,
  options,
}: {
  initial?: Density;
  onChange?: (density: Density) => void;
  options?: readonly Density[];
}) {
  const [value, setValue] = useState<Density>(initial);
  return (
    <DensitySegment
      tripId={tripId}
      value={value}
      options={options}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const tabLabels = () => screen.getAllByRole("tab").map((tab) => tab.props.accessibilityLabel);

describe("DensitySegment — options", () => {
  it("offers the three GridSurface densities by default — Day · 3-day · Trip-span, no Month", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment")).toBeOnTheScreen();
    expect(tabLabels()).toEqual(["Day", "3-day", "Trip-span"]);
    for (const key of ["day", "3-day", "trip-span"]) {
      expect(screen.getByTestId(`itinerary-density-segment-${key}`)).toBeOnTheScreen();
    }
    expect(screen.queryByTestId("itinerary-density-segment-month")).toBeNull();
  });

  it("offers all four R-itin-33 options in spec order when the screen passes DENSITIES", async () => {
    await renderWithTheme(<Wired options={DENSITIES} />);
    expect(tabLabels()).toEqual(["Day", "3-day", "Month", "Trip-span"]);
    expect(screen.getByTestId("itinerary-density-segment-month")).toBeOnTheScreen();
  });

  it("selects Day first on a fresh trip (R-itin-33 default)", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment-day").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });
});

describe("DensitySegment — selection calls back and persists (R-itin-33)", () => {
  it.each([
    ["3-day", "3-day"],
    ["trip-span", "trip-span"],
  ] as const)(
    "choosing %s calls back with it and writes it to the trip's key",
    async (key, expected) => {
      const onChange = jest.fn();
      await renderWithTheme(<Wired onChange={onChange} />);
      expect(readGridDensity(tripId)).toBe("day"); // nothing persisted yet
      await fireEvent.press(screen.getByTestId(`itinerary-density-segment-${key}`));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expected);
      expect(readGridDensity(tripId)).toBe(expected);
    },
  );

  it("choosing Month (when offered) calls back and persists it too — T-7.14/16's path", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<Wired options={DENSITIES} onChange={onChange} />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-month"));
    expect(onChange).toHaveBeenCalledWith("month");
    expect(readGridDensity(tripId)).toBe("month");
  });

  it("can go back to Day — Day is a real selection that overwrites a stored non-default", async () => {
    // A default read is also "day", so the write is only provable by
    // overwriting a stored NON-default value.
    storeGridDensity(tripId, "trip-span");
    const onChange = jest.fn();
    await renderWithTheme(<Wired onChange={onChange} />);
    expect(readGridDensity(tripId)).toBe("trip-span");
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-day"));
    expect(onChange).toHaveBeenCalledWith("day");
    expect(readGridDensity(tripId)).toBe("day");
    expect(screen.getByRole("tab", { name: "Day", selected: true })).toBeOnTheScreen();
  });

  it("persists BEFORE it calls back — a handler that re-reads storage already sees the choice", async () => {
    const seenInHandler: Density[] = [];
    await renderWithTheme(<Wired onChange={() => seenInHandler.push(readGridDensity(tripId))} />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-3-day"));
    expect(seenInHandler).toEqual(["3-day"]);
  });

  it("re-tapping the selected segment calls nothing and writes nothing", async () => {
    // Seed a non-default value while the control shows Day, so a stray write
    // of "day" would be visible (a default read alone could not tell).
    storeGridDensity(tripId, "trip-span");
    const onChange = jest.fn();
    await renderWithTheme(<DensitySegment tripId={tripId} value="day" onChange={onChange} />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-day"));
    expect(onChange).not.toHaveBeenCalled();
    expect(readGridDensity(tripId)).toBe("trip-span");
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
  });

  it("is per trip — choosing on one trip leaves another trip's density alone", async () => {
    const otherTrip = `${tripId}-other`;
    storeGridDensity(otherTrip, "trip-span");
    await renderWithTheme(<Wired />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-3-day"));
    expect(readGridDensity(tripId)).toBe("3-day");
    expect(readGridDensity(otherTrip)).toBe("trip-span");
  });

  it("a choice survives a remount — the next open restores it (R-itin-33)", async () => {
    await renderWithTheme(<Wired />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-trip-span"));
    await screen.unmount();
    // A fresh mount reads the persisted value, exactly as the screen will.
    await renderWithTheme(<Wired />);
    expect(
      screen.getByTestId("itinerary-density-segment-trip-span").props.accessibilityState,
    ).toEqual(expect.objectContaining({ selected: true }));
    expect(screen.getByTestId("itinerary-density-segment-day").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });
});

describe("DensitySegment — a11y: selected state announced, every option reachable (R-itin-30)", () => {
  it("exposes a tablist of tabs, each named by its label", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment").props.accessibilityRole).toBe("tablist");
    for (const label of ["Day", "3-day", "Trip-span"]) {
      expect(screen.getByRole("tab", { name: label })).toBeOnTheScreen();
    }
  });

  it("announces exactly ONE tab as selected — the current density", async () => {
    await renderWithTheme(<Wired initial="3-day" />);
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "3-day", selected: true })).toBeOnTheScreen();
    expect(screen.getByRole("tab", { name: "Day", selected: false })).toBeOnTheScreen();
    expect(screen.getByRole("tab", { name: "Trip-span", selected: false })).toBeOnTheScreen();
  });

  it("moves the selected announcement with a change — VoiceOver hears the new tab selected", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByRole("tab", { name: "Day", selected: true })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("tab", { name: "Trip-span" }));
    expect(screen.getByRole("tab", { name: "Trip-span", selected: true })).toBeOnTheScreen();
    expect(screen.getByRole("tab", { name: "Day", selected: false })).toBeOnTheScreen();
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
  });

  it("every option is reachable by role+name and activatable — the screen-reader path", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<Wired options={DENSITIES} onChange={onChange} />);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    for (const label of ["3-day", "Month", "Trip-span"]) {
      await fireEvent.press(screen.getByRole("tab", { name: label }));
    }
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["3-day", "month", "trip-span"]);
  });

  it("each tab is an accessible, focusable element — keyboard / switch-control reachable", async () => {
    await renderWithTheme(<Wired options={DENSITIES} />);
    for (const tab of screen.getAllByRole("tab")) {
      // `accessible === false` would drop it from the VoiceOver tree;
      // `focusable === false` would drop it from hardware-keyboard traversal.
      expect(tab.props.accessible).toBe(true);
      expect(tab.props.focusable).toBe(true);
      expect(tab.props.accessibilityElementsHidden).not.toBe(true);
      expect(typeof tab.props.accessibilityLabel).toBe("string");
      expect(tab.props.accessibilityLabel.length).toBeGreaterThan(0);
    }
  });

  it("gives every option a distinct testID and accessible name (no two tabs collide)", async () => {
    await renderWithTheme(<Wired options={DENSITIES} />);
    const tabs = screen.getAllByRole("tab");
    expect(new Set(tabs.map((tab) => tab.props.testID)).size).toBe(4);
    expect(new Set(tabs.map((tab) => tab.props.accessibilityLabel)).size).toBe(4);
  });
});

describe("DensitySegment — adversarial", () => {
  it("a persisted Month with the default three options selects nothing and does not crash", async () => {
    // T-7.16 misconfiguration guard: Month restored from storage but the
    // control wasn't given DENSITIES. No tab claims the selection.
    await renderWithTheme(<Wired initial="month" />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryAllByRole("tab", { selected: true })).toHaveLength(0);
  });
});
