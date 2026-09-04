/**
 * Budgets routes (T-9.4 / MON-6): GET `/trips/:tripId/budgets` (G1), PUT
 * `/trips/:tripId/budgets/:category` (G2) — money spec §3.2, wire shapes +
 * paths from `@gogo/shared/domains/money` (`moneyEndpoints`) only. Covers
 * R-money-20, R-money-25/26.
 *
 * AUTHZ POSTURE (money-surface precedent, followed exactly): runs behind the
 * app-wide `requireAuth`; both routes sit behind `requireTripMember` — a
 * non-member's 404 is byte-identical to an absent trip's (R-money-25, F-038
 * harness). G1 gates `viewer` (member read); G2 gates `editor` — the §3.8
 * matrix's one role-expressible money write (viewer → 403). `:category` is
 * NOT an id param: the spec pins a distinguishable 400 for an unknown
 * category, so it is checked IN-HANDLER against the shared
 * `BudgetCategorySegmentSchema` (real categories + the `total`
 * pseudo-segment) — after the gate, so a non-member never learns category
 * validity and the 404 posture stays intact.
 *
 * WRITE PATH: the mutation goes through the budgets domain service
 * (service.ts — the trips-first acquisition order lives there); this router
 * owns only wire validation, authz wiring, and the response pass-through
 * (the service returns wire-shaped documents).
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  BudgetCategorySegmentSchema,
  moneyEndpoints,
  type BudgetsRead,
} from "@gogo/shared/domains/money";
import type { DbClient } from "../db/create-user.js";
import { apiError, type RequestVars } from "../http/errors.js";
import { createRequireTripMember, tripContextOf } from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import { loadBudgetsDoc, putBudgetCap } from "./service.js";

export interface BudgetsRouterDeps {
  db: DbClient;
}

export function createBudgetsRouter(deps: BudgetsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/budgets — G1: full-taxonomy items + computed spend +
  // the overall-cap total block. Member read (any role).
  // -------------------------------------------------------------------------
  router.get(moneyEndpoints.getBudgets.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const body = await loadBudgetsDoc(deps.db, { tripId });
    return c.json(body satisfies BudgetsRead);
  });

  // -------------------------------------------------------------------------
  // PUT /trips/:tripId/budgets/:category — G2: upsert a category cap, or the
  // overall trip cap via the `total` pseudo-segment. Editor+ (R-money-26);
  // null clears the cap preserving the AI estimate (R-money-20). Returns the
  // recomputed G1 document (shared descriptor contract).
  // -------------------------------------------------------------------------
  router.put(
    moneyEndpoints.putBudget.path,
    zValidator("json", moneyEndpoints.putBudget.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember("editor"),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const body = c.req.valid("json");

      // Unknown category → the spec's distinguishable 400 (module doc: after
      // the gate, so only proven members reach this door).
      const segment = BudgetCategorySegmentSchema.safeParse(c.req.param("category"));
      if (!segment.success) {
        return apiError(c, "VALIDATION_FAILED", "unknown budget category", {
          category: "unknown",
        });
      }

      const doc = await putBudgetCap(deps.db, {
        tripId,
        segment: segment.data,
        capCents: body.cap_cents,
      });
      return c.json(doc satisfies BudgetsRead);
    },
  );

  return router;
}
