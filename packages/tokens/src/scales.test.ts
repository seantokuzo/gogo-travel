/**
 * Scale-shape checks (spec §2.3, §2.4, §2.6, §2.8): the non-color contracts
 * later DS tasks (Text primitive, haptics module, components) build on.
 */
import { describe, expect, it } from "vitest";
import { hapticEvents, hitSlop, motion, radius, space, touchTarget, typeScale } from "./scales.js";
import type { HapticEvent, TypeRole } from "./types.js";

describe("spacing / radius / touch (spec §2.4)", () => {
  it("space follows the 4-pt grid (key × 4 = pt)", () => {
    for (const [key, value] of Object.entries(space)) {
      expect(value).toBe(Number(key) * 4);
    }
    expect(Object.keys(space)).toHaveLength(10);
  });

  it("radius scale matches the locked values", () => {
    expect(radius).toEqual({
      none: 0,
      sm: 6,
      md: 10,
      lg: 14,
      xl: 20,
      full: 999,
    });
  });

  it("touch target is 44pt (R-ds-9) with sm/md hitSlop presets", () => {
    expect(touchTarget).toBe(44);
    expect(hitSlop.sm).toEqual({ top: 8, bottom: 8, left: 8, right: 8 });
    expect(hitSlop.md).toEqual({ top: 12, bottom: 12, left: 12, right: 12 });
  });
});

describe("typography (spec §2.3)", () => {
  const roles: TypeRole[] = [
    "display",
    "title",
    "heading",
    "subheading",
    "body",
    "bodyStrong",
    "caption",
    "label",
    "mono",
  ];

  it("all nine roles exist with complete styles + Dynamic Type caps", () => {
    expect(Object.keys(typeScale).sort()).toEqual([...roles].sort());
    for (const role of roles) {
      const style = typeScale[role];
      expect(style.fontSize).toBeGreaterThan(0);
      expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize);
      expect(["400", "500", "600", "700", "800"]).toContain(style.fontWeight);
      expect(style.maxFontSizeMultiplier).toBeGreaterThanOrEqual(1);
    }
  });

  it("system fonts v1: no fontFamily is set (platform default seam)", () => {
    for (const role of roles) {
      expect(typeScale[role].fontFamily).toBeUndefined();
    }
  });

  it("spot-checks the locked scale table", () => {
    expect(typeScale.display).toMatchObject({
      fontSize: 32,
      lineHeight: 38,
      fontWeight: "800",
      maxFontSizeMultiplier: 1.4,
    });
    expect(typeScale.body).toMatchObject({
      fontSize: 15,
      lineHeight: 22,
      fontWeight: "400",
      maxFontSizeMultiplier: 2.0,
    });
    expect(typeScale.label.letterSpacing).toBe(0.4);
  });
});

describe("motion (spec §2.6)", () => {
  it("durations: fast 120 / base 200 / slow 300 / shimmer 1200", () => {
    expect(motion.duration).toEqual({
      fast: 120,
      base: 200,
      slow: 300,
      shimmer: 1200,
    });
  });

  it("easings are 4-point beziers; sheet spring is configured", () => {
    for (const bezier of Object.values(motion.easing)) {
      expect(bezier).toHaveLength(4);
    }
    expect(motion.spring.sheet.damping).toBeGreaterThan(0);
    expect(motion.spring.sheet.stiffness).toBeGreaterThan(0);
  });
});

describe("haptics convention table (spec §2.8, R-ds-21)", () => {
  it("maps exactly the seven semantic events", () => {
    const expected: Record<HapticEvent, string> = {
      selection: "selection",
      actionLight: "impactLight",
      dragLift: "impactMedium",
      dragDrop: "impactLight",
      success: "notificationSuccess",
      warning: "notificationWarning",
      error: "notificationError",
    };
    expect(hapticEvents).toEqual(expected);
  });
});
