// @vitest-environment jsdom
/**
 * createStyles caching contract (R-ds-7, spec §2.7): factories run once per
 * Theme object, results are referentially stable per theme, and switching
 * back to a previously seen theme reuses the cached result via WeakMap.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../types.js";
import { ThemeProvider, useTheme } from "./context.js";
import type { ThemeContextValue } from "./context.js";
import { createStyles } from "./createStyles.js";

afterEach(cleanup);

interface Harness<T> {
  results: T[];
  ctx: () => ThemeContextValue;
  rerenderSame: () => void;
}

/** Mount a component consuming `useStyles`, capturing results + context. */
function mountWith<T>(useStyles: () => T): Harness<T> {
  const results: T[] = [];
  let captured: ThemeContextValue | undefined;
  function Consumer() {
    captured = useTheme();
    results.push(useStyles());
    return null;
  }
  // Fresh elements each time — reusing one element object would let React
  // bail out on element identity and skip the re-render entirely.
  const ui = () => createElement(ThemeProvider, {}, createElement(Consumer));
  const { rerender } = render(ui());
  return {
    results,
    ctx: () => {
      if (!captured) throw new Error("consumer never rendered");
      return captured;
    },
    rerenderSame: () => rerender(ui()),
  };
}

describe("createStyles", () => {
  it("returns referentially stable styles across re-renders of one theme", () => {
    const factory = vi.fn((t: Theme) => ({
      container: { backgroundColor: t.color.bg.screen, padding: t.space[4] },
    }));
    const useStyles = createStyles(factory);
    const h = mountWith(useStyles);
    h.rerenderSame();
    h.rerenderSame();
    expect(h.results.length).toBeGreaterThanOrEqual(3);
    expect(factory).toHaveBeenCalledTimes(1); // once per theme, not per render
    for (const styles of h.results) {
      expect(styles).toBe(h.results[0]);
    }
  });

  it("recomputes for a new theme, then serves the cache when it returns", () => {
    const factory = vi.fn((t: Theme) => ({
      title: { color: t.color.text.primary },
    }));
    const useStyles = createStyles(factory);
    const h = mountWith(useStyles);
    const lightStyles = h.results[0];
    expect(lightStyles?.title.color).toBe("#2A211C"); // goldenHour light ink

    act(() => h.ctx().setAppearancePref("dark"));
    const darkStyles = h.results[h.results.length - 1];
    expect(darkStyles).not.toBe(lightStyles);
    expect(darkStyles?.title.color).toBe("#F4EBE3"); // goldenHour dark ink
    expect(factory).toHaveBeenCalledTimes(2);

    act(() => h.ctx().setAppearancePref("light"));
    expect(h.results[h.results.length - 1]).toBe(lightStyles); // WeakMap hit
    expect(factory).toHaveBeenCalledTimes(2); // no third run
  });

  it("recomputes when the accent palette changes (R-ds-6)", () => {
    const factory = vi.fn((t: Theme) => ({
      button: { backgroundColor: t.color.primary.solid },
    }));
    const useStyles = createStyles(factory);
    const h = mountWith(useStyles);
    const golden = h.results[0];
    act(() => h.ctx().setAccentName("deepWaters"));
    const deep = h.results[h.results.length - 1];
    expect(deep).not.toBe(golden);
    expect(deep?.button.backgroundColor).not.toBe(golden?.button.backgroundColor);
  });

  it("caches are independent per createStyles call-site", () => {
    const factoryA = vi.fn((t: Theme) => ({ a: { padding: t.space[2] } }));
    const factoryB = vi.fn((t: Theme) => ({ b: { padding: t.space[4] } }));
    const useA = createStyles(factoryA);
    const useB = createStyles(factoryB);
    function Consumer() {
      useA();
      useB();
      return null;
    }
    render(createElement(ThemeProvider, {}, createElement(Consumer)));
    expect(factoryA).toHaveBeenCalledTimes(1);
    expect(factoryB).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved frozen Theme to the factory", () => {
    let received: Theme | undefined;
    const useStyles = createStyles((t: Theme) => {
      received = t;
      return {};
    });
    mountWith(useStyles);
    expect(received?.name).toBe("goldenHour-light");
    expect(Object.isFrozen(received)).toBe(true);
  });
});
