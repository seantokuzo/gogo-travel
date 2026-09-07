/**
 * Sheet — R-ds-19 dismissal affordances: explicit close button, scrim tap,
 * Android back, and the swipe-down RELEASE DECISION (the gesture pipeline
 * itself is not simulatable in jest; the 80pt/0.5vy math is a pure function).
 * Content mounts only while visible.
 */
import { ThemeProvider } from "@gogo/tokens/react";
import { act, fireEvent, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { Animated, Dimensions, Modal, View } from "react-native";

import { AppText, Sheet } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

import {
  __sheetExitCompletionForTests,
  DISMISS_DRAG_PT,
  DISMISS_VELOCITY,
  shouldDismissSheet,
} from "./Sheet";

/**
 * iOS-FAITHFUL `Modal` stand-in (B-19 round 1) — the reason the pins below
 * can discriminate the fix at all.
 *
 * The jest preset's mock (`@react-native/jest-preset/jest/mocks/Modal.js`)
 * returns `null` the instant `visible === false`, so under it "the Modal's
 * children unmounted" and "the native modal was dismissed" are the SAME
 * commit. On iOS they are one dismissal apart, and that gap IS B-19: RN keeps
 * the modal presented while `isRendered` is true (`Modal.js:276-282`,
 * `_shouldShowModal()` = `visible || isRendered`) and clears `isRendered`
 * only in the `onDismiss` handler (`Modal.js:318-327`), which native emits
 * from `dismissViewControllerAnimated:completion:`
 * (`RCTModalHostViewComponentView.mm:194-204`). Against the preset mock the
 * NAIVE fix — `useEffect(() => { if (wasMounted && !mounted) onExited?.(); },
 * [mounted])` with no probe — passes every pin in this file while
 * reproducing B-19 on device.
 *
 * So this reimplements the real machine (constructor seed
 * `isRendered: props.visible === true`, the false→true re-arm in
 * `componentDidUpdate`, `_shouldShowModal`) and makes the native dismissal an
 * EXPLICIT step the test drives. Per R-test-1 / ADR-006 B-4 the mock's own
 * behavior is re-asserted by a test — see "Modal mock fidelity" below; a mock
 * this load-bearing has to be pinned itself.
 *
 * `platform` defaults to `"android"`, which is exactly the preset mock's
 * behavior, so every pre-existing pin in this file is untouched. The B-19
 * block opts into `"ios"`.
 */
jest.mock("react-native/Libraries/Modal/Modal", () => {
  // jest.mock factories are hoisted above ES imports — require() is the only
  // way to reach modules from inside one (place-detail-cross-tab precedent).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactModule = require("react") as typeof import("react");

  type MockModalProps = {
    visible?: boolean;
    children?: import("react").ReactNode;
    onDismiss?: () => void;
  };

  let platform: "ios" | "android" = "android";

  class MockModal extends ReactModule.Component<MockModalProps, { isRendered: boolean }> {
    /** Native dismissal in flight — set when `visible` goes true→false. */
    dismissalPending = false;

    constructor(props: MockModalProps) {
      super(props);
      // Modal.js:236-238 — a FRESH instance can never inherit a stale flag.
      this.state = { isRendered: props.visible === true };
    }

    componentDidMount() {
      liveInstances.add(this);
    }

    componentWillUnmount() {
      liveInstances.delete(this);
    }

    componentDidUpdate(prev: MockModalProps) {
      // Modal.js:266-270 — re-armed ONLY on the false→true edge.
      if (prev.visible === false && this.props.visible === true) {
        this.setState({ isRendered: true });
      }
      // Native bookkeeping: hiding a PRESENTED modal starts a dismissal whose
      // completion (and therefore `onDismiss`) lands later. iOS only —
      // `Modal.js:317-327` gates the whole `onDismiss` handler on
      // `Platform.OS === 'ios'`, so on Android nothing is ever delivered.
      if (
        platform === "ios" &&
        prev.visible === true &&
        this.props.visible === false &&
        this.state.isRendered
      ) {
        this.dismissalPending = true;
      }
    }

    /** The `dismissViewControllerAnimated:completion:` completion block. */
    completeNativeDismissal() {
      this.dismissalPending = false;
      this.setState({ isRendered: false }, () => this.props.onDismiss?.());
    }

    render(): import("react").ReactNode {
      // Modal.js:276-282.
      const show =
        platform === "ios"
          ? this.props.visible === true || this.state.isRendered
          : this.props.visible === true;
      return show ? this.props.children : null;
    }
  }

  const liveInstances = new Set<MockModal>();

  return {
    __esModule: true,
    default: MockModal,
    __modalMockControls: {
      setPlatform(os: "ios" | "android") {
        platform = os;
      },
      reset() {
        platform = "android";
        liveInstances.clear();
      },
      pendingNativeDismissals(): number {
        return [...liveInstances].filter((instance) => instance.dismissalPending).length;
      },
      /** Deliver every in-flight dismissal completion, oldest instance first. */
      completeNativeDismissals() {
        for (const instance of [...liveInstances]) {
          if (instance.dismissalPending) instance.completeNativeDismissal();
        }
      },
    },
  };
});

const { __modalMockControls: modalMock } = jest.requireMock(
  "react-native/Libraries/Modal/Modal",
) as {
  __modalMockControls: {
    setPlatform(os: "ios" | "android"): void;
    reset(): void;
    pendingNativeDismissals(): number;
    completeNativeDismissals(): void;
  };
};

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
        screen.getByTestId("sheet-container", { includeHiddenElements: true }).props.pointerEvents,
      ).toBe("auto");
    });

    it("is NOT hit-testable through the exit animation", async () => {
      // B-21: fake timers PIN the exit window open. With real timers this
      // test raced the real ~200ms exit — a CI starvation stall could let
      // the exit COMPLETE mid-test (sheet unmounts → getByTestId throws) or
      // let the still-mounted completion setState land in an un-act'd gap
      // between the awaited act calls below (the "not wrapped in act"
      // sighting, repro'd under SIGSTOP pulsing of the jest worker). Under
      // fake timers the exit timer cannot fire unless advanced — and this
      // test never advances it.
      jest.useFakeTimers();
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
      // The exact escape shape (the exit timer lands after the consumer tore
      // the sheet down — the act-warning class that cost T-6.9/PR #14 review
      // rounds), determinized in B-21. FAKE timers, because with real timers
      // this test itself raced: a ≥200ms starvation stall between the
      // rerender and the unmount let the completion fire BEFORE the unmount,
      // outside act while the sheet was still mounted — a legitimate
      // setState turning the errorSpy red (the incident class). Under fake
      // timers the completion can only fire in the drain below, strictly
      // after teardown. The drain still deliberately happens OUTSIDE act —
      // the completion callback executes un-act'd, and the spy proves
      // nothing escapes. (React 19 note: a post-unmount setState is silently
      // dropped without any act warning, so this spy discriminates the
      // un-act'd-escape class, not the unmountedRef guard per se — true of
      // the original real-timer version of this pin as well.)
      jest.useFakeTimers();
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
      // Consumer tears the sheet down before the ~200ms exit timer lands —
      // guaranteed now: fake time has not advanced since the exit started.
      await view.unmount();
      // Drain WITHOUT act on purpose — proving nothing escapes un-act'd.
      await jest.advanceTimersByTimeAsync(400);
      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("skips the Animated-value parking when unmounted mid-exit (B-22 direct pin)", async () => {
      // DIRECT pin on `&& !unmountedRef.current` at the exit completion
      // (B-22 ①). The errorSpy pin above discriminates only the un-act'd-
      // escape class — React 19 silently drops a post-unmount setState, so
      // deleting the guard leaves that spy green (probe-proven, PR #52
      // review). Timer drains cannot reach the guard either: jest runs the
      // preset's MOCKED native driver (its NativeModules mock fires
      // `endCallback({ finished: true })` on a ~16ms setTimeout; animated
      // values never move), and unmount's detach cascade
      // (`AnimatedProps.__detach` → `__removeChild`-to-zero →
      // `AnimatedValue.__detach` → `stopAnimation`) delivers
      // `{ finished: false }` FIRST — the completion debounce
      // (`Animation.__notifyAnimationEnd` nulls `_onEnd` after its first
      // delivery) swallows the mock's later `finished: true`, so a
      // post-unmount completion always arrives `finished: false` (B-22
      // probe). The guard's real target is the ON-DEVICE native driver's
      // asynchronous `finished: true` delivery landing after teardown —
      // simulated here by invoking the REAL completion closure captured by
      // `__sheetExitCompletionForTests` (the same function object handed to
      // `Animated.parallel(...).start`); under jest only this seam can reach
      // the guard with `finished: true`. The observable is the guarded
      // block's value PARKING (`translate.setValue(offscreen)`,
      // `scrimOpacity.setValue(0)`): a `Animated.Value.prototype.setValue`
      // spy, cleared after unmount, sees explicit calls only — under jest no
      // animation frames touch the values at all.
      // Mutation-proven: deleting the `!unmountedRef.current` clause turns
      // this RED (2 parking setValue calls post-unmount); restored, GREEN.
      jest.useFakeTimers();
      const setValueSpy = jest.spyOn(Animated.Value.prototype, "setValue");
      try {
        __sheetExitCompletionForTests.current = null;
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
        // The exit effect ran on the hide edge and registered its completion.
        // (Read via a helper: TS otherwise carries the `= null` reset's
        // property narrowing across the render calls and types this `null`.)
        const readSeam = (): ((result: { finished: boolean }) => void) | null =>
          __sheetExitCompletionForTests.current;
        const completion = readSeam();
        expect(completion).not.toBeNull();
        await view.unmount();
        // Everything up to and including the unmount may setValue freely
        // (dragY reset on the entrance effect). The pin starts HERE: after
        // teardown, a `finished: true` completion must touch NO animated
        // value.
        setValueSpy.mockClear();
        await act(async () => {
          completion?.({ finished: true });
        });
        expect(setValueSpy).not.toHaveBeenCalled();
      } finally {
        setValueSpy.mockRestore();
        __sheetExitCompletionForTests.current = null;
      }
    });
  });

  /**
   * B-19 — `onExited` is the seam every "close the sheet, then open a modal
   * ROUTE" caller pushes from. Its whole value is WHEN it lands: a push that
   * shares a commit with the dismiss (or that fires from the exit
   * animation's completion, before the Modal has actually gone) presents an
   * expo-router modal while the sheet's `RCTModalHostViewController` is
   * still up, which latches `RNSScreenStackView._updatingModals` and wedges
   * that tab's stack for the life of the process.
   *
   * FALSIFICATION SET (R-test-7) — what these cases can and cannot red, and
   * why the "on iOS" block below is not optional.
   *
   * The cases in THIS block run against the default Modal mock, which is the
   * jest preset's behavior: `visible === false` unmounts the children in that
   * same commit, so "the Modal is gone" and "`mounted` flipped false" are
   * indistinguishable. They red on:
   *   - firing `onExited` from `onExitComplete` next to `setExiting(false)`
   *     (the exit TIMER — one commit early);
   *   - deleting `firedExitTickRef` (the fresh-identity replay);
   *   - firing from `ModalPresenceProbe`'s own cleanup unconditionally (the
   *     unmount-mid-exit case);
   * and they CANNOT red on the one variant that actually matters:
   *   - deleting the probe and firing from
   *     `useEffect(() => { if (wasMounted && !mounted) onExited?.(); },
   *     [mounted])` — passive effects run after the commit, so
   *     `sheetStillMountedAtCall` is `false` here and all of these stay
   *     GREEN, while on iOS that fires with the
   *     `RCTModalHostViewController` still presented and B-19 reproduces.
   *
   * On iOS the Modal outlives `visible: false` by a whole dismissal
   * animation. That divergence is the bug, so it gets its own block with a
   * Modal mock that models it.
   */
  describe("onExited — fires only once the RN Modal is off screen (B-19)", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("stays silent through the exit window, then fires ONCE with the Modal already gone", async () => {
      jest.useFakeTimers();
      let sheetStillMountedAtCall: boolean | null = null;
      const onExited = jest.fn(() => {
        sheetStillMountedAtCall =
          screen.queryByTestId("sheet", { includeHiddenElements: true }) !== null;
      });
      const view = await renderWithTheme(
        <Sheet visible onDismiss={() => undefined} onExited={() => onExited()} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      expect(onExited).not.toHaveBeenCalled();

      await view.rerender(
        themed(
          <Sheet
            visible={false}
            onDismiss={() => undefined}
            onExited={() => onExited()}
            testID="sheet"
          >
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      // The exit window: still mounted, still PRESENTED natively — the exact
      // interval in which a modal-route push wedges the stack.
      expect(screen.getByTestId("sheet", { includeHiddenElements: true })).toBeTruthy();
      expect(onExited).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(screen.queryByTestId("sheet", { includeHiddenElements: true })).toBeNull();
      expect(onExited).toHaveBeenCalledTimes(1);
      expect(sheetStillMountedAtCall).toBe(false);

      // A later render with a FRESH callback identity (every consumer render
      // makes one — the closure carries the pending intent) must not replay
      // an exit that was already reported.
      await view.rerender(
        themed(
          <Sheet
            visible={false}
            onDismiss={() => undefined}
            onExited={() => onExited()}
            testID="sheet"
          >
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(onExited).toHaveBeenCalledTimes(1);
    });

    it("fires NOTHING when the consumer unmounts mid-exit", async () => {
      jest.useFakeTimers();
      const onExited = jest.fn();
      const view = await renderWithTheme(
        <Sheet visible onDismiss={() => undefined} onExited={onExited} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await view.rerender(
        themed(
          <Sheet visible={false} onDismiss={() => undefined} onExited={onExited} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      // Torn down before the exit completes — the Modal goes with it, and a
      // callback landing after teardown would route a dead screen.
      await view.unmount();
      await jest.advanceTimersByTimeAsync(400);
      expect(onExited).not.toHaveBeenCalled();
    });

    it("a sheet that never opened reports no exit", async () => {
      jest.useFakeTimers();
      const onExited = jest.fn();
      await renderWithTheme(
        <Sheet visible={false} onDismiss={() => undefined} onExited={onExited} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(onExited).not.toHaveBeenCalled();
    });

    it("is a LIFECYCLE signal: a scrim/close dismissal fires it too", async () => {
      jest.useFakeTimers();
      const onExited = jest.fn();
      const onDismiss = jest.fn();
      const view = await renderWithTheme(
        <Sheet visible onDismiss={onDismiss} onExited={onExited} testID="sheet">
          <AppText>x</AppText>
        </Sheet>,
      );
      await fireEvent.press(screen.getByTestId("sheet-close"));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      // The consumer owns `visible`; mirror what it does with that dismissal.
      await view.rerender(
        themed(
          <Sheet visible={false} onDismiss={onDismiss} onExited={onExited} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        ),
      );
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(onExited).toHaveBeenCalledTimes(1);
    });

    /**
     * The iOS ordering, modeled: the RN `Modal` keeps its children — and its
     * `RCTModalHostViewController` — up past `visible: false`, until the
     * native dismissal completes. Everything B-19 turns on lives in that gap,
     * and no other block in this suite can see it.
     */
    describe("on iOS — the Modal outlives `visible: false`", () => {
      beforeEach(() => {
        modalMock.setPlatform("ios");
      });
      afterEach(() => {
        modalMock.reset();
      });

      it("[mock fidelity] holds children past `visible: false` until the native dismissal", async () => {
        // R-test-1 / ADR-006 B-4: a mock this load-bearing re-asserts its own
        // behavior, or every pin built on it is an assertion about a fiction.
        const onDismiss = jest.fn();
        const view = await renderWithTheme(
          <Modal visible onDismiss={onDismiss}>
            <View testID="modal-child" />
          </Modal>,
        );
        expect(screen.getByTestId("modal-child")).toBeTruthy();

        await view.rerender(
          themed(
            <Modal visible={false} onDismiss={onDismiss}>
              <View testID="modal-child" />
            </Modal>,
          ),
        );
        // Still presented (Modal.js `_shouldShowModal()` = visible ||
        // isRendered) — the dismissal has only been asked for.
        expect(screen.getByTestId("modal-child")).toBeTruthy();
        expect(modalMock.pendingNativeDismissals()).toBe(1);
        expect(onDismiss).not.toHaveBeenCalled();

        await act(async () => {
          modalMock.completeNativeDismissals();
        });
        expect(screen.queryByTestId("modal-child")).toBeNull();
        expect(onDismiss).toHaveBeenCalledTimes(1);
      });

      it("[mock fidelity] the default arm unmounts in the same commit — the preset's behavior", async () => {
        // Every OTHER pin in this file runs on this arm; if it ever drifts
        // from `@react-native/jest-preset/jest/mocks/Modal.js` they stop
        // meaning what they say.
        modalMock.setPlatform("android");
        const view = await renderWithTheme(
          <Modal visible>
            <View testID="modal-child" />
          </Modal>,
        );
        expect(screen.getByTestId("modal-child")).toBeTruthy();
        await view.rerender(
          themed(
            <Modal visible={false}>
              <View testID="modal-child" />
            </Modal>,
          ),
        );
        expect(screen.queryByTestId("modal-child")).toBeNull();
        expect(modalMock.pendingNativeDismissals()).toBe(0);
      });

      it("stays silent when the exit TIMER lands — it fires on the native dismissal", async () => {
        jest.useFakeTimers();
        let sheetStillMountedAtCall: boolean | null = null;
        const onExited = jest.fn(() => {
          sheetStillMountedAtCall =
            screen.queryByTestId("sheet", { includeHiddenElements: true }) !== null;
        });
        const view = await renderWithTheme(
          <Sheet visible onDismiss={() => undefined} onExited={() => onExited()} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        );
        await view.rerender(
          themed(
            <Sheet
              visible={false}
              onDismiss={() => undefined}
              onExited={() => onExited()}
              testID="sheet"
            >
              <AppText>x</AppText>
            </Sheet>,
          ),
        );

        await act(async () => {
          jest.advanceTimersByTime(400);
        });
        // The JS exit is OVER — `mounted` is false and the Sheet has stopped
        // rendering the modal. The native controller is still up. THIS is the
        // window the naive `[mounted]`-keyed effect fires in, and this is the
        // assertion that reds it.
        expect(onExited).not.toHaveBeenCalled();
        expect(modalMock.pendingNativeDismissals()).toBe(1);

        await act(async () => {
          modalMock.completeNativeDismissals();
        });
        expect(onExited).toHaveBeenCalledTimes(1);
        expect(sheetStillMountedAtCall).toBe(false);
      });

      it("fires once PER PRESENTATION across two full cycles", async () => {
        jest.useFakeTimers();
        const onExited = jest.fn();
        const view = await renderWithTheme(
          <Sheet visible onDismiss={() => undefined} onExited={onExited} testID="sheet">
            <AppText>x</AppText>
          </Sheet>,
        );
        for (const cycle of [1, 2]) {
          if (cycle === 2) {
            await view.rerender(
              themed(
                <Sheet visible onDismiss={() => undefined} onExited={onExited} testID="sheet">
                  <AppText>x</AppText>
                </Sheet>,
              ),
            );
          }
          await view.rerender(
            themed(
              <Sheet
                visible={false}
                onDismiss={() => undefined}
                onExited={onExited}
                testID="sheet"
              >
                <AppText>x</AppText>
              </Sheet>,
            ),
          );
          await act(async () => {
            jest.advanceTimersByTime(400);
          });
          await act(async () => {
            modalMock.completeNativeDismissals();
          });
          // Collapse the per-tick latch to a once-ever boolean and cycle 2 is
          // silent — i.e. every Sheet→modal-route flow in the app is a dead
          // tap from the second use onward, with the whole suite green.
          expect(onExited).toHaveBeenCalledTimes(cycle);
        }
      });

      it("a stale `isRendered` from a reopen cannot make the NEXT close fire early", async () => {
        jest.useFakeTimers();
        const onExited = jest.fn();
        const visibleSheet = (
          <Sheet visible onDismiss={() => undefined} onExited={onExited} testID="sheet">
            <AppText>x</AppText>
          </Sheet>
        );
        const hiddenSheet = (
          <Sheet visible={false} onDismiss={() => undefined} onExited={onExited} testID="sheet">
            <AppText>x</AppText>
          </Sheet>
        );
        const view = await renderWithTheme(visibleSheet);

        // Close 1, exit timer lands. The controller is off screen natively,
        // but RN's `onDismiss` has not reached JS yet (2-3 frames).
        await view.rerender(themed(hiddenSheet));
        await act(async () => {
          jest.advanceTimersByTime(400);
        });
        expect(onExited).not.toHaveBeenCalled();

        // The user reopens INSIDE that window. The `key` retires the
        // presentation-1 instance, so its late `onDismiss` has nowhere to
        // land and cannot leave `isRendered: false` on a presented modal.
        // The teardown that retiring it produces belongs to a superseded
        // presentation and must not be reported — a sheet is on screen.
        await view.rerender(themed(visibleSheet));
        await act(async () => {
          modalMock.completeNativeDismissals();
        });
        expect(onExited).not.toHaveBeenCalled();

        // Close 2 — the one that used to unmount the probe in the same commit
        // as `mounted → false`, i.e. before the native dismissal had even
        // started. Drop the `key` and this assertion goes red.
        await view.rerender(themed(hiddenSheet));
        await act(async () => {
          jest.advanceTimersByTime(400);
        });
        expect(onExited).not.toHaveBeenCalled();
        expect(modalMock.pendingNativeDismissals()).toBe(1);

        await act(async () => {
          modalMock.completeNativeDismissals();
        });
        expect(onExited).toHaveBeenCalledTimes(1);
      });
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
