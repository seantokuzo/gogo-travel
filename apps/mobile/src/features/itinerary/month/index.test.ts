/**
 * The Month barrel is the cross-task contract with T-7.16 (it imports
 * `MonthSurface` + its props type from here and cannot re-open the files).
 * What change makes this red: any entry point T-7.16 or a later consumer
 * relies on stops being exported from `./index`, or the density persistence
 * API leaks into this surface's exports.
 */
import * as month from "./index";
import {
  buildMonthModel,
  cellLabel,
  DEFAULT_WEEK_START,
  landingMonthKey,
  MAX_DOTS,
  MonthSurface,
  stepMonthIndex,
  weekdayHeaders,
} from "./index";

describe("month barrel", () => {
  it("exports the surface and every model entry point", () => {
    expect(typeof MonthSurface).toBe("function");
    expect(typeof buildMonthModel).toBe("function");
    expect(typeof cellLabel).toBe("function");
    expect(typeof landingMonthKey).toBe("function");
    expect(typeof stepMonthIndex).toBe("function");
    expect(typeof weekdayHeaders).toBe("function");
    expect(MAX_DOTS).toBe(3);
    expect(DEFAULT_WEEK_START).toBe(0);
  });

  it("does not leak the shared density contract — persistence stays the screen's", () => {
    const names = Object.keys(month);
    expect(names).not.toContain("storeGridDensity");
    expect(names).not.toContain("readGridDensity");
  });
});
