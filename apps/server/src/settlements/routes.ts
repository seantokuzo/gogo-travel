/**
 * Balances + settlements routes (T-9.3 / MON-3, MON-4):
 * GET `/trips/:tripId/balances` (B1), POST/GET `/trips/:tripId/settlements`
 * (S1/S2), DELETE `/trips/:tripId/settlements/:settlementId` (S3) — money
 * spec §3.2, wire shapes + paths from `@gogo/shared/domains/money`
 * (`moneyEndpoints`) only. Covers R-money-8/9/10 (balances) and
 * R-money-11..15, 18, 25 (settlements).
 *
 * AUTHZ POSTURE (bookings/saved-places routes precedent, followed exactly):
 * runs behind the app-wide `requireAuth`; every route sits behind
 * `requireTripMember` — a non-member's 404 is byte-identical to an absent
 * trip's (R-money-25, F-038 harness). All routes gate `viewer`: reads are
 * member-wide, and settlement writes are deliberately role-independent — the
 * §3.8 matrix makes S1 party-only and S3 recorder-only for every role ("a
 * viewer must always be able to settle their own debts", R-money-26); those
 * finer-than-role rules are the service's. `:settlementId` is a gate-adjacent
 * id param — in-handler `UUID_RE` pre-check folds malformed values into the
 * SAME indistinguishable 404 (server rule: a param 400 is a distinguishable
 * door), and the trip-scoped service lookup makes a wrong-trip settlementId
 * identical to an absent one.
 *
 * WRITE PATH: every mutation goes through the settlements domain service
 * (service.ts — atomic request-link semantics live there); this router owns
 * only wire validation, authz wiring, pagination, and serialization.
 *
 * MOUNTING: deliberately NOT mounted in app.ts by this task — the W3 wiring
 * closer (T-9.4) owns the app.ts/index.ts touch (P-9 W2 file-ownership
 * split, QUEUE row). Tests mount the factory directly.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Paginated } from "@gogo/shared/api/envelope";
import { moneyEndpoints, type BalancesRead, type Settlement } from "@gogo/shared/domains/money";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { epochMicrosExpr } from "../http/keyset-cursor.js";
import { authContextOf } from "../http/require-auth.js";
import { createRequireTripMember, tripContextOf, UUID_RE } from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import {
  decodeSettlementCursor,
  encodeSettlementCursor,
  settlementCursorPredicate,
} from "./cursor.js";
import { createSettlement, deleteSettlement, loadBalancesDoc } from "./service.js";
import { toSettlementWire } from "./serialize.js";

export interface SettlementsRouterDeps {
  db: DbClient;
}

/**
 * S2 default page size when the client omits `limit` (the hard cap, 100,
 * lives in the shared `SettlementListQuerySchema` — trips convention).
 * [I-8] Module-local rather than `config.ts`: the W2 file-ownership split
 * keeps this task out of shared files a parallel engineer may touch; T-9.4
 * (the wiring closer) may hoist it beside its siblings.
 */
export const SETTLEMENTS_PAGE_SIZE_DEFAULT = 50;

export function createSettlementsRouter(deps: SettlementsRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:settlementId` → the same indistinguishable 404 (module doc). */
  const validSettlementId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/balances — the B1 computed document (R-money-8/9/10):
  // signed member nets (Σ = 0), zero-omitted pairwise `Balance` rows, and the
  // always-returned simplified transfer list (the toggle is client-side).
  // Computed on read via the SHARED math — never stored, no query params
  // (the descriptor carries none by design).
  // -------------------------------------------------------------------------
  router.get(moneyEndpoints.getBalances.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const body = await loadBalancesDoc(deps.db, { tripId });
    return c.json(body satisfies BalancesRead);
  });

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/settlements — record a settlement (S1). Party rule,
  // base-currency rule, membership of both parties, and the atomic
  // request-link flip are the service's (R-money-11..14, 18). 201.
  // -------------------------------------------------------------------------
  router.post(
    moneyEndpoints.createSettlement.path,
    zValidator("json", moneyEndpoints.createSettlement.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const input = c.req.valid("json");

      const row = await createSettlement(deps.db, { tripId, callerId: userId, input });
      return c.json(toSettlementWire(row) satisfies Settlement, 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/settlements — the ledger list (S2), `settled_at DESC,
  // id DESC` (id is the deterministic tiebreaker) on the module's signed
  // keyset cursor (settled_at is client-suppliable — see cursor.ts);
  // malformed cursors fall back to page 1 (opaque server-minted token).
  // -------------------------------------------------------------------------
  router.get(
    moneyEndpoints.listSettlements.path,
    zValidator("query", moneyEndpoints.listSettlements.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const query = c.req.valid("query");
      const pageSize = query.limit ?? SETTLEMENTS_PAGE_SIZE_DEFAULT;
      const cursor = query.cursor ? decodeSettlementCursor(query.cursor) : null;

      // pageSize + 1 sentinel: know whether a next page exists without ever
      // minting a cursor that dereferences to an empty page.
      const rows = await deps.db
        .select({
          settlement: schema.settlements,
          settledMicros: epochMicrosExpr(schema.settlements.settledAt),
        })
        .from(schema.settlements)
        .where(
          and(
            eq(schema.settlements.tripId, tripId),
            ...(cursor ? [settlementCursorPredicate(cursor)] : []),
          ),
        )
        .orderBy(sql`${schema.settlements.settledAt} DESC, ${schema.settlements.id} DESC`)
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeSettlementCursor({ settledMicros: last.settledMicros, id: last.settlement.id })
          : null;

      const body: Paginated<Settlement> = {
        items: page.map((row) => toSettlementWire(row.settlement)),
        nextCursor,
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/settlements/:settlementId — the 24 h recorder-only
  // correction window (S3, R-money-15); linked requests reopen atomically.
  // 204.
  // -------------------------------------------------------------------------
  router.delete(moneyEndpoints.deleteSettlement.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const { userId } = authContextOf(c);
    const settlementId = validSettlementId(c.req.param("settlementId"));
    if (!settlementId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    await deleteSettlement(deps.db, { tripId, settlementId, callerId: userId });
    return c.body(null, 204);
  });

  return router;
}
