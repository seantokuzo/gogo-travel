/* eslint-disable no-console -- authoring tool; the adjustment report IS its output */
/**
 * derive-ramps.mjs — authoring-time palette derivation for @gogo/tokens (T-4.1).
 *
 * NOT part of the build and never shipped: `"files": ["dist"]` excludes
 * scripts/ from the published package, tsconfig(.build) includes src/ only,
 * and culori is deliberately NOT a dependency (the shipped package has zero
 * runtime deps). Re-run only when adding a palette or changing the recipe.
 *
 * INPUTS
 *   Seed table: .specs/design-system/tokens.spec.md § Resolved (Gate 3) —
 *   per palette: primary 100/300/500/700/900, accent 100/500/700, light
 *   bg/ink, dark bg/card/ink, dark primary/accent (15 seeds x 3 palettes),
 *   mirrored into the `palettes` record below. Status-hue seeds (spec §2.2
 *   hue families, shared across palettes) live in `statusSeeds`.
 *
 * OUTPUTS (written under the cwd)
 *   out/<palette>.ts    → body of src/themes/<palette>.ts (when pasting, add
 *                         the file header, `import type { PaletteDef }`, and
 *                         the `: PaletteDef` annotation)
 *   out/status-ramps.ts → body of src/ramps.ts
 *   stdout              → adjustment report: every derived value moved to
 *                         reach AA, before → after (seeds NEVER move)
 *
 * INTERPOLATION PARAMS (all mixing in OKLCH via culori 4.0.2, chroma-clamped)
 *   primary ramp  200/400/600/800 = midpoint mix of the flanking seeds;
 *                 50 = mix(100, white, 0.55); 950 = mix(900, black, 0.35)
 *   accent ramp   200/300/400 = mix(100, 500, 0.25/0.50/0.75);
 *                 600 = mix(500, 700, 0.5); 800/900 extrapolate the 500→700
 *                 L/C trajectory (steps 0.5/1.0, ΔC damped x0.6, floors
 *                 L 0.13 / C 0.02); 50/950 as in the primary ramp
 *   neutral ramp  50 = light-bg seed, 900 = light-ink seed, 950 = dark-bg
 *                 seed; 100..800 = mix(lightBg, lightInk, t) at
 *                 t = .05/.12/.22/.36/.50/.64/.78/.90
 *   status ramps  accentRamp() over the status hue seeds
 *
 * AA ADJUSTMENTS (how they were applied)
 *   fixContrast(): step the derived color toward an anchor in OKLCH
 *   increments of t = 0.02 until EVERY listed background clears the WCAG
 *   threshold (4.5:1 text, 3:1 UI). pickInk(): first preference-ordered ink
 *   candidate that clears the threshold. Translucent subtleBg tokens are
 *   source-over composited onto their host surfaces before measuring; dark
 *   text.accent must clear 4.5:1 over BOTH the primary and accent subtleBg
 *   composites (accent added round 1 — Badge §2.9 pairs text.accent with
 *   accent.subtleBg), and light text.accent over both opaque subtle fills.
 *
 *   Adjustment report as of T-4.1 round 1 (authoritative source: re-run):
 *     [goldenHour]      light text.muted            #8B837D → #706862
 *     [goldenHour]      light text.accent           #BF3E2A → #BD3D29
 *     [goldenHour]      dark  text.muted            #938A84 → #9E958F
 *     [goldenHour]      dark  text.accent           #E96A50 → #EB7658
 *                       → over subtleBg composites  #EB7658 → #EE8E6B
 *     [deepWaters]      light text.muted            #7C8788 → #5F6C6E
 *     [deepWaters]      light accent.solidPressed   #CA7228 → #CC7329
 *     [deepWaters]      dark  text.muted            #838C8D → #8D9697
 *     [deepWaters]      dark  text.accent
 *                       → over subtleBg composites  #2FA8A0 → #4AAFA9
 *     [midnightExpress] light text.muted            #927F84 → #756470
 *     [midnightExpress] light accent.solidPressed   #A97F37 → #AF843B
 *     [midnightExpress] dark  text.muted            #888B99 → #9294A2
 *     [midnightExpress] dark  text.accent           #5D74B8 → #8695CA
 *                       → over subtleBg composites  #8695CA → #929FCF
 *
 * RUN
 *   cd packages/tokens/scripts && npm i --no-save culori@4.0.2 && node derive-ramps.mjs
 */
import { oklch, formatHex, interpolate, clampChroma, wcagContrast, rgb } from "culori";

const toOklch = (hex) => oklch(hex);
const fmt = (c) => formatHex(clampChroma(c, "oklch"));

/** mix a→b at t in OKLCH */
function mix(a, b, t) {
  const i = interpolate([a, b], "oklch");
  return fmt(i(t));
}

/** composite 8-digit-hex (or hex+alpha) fg over opaque bg */
function composite(fgHex, alpha, bgHex) {
  const f = rgb(fgHex);
  const b = rgb(bgHex);
  const out = {
    mode: "rgb",
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  };
  return formatHex(out);
}

const contrast = (fg, bg) => wcagContrast(fg, bg);

const adjustments = [];
function note(palette, what) {
  adjustments.push(`[${palette}] ${what}`);
}

/**
 * Fix-loop: move `color` toward `toward` until contrast(color, bg) >= min
 * for EVERY bg in bgs. Returns adjusted hex. Steps of t=0.02.
 */
function fixContrast(palette, label, color, towards, bgs, min) {
  const worst = (c) => Math.min(...bgs.map((bg) => contrast(c, bg)));
  if (worst(color) >= min) return color;
  const start = color;
  let t = 0;
  let c = color;
  while (worst(c) < min && t < 1) {
    t += 0.02;
    c = mix(start, towards, t);
  }
  note(
    palette,
    `${label}: ${start} → ${c} (t=${t.toFixed(2)}) to reach ${min}:1 (worst ${worst(c).toFixed(2)})`,
  );
  return c;
}

/** pick the candidate with max worst-case contrast over bgs; must be >= min */
function pickInk(palette, label, candidates, bgs, min) {
  const worst = (c) => Math.min(...bgs.map((bg) => contrast(c, bg)));
  // candidates are in preference order (palette-cohesive first): first one
  // that clears `min` wins; fall back to max-contrast if none pass.
  const best =
    candidates.find((c) => worst(c) >= min) ??
    [...candidates].sort((a, b) => worst(b) - worst(a))[0];
  if (worst(best) < min) {
    note(
      palette,
      `${label}: BEST candidate ${best} only ${worst(best).toFixed(2)}:1 (< ${min}) — needs manual attention`,
    );
  }
  return best;
}

// ---------------------------------------------------------------- seeds

const palettes = {
  goldenHour: {
    label: "Golden Hour",
    primary: {
      100: "#FBE3DD",
      300: "#F3A795",
      500: "#D64933",
      700: "#A83322",
      900: "#6E2113",
    },
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
    label: "Deep Waters",
    primary: {
      100: "#D9ECEC",
      300: "#7CC2BF",
      500: "#0E6E6B",
      700: "#0A4F4D",
      900: "#063230",
    },
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
    label: "Midnight Express",
    primary: {
      100: "#DEE3F2",
      300: "#93A3CE",
      500: "#2B3A67",
      700: "#1F2B4E",
      900: "#131B33",
    },
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

// status seeds (shared across palettes) — hue families per spec §2.2
const statusSeeds = {
  success: { 100: "#D7F2E4", 500: "#16A06B", 700: "#0E7A4F" },
  warning: { 100: "#FCEED3", 500: "#E28B16", 700: "#A05F0B" },
  danger: { 100: "#FBE1DF", 500: "#DC4B41", 700: "#A82E26" },
  info: { 100: "#DCE9FB", 500: "#3B82D6", 700: "#2559A8" },
};

// ---------------------------------------------------------------- ramps

/** primary ramp: seeds at 100/300/500/700/900 → full 50..950 */
function primaryRamp(seeds) {
  const r = { ...seeds };
  r[200] = mix(seeds[100], seeds[300], 0.5);
  r[400] = mix(seeds[300], seeds[500], 0.5);
  r[600] = mix(seeds[500], seeds[700], 0.5);
  r[800] = mix(seeds[700], seeds[900], 0.5);
  r[50] = mix(seeds[100], "#FFFFFF", 0.55);
  r[950] = mix(seeds[900], "#000000", 0.35);
  return r;
}

/** accent ramp: seeds at 100/500/700 → full 50..950 (extrapolate past 700) */
function accentRamp(seeds) {
  const r = { ...seeds };
  r[200] = mix(seeds[100], seeds[500], 0.25);
  r[300] = mix(seeds[100], seeds[500], 0.5);
  r[400] = mix(seeds[100], seeds[500], 0.75);
  r[600] = mix(seeds[500], seeds[700], 0.5);
  // extrapolate 800/900 continuing the 500→700 darkening trajectory
  const c500 = toOklch(seeds[500]);
  const c700 = toOklch(seeds[700]);
  const dL = c500.l - c700.l;
  const dC = (c500.c ?? 0) - (c700.c ?? 0);
  const mk = (steps) =>
    fmt({
      mode: "oklch",
      l: Math.max(0.13, c700.l - dL * steps),
      c: Math.max(0.02, (c700.c ?? 0) - dC * steps * 0.6),
      h: c700.h,
    });
  r[800] = mk(0.5);
  r[900] = mk(1.0);
  r[50] = mix(seeds[100], "#FFFFFF", 0.55);
  r[950] = mix(r[900], "#000000", 0.35);
  return r;
}

/** neutral ramp anchored on light bg (50) and light ink (900); 950 = dark bg */
function neutralRamp(p) {
  const t = {
    100: 0.05,
    200: 0.12,
    300: 0.22,
    400: 0.36,
    500: 0.5,
    600: 0.64,
    700: 0.78,
    800: 0.9,
  };
  const r = { 50: p.lightBg, 900: p.lightInk, 950: p.darkBg };
  for (const [stop, tv] of Object.entries(t)) r[stop] = mix(p.lightBg, p.lightInk, tv);
  return r;
}

const statusRamps = Object.fromEntries(
  Object.entries(statusSeeds).map(([k, seeds]) => [k, accentRamp(seeds)]),
);

// ---------------------------------------------------------------- semantics

const WHITE = "#FFFFFF";

function lightSemantics(name, p, ramps) {
  const n = ramps.neutral,
    pr = ramps.primary,
    ac = ramps.accent;
  const bg = {
    screen: p.lightBg,
    surface: WHITE,
    surfaceRaised: WHITE,
    inset: n[100],
    scrim: n[950] + "66",
  };
  const textPrimary = p.lightInk;
  const textSecondary = fixContrast(
    name,
    "light text.secondary",
    n[600],
    p.lightInk,
    [p.lightBg, WHITE, n[100]],
    4.5,
  );
  const textMuted = fixContrast(
    name,
    "light text.muted",
    n[500],
    p.lightInk,
    [p.lightBg, WHITE, n[100]],
    4.5,
  );
  const primarySolid = pr[600];
  const primaryOnSolid = pickInk(
    name,
    "light primary.onSolid",
    [WHITE, p.lightBg, n[50]],
    [pr[600], pr[700]],
    4.5,
  );
  // Mid-tone amber trap: accent-600 passes 4.5 with NO ink. Light accent.solid
  // maps to the 500 SEED (dark ink ≈ 8:1); pressed = derived 600 nudged
  // lighter until ink passes (derived-stop adjustment, seed untouched).
  const accentOnSolid = pickInk(
    name,
    "light accent.onSolid",
    [p.lightInk, p.darkBg, "#000000", WHITE],
    [ac[500]],
    4.5,
  );
  const accentPressed = fixContrast(
    name,
    "light accent.solidPressed (fill vs onSolid)",
    ac[600],
    ac[500],
    [accentOnSolid],
    4.5,
  );
  const textAccent = fixContrast(
    name,
    "light text.accent",
    pr[600],
    pr[900],
    // every body-text surface + BOTH subtle pill fills (matrix pairings;
    // ac[50] added round 1 — Badge §2.9 puts text.accent on accent.subtleBg)
    [p.lightBg, WHITE, n[100], pr[50], ac[50]],
    4.5,
  );
  const focus = fixContrast(name, "light border.focus", pr[600], pr[900], [p.lightBg, WHITE], 3);
  const borderStrong = fixContrast(
    name,
    "light border.strong",
    n[500],
    p.lightInk,
    [WHITE, p.lightBg],
    3,
  );
  const status = Object.fromEntries(
    Object.entries(statusRamps).map(([k, r]) => {
      const fg = fixContrast(
        name,
        `light status.${k}.fg`,
        r[700],
        r[950],
        [r[50], WHITE, p.lightBg],
        4.5,
      );
      return [k, { fg, bg: r[50], border: r[200] }];
    }),
  );
  return {
    bg,
    text: {
      primary: textPrimary,
      secondary: textSecondary,
      muted: textMuted,
      inverse: p.lightBg,
      onPrimary: primaryOnSolid,
      onAccent: accentOnSolid,
      accent: textAccent,
    },
    border: { subtle: n[200], default: n[300], strong: borderStrong, focus },
    primary: {
      solid: primarySolid,
      solidPressed: pr[700],
      subtleBg: pr[50],
      subtleBorder: pr[200],
      onSolid: primaryOnSolid,
    },
    accent: {
      solid: ac[500],
      solidPressed: accentPressed,
      subtleBg: ac[50],
      subtleBorder: ac[200],
      onSolid: accentOnSolid,
    },
    status,
    interactive: {
      pressedOverlay: n[950] + "14",
      disabledBg: n[200],
      disabledText: n[400],
    },
  };
}

function darkSemantics(name, p) {
  const surfaceRaised = mix(p.darkCard, p.darkInk, 0.07);
  const inset = mix(p.darkCard, p.darkInk, 0.05);
  const bgs = [p.darkBg, p.darkCard, surfaceRaised, inset];
  const bg = {
    screen: p.darkBg,
    surface: p.darkCard,
    surfaceRaised,
    inset,
    scrim: "#00000099",
  };
  const textSecondary = fixContrast(
    name,
    "dark text.secondary",
    mix(p.darkInk, p.darkBg, 0.25),
    p.darkInk,
    bgs,
    4.5,
  );
  const textMuted = fixContrast(
    name,
    "dark text.muted",
    mix(p.darkInk, p.darkBg, 0.42),
    p.darkInk,
    bgs,
    4.5,
  );
  const primaryOnSolid = pickInk(
    name,
    "dark primary.onSolid",
    [p.darkBg, "#000000", WHITE, p.darkInk],
    [p.darkPrimary],
    4.5,
  );
  const primaryPressed = mix(p.darkPrimary, p.darkInk, 0.12);
  const accentOnSolid = pickInk(
    name,
    "dark accent.onSolid",
    [p.darkBg, "#000000", p.darkInk, WHITE],
    [p.darkAccent],
    4.5,
  );
  const accentPressed = mix(p.darkAccent, p.darkInk, 0.12);
  const textAccent = fixContrast(name, "dark text.accent", p.darkPrimary, p.darkInk, bgs, 4.5);
  const focus = fixContrast(
    name,
    "dark border.focus",
    p.darkPrimary,
    p.darkInk,
    [p.darkBg, p.darkCard],
    3,
  );
  const borderStrong = fixContrast(
    name,
    "dark border.strong",
    mix(p.darkCard, p.darkInk, 0.45),
    p.darkInk,
    [p.darkCard, p.darkBg],
    3,
  );
  // subtleBg is translucent (spec §2.2 dark) — validate text.accent over the
  // primary AND accent subtleBg composites (accent pair added round 1:
  // Badge §2.9 puts text.accent ink on accent.subtleBg pills/badges)
  const subtleAlpha = 0.16;
  const subtleComposites = [
    composite(p.darkPrimary, subtleAlpha, p.darkCard),
    composite(p.darkPrimary, subtleAlpha, p.darkBg),
    composite(p.darkAccent, subtleAlpha, p.darkCard),
    composite(p.darkAccent, subtleAlpha, p.darkBg),
  ];
  const textAccentFinal = fixContrast(
    name,
    "dark text.accent (over subtleBg composite)",
    textAccent,
    p.darkInk,
    [...bgs, ...subtleComposites],
    4.5,
  );
  const status = Object.fromEntries(
    Object.entries(statusRamps).map(([k, r]) => {
      const fg = fixContrast(name, `dark status.${k}.fg`, r[300], WHITE, [r[950], r[900]], 4.5);
      return [k, { fg, bg: r[950], border: r[800] }];
    }),
  );
  return {
    bg,
    text: {
      primary: p.darkInk,
      secondary: textSecondary,
      muted: textMuted,
      inverse: p.darkBg,
      onPrimary: primaryOnSolid,
      onAccent: accentOnSolid,
      accent: textAccentFinal,
    },
    border: {
      subtle: mix(p.darkCard, p.darkInk, 0.14),
      default: mix(p.darkCard, p.darkInk, 0.22),
      strong: borderStrong,
      focus,
    },
    primary: {
      solid: p.darkPrimary,
      solidPressed: primaryPressed,
      subtleBg: p.darkPrimary + "29",
      subtleBorder: p.darkPrimary + "4D",
      onSolid: primaryOnSolid,
    },
    accent: {
      solid: p.darkAccent,
      solidPressed: accentPressed,
      subtleBg: p.darkAccent + "29",
      subtleBorder: p.darkAccent + "4D",
      onSolid: accentOnSolid,
    },
    status,
    interactive: {
      pressedOverlay: "#FFFFFF14",
      disabledBg: mix(p.darkCard, p.darkInk, 0.12),
      disabledText: mix(p.darkInk, p.darkBg, 0.58),
    },
  };
}

// validate pressed-state onSolid too (report only — pressed inherits onSolid)
function validatePressed(name, sem, scheme) {
  for (const group of ["primary", "accent"]) {
    const c = contrast(sem[group].onSolid, sem[group].solidPressed);
    if (c < 4.5)
      note(
        name,
        `${scheme} ${group}.onSolid on solidPressed = ${c.toFixed(2)} (<4.5) — needs attention`,
      );
  }
}

// ---------------------------------------------------------------- emit

const RAMP_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

function rampTs(r, indent) {
  const pad = " ".repeat(indent);
  return `{\n${RAMP_STOPS.map((s) => `${pad}  ${s}: "${r[s].toUpperCase()}",`).join("\n")}\n${pad}}`;
}

function semTs(s, indent) {
  const q = (v) => `"${v.toUpperCase()}"`;
  const obj = (o, ind) => {
    const p = " ".repeat(ind);
    return `{\n${Object.entries(o)
      .map(([k, v]) => `${p}  ${k}: ${typeof v === "string" ? q(v) : obj(v, ind + 2)},`)
      .join("\n")}\n${p}}`;
  };
  return obj(s, indent);
}

import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("out", { recursive: true });

for (const [name, p] of Object.entries(palettes)) {
  const ramps = {
    neutral: neutralRamp(p),
    primary: primaryRamp(p.primary),
    accent: accentRamp(p.accent),
  };
  const light = lightSemantics(name, p, ramps);
  const dark = darkSemantics(name, p);
  validatePressed(name, light, "light");
  validatePressed(name, dark, "dark");
  const ts = `export const ${name} = {
  name: "${name}",
  label: "${p.label}",
  ramps: {
    neutral: ${rampTs(ramps.neutral, 4)},
    primary: ${rampTs(ramps.primary, 4)},
    accent: ${rampTs(ramps.accent, 4)},
  },
  semantics: {
    light: ${semTs(light, 4)},
    dark: ${semTs(dark, 4)},
  },
};
`;
  writeFileSync(`out/${name}.ts`, ts);
}

// status ramps file
const statusTs = Object.entries(statusRamps)
  .map(([k, r]) => `export const ${k}Ramp = ${rampTs(r, 0)};`)
  .join("\n\n");
writeFileSync("out/status-ramps.ts", statusTs + "\n");

console.log("=== ADJUSTMENTS / WARNINGS ===");
for (const a of adjustments) console.log(a);
console.log(`\n${adjustments.length} adjustment(s). Files in out/`);
