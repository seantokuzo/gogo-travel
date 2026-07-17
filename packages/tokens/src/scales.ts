/**
 * @gogo/tokens — non-color scales: space, radius, typography, elevation,
 * motion, touch, haptics (spec §2.3–§2.8). Scheme-independent except
 * elevation, which ships a light and a dark set (§2.5: dark drops shadow
 * opacity and leans on surface separation instead).
 */
import type {
  ColorSchemeName,
  ElevationLevel,
  ElevationStyle,
  HapticCall,
  HapticEvent,
  Insets,
  Motion,
  RadiusScale,
  SpaceScale,
  TypeRole,
  TypeStyle,
} from "./types.js";

// ---------------------------------------------------------------- spacing

/** 4-pt grid — key × 4 = pt. Screen gutter convention: space[4] (16). */
export const space: SpaceScale = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
};

/** Cards/inputs `md`, sheets `xl` (top corners), badges/avatars `full`. */
export const radius: RadiusScale = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 999,
};

// ---------------------------------------------------------------- touch

/** Minimum interactive hit target in pt (R-ds-9). */
export const touchTarget = 44;

/** Standard hitSlop presets for visually-small controls (spec §2.4). */
export const hitSlop: { sm: Insets; md: Insets } = {
  sm: { top: 8, bottom: 8, left: 8, right: 8 },
  md: { top: 12, bottom: 12, left: 12, right: 12 },
};

// ---------------------------------------------------------------- typography

/**
 * Role-based type scale (spec §2.3). `fontFamily` is intentionally omitted:
 * system fonts v1 (SF Pro / Roboto via platform default). Components never
 * set raw font sizes.
 */
export const typeScale: Record<TypeRole, TypeStyle> = {
  display: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "800",
    maxFontSizeMultiplier: 1.4,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    maxFontSizeMultiplier: 1.5,
  },
  heading: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "600",
    maxFontSizeMultiplier: 1.6,
  },
  subheading: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    maxFontSizeMultiplier: 1.8,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "400",
    maxFontSizeMultiplier: 2.0,
  },
  bodyStrong: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "600",
    maxFontSizeMultiplier: 2.0,
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "400",
    maxFontSizeMultiplier: 2.0,
  },
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "600",
    letterSpacing: 0.4,
    maxFontSizeMultiplier: 1.6,
  },
  mono: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    maxFontSizeMultiplier: 2.0,
  },
};

// ---------------------------------------------------------------- elevation

// levels: 0 none · 1 card · 2 raised card / FAB · 3 sheet · 4 dialog
const elevationLight: Record<ElevationLevel, ElevationStyle> = {
  0: {
    shadowColor: "#000000",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  1: {
    shadowColor: "#000000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  2: {
    shadowColor: "#000000",
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  3: {
    shadowColor: "#000000",
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  4: {
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
};

// Dark scheme: shadows read poorly on dark — opacity drops (~0.5×); surface
// tone separation (bg.surface vs bg.surfaceRaised) does the visual work.
const elevationDark: Record<ElevationLevel, ElevationStyle> = {
  0: {
    shadowColor: "#000000",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  1: {
    shadowColor: "#000000",
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  2: {
    shadowColor: "#000000",
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  3: {
    shadowColor: "#000000",
    shadowOpacity: 0.07,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  4: {
    shadowColor: "#000000",
    shadowOpacity: 0.09,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
};

export const elevation: Record<ColorSchemeName, Record<ElevationLevel, ElevationStyle>> = {
  light: elevationLight,
  dark: elevationDark,
};

// ---------------------------------------------------------------- motion

export const motion: Motion = {
  duration: { fast: 120, base: 200, slow: 300, shimmer: 1200 },
  easing: {
    standard: [0.2, 0, 0, 1],
    decelerate: [0, 0, 0.2, 1],
    accelerate: [0.3, 0, 1, 1],
  },
  spring: {
    sheet: { damping: 30, stiffness: 300 },
  },
};

// ---------------------------------------------------------------- haptics

/**
 * Semantic haptic event → abstract call (spec §2.8 convention table).
 * DS-6 wraps these onto expo-haptics in the app; components reference
 * events, never raw calls. Rules: never on scroll, never on push/pop
 * navigation, max one per user action.
 */
export const hapticEvents: Record<HapticEvent, HapticCall> = {
  selection: "selection",
  actionLight: "impactLight",
  dragLift: "impactMedium",
  dragDrop: "impactLight",
  success: "notificationSuccess",
  warning: "notificationWarning",
  error: "notificationError",
};
