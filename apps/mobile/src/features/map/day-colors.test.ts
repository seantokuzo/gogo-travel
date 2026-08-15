/**
 * Day-color mapping pins (T-8.2 / MAP-1 — §2.2 + the Euclidean-modulo
 * ruling). The negative-index arm is the ruling's raison d'être: R-itin-1
 * item days before the trip produce NEGATIVE day indexes, and a naive `%`
 * lookup lands `undefined` on a Mapbox paint prop.
 */
import { mapDayColors } from "@gogo/tokens";

import { lightTheme } from "@/test-utils/render";

import {
  DAY_COLOR_COUNT,
  dayColorFor,
  dayColorIndex,
  dayIndexFor,
  dayNumberLabel,
} from "./day-colors";

describe("dayIndexFor", () => {
  it("is 0 on the trip's first day", () => {
    expect(dayIndexFor("2026-09-10", "2026-09-10")).toBe(0);
  });

  it("counts whole wall-days forward, across month boundaries", () => {
    expect(dayIndexFor("2026-09-13", "2026-09-10")).toBe(3);
    expect(dayIndexFor("2026-10-02", "2026-09-28")).toBe(4);
  });

  it("is NEGATIVE for item days before the trip (R-itin-1 union)", () => {
    expect(dayIndexFor("2026-09-08", "2026-09-10")).toBe(-2);
    expect(dayIndexFor("2026-08-31", "2026-09-10")).toBe(-10);
  });
});

describe("dayColorIndex (Euclidean modulo — binding ruling)", () => {
  it("cycles non-negative indexes through 0..7", () => {
    expect(dayColorIndex(0)).toBe(0);
    expect(dayColorIndex(7)).toBe(7);
    expect(dayColorIndex(8)).toBe(0);
    expect(dayColorIndex(9)).toBe(1);
  });

  it("maps NEGATIVE indexes into 0..7 (never a negative remainder)", () => {
    expect(dayColorIndex(-1)).toBe(7);
    expect(dayColorIndex(-8)).toBe(0);
    expect(dayColorIndex(-9)).toBe(7);
    expect(dayColorIndex(-2)).toBe(6);
  });

  it("CONTROL: naive JS % would have produced a negative index → undefined color", () => {
    // The ungated arm this module exists to prevent: prove the failure is
    // real, so the Euclid pins above are falsifiable, not vacuous.
    const naive = -1 % DAY_COLOR_COUNT;
    expect(naive).toBe(-1);
    const colors = mapDayColors(lightTheme);
    expect(colors[naive as 0]).toBeUndefined();
  });
});

describe("dayColorFor", () => {
  it("returns a defined tuple color for every index, negative included", () => {
    const colors = mapDayColors(lightTheme);
    for (const dayIndex of [-10, -9, -8, -1, 0, 3, 7, 8, 15]) {
      const color = dayColorFor(colors, dayIndex);
      expect(typeof color).toBe("string");
      expect(colors).toContain(color);
    }
  });

  it("matches the tokens tuple positionally (day 0 = info mid stop)", () => {
    const colors = mapDayColors(lightTheme);
    expect(dayColorFor(colors, 0)).toBe(colors[0]);
    expect(dayColorFor(colors, -1)).toBe(colors[7]);
    expect(dayColorFor(colors, 8)).toBe(colors[0]);
  });
});

describe("dayNumberLabel", () => {
  it("is 1-based for in-range days", () => {
    expect(dayNumberLabel(0)).toBe("1");
    expect(dayNumberLabel(6)).toBe("7");
  });

  it("carries the arithmetic number for out-of-range days (module doc)", () => {
    expect(dayNumberLabel(-1)).toBe("0");
    expect(dayNumberLabel(-3)).toBe("-2");
  });
});
