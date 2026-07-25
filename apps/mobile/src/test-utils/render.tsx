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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";

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

/**
 * A throwaway QueryClient for component tests — retries OFF so a rejected
 * network mock settles to `error` immediately (no backoff timers to advance).
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    // retry off → a rejected mock settles to `error` with no backoff timer;
    // gcTime 0 → no lingering GC timeout keeps jest from exiting cleanly.
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

/**
 * Component-test harness for screens that read server state — wraps both the
 * QueryClientProvider (fresh test client unless one is passed) and the ephemeral
 * ThemeProvider.
 */
export function renderWithProviders(
  ui: ReactElement,
  opts?: { scheme?: ColorSchemeName; accent?: ThemeName; queryClient?: QueryClient },
) {
  const client = opts?.queryClient ?? makeTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ThemeProvider
          defaultAppearancePref={opts?.scheme ?? "light"}
          defaultAccentName={opts?.accent}
        >
          {children}
        </ThemeProvider>
      </QueryClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

/** The default assertion theme — goldenHour light, same object getTheme memoizes. */
export const lightTheme = getTheme(DEFAULT_THEME, "light");
export const darkTheme = getTheme(DEFAULT_THEME, "dark");
