/**
 * AppText — role/color styles come from tokens; Dynamic Type caps are PROPS
 * (R-ds-10); `label` role uppercases (spec §2.3).
 */
import { screen } from "@testing-library/react-native";

import { AppText } from "@/components";
import { lightTheme, renderWithTheme } from "@/test-utils/render";

describe("AppText", () => {
  it("applies the role's type tokens and defaults to body/primary", async () => {
    await renderWithTheme(<AppText testID="txt">hello</AppText>);
    expect(screen.getByTestId("txt")).toHaveStyle({
      fontSize: lightTheme.type.body.fontSize,
      lineHeight: lightTheme.type.body.lineHeight,
      color: lightTheme.color.text.primary,
    });
  });

  it("applies a named role and semantic color", async () => {
    await renderWithTheme(
      <AppText role="title" color="secondary" testID="txt">
        Screen title
      </AppText>,
    );
    expect(screen.getByTestId("txt")).toHaveStyle({
      fontSize: lightTheme.type.title.fontSize,
      fontWeight: lightTheme.type.title.fontWeight,
      color: lightTheme.color.text.secondary,
    });
  });

  it("caps Dynamic Type per role via the maxFontSizeMultiplier PROP (R-ds-10)", async () => {
    await renderWithTheme(
      <AppText role="display" testID="txt">
        Hero
      </AppText>,
    );
    expect(screen.getByTestId("txt").props.maxFontSizeMultiplier).toBe(
      lightTheme.type.display.maxFontSizeMultiplier,
    );
  });

  it("lets callers override the cap without disabling scaling", async () => {
    await renderWithTheme(
      <AppText role="body" maxFontSizeMultiplier={1.1} testID="txt">
        chrome
      </AppText>,
    );
    expect(screen.getByTestId("txt").props.maxFontSizeMultiplier).toBe(1.1);
  });

  it("uppercases the label role (spec §2.3) with its letter tracking", async () => {
    await renderWithTheme(
      <AppText role="label" testID="txt">
        badge
      </AppText>,
    );
    expect(screen.getByTestId("txt")).toHaveStyle({
      textTransform: "uppercase",
      letterSpacing: lightTheme.type.label.letterSpacing,
    });
  });
});
