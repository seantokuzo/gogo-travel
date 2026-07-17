/**
 * Component-test harness — renders under an EPHEMERAL ThemeProvider (no
 * storage / appearance source: nothing persists, `system` resolves light).
 * Assertions compare against theme objects from getTheme, never literals.
 *
 * Lives outside `__tests__/` so jest's default testMatch never treats it as
 * a test file.
 */
import { DEFAULT_THEME, getTheme } from "@gogo/tokens";
import type { ColorSchemeName, ThemeName } from "@gogo/tokens";
import { ThemeProvider } from "@gogo/tokens/react";
import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";

export function renderWithTheme(
  ui: ReactElement,
  opts?: { scheme?: ColorSchemeName; accent?: ThemeName },
) {
  return render(
    <ThemeProvider defaultAppearancePref={opts?.scheme ?? "light"} defaultAccentName={opts?.accent}>
      {ui}
    </ThemeProvider>,
  );
}

/** The default assertion theme — goldenHour light, same object getTheme memoizes. */
export const lightTheme = getTheme(DEFAULT_THEME, "light");
export const darkTheme = getTheme(DEFAULT_THEME, "dark");
