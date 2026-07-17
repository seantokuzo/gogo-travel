/**
 * R-ds-8 contrast matrix — THE palette validator.
 *
 * Every declared foreground/background token pairing must meet WCAG 2.1 AA
 * across every `scheme × accent theme` combination:
 *   - ≥ 4.5:1 for text pairings (body text)
 *   - ≥ 3:1  for UI pairings (focus indicators, strong borders — WCAG 1.4.11)
 *
 * Contrast math is implemented here from the WCAG 2.1 definition — no color
 * library involved — so this suite independently validates the
 * authoring-time derivation. A new palette that fails a pairing fails the
 * build; fix it by adjusting DERIVED stops, never approved seeds.
 *
 * Deliberately unchecked: `interactive.disabled*` (WCAG 1.4.3 exempts
 * disabled controls) and decorative hairlines (`border.subtle/default`).
 */
import { describe, expect, it } from "vitest";
import { THEME_NAMES, themes } from "./themes.js";
import type { SemanticColors } from "./types.js";

// ------------------------------------------------------------ WCAG 2.1 math

interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  alpha: number;
}

function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!m || m[1] === undefined) {
    throw new Error(`not a 6/8-digit hex color: ${hex}`);
  }
  const int = parseInt(m[1], 16);
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff,
    alpha: m[2] !== undefined ? parseInt(m[2], 16) / 255 : 1,
  };
}

/** WCAG 2.1 relative luminance of an OPAQUE color. */
function luminance(c: Rgb): number {
  const lin = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** Source-over composite of a (possibly translucent) color onto an opaque bg. */
function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.alpha;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    alpha: 1,
  };
}

/** WCAG contrast ratio between an opaque fg and opaque bg, 1..21. */
function contrast(fgHex: string, bgHex: string): number {
  const l1 = luminance(parseHex(fgHex));
  const l2 = luminance(parseHex(bgHex));
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe("WCAG helpers (self-test)", () => {
  it("matches canonical values", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#000000", "#000000")).toBeCloseTo(1, 5);
    // 8-digit hex composite: 50% black over white = #808080-ish gray
    const gray = composite(parseHex("#00000080"), parseHex("#FFFFFF"));
    expect(luminance(gray)).toBeGreaterThan(0.2);
    expect(luminance(gray)).toBeLessThan(0.26);
  });
});

// ------------------------------------------------------------ the matrix

const TEXT_AA = 4.5;
const UI_AA = 3;

interface Pairing {
  label: string;
  fg: string;
  bg: string;
  min: number;
}

/** All declared pairings for one semantic set (spec §2.2 + §Resolved). */
function pairingsOf(sem: SemanticColors, opposite: SemanticColors): Pairing[] {
  const textSurfaces: Array<[string, string]> = [
    ["bg.screen", sem.bg.screen],
    ["bg.surface", sem.bg.surface],
    ["bg.surfaceRaised", sem.bg.surfaceRaised],
    ["bg.inset", sem.bg.inset],
  ];
  const pairs: Pairing[] = [];

  // ink-on-background body text
  for (const [role, ink] of [
    ["text.primary", sem.text.primary],
    ["text.secondary", sem.text.secondary],
    ["text.muted", sem.text.muted],
  ] as const) {
    for (const [surface, bg] of textSurfaces) {
      pairs.push({ label: `${role} on ${surface}`, fg: ink, bg, min: TEXT_AA });
    }
  }

  // links / accent-tinted text
  for (const [surface, bg] of textSurfaces) {
    pairs.push({
      label: `text.accent on ${surface}`,
      fg: sem.text.accent,
      bg,
      min: TEXT_AA,
    });
  }
  // ... including over the accent-tinted container fill (composited when
  // translucent — the dark-scheme subtleBg is 8-digit hex)
  for (const [surface, bg] of [
    ["bg.surface", sem.bg.surface],
    ["bg.screen", sem.bg.screen],
  ] as const) {
    const fill = composite(parseHex(sem.primary.subtleBg), parseHex(bg));
    const fillHex = `#${[fill.r, fill.g, fill.b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")}`;
    pairs.push({
      label: `text.accent on primary.subtleBg over ${surface}`,
      fg: sem.text.accent,
      bg: fillHex,
      min: TEXT_AA,
    });
  }

  // button labels on solid fills — held to BODY AA, incl. pressed state
  for (const group of ["primary", "accent"] as const) {
    pairs.push({
      label: `${group}.onSolid on ${group}.solid`,
      fg: sem[group].onSolid,
      bg: sem[group].solid,
      min: TEXT_AA,
    });
    pairs.push({
      label: `${group}.onSolid on ${group}.solidPressed`,
      fg: sem[group].onSolid,
      bg: sem[group].solidPressed,
      min: TEXT_AA,
    });
  }

  // mirrored ink tokens must actually mirror (single source of truth)
  pairs.push({
    label: "text.onPrimary on primary.solid",
    fg: sem.text.onPrimary,
    bg: sem.primary.solid,
    min: TEXT_AA,
  });
  pairs.push({
    label: "text.onAccent on accent.solid",
    fg: sem.text.onAccent,
    bg: sem.accent.solid,
    min: TEXT_AA,
  });

  // status banners
  for (const tone of ["success", "warning", "danger", "info"] as const) {
    pairs.push({
      label: `status.${tone}.fg on status.${tone}.bg`,
      fg: sem.status[tone].fg,
      bg: sem.status[tone].bg,
      min: TEXT_AA,
    });
  }

  // inverse ink sits on the OPPOSITE scheme's surfaces (chips/toasts)
  pairs.push({
    label: "text.inverse on opposite bg.surface",
    fg: sem.text.inverse,
    bg: opposite.bg.surface,
    min: TEXT_AA,
  });

  // non-text UI (WCAG 1.4.11): focus indicator + strong border
  for (const [surface, bg] of [
    ["bg.screen", sem.bg.screen],
    ["bg.surface", sem.bg.surface],
  ] as const) {
    pairs.push({
      label: `border.focus vs ${surface}`,
      fg: sem.border.focus,
      bg,
      min: UI_AA,
    });
    pairs.push({
      label: `border.strong vs ${surface}`,
      fg: sem.border.strong,
      bg,
      min: UI_AA,
    });
  }

  return pairs;
}

describe("R-ds-8: contrast matrix (every palette × scheme)", () => {
  for (const name of THEME_NAMES) {
    const palette = themes[name];
    for (const scheme of ["light", "dark"] as const) {
      const sem = palette.semantics[scheme];
      const opposite = palette.semantics[scheme === "light" ? "dark" : "light"];
      describe(`${name} × ${scheme}`, () => {
        for (const pair of pairingsOf(sem, opposite)) {
          it(`${pair.label} ≥ ${pair.min}:1`, () => {
            const ratio = contrast(pair.fg, pair.bg);
            expect(
              ratio,
              `${pair.label}: ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(pair.min);
          });
        }
      });
    }
  }
});
