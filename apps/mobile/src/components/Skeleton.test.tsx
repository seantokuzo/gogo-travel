/**
 * Skeleton — R-ds-11: reduce-motion renders a STATIC placeholder (the
 * `{testID}-shimmer` animated wrapper disappears); default renders shimmer.
 * Hidden from accessibility either way — which is WHY every query here opts
 * into includeHiddenElements: RNTL's default visibility filter (correctly)
 * excludes the AT-hidden skeleton subtree.
 */
import { screen, waitFor } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

import { Skeleton } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

const hidden = { includeHiddenElements: true } as const;

describe("Skeleton", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders the animated shimmer wrapper by default", async () => {
    await renderWithTheme(<Skeleton variant="rect" testID="sk" />);
    expect(screen.getByTestId("sk-shimmer", hidden)).toBeOnTheScreen();
  });

  it("reduce-motion ⇒ static placeholder, no shimmer node (R-ds-11)", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    await renderWithTheme(<Skeleton variant="rect" testID="sk" />);
    // The OS flag resolves async; the shimmer wrapper must then unmount.
    await waitFor(() => expect(screen.queryByTestId("sk-shimmer", hidden)).toBeNull());
    expect(screen.getByTestId("sk", hidden)).toBeOnTheScreen();
  });

  it("text variant stacks the requested number of lines", async () => {
    await renderWithTheme(<Skeleton variant="text" lines={3} testID="sk" />);
    expect(screen.getByTestId("sk-line-0", hidden)).toBeOnTheScreen();
    expect(screen.getByTestId("sk-line-2", hidden)).toBeOnTheScreen();
    expect(screen.queryByTestId("sk-line-3", hidden)).toBeNull();
  });

  it("is hidden from assistive tech — a skeleton is not content", async () => {
    await renderWithTheme(<Skeleton variant="circle" testID="sk" />);
    // The DEFAULT query filter must NOT see it…
    expect(screen.queryByTestId("sk")).toBeNull();
    // …while the element itself carries the hiding props.
    const root = screen.getByTestId("sk", hidden);
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe("no-hide-descendants");
  });
});
