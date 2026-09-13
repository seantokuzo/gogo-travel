/**
 * PageHeader — header role on the title, back auto-wires the router, max 2
 * trailing actions, each with its own required testID, and (B-27) exactly ONE
 * copy of the top safe-area inset: its own when it is the topmost chrome,
 * none when a `TopInsetBoundary` says an ancestor already claimed it.
 */
import { fireEvent, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { PageHeader, TopInsetBoundary } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

jest.mock("expo-router", () => {
  const back = jest.fn();
  return { useRouter: () => ({ back }), __back: back };
});

const { __back: mockBack } = jest.requireMock("expo-router") as { __back: jest.Mock };

/**
 * A notch device's window insets. The suite-wide safe-area mock resolves
 * `useSafeAreaInsets()` through `SafeAreaInsetsContext`, so providing it is
 * enough to put a REAL, non-zero inset in front of the component — under the
 * mock's 0 default every assertion below would pass with or without the fix.
 */
const DEVICE_INSETS = { top: 59, bottom: 34, left: 0, right: 0 };

function renderWithDeviceInsets(ui: ReactElement) {
  return renderWithTheme(
    <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>{ui}</SafeAreaInsetsContext.Provider>,
  );
}

function paddingTopOf(testID: string): number | undefined {
  const style = StyleSheet.flatten(screen.getByTestId(testID).props.style) as {
    paddingTop?: number;
  };
  return style.paddingTop;
}

describe("PageHeader", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders title (header role) and subtitle", async () => {
    await renderWithTheme(<PageHeader title="Trip" subtitle="Jul 20 – Aug 2" testID="hdr" />);
    const title = screen.getByText("Trip");
    expect(title.props.accessibilityRole).toBe("header");
    expect(screen.getByText("Jul 20 – Aug 2")).toBeOnTheScreen();
  });

  it("leading='back' wires router.back with an accessible 44pt control", async () => {
    await renderWithTheme(<PageHeader title="Trip" leading="back" testID="hdr" />);
    const back = screen.getByTestId("hdr-back");
    expect(back.props.accessibilityRole).toBe("button");
    expect(back.props.accessibilityLabel).toBe("Back");
    await fireEvent.press(back);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("uses ONLY the screen-passed testID — no default resurfaces (nav §2.7 grammar)", async () => {
    // Omission itself is now a type error (testid-required.typetest.tsx);
    // this guards the runtime half: the passed id is applied verbatim and
    // the removed "page-header" fallback must not resurface.
    await renderWithTheme(<PageHeader title="Trip" leading="back" testID="hdr" />);
    expect(screen.getByTestId("hdr")).toBeOnTheScreen();
    expect(screen.queryByTestId("page-header")).toBeNull();
    expect(screen.queryByTestId("page-header-back")).toBeNull();
    expect(screen.getByLabelText("Back")).toBeOnTheScreen();
  });

  it("renders trailing actions and fires their handlers", async () => {
    const onAdd = jest.fn();
    await renderWithTheme(
      <PageHeader
        title="Trip"
        testID="hdr"
        trailing={[{ icon: "add", label: "Add stop", onPress: onAdd, testID: "hdr-add" }]}
      />,
    );
    const action = screen.getByTestId("hdr-add");
    expect(action.props.accessibilityLabel).toBe("Add stop");
    await fireEvent.press(action);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("caps trailing actions at 2 (spec §2.9)", async () => {
    const noop = () => undefined;
    await renderWithTheme(
      <PageHeader
        title="Trip"
        testID="hdr"
        trailing={[
          { icon: "add", label: "One", onPress: noop, testID: "a1" },
          { icon: "search", label: "Two", onPress: noop, testID: "a2" },
          { icon: "close", label: "Three", onPress: noop, testID: "a3" },
        ]}
      />,
    );
    expect(screen.getByTestId("a1")).toBeOnTheScreen();
    expect(screen.getByTestId("a2")).toBeOnTheScreen();
    expect(screen.queryByTestId("a3")).toBeNull();
  });

  describe("top safe area (B-27) — claimed exactly once", () => {
    it("claims the full inset when it is the topmost chrome", async () => {
      await renderWithDeviceInsets(<PageHeader title="Trip" testID="hdr" />);
      expect(paddingTopOf("hdr")).toBe(DEVICE_INSETS.top + lightTheme.space[2]);
    });

    it("drops the inset — keeping its token gap — under a claiming boundary", async () => {
      await renderWithDeviceInsets(
        <TopInsetBoundary claimed>
          <PageHeader title="Trip" testID="hdr" />
        </TopInsetBoundary>,
      );
      // Not 0: the deliberate gap below the trip switcher bar is space[2].
      expect(paddingTopOf("hdr")).toBe(lightTheme.space[2]);
      expect(paddingTopOf("hdr")).not.toBe(DEVICE_INSETS.top + lightTheme.space[2]);
    });

    it("re-claims the inset when a nested boundary re-opens it (the native-modal case)", async () => {
      // What `itinerary/item/new` and `money/expense/new` do: React
      // descendants of the trip shell that are presented OVER it natively, so
      // they start a fresh top edge and own it again.
      await renderWithDeviceInsets(
        <TopInsetBoundary claimed>
          <TopInsetBoundary claimed={false}>
            <PageHeader title="Add" testID="hdr" />
          </TopInsetBoundary>
        </TopInsetBoundary>,
      );
      expect(paddingTopOf("hdr")).toBe(DEVICE_INSETS.top + lightTheme.space[2]);
    });
  });
});
