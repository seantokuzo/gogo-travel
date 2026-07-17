/**
 * Registry completeness + buildTheme/getTheme contract (spec §2.7, R-ds-5).
 */
import { describe, expect, it } from "vitest";
import { buildTheme, getTheme, isThemeName } from "./build.js";
import { DEFAULT_THEME, THEME_NAMES, themes } from "./themes.js";
import type { ColorRamp, RampStep } from "./types.js";

const RAMP_STOPS: readonly RampStep[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const HEX6 = /^#[0-9A-F]{6}$/i;

describe("theme registry", () => {
  it("ships exactly the three Gate-3 palettes", () => {
    expect(THEME_NAMES).toEqual(["goldenHour", "deepWaters", "midnightExpress"]);
  });

  it("defaults to goldenHour and the default is registered", () => {
    expect(DEFAULT_THEME).toBe("goldenHour");
    expect(themes[DEFAULT_THEME]).toBeDefined();
  });

  it("every palette's name matches its registry key and has a label", () => {
    for (const name of THEME_NAMES) {
      expect(themes[name].name).toBe(name);
      expect(themes[name].label.length).toBeGreaterThan(0);
    }
  });

  it("every palette carries full 11-stop ramps of valid hex", () => {
    for (const name of THEME_NAMES) {
      for (const rampName of ["neutral", "primary", "accent"] as const) {
        const ramp: ColorRamp = themes[name].ramps[rampName];
        for (const stop of RAMP_STOPS) {
          expect(ramp[stop], `${name}.${rampName}[${stop}]`).toMatch(HEX6);
        }
      }
    }
  });

  it("approved seed values are preserved exactly (never adjusted)", () => {
    // Spot-check the spec's seed table (Gate 3) against shipped data.
    expect(themes.goldenHour.ramps.primary[500]).toBe("#D64933");
    expect(themes.goldenHour.ramps.accent[500]).toBe("#E8A33D");
    expect(themes.goldenHour.semantics.light.bg.screen).toBe("#FBF6F0");
    expect(themes.goldenHour.semantics.dark.bg.surface).toBe("#2B221D");
    expect(themes.goldenHour.semantics.dark.primary.solid).toBe("#E96A50");
    expect(themes.deepWaters.ramps.primary[500]).toBe("#0E6E6B");
    expect(themes.deepWaters.semantics.dark.bg.screen).toBe("#0E1618");
    expect(themes.midnightExpress.ramps.primary[700]).toBe("#1F2B4E");
    expect(themes.midnightExpress.semantics.dark.accent.solid).toBe("#D4A95C");
  });

  it("isThemeName guards registry membership (incl. prototype keys)", () => {
    expect(isThemeName("goldenHour")).toBe(true);
    expect(isThemeName("neonVaporwave")).toBe(false);
    expect(isThemeName("toString")).toBe(false);
  });
});

describe("buildTheme / getTheme", () => {
  it("composes name, scheme, accent, and scheme-matched semantics", () => {
    const theme = buildTheme("dark", themes.deepWaters);
    expect(theme.name).toBe("deepWaters-dark");
    expect(theme.scheme).toBe("dark");
    expect(theme.accent).toBe("deepWaters");
    expect(theme.color).toBe(themes.deepWaters.semantics.dark);
    expect(theme.ramp.accent).toBe(themes.deepWaters.ramps.accent);
    expect(theme.ramp.success[500]).toMatch(HEX6);
    expect(theme.touchTarget).toBe(44);
  });

  it("themes are deeply frozen", () => {
    const theme = getTheme("goldenHour", "light");
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.color.text)).toBe(true);
    expect(Object.isFrozen(theme.type.body)).toBe(true);
    expect(() => {
      (theme.color.text as { primary: string }).primary = "#FF0000";
    }).toThrow(TypeError);
  });

  it("getTheme is referentially stable per (accent, scheme)", () => {
    for (const name of THEME_NAMES) {
      for (const scheme of ["light", "dark"] as const) {
        expect(getTheme(name, scheme)).toBe(getTheme(name, scheme));
      }
    }
    expect(getTheme("goldenHour", "light")).not.toBe(getTheme("goldenHour", "dark"));
    expect(getTheme("goldenHour", "light")).not.toBe(getTheme("deepWaters", "light"));
  });

  it("dark scheme drops shadow opacity vs light (spec §2.5)", () => {
    const light = getTheme("goldenHour", "light");
    const dark = getTheme("goldenHour", "dark");
    for (const level of [1, 2, 3, 4] as const) {
      expect(dark.elevation[level].shadowOpacity).toBeLessThan(
        light.elevation[level].shadowOpacity,
      );
    }
  });
});
