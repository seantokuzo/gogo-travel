/**
 * First render tests for the app shell theme wiring (T-4.2).
 *
 * Renders the REAL home screen against the token runtime — assertions compare
 * against theme objects from getTheme, never color/size literals.
 */
import { DEFAULT_THEME, getTheme } from "@gogo/tokens";
import { STORAGE_KEYS, ThemeProvider } from "@gogo/tokens/react";
import { render, screen } from "@testing-library/react-native";

import Index from "@/app/index";
import { systemAppearance, themeStorage } from "@/theme";

describe("home screen (first live token consumer)", () => {
  it("renders with the default goldenHour light theme tokens", async () => {
    // Ephemeral provider (no storage / system source) → defaults: goldenHour, light.
    // RNTL v14 render is async (universal test-renderer).
    await render(
      <ThemeProvider>
        <Index />
      </ThemeProvider>,
    );

    expect(DEFAULT_THEME).toBe("goldenHour");
    const theme = getTheme(DEFAULT_THEME, "light");
    expect(screen.getByTestId("home-screen")).toHaveStyle({
      backgroundColor: theme.color.bg.screen,
      padding: theme.space[6],
    });
    expect(screen.getByTestId("home-title")).toHaveStyle({
      color: theme.color.text.primary,
      fontSize: theme.type.title.fontSize,
    });
  });

  it("boots dark from a persisted preference through the real adapters", async () => {
    // Real MMKV adapter (jest substitutes an in-memory MMKV automatically):
    // persist "dark", then mount the provider exactly as _layout.tsx does.
    themeStorage.set(STORAGE_KEYS.appearance, "dark");

    await render(
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        <Index />
      </ThemeProvider>,
    );

    const dark = getTheme(DEFAULT_THEME, "dark");
    const light = getTheme(DEFAULT_THEME, "light");
    // Guard: the assertion below is only meaningful if the schemes differ.
    expect(dark.color.bg.screen).not.toBe(light.color.bg.screen);
    expect(screen.getByTestId("home-screen")).toHaveStyle({
      backgroundColor: dark.color.bg.screen,
    });
    expect(screen.getByTestId("home-title")).toHaveStyle({
      color: dark.color.text.primary,
    });
  });
});
