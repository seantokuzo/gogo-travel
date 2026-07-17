/**
 * First render tests for the app shell theme wiring (T-4.2).
 *
 * Renders the REAL home screen against the token runtime — assertions compare
 * against theme objects from getTheme, never color/size literals.
 */
import { DEFAULT_THEME, getTheme } from "@gogo/tokens";
import { STORAGE_KEYS, ThemeProvider, useTheme } from "@gogo/tokens/react";
import type { ThemeStorage } from "@gogo/tokens/react";
import { render, screen } from "@testing-library/react-native";
import { useEffect } from "react";

import Index from "@/app/index";
import { systemAppearance, themeStorage } from "@/theme";

// The home screen's __DEV__ gallery Link needs a router context that doesn't
// exist in a bare component render — stub it (navigation is not under test).
jest.mock("expo-router", () => {
  const { createElement, Fragment } = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ children }: { children?: import("react").ReactNode }) =>
      createElement(Fragment, null, children),
  };
});

/**
 * Records the resolved scheme on every COMMIT. seen[0] is the first committed
 * frame — what R-ds-4 actually promises. A regression moving the storage read
 * from the provider's useState initializers into an effect would commit light
 * first and fail seen[0] === "dark", where a post-mount assertion still passes
 * (RNTL's await render flushes effects).
 */
function SchemeProbe({ seen }: { seen: ("light" | "dark")[] }) {
  const { scheme } = useTheme();
  useEffect(() => {
    seen.push(scheme);
  });
  return null;
}

// The ThemeStorage seam is getString/set only; the underlying MMKV instance
// (mmkv's sanctioned in-memory mock under jest) also exposes remove — reach
// through for test isolation only, never in product code.
const mmkvStorage = themeStorage as ThemeStorage & { remove(key: string): void };

describe("home screen (first live token consumer)", () => {
  beforeEach(() => {
    // The adapter is a module-level singleton shared by every test in this
    // file — clear persisted theme state so no test inherits another's writes.
    mmkvStorage.remove(STORAGE_KEYS.appearance);
    mmkvStorage.remove(STORAGE_KEYS.accentTheme);
  });

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

  it("commits dark on the FIRST frame from a persisted preference (R-ds-4 no-flash)", async () => {
    themeStorage.set(STORAGE_KEYS.appearance, "dark");
    const seen: ("light" | "dark")[] = [];

    await render(
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        <SchemeProbe seen={seen} />
        <Index />
      </ThemeProvider>,
    );

    // Not just "ends up dark" — dark from the very first committed frame.
    expect(seen[0]).toBe("dark");
  });
});
