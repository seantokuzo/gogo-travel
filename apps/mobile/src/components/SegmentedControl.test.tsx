/**
 * SegmentedControl — selection change fires onChange + `selection` haptic;
 * re-tapping the active segment is a full no-op (§2.8: max one haptic per
 * user action). Per-segment testIDs derive `{testID}-{key}`.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { SegmentedControl } from "@/components";
import { triggerHaptic } from "@/theme/haptics";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
const mockTriggerHaptic = triggerHaptic as jest.Mock;

const segments = [
  { key: "budget", label: "Budget" },
  { key: "expenses", label: "Expenses" },
  { key: "balances", label: "Balances" },
];

describe("SegmentedControl", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders every segment with derived testIDs on a tablist", async () => {
    await renderWithTheme(
      <SegmentedControl
        segments={segments}
        selectedKey="budget"
        onChange={() => undefined}
        testID="money-tabs"
      />,
    );
    expect(screen.getByTestId("money-tabs").props.accessibilityRole).toBe("tablist");
    for (const { key, label } of segments) {
      const seg = screen.getByTestId(`money-tabs-${key}`);
      expect(seg.props.accessibilityRole).toBe("tab");
      expect(seg.props.accessibilityLabel).toBe(label);
    }
  });

  it("marks only the selected segment via accessibilityState (R-ds-12)", async () => {
    await renderWithTheme(
      <SegmentedControl
        segments={segments}
        selectedKey="expenses"
        onChange={() => undefined}
        testID="t"
      />,
    );
    expect(screen.getByTestId("t-expenses").props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByTestId("t-budget").props.accessibilityState).toMatchObject({
      selected: false,
    });
  });

  it("selecting a different segment fires onChange + selection haptic", async () => {
    const onChange = jest.fn();
    await renderWithTheme(
      <SegmentedControl segments={segments} selectedKey="budget" onChange={onChange} testID="t" />,
    );
    await fireEvent.press(screen.getByTestId("t-balances"));
    expect(onChange).toHaveBeenCalledWith("balances");
    expect(mockTriggerHaptic).toHaveBeenCalledWith("selection");
  });

  it("re-tapping the active segment does nothing — no onChange, no haptic", async () => {
    const onChange = jest.fn();
    await renderWithTheme(
      <SegmentedControl segments={segments} selectedKey="budget" onChange={onChange} testID="t" />,
    );
    await fireEvent.press(screen.getByTestId("t-budget"));
    expect(onChange).not.toHaveBeenCalled();
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
  });

  it("styles the active segment as bg.surface on the bg.inset track", async () => {
    await renderWithTheme(
      <SegmentedControl
        segments={segments}
        selectedKey="budget"
        onChange={() => undefined}
        testID="t"
      />,
    );
    expect(screen.getByTestId("t")).toHaveStyle({
      backgroundColor: lightTheme.color.bg.inset,
      minHeight: lightTheme.touchTarget,
    });
    expect(screen.getByTestId("t-budget")).toHaveStyle({
      backgroundColor: lightTheme.color.bg.surface,
    });
  });
});
