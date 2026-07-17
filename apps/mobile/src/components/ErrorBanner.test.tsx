/**
 * ErrorBanner — R-ds-17: alert role, retry affordance, derived control
 * testIDs, tone trios from tokens.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { ErrorBanner } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("ErrorBanner", () => {
  it("renders as an alert with the danger trio by default", async () => {
    await renderWithTheme(<ErrorBanner message="Sync failed." testID="banner" />);
    const banner = screen.getByTestId("banner");
    expect(banner.props.accessibilityRole).toBe("alert");
    expect(banner).toHaveStyle({
      backgroundColor: lightTheme.color.status.danger.bg,
      borderColor: lightTheme.color.status.danger.border,
    });
    expect(screen.getByText("Sync failed.")).toHaveStyle({
      color: lightTheme.color.status.danger.fg,
    });
  });

  it("warning tone swaps the trio", async () => {
    await renderWithTheme(<ErrorBanner message="Offline." tone="warning" testID="banner" />);
    expect(screen.getByTestId("banner")).toHaveStyle({
      backgroundColor: lightTheme.color.status.warning.bg,
    });
  });

  it("retry affordance fires onRetry from {testID}-retry (R-ds-17)", async () => {
    const onRetry = jest.fn();
    await renderWithTheme(<ErrorBanner message="x" onRetry={onRetry} testID="banner" />);
    await fireEvent.press(screen.getByTestId("banner-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("dismiss control appears only with onDismiss and fires it", async () => {
    const onDismiss = jest.fn();
    await renderWithTheme(
      <>
        <ErrorBanner message="a" testID="plain" />
        <ErrorBanner message="b" onDismiss={onDismiss} testID="dismissable" />
      </>,
    );
    expect(screen.queryByTestId("plain-dismiss")).toBeNull();
    await fireEvent.press(screen.getByTestId("dismissable-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
