/**
 * Settle-request routes (T-9.4 / MON-5): POST `/trips/:tripId/settle-requests`
 * (Q1), GET/DELETE `/trips/:tripId/settle-requests/:requestId` (Q2/Q3) —
 * money spec §3.2, wire shapes + paths from `@gogo/shared/domains/money`
 * (`moneyEndpoints`) only. Covers R-money-16..19, 25.
 *
 * AUTHZ POSTURE (settlements routes precedent, followed exactly): runs behind
 * the app-wide `requireAuth`; every route sits behind `requireTripMember` — a
 * non-member's 404 is byte-identical to an absent trip's (R-money-25, F-038
 * harness). All routes gate `viewer`: the §3.8 matrix makes Q1 creditor-only
 * and Q3 creator-only for EVERY role ("a viewer must always be able to settle
 * their own debts", R-money-26) — those finer-than-role rules are the
 * service's; Q2 is member-wide (non-member recipients need app + account,
 * resolved Gate 2 at the navigation spec). `:requestId` is a gate-adjacent id
 * param — in-handler `UUID_RE` pre-check folds malformed values into the SAME
 * indistinguishable 404 (server rule: a param 400 is a distinguishable door),
 * and the trip-scoped service lookup makes a wrong-trip requestId identical
 * to an absent one.
 *
 * WRITE PATH: every mutation goes through the settle-request domain service
 * (requests-service.ts — trips-lock + debt-defaulting semantics live there);
 * this router owns only wire validation, authz wiring, and serialization.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import {
  moneyEndpoints,
  type SettleRequest,
  type SettleRequestDetail,
} from "@gogo/shared/domains/money";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { authContextOf } from "../http/require-auth.js";
import { createRequireTripMember, tripContextOf, UUID_RE } from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import { toUserProfileWire } from "../users/serialize.js";
import {
  cancelSettleRequest,
  createSettleRequest,
  getSettleRequestDetail,
} from "./requests-service.js";
import { toSettleRequestWire } from "./requests-serialize.js";
import type { SettlementsRouterDeps } from "./routes.js";

/**
 * Rides the SAME dep set as the settlements router (one DB, one wire module —
 * `buildSettlementsDeps`); app.ts mounts both off the one `settlements`
 * option (T-9.4 wiring closer).
 */
export function createSettleRequestsRouter(deps: SettlementsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:requestId` → the same indistinguishable 404 (module doc). */
  const validRequestId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/settle-requests — Q1: "send the bill". Creditor-only
  // by construction (to_user = caller); amount defaults to the live pairwise
  // debt via the T-9.3 balances service (R-money-16). 201.
  // -------------------------------------------------------------------------
  router.post(
    moneyEndpoints.createSettleRequest.path,
    zValidator("json", moneyEndpoints.createSettleRequest.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const input = c.req.valid("json");

      const created = await createSettleRequest(deps.db, { tripId, callerId: userId, input });
      return c.json(toSettleRequestWire(created.row, created.resolved) satisfies SettleRequest, 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/settle-requests/:requestId — Q2: deep-link data. The
  // request + the requester's UserProfile and NOTHING more (R-money-17
  // minimum disclosure — the wire schema simply has no other fields).
  // Cancelled/settled requests still render (nav §2.3 "missing/settled" row).
  // -------------------------------------------------------------------------
  router.get(moneyEndpoints.getSettleRequest.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const requestId = validRequestId(c.req.param("requestId"));
    if (!requestId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const found = await getSettleRequestDetail(deps.db, { tripId, requestId });
    if (!found) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const body: SettleRequestDetail = {
      ...toSettleRequestWire(found.row, found.resolved),
      requester: toUserProfileWire(found.requester),
    };
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/settle-requests/:requestId — Q3: soft cancel
  // (`status = 'cancelled'`; the link keeps rendering). Creator-only; 409 on
  // a non-open request — the service owns both rules. 204.
  // -------------------------------------------------------------------------
  router.delete(moneyEndpoints.cancelSettleRequest.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const { userId } = authContextOf(c);
    const requestId = validRequestId(c.req.param("requestId"));
    if (!requestId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    await cancelSettleRequest(deps.db, { tripId, requestId, callerId: userId });
    return c.body(null, 204);
  });

  return router;
}
