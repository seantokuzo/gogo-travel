/**
 * buildTheme(scheme, palette) → frozen Theme (spec §2.7).
 *
 * Pure composition: palette data + shared scales + status ramps. `getTheme`
 * memoizes per (accent, scheme) so context consumers can rely on reference
 * equality — and so `createStyles`' WeakMap cache holds across re-renders.
 */
import { dangerRamp, infoRamp, successRamp, warningRamp } from "./ramps.js";
import { elevation, hitSlop, motion, radius, space, touchTarget, typeScale } from "./scales.js";
import { themes } from "./themes.js";
import type { ThemeName } from "./themes.js";
import type { ColorSchemeName, PaletteDef, Theme } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** Type guard for registry membership (persisted values, wire input). */
export function isThemeName(value: string): value is ThemeName {
  return Object.prototype.hasOwnProperty.call(themes, value);
}

/**
 * Compose a frozen Theme from any PaletteDef — works for unregistered
 * palettes too (tests, previews). Not cached; prefer `getTheme` at runtime.
 */
export function buildTheme(scheme: ColorSchemeName, palette: PaletteDef): Theme {
  return deepFreeze<Theme>({
    name: `${palette.name}-${scheme}`,
    scheme,
    accent: palette.name,
    color: palette.semantics[scheme],
    ramp: {
      neutral: palette.ramps.neutral,
      primary: palette.ramps.primary,
      accent: palette.ramps.accent,
      success: successRamp,
      warning: warningRamp,
      danger: dangerRamp,
      info: infoRamp,
    },
    type: typeScale,
    space,
    radius,
    elevation: elevation[scheme],
    motion,
    touchTarget,
    hitSlop,
  });
}

const themeCache = new Map<string, Theme>();

/**
 * Registry lookup with per-(accent, scheme) memoization — the runtime entry
 * point. Referentially stable: same inputs always return the SAME object.
 */
export function getTheme(accent: ThemeName, scheme: ColorSchemeName): Theme {
  const key = `${accent}-${scheme}`;
  let theme = themeCache.get(key);
  if (!theme) {
    theme = buildTheme(scheme, themes[accent]);
    themeCache.set(key, theme);
  }
  return theme;
}
