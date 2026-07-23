/**
 * `requireAiQuota(feature)` — the server-side AI cap seam (AU-5, R-ent-2;
 * auth-users spec §3.5). This task owns the GATE only; the AI platform (P-10,
 * `.specs/api/ai.spec.md`) owns the model calls, `ai_usage` increment, cache,
 * and the kill-switch's month-to-date cost math. AU-5 provides the middleware
 * every metered AI route will mount and the two rejections it must produce,
 * with the cost computation injected as a port so this file never grows an
 * Anthropic dependency.
 *
 * Within the request, before any model call (R-ent-2 order):
 *   1. Kill-switch check (injected `killSwitch`) → 503 `AI_DISABLED` if tripped
 *      — a global policy stop that short-circuits before any per-user read.
 *   2. `resolveEntitlements(row)` → the effective `ai_calls_per_day`, then the
 *      caller's counted `ai_usage` for today (UTC). At/over the cap → 429
 *      `AI_CAP_EXCEEDED` with `details: { feature, cap, resets_at }` (R-ai-4).
 *   3. Otherwise attach `{ feature, cap, used }` and continue to the handler,
 *      which performs the model call and (AI spec) the usage increment.
 *
 * Cap accounting mirrors the spec's "summed counted calls": only features
 * whose `AI_FEATURE_CONFIG[...].counts_against_daily_cap` is true count toward
 * the global daily cap. Cap-exempt features (capture, tour guide, recap) skip
 * this middleware entirely (§3.5 note: their call sites don't mount it) and,
 * were it ever mounted for one, are simply excluded from the sum. Per-feature
 * ceilings (R-ai-5) are the AI spec's additive refinement — not this seam.
 */
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AiFeature } from "@gogo/shared/enums";
import { AI_FEATURE_CONFIG } from "@gogo/shared/config/ai-pricing";
import { resolveEntitlements } from "@gogo/shared/config/entitlements";
import type { Plan } from "@gogo/shared/enums";
import type { EntitlementOverrides } from "@gogo/shared/domains/entitlement";
import { apiError, type AiQuotaContext, type RequestVars } from "./errors.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { authContextOf } from "./require-auth.js";

/**
 * The kill-switch port. Its truth is derived state — month-to-date modeled
 * spend ≥ `AI_KILL_SWITCH_CENTS`, memoized per process (AI spec R-ai-7). AU-5
 * consumes the boolean; P-10 supplies the computation. Kept a port so this
 * seam has zero cost-math or pricing coupling.
 */
export interface AiKillSwitch {
  isTripped(): boolean | Promise<boolean>;
}

/** The always-open kill switch — the default until P-10 wires the real one. */
export const KILL_SWITCH_OPEN: AiKillSwitch = { isTripped: () => false };

export interface RequireAiQuotaDeps {
  db: DbClient;
  killSwitch: AiKillSwitch;
  /** Clock seam for the UTC day boundary + `resets_at` (tests inject it). */
  now?: () => Date;
}

/** UTC calendar day (`YYYY-MM-DD`) — the `ai_usage.day` key. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Next UTC midnight as ISO — when today's counts reset (R-ai-4 `resets_at`). */
function nextUtcMidnight(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/**
 * Build the quota guard factory. `requireAiQuota(feature)` returns the
 * per-route middleware (the signature every AI spec references by name).
 */
export function createRequireAiQuota(deps: RequireAiQuotaDeps) {
  return (feature: AiFeature) =>
    createMiddleware<RequestVars>(async (c, next) => {
      // 1. Kill-switch first — a global stop, before any per-user work or model
      //    call. 503, retryable when the switch releases (month rollover).
      if (await deps.killSwitch.isTripped()) {
        return apiError(c, "AI_DISABLED", "AI features are temporarily disabled");
      }

      const { userId } = authContextOf(c);
      const now = deps.now ? deps.now() : new Date();

      // 2a. Effective cap via the ONLY resolution path (R-shared-12). A missing
      //     entitlements row is impossible for a live user (created with the
      //     account); default to plan `free` so a data anomaly fails safe (the
      //     v1 default) rather than 500-ing an AI request.
      const [entRow] = await deps.db
        .select({ plan: schema.entitlements.plan, overrides: schema.entitlements.overrides })
        .from(schema.entitlements)
        .where(eq(schema.entitlements.userId, userId));
      const entitlement: { plan: Plan; overrides: EntitlementOverrides } = entRow ?? {
        plan: "free",
        overrides: {},
      };
      const cap = resolveEntitlements(entitlement).ai_calls_per_day;

      // 2b. Today's counted calls: sum `calls` across the caller's cap-counting
      //     features for the UTC day. Cap-exempt features never contribute.
      const usageRows = await deps.db
        .select({ feature: schema.aiUsage.feature, calls: schema.aiUsage.calls })
        .from(schema.aiUsage)
        .where(and(eq(schema.aiUsage.userId, userId), eq(schema.aiUsage.day, utcDay(now))));
      const used = usageRows.reduce(
        (sum, row) =>
          AI_FEATURE_CONFIG[row.feature].counts_against_daily_cap ? sum + row.calls : sum,
        0,
      );

      if (used >= cap) {
        return apiError(c, "AI_CAP_EXCEEDED", "daily AI limit reached", {
          feature,
          cap,
          resets_at: nextUtcMidnight(now),
        });
      }

      const quota: AiQuotaContext = { feature, cap, used };
      c.set("aiQuota", quota);
      await next();
      return undefined;
    });
}

/**
 * Read the quota context a preceding `requireAiQuota` attached. Absent means
 * the guard did not run — a wiring bug, never a client condition.
 */
export function aiQuotaContextOf(c: Context<RequestVars>): AiQuotaContext {
  const quota = c.get("aiQuota");
  if (!quota) throw new Error("aiQuotaContextOf called without a preceding requireAiQuota");
  return quota;
}
