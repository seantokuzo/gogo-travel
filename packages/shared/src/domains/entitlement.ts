/**
 * Entitlements domain (ADR-005 seam; contracts spec §3.4; schema spec §3.3.2).
 *
 * Plan DEFAULTS live in `config/entitlements.ts`; this module owns the row
 * and wire shapes. Effective cap = `overrides.x ?? PLAN_DEFAULTS[plan].x` —
 * `resolveEntitlements` in config is the only resolution path (R-shared-12).
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { PlanSchema } from "../enums.js";
import { ISODateTimeSchema, UuidSchema } from "../scalars.js";

/**
 * `entitlements.overrides` JSONB (schema spec §3.4.7) — per-user exceptions
 * to plan defaults. All optional; absent key = plan default. Only the ADR-005
 * gateable candidates — nothing else grows a seam without an ADR.
 */
export const EntitlementOverridesSchema = z.object({
  ai_calls_per_day: z.int().nonnegative().optional(),
  alerts_enabled: z.boolean().optional(),
  premium_place_details: z.boolean().optional(),
});
export type EntitlementOverrides = z.infer<typeof EntitlementOverridesSchema>;

/** The `entitlements` row (created with the user in one transaction, R-db-5). */
export const EntitlementSchema = z.object({
  user_id: UuidSchema,
  plan: PlanSchema,
  overrides: EntitlementOverridesSchema,
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/**
 * `GET /users/me/entitlements` response — the `resolveEntitlements` return
 * type (R-shared-12). Values are display-only on the client (R-ent-2).
 */
export const EffectiveEntitlementsSchema = z.object({
  plan: PlanSchema,
  ai_calls_per_day: z.int().nonnegative(),
  alerts_enabled: z.boolean(),
  premium_place_details: z.boolean(),
});
export type EffectiveEntitlements = z.infer<typeof EffectiveEntitlementsSchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (auth-users spec §3.4.3; contracts spec §3.6)
// ---------------------------------------------------------------------------

/**
 * Read side of the ADR-005 seam. No entitlement write endpoint exists in v1
 * (R-ent-3) — plan/override changes are operator actions, not API surface.
 */
export const entitlementEndpoints = {
  /**
   * Auth required. Computed solely by shared `resolveEntitlements()`
   * (R-ent-1); values are display-only on the client — the server-side
   * `requireAiQuota` check is the enforcement (R-ent-2).
   */
  getMyEntitlements: {
    method: "GET",
    path: "/users/me/entitlements",
    response: EffectiveEntitlementsSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
