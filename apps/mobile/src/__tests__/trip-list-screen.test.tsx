/**
 * Theme-boot probes on the app's landing screen (T-4.2 wiring, carried
 * through T-4.4): `app/index.tsx` is now a pure entry Redirect, so the
 * R-ds-4 first-frame evidence lives on the trip-list screen it lands on.
 * Assertions compare against theme objects from getTheme, never literals.
 */
import { DEFAULT_THEME, getTheme } from "@gogo/tokens";
import { STORAGE_KEYS, ThemeProvider, useTheme } from "@gogo/tokens/react";
import type { ThemeStorage } from "@gogo/tokens/react";
import { render, screen, within } from "@testing-library/react-native";
import { useEffect } from "react";

import TripListScreen from "@/app/(trips)/index";
import { systemAppearance, themeStorage } from "@/theme";

// Screen-level render without a router host — stub the hook surface the
// screen + PageHeader consume. Navigation behavior itself is covered by
// navigation-skeleton.test.tsx against the real route tree.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));

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

describe("trip-list screen (landing surface theme wiring)", () => {
  beforeEach(() => {
    // The adapter is a module-level singleton shared by every test in this
    // file — clear persisted theme state so no test inherits another's writes.
    mmkvStorage.remove(STORAGE_KEYS.appearance);
    mmkvStorage.remove(STORAGE_KEYS.accentTheme);
  });

  it("renders with the default goldenHour light theme tokens", async () => {
    // Ephemeral provider (no storage / system source) → defaults: goldenHour, light.
    await render(
      <ThemeProvider>
        <TripListScreen />
      </ThemeProvider>,
    );

    expect(DEFAULT_THEME).toBe("goldenHour");
    const theme = getTheme(DEFAULT_THEME, "light");
    expect(screen.getByTestId("trip-list-screen")).toHaveStyle({
      backgroundColor: theme.color.bg.screen,
    });
    // "Trips" renders in the PageHeader AND as the EmptyState headline —
    // the header's large-variant title is the one carrying the title role.
    expect(within(screen.getByTestId("trip-list-header")).getByText("Trips")).toHaveStyle({
      color: theme.color.text.primary,
      fontSize: theme.type.title.fontSize,
    });
  });

  it("boots dark from a persisted preference through the real adapters", async () => {
    themeStorage.set(STORAGE_KEYS.appearance, "dark");

    await render(
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        <TripListScreen />
      </ThemeProvider>,
    );

    const dark = getTheme(DEFAULT_THEME, "dark");
    const light = getTheme(DEFAULT_THEME, "light");
    // Guard: the assertion below is only meaningful if the schemes differ.
    expect(dark.color.bg.screen).not.toBe(light.color.bg.screen);
    expect(screen.getByTestId("trip-list-screen")).toHaveStyle({
      backgroundColor: dark.color.bg.screen,
    });
  });

  it("commits dark on the FIRST frame from a persisted preference (R-ds-4 no-flash)", async () => {
    themeStorage.set(STORAGE_KEYS.appearance, "dark");
    const seen: ("light" | "dark")[] = [];

    await render(
      <ThemeProvider storage={themeStorage} systemAppearance={systemAppearance}>
        <SchemeProbe seen={seen} />
        <TripListScreen />
      </ThemeProvider>,
    );

    // Not just "ends up dark" — dark from the very first committed frame.
    expect(seen[0]).toBe("dark");
  });
});
