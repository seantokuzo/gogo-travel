/**
 * @gogo/tokens — design tokens + theme definitions.
 *
 * This root entry is platform-agnostic PURE DATA + pure functions: no React,
 * no react-native, no I/O (R-shared-9 discipline). The React runtime binding
 * (ThemeProvider / useTheme / createStyles) lives in the `@gogo/tokens/react`
 * subpath so data-only consumers (server, tests, tools) never touch React.
 */

// types
export type {
  AppearancePref,
  ColorRamp,
  ColorSchemeName,
  EasingBezier,
  ElevationLevel,
  ElevationStyle,
  HapticCall,
  HapticEvent,
  Insets,
  Motion,
  PaletteDef,
  RadiusKey,
  RadiusScale,
  RampStep,
  SemanticColors,
  SolidGroup,
  SpaceKey,
  SpaceScale,
  StatusTone,
  Theme,
  ThemeRamps,
  TypeRole,
  TypeStyle,
} from "./types.js";

// scales (spec §2.3–§2.8)
export {
  elevation,
  hapticEvents,
  hitSlop,
  motion,
  radius,
  space,
  touchTarget,
  typeScale,
} from "./scales.js";

// shared status ramps (spec §2.2 layer 1)
export { dangerRamp, infoRamp, successRamp, warningRamp } from "./ramps.js";

// theme registry (Gate-3: all palettes user-selectable)
export { DEFAULT_THEME, THEME_NAMES, themes } from "./themes.js";
export type { ThemeName } from "./themes.js";

// theme composition
export { buildTheme, getTheme, isThemeName } from "./build.js";
