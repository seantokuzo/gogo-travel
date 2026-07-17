/**
 * Registry completeness + buildTheme/getTheme contract (spec §2.7, R-ds-5).
 */
import { describe, expect, it } from "vitest";
import { buildTheme, getTheme, isThemeName } from "./build.js";
import { DEFAULT_THEME, THEME_NAMES, themes } from "./themes.js";
import type { ThemeName } from "./themes.js";
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

  // The FULL Gate-3 seed table from .specs/design-system/tokens.spec.md
  // § Resolved — 3 palettes x 15 slots = 45 approved values. The contrast
  // suite's rule is "fix by adjusting DERIVED stops, never approved seeds";
  // this table is what machine-enforces it: ANY seed edit fails loudly here.
  const GATE3_SEEDS: Record<
    ThemeName,
    {
      primary: Record<100 | 300 | 500 | 700 | 900, string>;
      accent: Record<100 | 500 | 700, string>;
      lightBg: string;
      lightInk: string;
      darkBg: string;
      darkCard: string;
      darkInk: string;
      darkPrimary: string;
      darkAccent: string;
    }
  > = {
    goldenHour: {
      primary: { 100: "#FBE3DD", 300: "#F3A795", 500: "#D64933", 700: "#A83322", 900: "#6E2113" },
      accent: { 100: "#FDEED3", 500: "#E8A33D", 700: "#9C6716" },
      lightBg: "#FBF6F0",
      lightInk: "#2A211C",
      darkBg: "#201915",
      darkCard: "#2B221D",
      darkInk: "#F4EBE3",
      darkPrimary: "#E96A50",
      darkAccent: "#EFB35B",
    },
    deepWaters: {
      primary: { 100: "#D9ECEC", 300: "#7CC2BF", 500: "#0E6E6B", 700: "#0A4F4D", 900: "#063230" },
      accent: { 100: "#FDE8D4", 500: "#EE8B3A", 700: "#A85A14" },
      lightBg: "#F4F7F7",
      lightInk: "#16262A",
      darkBg: "#0E1618",
      darkCard: "#162226",
      darkInk: "#E9F1F1",
      darkPrimary: "#2FA8A0",
      darkAccent: "#F2A45E",
    },
    midnightExpress: {
      primary: { 100: "#DEE3F2", 300: "#93A3CE", 500: "#2B3A67", 700: "#1F2B4E", 900: "#131B33" },
      accent: { 100: "#F3E7CD", 500: "#C9994B", 700: "#8A6524" },
      lightBg: "#F7F4EC",
      lightInk: "#1F2437",
      darkBg: "#131729",
      darkCard: "#1C2138",
      darkInk: "#EDEEF5",
      darkPrimary: "#5D74B8",
      darkAccent: "#D4A95C",
    },
  };

  for (const name of THEME_NAMES) {
    it(`${name}: all 15 approved seeds are preserved exactly (never adjusted)`, () => {
      const seeds = GATE3_SEEDS[name];
      const palette = themes[name];
      for (const [stop, hex] of Object.entries(seeds.primary)) {
        expect(palette.ramps.primary[Number(stop) as RampStep], `${name}.primary[${stop}]`).toBe(
          hex,
        );
      }
      for (const [stop, hex] of Object.entries(seeds.accent)) {
        expect(palette.ramps.accent[Number(stop) as RampStep], `${name}.accent[${stop}]`).toBe(hex);
      }
      expect(palette.semantics.light.bg.screen, `${name} light bg`).toBe(seeds.lightBg);
      expect(palette.semantics.light.text.primary, `${name} light ink`).toBe(seeds.lightInk);
      expect(palette.semantics.dark.bg.screen, `${name} dark bg`).toBe(seeds.darkBg);
      expect(palette.semantics.dark.bg.surface, `${name} dark card`).toBe(seeds.darkCard);
      expect(palette.semantics.dark.text.primary, `${name} dark ink`).toBe(seeds.darkInk);
      expect(palette.semantics.dark.primary.solid, `${name} dark primary`).toBe(seeds.darkPrimary);
      expect(palette.semantics.dark.accent.solid, `${name} dark accent`).toBe(seeds.darkAccent);
    });
  }

  it("the registry and THEME_NAMES are frozen (isThemeName gate can't widen at runtime)", () => {
    expect(Object.isFrozen(themes)).toBe(true);
    expect(Object.isFrozen(THEME_NAMES)).toBe(true);
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
