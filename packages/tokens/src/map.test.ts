/**
 * mapColors / mapDayColors contract (map spec §2.2; tokens spec §2.10
 * delegation). Pins both the spec'd shape (8 ordered scheme-tuned day
 * colors, every map color theme-derived — R-map-7 "no literal colors") and
 * the T-8.6 interpretation (day colors draw only from the shared status
 * ramps; accent/primary/neutral stay reserved for saved/cluster/photo pin
 * semantics).
 */
import { describe, expect, it } from "vitest";
import { getTheme } from "./build.js";
import { mapColors, mapDayColors } from "./map.js";
import { THEME_NAMES } from "./themes.js";
import type { ColorRamp, Theme } from "./types.js";

const HEX6 = /^#[0-9A-F]{6}$/i;
const SCHEMES = ["light", "dark"] as const;

const forEachTheme = (fn: (theme: Theme, label: string) => void): void => {
  for (const name of THEME_NAMES) {
    for (const scheme of SCHEMES) {
      fn(getTheme(name, scheme), `${name} × ${scheme}`);
    }
  }
};

const rampValues = (...ramps: ColorRamp[]): Set<string> =>
  new Set(ramps.flatMap((ramp) => Object.values(ramp)));

describe("mapDayColors (map spec §2.2)", () => {
  it("returns exactly 8 valid, distinct hex colors for every theme", () => {
    forEachTheme((theme, label) => {
      const colors = mapDayColors(theme);
      expect(colors, label).toHaveLength(8);
      for (const color of colors) {
        expect(color, label).toMatch(HEX6);
      }
      expect(new Set(colors).size, `${label}: day colors must be distinct`).toBe(8);
    });
  });

  it("every day color is drawn from the theme's status ramps — never a literal", () => {
    forEachTheme((theme, label) => {
      const statusValues = rampValues(
        theme.ramp.info,
        theme.ramp.success,
        theme.ramp.warning,
        theme.ramp.danger,
      );
      for (const [index, color] of mapDayColors(theme).entries()) {
        expect(
          statusValues.has(color),
          `${label}: dayColors[${index}] = ${color} is not a status-ramp value`,
        ).toBe(true);
      }
    });
  });

  it("never borrows the reserved pin families (accent = saved, neutral = photo, primary = cluster/selected)", () => {
    forEachTheme((theme, label) => {
      const reserved = rampValues(theme.ramp.accent, theme.ramp.neutral, theme.ramp.primary);
      const { pinSaved, pinPhotoRing, pinSelectedRing, clusterFill } = mapColors(theme);
      for (const marker of [pinSaved, pinPhotoRing, pinSelectedRing, clusterFill]) {
        reserved.add(marker);
      }
      for (const [index, color] of mapDayColors(theme).entries()) {
        expect(
          reserved.has(color),
          `${label}: dayColors[${index}] = ${color} collides with a reserved pin family`,
        ).toBe(false);
      }
    });
  });

  it("is scheme-tuned: light and dark sequences differ", () => {
    for (const name of THEME_NAMES) {
      expect(mapDayColors(getTheme(name, "light"))).not.toEqual(
        mapDayColors(getTheme(name, "dark")),
      );
    }
  });

  it("pins the tuning DIRECTION: light = mid(500)/deep(800) stops, dark = mid(400)/soft(200) stops", () => {
    for (const name of THEME_NAMES) {
      const light = getTheme(name, "light");
      const dark = getTheme(name, "dark");
      const lightDays = mapDayColors(light);
      const darkDays = mapDayColors(dark);
      // Mid stops carry days 1–4 (info leads, success second)…
      expect(lightDays[0], `${name} × light: day 1 mid stop`).toBe(light.ramp.info[500]);
      expect(lightDays[1], `${name} × light: day 2 mid stop`).toBe(light.ramp.success[500]);
      expect(darkDays[0], `${name} × dark: day 1 mid stop`).toBe(dark.ramp.info[400]);
      expect(darkDays[1], `${name} × dark: day 2 mid stop`).toBe(dark.ramp.success[400]);
      // …days 5–8 are deepened (light) / softened (dark), never the reverse.
      expect(lightDays[4], `${name} × light: day 5 deep stop`).toBe(light.ramp.info[800]);
      expect(lightDays[5], `${name} × light: day 6 deep stop`).toBe(light.ramp.success[800]);
      expect(darkDays[4], `${name} × dark: day 5 soft stop`).toBe(dark.ramp.info[200]);
      expect(darkDays[5], `${name} × dark: day 6 soft stop`).toBe(dark.ramp.success[200]);
    }
  });

  it("is palette-invariant per scheme (status ramps are shared, so day identity survives accent switches)", () => {
    for (const scheme of SCHEMES) {
      const reference = mapDayColors(getTheme("goldenHour", scheme));
      for (const name of THEME_NAMES) {
        expect(mapDayColors(getTheme(name, scheme)), `${name} × ${scheme}`).toEqual(reference);
      }
    }
  });

  it("adjacent days (incl. the mod-8 wrap) never share a hue family", () => {
    forEachTheme((theme, label) => {
      const familyOf = (color: string): string => {
        for (const family of ["info", "success", "warning", "danger"] as const) {
          if (Object.values<string>(theme.ramp[family]).includes(color)) return family;
        }
        return "unknown";
      };
      const families = mapDayColors(theme).map(familyOf);
      for (let i = 0; i < families.length; i += 1) {
        const next = families[(i + 1) % families.length];
        expect(
          families[i],
          `${label}: day ${i + 1} and day ${((i + 1) % families.length) + 1} share a hue family`,
        ).not.toBe(next);
      }
    });
  });
});

describe("mapColors (map spec §2.2)", () => {
  it("every color is a valid hex and dimOpacity sits strictly inside (0, 1)", () => {
    forEachTheme((theme, label) => {
      const { dimOpacity, ...colors } = mapColors(theme);
      for (const [key, value] of Object.entries(colors)) {
        expect(value, `${label}: ${key}`).toMatch(HEX6);
      }
      expect(dimOpacity, label).toBeGreaterThan(0);
      expect(dimOpacity, label).toBeLessThan(1);
    });
  });

  it("traces every concern to its designated theme token", () => {
    forEachTheme((theme, label) => {
      const colors = mapColors(theme);
      // §2.2: saved-but-unscheduled pins = accent
      expect(colors.pinSaved, label).toBe(theme.color.accent.solid);
      // §2.2: photo pins = neutral ring
      expect(
        rampValues(theme.ramp.neutral).has(colors.pinPhotoRing),
        `${label}: pinPhotoRing must come from the neutral ramp`,
      ).toBe(true);
      // selected ring rides the AA-validated focus indicator
      expect(colors.pinSelectedRing, label).toBe(theme.color.border.focus);
      // cluster count ink rides the R-ds-8-validated onSolid/solid pairing
      expect(colors.clusterFill, label).toBe(theme.color.primary.solid);
      expect(colors.clusterText, label).toBe(theme.color.primary.onSolid);
      // route line (future §2.2 reservation) comes from the info ramp…
      expect(
        rampValues(theme.ramp.info).has(colors.routeLine),
        `${label}: routeLine must come from the info ramp`,
      ).toBe(true);
      // …but never collides with a day stop (a route must not read as a day)
      expect(mapDayColors(theme), label).not.toContain(colors.routeLine);
    });
  });
});

describe("stability", () => {
  it("outputs are frozen and referentially stable per Theme (WeakMap memo)", () => {
    forEachTheme((theme, label) => {
      expect(mapColors(theme), label).toBe(mapColors(theme));
      expect(mapDayColors(theme), label).toBe(mapDayColors(theme));
      expect(Object.isFrozen(mapColors(theme)), label).toBe(true);
      expect(Object.isFrozen(mapDayColors(theme)), label).toBe(true);
    });
  });

  it("distinct themes get distinct outputs", () => {
    expect(mapColors(getTheme("goldenHour", "light"))).not.toBe(
      mapColors(getTheme("goldenHour", "dark")),
    );
    expect(mapDayColors(getTheme("goldenHour", "light"))).not.toBe(
      mapDayColors(getTheme("goldenHour", "dark")),
    );
  });
});
