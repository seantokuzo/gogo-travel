/**
 * Plan defaults + the effective-entitlement resolver (R-shared-12; ADR-005).
 *
 * Gating changes are CONFIG EDITS here, never migrations. Everything is free
 * in v1, so the free plan enables all gateable candidates. The free-forever
 * list (offline, collab, splitting) has NO seam by design — ADR-005 forbids
 * ever gating it.
 */
import type { Plan } from "../enums.js";
import type { EffectiveEntitlements, Entitlement } from "../domains/entitlement.js";

export interface PlanDefaults {
  ai_calls_per_day: number;
  alerts_enabled: boolean;
  premium_place_details: boolean;
}

export const PLAN_DEFAULTS: Readonly<Record<Plan, PlanDefaults>> = {
  free: {
    /** The 30/day default AI cap (ADR-005). */
    ai_calls_per_day: 30,
    alerts_enabled: true,
    premium_place_details: true,
  },
};

/**
 * THE only resolution path (R-shared-12): `overrides.x ?? PLAN_DEFAULTS[plan].x`.
 */
export function resolveEntitlements(
  entitlement: Pick<Entitlement, "plan" | "overrides">,
): EffectiveEntitlements {
  const defaults = PLAN_DEFAULTS[entitlement.plan];
  return {
    plan: entitlement.plan,
    ai_calls_per_day: entitlement.overrides.ai_calls_per_day ?? defaults.ai_calls_per_day,
    alerts_enabled: entitlement.overrides.alerts_enabled ?? defaults.alerts_enabled,
    premium_place_details:
      entitlement.overrides.premium_place_details ?? defaults.premium_place_details,
  };
}
