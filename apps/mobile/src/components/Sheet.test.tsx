/**
 * Sheet — R-ds-19 dismissal affordances: explicit close button, scrim tap,
 * Android back, and the swipe-down RELEASE DECISION (the gesture pipeline
 * itself is not simulatable in jest; the 80pt/0.5vy math is a pure function).
 * Content mounts only while visible.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import { Dimensions } from "react-native";

import { AppText, Sheet } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

import { DISMISS_DRAG_PT, DISMISS_VELOCITY, shouldDismissSheet } from "./Sheet";

describe("Sheet", () => {
  it("renders nothing while not visible", async () => {
    await renderWithTheme(
      <Sheet visible={false} onDismiss={() => undefined} testID="sheet">
        <AppText>content</AppText>
      </Sheet>,
    );
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("renders title, children, grab handle region when visible", async () => {
    await renderWithTheme(
      <Sheet visible onDismiss={() => undefined} title="Place details" testID="sheet">
        <AppText>content</AppText>
      </Sheet>,
    );
    expect(screen.getByTestId("sheet")).toBeOnTheScreen();
    expect(screen.getByText("Place details").props.accessibilityRole).toBe("header");
    expect(screen.getByText("content")).toBeOnTheScreen();
    expect(screen.getByTestId("sheet").props.accessibilityViewIsModal).toBe(true);
  });

  it("explicit close affordance dismisses (R-ds-19)", async () => {
    const onDismiss = jest.fn();
    await renderWithTheme(
      <Sheet visible onDismiss={onDismiss} testID="sheet">
        <AppText>x</AppText>
      </Sheet>,
    );
    const close = screen.getByTestId("sheet-close");
    expect(close.props.accessibilityRole).toBe("button");
    expect(close.props.accessibilityLabel).toBe("Close");
    await fireEvent.press(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("scrim tap dismisses", async () => {
    const onDismiss = jest.fn();
    await renderWithTheme(
      <Sheet visible onDismiss={onDismiss} testID="sheet">
        <AppText>x</AppText>
      </Sheet>,
    );
    // The scrim fades in from animated opacity 0; RNTL's visibility filter
    // would exclude it mid-entrance — the affordance, not the fade, is under
    // test here.
    await fireEvent.press(screen.getByTestId("sheet-scrim", { includeHiddenElements: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("honors a fixed numeric snap point as sheet height", async () => {
    await renderWithTheme(
      <Sheet visible onDismiss={() => undefined} snapPoints={[320]} testID="sheet">
        <AppText>x</AppText>
      </Sheet>,
    );
    expect(screen.getByTestId("sheet")).toHaveStyle({ height: 320 });
  });

  it("'content' snap (default) caps height at 85% of the window", async () => {
    await renderWithTheme(
      <Sheet visible onDismiss={() => undefined} testID="sheet">
        <AppText>x</AppText>
      </Sheet>,
    );
    const { height: windowHeight } = Dimensions.get("window");
    expect(screen.getByTestId("sheet")).toHaveStyle({
      maxHeight: Math.round(windowHeight * 0.85),
    });
  });

  it("Android hardware back dismisses (R-ds-19)", async () => {
    const onDismiss = jest.fn();
    await renderWithTheme(
      <Sheet visible onDismiss={onDismiss} testID="sheet">
        <AppText>x</AppText>
      </Sheet>,
    );
    // fireEvent walks ancestors for the handler — `requestClose` fired from
    // inside the modal reaches Modal's onRequestClose.
    await fireEvent(screen.getByTestId("sheet"), "requestClose");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  describe("swipe-down release decision (R-ds-19 threshold math)", () => {
    it("dismisses past the drag threshold regardless of velocity", () => {
      expect(shouldDismissSheet({ dy: 100, vy: 0 })).toBe(true);
    });

    it("dismisses on a fast flick even with a short drag", () => {
      expect(shouldDismissSheet({ dy: 20, vy: 0.6 })).toBe(true);
    });

    it("springs back on a short, slow drag", () => {
      expect(shouldDismissSheet({ dy: 20, vy: 0 })).toBe(false);
    });

    it("thresholds are exclusive — exactly AT the boundary springs back", () => {
      expect(shouldDismissSheet({ dy: DISMISS_DRAG_PT, vy: 0 })).toBe(false);
      expect(shouldDismissSheet({ dy: 0, vy: DISMISS_VELOCITY })).toBe(false);
      expect(shouldDismissSheet({ dy: DISMISS_DRAG_PT + 1, vy: 0 })).toBe(true);
      expect(shouldDismissSheet({ dy: 0, vy: DISMISS_VELOCITY + 0.01 })).toBe(true);
    });
  });
});
