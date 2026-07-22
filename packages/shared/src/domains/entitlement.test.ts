/**
 * AU-1 contract suite for the entitlement domain (auth-users spec §3.4.3;
 * ADR-005 seam). Resolver behavior lives in `config/entitlements.test.ts`;
 * this file owns the wire shapes + descriptor.
 */
import { describe, expect, it } from "vitest";
import { descriptorKey } from "../api/descriptor.js";
import {
  EffectiveEntitlementsSchema,
  entitlementEndpoints,
  EntitlementOverridesSchema,
  EntitlementSchema,
} from "./entitlement.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

describe("EntitlementOverrides", () => {
  it("all keys optional; unknown keys stripped (no seam grows without an ADR)", () => {
    expect(EntitlementOverridesSchema.parse({})).toEqual({});
    const parsed = EntitlementOverridesSchema.parse({
      ai_calls_per_day: 100,
      free_flights: true,
    });
    expect(parsed.ai_calls_per_day).toBe(100);
    expect(parsed).not.toHaveProperty("free_flights");
  });
  it("rejects negative and float ai_calls_per_day", () => {
    for (const ai_calls_per_day of [-1, 0.5, "30"]) {
      expect(EntitlementOverridesSchema.safeParse({ ai_calls_per_day }).success).toBe(false);
    }
  });
});

describe("Entitlement row / EffectiveEntitlements", () => {
  it("row round-trips", () => {
    const parsed = EntitlementSchema.parse({
      user_id: UUID,
      plan: "free",
      overrides: {},
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
    });
    expect(parsed.plan).toBe("free");
  });
  it("effective shape requires every resolved value — no partials on the wire", () => {
    const valid = {
      plan: "free",
      ai_calls_per_day: 30,
      alerts_enabled: false,
      premium_place_details: false,
    };
    expect(EffectiveEntitlementsSchema.parse(valid).ai_calls_per_day).toBe(30);
    for (const key of Object.keys(valid)) {
      const { [key]: _omitted, ...rest } = valid as Record<string, unknown>;
      expect(EffectiveEntitlementsSchema.safeParse(rest).success).toBe(false);
    }
  });
  it("rejects unknown plans", () => {
    expect(
      EffectiveEntitlementsSchema.safeParse({
        plan: "enterprise",
        ai_calls_per_day: 30,
        alerts_enabled: true,
        premium_place_details: true,
      }).success,
    ).toBe(false);
  });
});

describe("entitlementEndpoints descriptors (§3.4.3)", () => {
  it("expose exactly the read endpoint — no write surface in v1 (R-ent-3)", () => {
    expect(Object.keys(entitlementEndpoints)).toEqual(["getMyEntitlements"]);
    expect(descriptorKey(entitlementEndpoints.getMyEntitlements)).toBe(
      "GET /users/me/entitlements",
    );
    expect(entitlementEndpoints.getMyEntitlements.response).toBe(EffectiveEntitlementsSchema);
    expect(entitlementEndpoints.getMyEntitlements).not.toHaveProperty("body");
  });
});
