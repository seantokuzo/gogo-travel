/**
 * ListItem — 44pt+ row (R-ds-9), chevron shorthand, pressable form gains
 * button role + title-derived a11y label.
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { Badge, ListItem } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("ListItem", () => {
  it("renders title/subtitle at a ≥44pt row height", async () => {
    await renderWithTheme(<ListItem title="Documents" subtitle="3 files" testID="row" />);
    expect(screen.getByText("Documents")).toBeOnTheScreen();
    expect(screen.getByText("3 files")).toBeOnTheScreen();
    expect(screen.getByTestId("row")).toHaveStyle({ minHeight: 56 });
  });

  it("pressable row exposes button role, derives its label, fires onPress", async () => {
    const onPress = jest.fn();
    await renderWithTheme(<ListItem title="Trip members" onPress={onPress} testID="members-row" />);
    const row = screen.getByTestId("members-row");
    expect(row.props.accessibilityRole).toBe("button");
    expect(row.props.accessibilityLabel).toBe("Trip members");
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("static row exposes no button role", async () => {
    await renderWithTheme(<ListItem title="Static" testID="row" />);
    expect(screen.getByTestId("row").props.accessibilityRole).toBeUndefined();
  });

  it("renders a custom trailing node (e.g. a Badge)", async () => {
    await renderWithTheme(
      <ListItem title="Members" trailing={<Badge label="Owner" tone="accent" />} />,
    );
    expect(screen.getByText("Owner")).toHaveStyle({ color: lightTheme.color.text.accent });
  });
});
