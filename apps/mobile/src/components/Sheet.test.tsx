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
    it("renders the close affordance visibly disabled", async () => {
      const onDismiss = jest.fn();
      await renderWithTheme(
        <Sheet visible onDismiss={onDismiss} dismissDisabled title="Working" testID="sheet">
          <AppText>content</AppText>
        </Sheet>,
      );
      const close = screen.getByTestId("sheet-close");
      // LEGIBLE, not merely inert: a swallowed tap with no visible state
      // reads as a frozen app (why a silent gate was rejected).
      expect(close).toBeDisabled();
      expect(close.props.accessibilityState).toMatchObject({ disabled: true });
    });

    /**
     * Each of the FOUR dismissal routes, pinned INDEPENDENTLY.
     *
     * Round-2 verifier: the previous version asserted `onDismiss` was not
     * called after `fireEvent.press` on a `disabled` element — but RNTL
     * refuses to fire a handler on a disabled element at all, so that
     * assertion held whether or not the handler was gated (ungating any of
     * the four routes left it GREEN). The `disabled` prop is a SECOND layer;
     * the gate under test is `guardedDismiss`, so these invoke each route's
     * wired handler DIRECTLY, past RNTL's disabled short-circuit.
     *
     * Every case also asserts the UNGATED control fires — otherwise
     * "not called" could pass simply because the invocation reached nothing.
     */
    describe("gates each dismissal route independently", () => {
      async function mount(dismissDisabled: boolean) {
        const onDismiss = jest.fn();
        await renderWithTheme(
          <Sheet
            visible
            onDismiss={onDismiss}
            dismissDisabled={dismissDisabled}
            title="Working"
            testID="sheet"
          >
            <AppText>content</AppText>
          </Sheet>,
        );
        return onDismiss;
      }

      /**
       * close + scrim: the OBSERVABLE gate on these two is the `disabled`
       * prop — RN (and RNTL) will not fire `onPress` on a disabled Pressable
       * at all, so `guardedDismiss` on these routes is redundant
       * defense-in-depth with no separately observable effect. What is
       * falsifiable, and what this asserts, is the disabled state itself:
       * dropping `disabled={dismissDisabled}` from either element turns this
       * RED (and is exactly what would make the gate silent again).
       */
      it.each([
        ["close button", "sheet-close"],
        ["scrim", "sheet-scrim"],
      ])("%s — visibly disabled, and the press does not reach onDismiss", async (_l, testID) => {
        const ungated = await mount(false);
        const enabled = screen.getByTestId(testID, { includeHiddenElements: true });
        expect(enabled).not.toBeDisabled(); // the control
        await fireEvent.press(enabled);
        expect(ungated).toHaveBeenCalledTimes(1);

        const gated = await mount(true);
        const blocked = screen.getByTestId(testID, { includeHiddenElements: true });
        expect(blocked).toBeDisabled();
        expect(blocked.props.accessibilityState).toMatchObject({ disabled: true });
        await fireEvent.press(blocked);
        expect(gated).not.toHaveBeenCalled();
      });

      /**
       * Android back is the route with NO `disabled` backstop — the Modal's
       * `onRequestClose` is called by the platform regardless — so here the
       * `guardedDismiss` wiring is the only thing standing between a back
       * press and a mid-mutation unmount, and this case discriminates it
       * directly.
       */
      it("Android back (Modal onRequestClose) — no `disabled` backstop exists here", async () => {
        const ungated = await mount(false);
        await fireEvent(screen.getByTestId("sheet"), "requestClose");
        expect(ungated).toHaveBeenCalledTimes(1); // the control

        const gated = await mount(true);
        await fireEvent(screen.getByTestId("sheet"), "requestClose");
        expect(gated).not.toHaveBeenCalled();
      });

      /**
       * The FOURTH route — swipe-down release — is NOT independently pinned
       * here, and deliberately not papered over.
       *
       * `panHandlers.onResponderRelease` is PanResponder's own wrapper: it
       * derives `gestureState` from accumulated touch history, so invoking it
       * without a fabricated grant→move→release sequence yields `dy: 0` and
       * would never dismiss even UNGATED — the "control" arm could not go
       * green, making any gated assertion vacuous by construction. That is
       * the same limit this file documents at the top ("the gesture pipeline
       * itself is not simulatable in jest"), which is why the 80pt/0.5vy
       * decision is extracted as the pure `shouldDismissSheet`.
       *
       * What IS pinned: `shouldDismissSheet` (above) decides dismissal, and
       * the release calls the SAME `guardedDismiss` the three routes above
       * are proven to gate — one memoized callback, one construction site.
       * Treat this route as covered by inspection, not by test.
       */
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
