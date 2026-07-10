import { describe, expect, it } from "vitest";
import { PLAN_DEFAULTS, resolveEntitlements } from "./entitlements.js";
import { PLANS } from "../enums.js";

describe("PLAN_DEFAULTS (ADR-005 / R-shared-12)", () => {
  it("covers every plan in the enum", () => {
    for (const plan of PLANS) {
      expect(PLAN_DEFAULTS[plan]).toBeDefined();
    }
  });
  it("free plan defaults: 30 AI calls/day, everything enabled (v1 is free)", () => {
    expect(PLAN_DEFAULTS.free).toEqual({
      ai_calls_per_day: 30,
      alerts_enabled: true,
      premium_place_details: true,
    });
  });
});

describe("resolveEntitlements — override precedence (R-shared-12)", () => {
  it("returns plan defaults when overrides are empty", () => {
    expect(resolveEntitlements({ plan: "free", overrides: {} })).toEqual({
      plan: "free",
      ai_calls_per_day: 30,
      alerts_enabled: true,
      premium_place_details: true,
    });
  });

  it("overrides win over plan defaults", () => {
    expect(
      resolveEntitlements({ plan: "free", overrides: { ai_calls_per_day: 100 } }),
    ).toMatchObject({ ai_calls_per_day: 100, alerts_enabled: true });
    expect(
      resolveEntitlements({ plan: "free", overrides: { alerts_enabled: false } }),
    ).toMatchObject({ ai_calls_per_day: 30, alerts_enabled: false });
  });

  it("a zero override is respected (?? not ||)", () => {
    expect(
      resolveEntitlements({ plan: "free", overrides: { ai_calls_per_day: 0 } }).ai_calls_per_day,
    ).toBe(0);
  });
});
