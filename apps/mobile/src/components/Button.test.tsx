/**
 * Button — R-ds-13/14 behaviors, §2.9 synced color mapping, §2.8 haptic
 * defaults. Haptics assert against the DS-6 wrapper (mocked); the wrapper's
 * own suite covers the expo-haptics mapping.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { Button } from "@/components";
import { triggerHaptic } from "@/theme/haptics";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));
const mockTriggerHaptic = triggerHaptic as jest.Mock;

describe("Button", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders with button role, label-derived a11y label, and forwarded testID", async () => {
    await renderWithTheme(<Button title="Save" onPress={() => undefined} testID="save-btn" />);
    const btn = screen.getByTestId("save-btn");
    expect(btn.props.accessibilityRole).toBe("button");
    expect(btn.props.accessibilityLabel).toBe("Save");
    expect(screen.getByText("Save")).toBeOnTheScreen();
  });

  it("primary variant = primary.solid fill + text.onPrimary label (synced mapping)", async () => {
    await renderWithTheme(<Button title="Go" onPress={() => undefined} testID="btn" />);
    expect(screen.getByTestId("btn")).toHaveStyle({
      backgroundColor: lightTheme.color.primary.solid,
    });
    expect(screen.getByText("Go")).toHaveStyle({ color: lightTheme.color.text.onPrimary });
  });

  it("secondary variant = primary-outline with text.accent label", async () => {
    await renderWithTheme(
      <Button title="Go" onPress={() => undefined} variant="secondary" testID="btn" />,
    );
    expect(screen.getByTestId("btn")).toHaveStyle({
      backgroundColor: "transparent",
      borderColor: lightTheme.color.primary.solid,
    });
    expect(screen.getByText("Go")).toHaveStyle({ color: lightTheme.color.text.accent });
  });

  it("destructive variant = status.danger pair (AA-validated fg-on-bg)", async () => {
    await renderWithTheme(
      <Button title="Delete" onPress={() => undefined} variant="destructive" testID="btn" />,
    );
    expect(screen.getByTestId("btn")).toHaveStyle({
      backgroundColor: lightTheme.color.status.danger.bg,
    });
    expect(screen.getByText("Delete")).toHaveStyle({ color: lightTheme.color.status.danger.fg });
  });

  it("fires onPress and the default primary haptic (actionLight)", async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Go" onPress={onPress} testID="btn" />);
    await fireEvent.press(screen.getByTestId("btn"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockTriggerHaptic).toHaveBeenCalledWith("actionLight");
  });

  it("destructive default haptic is warning; secondary/ghost fire none (§2.9)", async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <>
        <Button title="Del" onPress={onPress} variant="destructive" testID="del" />
        <Button title="Sec" onPress={onPress} variant="secondary" testID="sec" />
        <Button title="Gho" onPress={onPress} variant="ghost" testID="gho" />
      </>,
    );
    await fireEvent.press(screen.getByTestId("del"));
    expect(mockTriggerHaptic).toHaveBeenLastCalledWith("warning");
    await fireEvent.press(screen.getByTestId("sec"));
    await fireEvent.press(screen.getByTestId("gho"));
    expect(mockTriggerHaptic).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it("honors an explicit haptic override and haptic={false} silence", async () => {
    await renderWithTheme(
      <>
        <Button title="A" onPress={() => undefined} haptic="success" testID="a" />
        <Button title="B" onPress={() => undefined} haptic={false} testID="b" />
      </>,
    );
    await fireEvent.press(screen.getByTestId("a"));
    expect(mockTriggerHaptic).toHaveBeenLastCalledWith("success");
    await fireEvent.press(screen.getByTestId("b"));
    expect(mockTriggerHaptic).toHaveBeenCalledTimes(1);
  });

  it("loading blocks presses, shows the spinner, and keeps the title mounted (R-ds-14)", async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Save" onPress={onPress} loading testID="btn" />);
    await fireEvent.press(screen.getByTestId("btn"));
    expect(onPress).not.toHaveBeenCalled();
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
    expect(screen.getByTestId("btn-spinner")).toBeOnTheScreen();
    // Layout stability: the label stays in the tree (hidden, not removed).
    expect(screen.getByText("Save")).toBeOnTheScreen();
    expect(screen.getByTestId("btn").props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
  });

  it("disabled blocks press AND haptic, with disabled a11y state", async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Nope" onPress={onPress} disabled testID="btn" />);
    await fireEvent.press(screen.getByTestId("btn"));
    expect(onPress).not.toHaveBeenCalled();
    expect(mockTriggerHaptic).not.toHaveBeenCalled();
    expect(screen.getByTestId("btn").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("meets the 44pt target: md/lg minHeight; sm restores it via hitSlop (R-ds-9)", async () => {
    await renderWithTheme(
      <>
        <Button title="M" onPress={() => undefined} testID="m" />
        <Button title="S" onPress={() => undefined} size="sm" testID="s" />
      </>,
    );
    expect(screen.getByTestId("m")).toHaveStyle({ minHeight: lightTheme.touchTarget });
    expect(screen.getByTestId("s")).toHaveStyle({ minHeight: 36 });
    expect(screen.getByTestId("s").props.hitSlop).toEqual(lightTheme.hitSlop.sm);
  });
});
