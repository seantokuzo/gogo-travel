// @vitest-environment jsdom
/**
 * ThemeProvider / useTheme contract (spec §2.7; R-ds-1..4, R-ds-6).
 * Persistence + OS appearance are injected fakes — the same seams the app
 * fills with MMKV and RN `Appearance` in T-4.2.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTheme } from "../build.js";
import { STORAGE_KEYS, ThemeProvider, useTheme } from "./context.js";
import type {
  SystemAppearanceSource,
  ThemeContextValue,
  ThemeProviderProps,
  ThemeStorage,
} from "./context.js";
import type { ColorSchemeName } from "../types.js";

afterEach(cleanup);

// ------------------------------------------------------------ fakes

function fakeStorage(seed: Record<string, string> = {}): ThemeStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getString: (key) => data.get(key),
    set: (key, value) => {
      data.set(key, value);
    },
  };
}

function fakeSystem(initial: ColorSchemeName | null): SystemAppearanceSource & {
  emit(scheme: ColorSchemeName | null): void;
} {
  let current = initial;
  const listeners = new Set<(s: ColorSchemeName | null | undefined) => void>();
  return {
    getColorScheme: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(scheme) {
      current = scheme;
      for (const l of listeners) l(scheme);
    },
  };
}

/** Render a probe under the provider and capture every context value seen. */
function mount(props: Omit<ThemeProviderProps, "children"> = {}) {
  const seen: ThemeContextValue[] = [];
  function Probe() {
    seen.push(useTheme());
    return null;
  }
  render(createElement(ThemeProvider, props, createElement(Probe)));
  const latest = () => {
    const value = seen[seen.length - 1];
    if (!value) throw new Error("probe never rendered");
    return value;
  };
  return { seen, latest };
}

// ------------------------------------------------------------ tests

describe("ThemeProvider boot resolution", () => {
  it("R-ds-1: no persisted pref → resolves from the OS scheme", () => {
    const { latest } = mount({ systemAppearance: fakeSystem("dark") });
    expect(latest().scheme).toBe("dark");
    expect(latest().appearancePref).toBe("system");
    expect(latest().accentName).toBe("goldenHour"); // DEFAULT_THEME
  });

  it("R-ds-4: persisted values resolve in the FIRST render (no flash)", () => {
    const storage = fakeStorage({
      [STORAGE_KEYS.appearance]: "dark",
      [STORAGE_KEYS.accentTheme]: "deepWaters",
    });
    const { seen } = mount({ storage, systemAppearance: fakeSystem("light") });
    // the very first committed frame is already dark deepWaters
    expect(seen[0]?.scheme).toBe("dark");
    expect(seen[0]?.accentName).toBe("deepWaters");
    expect(seen[0]?.theme).toBe(getTheme("deepWaters", "dark"));
  });

  it("falls back safely on corrupt/stale persisted values", () => {
    const storage = fakeStorage({
      [STORAGE_KEYS.appearance]: "disco",
      [STORAGE_KEYS.accentTheme]: "removedPalette",
    });
    const { latest } = mount({ storage });
    expect(latest().appearancePref).toBe("system");
    expect(latest().accentName).toBe("goldenHour");
  });

  it("no injected system source → `system` resolves light", () => {
    const { latest } = mount({});
    expect(latest().scheme).toBe("light");
  });
});

describe("appearance preference (R-ds-2, R-ds-3)", () => {
  it("setAppearancePref applies immediately and persists", () => {
    const storage = fakeStorage();
    const { latest } = mount({ storage });
    act(() => latest().setAppearancePref("dark"));
    expect(latest().scheme).toBe("dark");
    expect(latest().appearancePref).toBe("dark");
    expect(storage.data.get(STORAGE_KEYS.appearance)).toBe("dark");
  });

  it("R-ds-3: OS change re-renders while pref is `system`", () => {
    const system = fakeSystem("light");
    const { latest } = mount({ systemAppearance: system });
    expect(latest().scheme).toBe("light");
    act(() => system.emit("dark"));
    expect(latest().scheme).toBe("dark");
    expect(latest().theme).toBe(getTheme("goldenHour", "dark"));
  });

  it("manual pref wins over OS changes; returning to `system` follows again", () => {
    const system = fakeSystem("light");
    const storage = fakeStorage();
    const { latest } = mount({ storage, systemAppearance: system });
    act(() => latest().setAppearancePref("light"));
    act(() => system.emit("dark"));
    expect(latest().scheme).toBe("light"); // pinned
    act(() => latest().setAppearancePref("system"));
    expect(latest().scheme).toBe("dark"); // follows OS again
  });
});

describe("accent theme (R-ds-6)", () => {
  it("setAccentName swaps the resolved theme immediately and persists", () => {
    const storage = fakeStorage();
    const { latest } = mount({ storage });
    act(() => latest().setAccentName("midnightExpress"));
    expect(latest().accentName).toBe("midnightExpress");
    expect(latest().theme).toBe(getTheme("midnightExpress", "light"));
    expect(storage.data.get(STORAGE_KEYS.accentTheme)).toBe("midnightExpress");
  });

  it("unknown accent names are ignored (registry is the source of truth)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const storage = fakeStorage();
      const { latest } = mount({ storage });
      act(() => latest().setAccentName("neonVaporwave"));
      expect(latest().accentName).toBe("goldenHour");
      expect(storage.data.has(STORAGE_KEYS.accentTheme)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("context value stability (spec §2.7)", () => {
  it("theme references are stable per (scheme, accent) across toggles", () => {
    const { latest } = mount({});
    const lightGolden = latest().theme;
    act(() => latest().setAppearancePref("dark"));
    const darkGolden = latest().theme;
    expect(darkGolden).not.toBe(lightGolden);
    act(() => latest().setAppearancePref("light"));
    expect(latest().theme).toBe(lightGolden); // same frozen object again
    expect(darkGolden).toBe(getTheme("goldenHour", "dark"));
  });
});

describe("useTheme outside a provider", () => {
  it("throws a descriptive error", () => {
    function Naked() {
      useTheme();
      return null;
    }
    expect(() => render(createElement(Naked))).toThrow(
      /useTheme must be used within a <ThemeProvider>/,
    );
  });
});
