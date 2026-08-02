/**
 * Sheet — R-ds-19 dismissal affordances: explicit close button, scrim tap,
 * Android back, and the swipe-down RELEASE DECISION (the gesture pipeline
 * itself is not simulatable in jest; the 80pt/0.5vy math is a pure function).
 * Content mounts only while visible.
 */
import { ThemeProvider } from "@gogo/tokens/react";
import { act, fireEvent, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { Dimensions } from "react-native";

import { AppText, Sheet } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

import { DISMISS_DRAG_PT, DISMISS_VELOCITY, shouldDismissSheet } from "./Sheet";

/** Same wrapper renderWithTheme applies — rerenders must re-wrap manually. */
function themed(ui: ReactElement) {
  return <ThemeProvider defaultAppearancePref="light">{ui}</ThemeProvider>;
}

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

  describe("exit-window guard (QUEUE P1 — hit-testable/setState exit tax)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("keeps touches enabled while visible", async () => {
      await renderWithTheme(
        <Sheet visible onDismiss={() => undefined} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      expect(
        screen.getByTestId("sheet-container", { includeHiddenElements: true }).props
          .pointerEvents,
      ).toBe("auto");
    });

    it("is NOT hit-testable through the exit animation", async () => {
      const onDismiss = jest.fn();
      const view = await renderWithTheme(
        <Sheet visible onDismiss={onDismiss} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await view.rerender(
        themed(
          <Sheet visible={false} onDismiss={onDismiss} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        ),
      );

      // Exit window open: still mounted, but the touch boundary is closed.
      const container = screen.getByTestId("sheet-container", { includeHiddenElements: true });
      expect(container.props.pointerEvents).toBe("none");
      await fireEvent.press(screen.getByTestId("sheet-scrim", { includeHiddenElements: true }));
      await fireEvent.press(screen.getByTestId("sheet-close", { includeHiddenElements: true }));
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("closes the exit window on its own timer and unmounts", async () => {
      jest.useFakeTimers();
      const view = await renderWithTheme(
        <Sheet visible onDismiss={() => undefined} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await view.rerender(
        themed(
          <Sheet visible={false} onDismiss={() => undefined} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      expect(screen.getByTestId("sheet", { includeHiddenElements: true })).toBeTruthy();

      // duration.base exit (~200ms) + headroom — consumer drains at 250ms
      // stay harmless no-ops against this window.
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(screen.queryByTestId("sheet", { includeHiddenElements: true })).toBeNull();
    });

    it("guards the completion setState when unmounted mid-exit", async () => {
      // REAL timers, and the drain deliberately happens OUTSIDE act: this is
      // the exact escape shape (the exit timer lands after the consumer tore
      // the sheet down — the act-warning class that cost T-6.9/PR #14 review
      // rounds). Unguarded, React logs "An update to Sheet ... not wrapped
      // in act" here; the errorSpy makes that a deterministic red.
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const view = await renderWithTheme(
        <Sheet visible onDismiss={() => undefined} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await view.rerender(
        themed(
          <Sheet visible={false} onDismiss={() => undefined} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      // Consumer tears the sheet down before the ~200ms exit timer lands.
      await view.unmount();
      // Drain WITHOUT act on purpose — proving nothing escapes un-act'd.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });
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

  describe("dismissDisabled — a gated affordance SHOWS it is gated", () => {
    it("blocks every dismissal route and renders the close button visibly disabled", async () => {
      const onDismiss = jest.fn();
      await renderWithTheme(
        <Sheet visible onDismiss={onDismiss} dismissDisabled title="Working" testID="sheet">
          <AppText>content</AppText>
        </Sheet>,
      );

      const close = screen.getByTestId("sheet-close");
      // LEGIBLE, not merely inert: a swallowed tap with no visible state
      // reads as a frozen app (the reason a silent gate was rejected).
      expect(close).toBeDisabled();
      expect(close.props.accessibilityState).toMatchObject({ disabled: true });

      await fireEvent.press(close);
      // The scrim sits under an `opacity: 0` Animated.View (its entrance
      // value never advances in jest), so RNTL hides it from queries by
      // default — `includeHiddenElements` is the only way to pin that route.
      await fireEvent.press(
        screen.getByTestId("sheet-scrim", { includeHiddenElements: true }),
      );
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("is opt-in: dismissal works normally by default", async () => {
      const onDismiss = jest.fn();
      await renderWithTheme(
        <Sheet visible onDismiss={onDismiss} title="Idle" testID="sheet">
          <AppText>content</AppText>
        </Sheet>,
      );
      const close = screen.getByTestId("sheet-close");
      expect(close).not.toBeDisabled();
      await fireEvent.press(close);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
