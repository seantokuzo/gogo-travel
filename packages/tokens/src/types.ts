/**
 * @gogo/tokens — all exported TypeScript types.
 *
 * Contract: .specs/design-system/tokens.spec.md §2. Platform-agnostic —
 * no react/react-native imports anywhere in this module (R-shared-9 style).
 */

// ---------------------------------------------------------------- color

export type RampStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

/** 11-step color ramp, hex values (spec §2.2 layer 1). */
export type ColorRamp = Record<RampStep, string>;

export type StatusTone = "success" | "warning" | "danger" | "info";

/**
 * A solid-fill token group (buttons, pills). `onSolid` is validated ≥ 4.5:1
 * against `solid` AND `solidPressed` by the R-ds-8 contrast matrix.
 */
export interface SolidGroup {
  solid: string;
  solidPressed: string;
  /** Tinted container fill — opaque hex in light, 8-digit translucent in dark. */
  subtleBg: string;
  subtleBorder: string;
  onSolid: string;
}

/**
 * Semantic color tokens — components consume ONLY these (spec §2.2 layer 2).
 *
 * Post-Gate-3 superset: every palette ships BOTH a `primary` ramp (brand
 * color) and an `accent` ramp (secondary highlight), so the semantic set
 * carries both solid groups (`primary`/`accent`) plus mirrored ink tokens
 * (`text.onPrimary`/`text.onAccent`).
 */
export interface SemanticColors {
  bg: {
    /** Screen background. */
    screen: string;
    /** Cards / sheets. */
    surface: string;
    /** Elevated sheets / dialogs. */
    surfaceRaised: string;
    /** Inputs, wells. */
    inset: string;
    /** Modal backdrop — 8-digit hex with alpha. */
    scrim: string;
  };
  text: {
    primary: string;
    secondary: string;
    /** Must pass 4.5:1 on every bg surface (validated by contrast matrix). */
    muted: string;
    /** Ink for opposite-scheme chips/toasts. */
    inverse: string;
    /** = primary.onSolid. */
    onPrimary: string;
    /** = accent.onSolid. */
    onAccent: string;
    /** Links / active tint. */
    accent: string;
  };
  border: {
    subtle: string;
    default: string;
    /** ≥ 3:1 vs surfaces (WCAG 1.4.11 non-text). */
    strong: string;
    /** Focus indicator — ≥ 3:1 vs surfaces. */
    focus: string;
  };
  primary: SolidGroup;
  accent: SolidGroup;
  status: Record<StatusTone, { fg: string; bg: string; border: string }>;
  interactive: {
    /** 8-digit hex overlay for pressed feedback. */
    pressedOverlay: string;
    /** Disabled fills/inks are exempt from AA (WCAG 1.4.3 exception). */
    disabledBg: string;
    disabledText: string;
  };
}

/**
 * A complete user-selectable palette — PURE DATA (R-ds-5). Adding a palette
 * is one data file conforming to this shape + one registry line; anything
 * more is a design-system bug.
 *
 * Semantic sets are fully materialized at authoring time (derived from the
 * approved seed table + WCAG-AA fix-loop) rather than mapped from ramp stops
 * at runtime — the R-ds-8 contrast matrix is the validator for additions.
 */
export interface PaletteDef {
  /** Stable registry key, camelCase (e.g. "goldenHour"). */
  name: string;
  /** Display name for the settings picker. */
  label: string;
  ramps: {
    neutral: ColorRamp;
    primary: ColorRamp;
    accent: ColorRamp;
  };
  semantics: {
    light: SemanticColors;
    dark: SemanticColors;
  };
}

// ---------------------------------------------------------------- typography

export type TypeRole =
  | "display"
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "bodyStrong"
  | "caption"
  | "label"
  | "mono";

export interface TypeStyle {
  /**
   * System fonts v1 (Gate 2): omitted ⇒ platform default (SF Pro / Roboto).
   * A custom font pair is a later, additive upgrade through this seam.
   */
  fontFamily?: string;
  /** pt */
  fontSize: number;
  /** pt */
  lineHeight: number;
  fontWeight: "400" | "500" | "600" | "700" | "800";
  letterSpacing?: number;
  /** Dynamic Type cap per role (R-ds-10). */
  maxFontSizeMultiplier: number;
}

// ---------------------------------------------------------------- scales

/** 4-pt grid: key × 4 = pt (spec §2.4). */
export type SpaceKey = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
export type SpaceScale = Record<SpaceKey, number>;

export type RadiusKey = "none" | "sm" | "md" | "lg" | "xl" | "full";
export type RadiusScale = Record<RadiusKey, number>;

export type ElevationLevel = 0 | 1 | 2 | 3 | 4;

/** Ready-to-spread: iOS shadow props + Android elevation (spec §2.5). */
export interface ElevationStyle {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  /** Android */
  elevation: number;
}

/** cubic-bezier control points [x1, y1, x2, y2] — animation-lib-agnostic. */
export type EasingBezier = readonly [number, number, number, number];

export interface Motion {
  duration: {
    /** Pressed feedback. */
    fast: number;
    /** Screen/sheet transitions (with `slow`). */
    base: number;
    slow: number;
    /** Skeleton shimmer loop (spec §2.6 convention). */
    shimmer: number;
  };
  easing: {
    standard: EasingBezier;
    decelerate: EasingBezier;
    accelerate: EasingBezier;
  };
  spring: {
    sheet: { damping: number; stiffness: number };
  };
}

/** Local twin of react-native's Insets — tokens stay RN-free. */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// ---------------------------------------------------------------- haptics

/** Semantic haptic events (spec §2.8) — components reference events only. */
export type HapticEvent =
  "selection" | "actionLight" | "dragLift" | "dragDrop" | "success" | "warning" | "error";

/** Abstract call names — DS-6 maps these onto expo-haptics app-side. */
export type HapticCall =
  | "selection"
  | "impactLight"
  | "impactMedium"
  | "notificationSuccess"
  | "notificationWarning"
  | "notificationError";

// ---------------------------------------------------------------- theme

export type ColorSchemeName = "light" | "dark";
export type AppearancePref = "system" | "light" | "dark";

export interface ThemeRamps {
  neutral: ColorRamp;
  primary: ColorRamp;
  accent: ColorRamp;
  success: ColorRamp;
  warning: ColorRamp;
  danger: ColorRamp;
  info: ColorRamp;
}

/** Resolved, frozen theme (spec §2.7) — referentially stable per (scheme, accent). */
export interface Theme {
  /** `${accent}-${scheme}` */
  name: string;
  scheme: ColorSchemeName;
  /** Accent palette key. */
  accent: string;
  color: SemanticColors;
  ramp: ThemeRamps;
  type: Record<TypeRole, TypeStyle>;
  space: SpaceScale;
  radius: RadiusScale;
  elevation: Record<ElevationLevel, ElevationStyle>;
  motion: Motion;
  /** 44 pt minimum hit target (R-ds-9). */
  touchTarget: number;
  hitSlop: { sm: Insets; md: Insets };
}
