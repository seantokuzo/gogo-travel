/**
 * Accent theme registry (spec §2.2 layer 3, Gate-3 resolution).
 *
 * ALL palettes are user-selectable. Adding a palette = one pure-data file in
 * ./themes/ + ONE line in this record — nothing else (R-ds-5). `ThemeName`
 * derives from the record, so every consumer picks the new palette up for
 * free; the R-ds-8 contrast matrix test validates it at build.
 */
import type { PaletteDef } from "./types.js";
import { deepWaters } from "./themes/deepWaters.js";
import { goldenHour } from "./themes/goldenHour.js";
import { midnightExpress } from "./themes/midnightExpress.js";

// Frozen at module scope: the registry is the validation gate for persisted
// accent values (isThemeName) — `as const` is compile-time only, and a lazy
// per-palette freeze would leave the record itself mutable at runtime.
export const themes = Object.freeze({
  goldenHour,
  deepWaters,
  midnightExpress,
} as const satisfies Record<string, PaletteDef>);

export type ThemeName = keyof typeof themes;

export const THEME_NAMES: readonly ThemeName[] = Object.freeze(Object.keys(themes) as ThemeName[]);

/** First-launch default — one-line config, flippable anytime (Gate 3). */
export const DEFAULT_THEME = "goldenHour" satisfies ThemeName;
