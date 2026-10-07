/**
 * DensitySegment (T-7.13 — R-itin-33, §2.5b, R-itin-30): the Day · 3-day ·
 * Month · Trip-span control. A PURE controlled wrapper over the DS
 * SegmentedControl — it reports a choice; the SCREEN (T-7.16) persists it,
 * because density is also set programmatically (T-7.14's Month day-cell tap)
 * and a store inside the control would be skipped on that path. Persistence
 * itself is pinned in `grid-density.test.ts`; the screen-level "one
 * changeDensity = set + store" pin belongs to T-7.16's screen test.
 *
 * What change makes each pin red (mutation-verified in the PR body):
 * - selected state: `selectedKey` stops following `value` (pinned / inverted)
 *   → the selected-state, announced-after-change and Month-selected pins;
 * - purity: the control starts storing a choice itself → the "never stores" pin;
 * - reachability: the control is hidden from the a11y tree → every role query;
 * - option set: the default drops Month, or `options` is ignored / reordered
 *   → the four-vs-subset pins.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { useState } from "react";

import { triggerHaptic } from "@/theme/haptics";
import { renderWithTheme } from "@/test-utils/render";

import { DensitySegment } from "./DensitySegment";
import * as gridDensity from "./grid-density";
import { DENSITIES, GRID_SURFACE_DENSITIES, type Density } from "./grid-density";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
const mockTriggerHaptic = triggerHaptic as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The wiring T-7.16 does: controlled state in, the chosen density out. */
function Wired({
  initial = "day",
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
  it("offers all four R-itin-33 options in spec order by default — Month included", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment")).toBeOnTheScreen();
    expect(tabLabels()).toEqual(["Day", "3-day", "Month", "Trip-span"]);
    for (const key of DENSITIES) {
      expect(screen.getByTestId(`itinerary-density-segment-${key}`)).toBeOnTheScreen();
    }
  });

  it("offers only the subset it is given, in the order given", async () => {
    await renderWithTheme(<Wired options={GRID_SURFACE_DENSITIES} />);
    expect(tabLabels()).toEqual(["Day", "3-day", "Trip-span"]);
    expect(screen.queryByTestId("itinerary-density-segment-month")).toBeNull();
    await screen.unmount();
    await renderWithTheme(<Wired options={["trip-span", "day"]} />);
    expect(tabLabels()).toEqual(["Trip-span", "Day"]);
  });

  it("selects Day first on a fresh trip (R-itin-33 default)", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment-day").props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
  });
});

describe("DensitySegment — selection calls back, and only calls back (R-itin-33)", () => {
  it.each(["3-day", "trip-span", "month"] as const)(
    "choosing %s calls back once with exactly that density",
    async (key) => {
      const onChange = jest.fn();
      await renderWithTheme(<Wired onChange={onChange} />);
      await fireEvent.press(screen.getByTestId(`itinerary-density-segment-${key}`));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(key);
    },
  );

  it("can go back to Day — Day is a real selection, not just the unset state", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<Wired initial="trip-span" onChange={onChange} />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-day"));
    expect(onChange).toHaveBeenCalledWith("day");
    expect(screen.getByRole("tab", { name: "Day", selected: true })).toBeOnTheScreen();
  });

  it("re-tapping the selected segment calls nothing — no callback, no haptic", async () => {
    const onChange = jest.fn();
    await renderWithTheme(<DensitySegment value="day" onChange={onChange} />);
    await fireEvent.press(screen.getByTestId("itinerary-density-segment-day"));
    expect(onChange).not.toHaveBeenCalled();
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
  });

  it("NEVER stores — persistence is the screen's, so a programmatic set can't skip it (T-7.16 contract)", async () => {
    // Falsification: a `storeGridDensity(...)` call inside the control (the
    // round-0 design) makes this red. The spy is on the module's export, which
    // is the exact binding the component would call.
    const store = jest.spyOn(gridDensity, "storeGridDensity");
    await renderWithTheme(<Wired options={DENSITIES} />);
    for (const label of ["3-day", "Month", "Trip-span", "Day"]) {
      await fireEvent.press(screen.getByRole("tab", { name: label }));
    }
    expect(store).not.toHaveBeenCalled();
  });
});

describe("DensitySegment — a11y: selected state announced, every option reachable (R-itin-30)", () => {
  it("exposes a tablist of tabs, each named by its label", async () => {
    await renderWithTheme(<Wired />);
    expect(screen.getByTestId("itinerary-density-segment").props.accessibilityRole).toBe("tablist");
    for (const label of ["Day", "3-day", "Month", "Trip-span"]) {
      expect(screen.getByRole("tab", { name: label })).toBeOnTheScreen();
    }
  });

  it("announces exactly ONE tab as selected — the current density", async () => {
    await renderWithTheme(<Wired initial="3-day" />);
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "3-day", selected: true })).toBeOnTheScreen();
    expect(screen.getByRole("tab", { name: "Day", selected: false })).toBeOnTheScreen();
    expect(screen.getByRole("tab", { name: "Month", selected: false })).toBeOnTheScreen();
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
    await renderWithTheme(<Wired onChange={onChange} />);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    for (const label of ["3-day", "Month", "Trip-span"]) {
      await fireEvent.press(screen.getByRole("tab", { name: label }));
    }
    expect(onChange.mock.calls.map((call) => call[0])).toEqual(["3-day", "month", "trip-span"]);
  });

  it("each tab is an accessible, focusable element — keyboard / switch-control reachable", async () => {
    await renderWithTheme(<Wired />);
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
    await renderWithTheme(<Wired />);
    const tabs = screen.getAllByRole("tab");
    expect(new Set(tabs.map((tab) => tab.props.testID)).size).toBe(4);
    expect(new Set(tabs.map((tab) => tab.props.accessibilityLabel)).size).toBe(4);
  });
});

describe("DensitySegment — adversarial", () => {
  it("a restored Month selects the Month tab by default — the screen can't forget `options` and lose it", async () => {
    await renderWithTheme(<Wired initial="month" />);
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: "Month", selected: true })).toBeOnTheScreen();
    expect(screen.getAllByRole("tab", { selected: true })).toHaveLength(1);
  });

  it("a value outside a restricted option subset selects nothing and does not crash", async () => {
    // A screen that restricts `options` (no Month) but restored Month from
    // storage: no tab claims the selection, and nothing throws.
    await renderWithTheme(<Wired initial="month" options={GRID_SURFACE_DENSITIES} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryAllByRole("tab", { selected: true })).toHaveLength(0);
  });
});
