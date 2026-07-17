/**
 * Card — variant fills from tokens; pressable form gains button role +
 * onPress (testID enforced by the type-level suite).
 */
import { fireEvent, screen } from "@testing-library/react-native";

import { AppText, Card } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("Card", () => {
  it("raised (default) uses bg.surface; inset uses bg.inset", async () => {
    await renderWithTheme(
      <>
        <Card testID="raised">
          <AppText>a</AppText>
        </Card>
        <Card variant="inset" testID="inset">
          <AppText>b</AppText>
        </Card>
      </>,
    );
    expect(screen.getByTestId("raised")).toHaveStyle({
      backgroundColor: lightTheme.color.bg.surface,
      borderRadius: lightTheme.radius.md,
    });
    expect(screen.getByTestId("inset")).toHaveStyle({
      backgroundColor: lightTheme.color.bg.inset,
    });
  });

  it("flat variant draws the subtle border instead of elevation", async () => {
    await renderWithTheme(
      <Card variant="flat" testID="flat">
        <AppText>a</AppText>
      </Card>,
    );
    expect(screen.getByTestId("flat")).toHaveStyle({
      borderColor: lightTheme.color.border.subtle,
      borderWidth: 1,
    });
  });

  it("padded defaults on (space[4]) and can be disabled", async () => {
    await renderWithTheme(
      <>
        <Card testID="padded">
          <AppText>a</AppText>
        </Card>
        <Card padded={false} testID="bare">
          <AppText>b</AppText>
        </Card>
      </>,
    );
    expect(screen.getByTestId("padded")).toHaveStyle({ padding: lightTheme.space[4] });
    expect(screen.getByTestId("bare")).not.toHaveStyle({ padding: lightTheme.space[4] });
  });

  it("pressable card exposes button role and fires onPress (R-ds-12/20)", async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <Card onPress={onPress} testID="press-card" accessibilityLabel="Open trip">
        <AppText>content</AppText>
      </Card>,
    );
    const card = screen.getByTestId("press-card");
    expect(card.props.accessibilityRole).toBe("button");
    expect(card.props.accessibilityLabel).toBe("Open trip");
    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
