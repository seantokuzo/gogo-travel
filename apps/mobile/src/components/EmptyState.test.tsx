/**
 * EmptyState — R-ds-16: icon + title + optional body + optional CTA; the CTA
 * carries its own required testID.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { EmptyState } from "@/components";
import { renderWithTheme } from "@/test-utils/render";

jest.mock("@/theme/haptics", () => ({ triggerHaptic: jest.fn() }));

describe("EmptyState", () => {
  it("renders title and body copy", async () => {
    await renderWithTheme(
      <EmptyState
        icon="airplane"
        title="No trips yet"
        body="Plan your first trip."
        testID="empty"
      />,
    );
    expect(screen.getByText("No trips yet")).toBeOnTheScreen();
    expect(screen.getByText("Plan your first trip.")).toBeOnTheScreen();
  });

  it("renders the CTA when provided and fires its onPress", async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <EmptyState
        icon="airplane"
        title="No trips yet"
        action={{ label: "Create a trip", onPress, testID: "empty-cta" }}
      />,
    );
    await fireEvent.press(screen.getByTestId("empty-cta"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("omits the CTA without an action", async () => {
    await renderWithTheme(<EmptyState icon="airplane" title="No trips yet" testID="empty" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
