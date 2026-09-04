/**
 * Expenses routes (T-9.2 / MON-2): GET/POST `/trips/:tripId/expenses`,
 * GET/PATCH/DELETE `/trips/:tripId/expenses/:expenseId` — money spec §3.1
 * E1–E5, wire shapes from `@gogo/shared/domains/money` only. Covers
 * R-money-1/2/4/5/6/7 + R-money-25/26/27.
 *
 * AUTHZ POSTURE (bookings routes precedent, followed exactly): runs behind
 * the app-wide `requireAuth`; every route sits behind `requireTripMember` —
 * a non-member's 404 is byte-identical to an absent trip's (R-money-25,
 * F-038 harness). The route gate stays `viewer` on ALL FIVE routes:
 * creation is open to every member INCLUDING viewers (R-money-26 — "viewers
 * are travelers, not spectators"), and edit/delete authz is
 * creator-or-owner, which no role gate can express (a viewer edits their
 * OWN expense; an editor may not touch another's) — the service enforces it
 * (403 for a proven member, per the §3.8 matrix). No param zValidator on
 * `:tripId` (the gate folds malformed ids into the same 404);
 * `:expenseId` is a gate-adjacent id param — in-handler `UUID_RE` pre-check
 * folds malformed values into the SAME indistinguishable 404 (server rule:
 * a param 400 is a distinguishable door), and the trip-scoped service
 * lookup makes a wrong-trip expenseId identical to an absent one.
 *
 * WRITE PATH: every mutation goes through the expense domain service
 * (service.ts — R-money-1's single atomic write path); this router owns
 * only wire validation, authz context, pagination, and serialization.
 *
 * SOFT-DELETE SURFACE (R-money-27) — Law #4 interpretations, recorded here
 * and in the T-9.2 PR body (the spec pins soft-delete + "default lists
 * exclude / audit visible" but not the per-endpoint surface):
 *  1. E2 (list) always excludes soft-deleted rows — the shared
 *     `ExpenseListQuery` carries no include-deleted switch, so "default
 *     list" is the only list. (T-9.6 may add a wire param if the history
 *     screen needs listed audit entries — a shared-schema change, not
 *     improvised here.)
 *  2. E3 (detail) RETURNS a soft-deleted expense, `deleted_at`/`deleted_by`
 *     populated — the wire schema carries the audit pair precisely so the
 *     deletion can render ("Sean deleted 'Dinner ¥12,000'", client spec
 *     R-cmoney-13).
 *  3. E4 (PATCH) on a deleted expense → 409 CONFLICT (`expense_deleted`):
 *     the audit trail must stay what the deleter deleted; no undelete
 *     endpoint exists in v1.
 *  4. E5 (DELETE) on an already-deleted expense → 204, row untouched —
 *     idempotent converge; the FIRST deleter's audit pair is the record.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, exists, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { moneyEndpoints, type Expense } from "@gogo/shared/domains/money";
import type { Paginated } from "@gogo/shared/api/envelope";
import { EXPENSES_PAGE_SIZE_DEFAULT } from "../config.js";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { apiError, NOT_FOUND_MESSAGE, type RequestVars } from "../http/errors.js";
import { epochMicrosExpr } from "../http/keyset-cursor.js";
import { authContextOf } from "../http/require-auth.js";
import {
  createRequireTripMember,
  tripContextOf,
  UUID_RE,
} from "../http/require-trip-member.js";
import { rejectInvalidBody } from "../http/validation.js";
import {
  decodeExpenseCursor,
  encodeExpenseCursor,
  expenseCursorPredicate,
} from "./cursor.js";
import {
  createExpense,
  expenseSharesJsonExpr,
  getExpenseWithShares,
  softDeleteExpense,
  updateExpense,
} from "./service.js";
import { toExpenseWire } from "./serialize.js";

export interface ExpensesRouterDeps {
  db: DbClient;
}

export function createExpensesRouter(deps: ExpensesRouterDeps): Hono<RequestVars> {
  const router = new Hono<RequestVars>();
  const requireTripMember = createRequireTripMember({ db: deps.db });

  /** Malformed `:expenseId` → the same indistinguishable 404 (module doc). */
  const validExpenseId = (raw: string | undefined): string | null =>
    raw !== undefined && UUID_RE.test(raw) ? raw : null;

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/expenses — E2: paginated list, newest first
  // (`spent_at DESC, created_at DESC, id DESC` — the determinism tiebreaker;
  // matches the `(trip_id, spent_at)` index). Filters per §3.2: `category`,
  // `member` (payer OR share-holder), `from`/`to` on `spent_at`. Soft-deleted
  // rows excluded (module-doc interpretation 1). Keyset-paginated; malformed
  // cursors fall back to page 1 (no cursor 400 is documented).
  // -------------------------------------------------------------------------
  router.get(
    moneyEndpoints.listExpenses.path,
    zValidator("query", moneyEndpoints.listExpenses.query, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const query = c.req.valid("query");
      const pageSize = query.limit ?? EXPENSES_PAGE_SIZE_DEFAULT;
      const decoded = query.cursor ? decodeExpenseCursor(query.cursor) : null;

      const predicates: SQL[] = [
        eq(schema.expenses.tripId, tripId),
        isNull(schema.expenses.deletedAt),
      ];
      if (query.category !== undefined) {
        predicates.push(eq(schema.expenses.category, query.category));
      }
      if (query.member !== undefined) {
        // §3.2: `member` matches payer OR share-holder.
        const memberMatch = or(
          eq(schema.expenses.paidBy, query.member),
          exists(
            deps.db
              .select({ one: sql`1` })
              .from(schema.expenseShares)
              .where(
                and(
                  eq(schema.expenseShares.expenseId, schema.expenses.id),
                  eq(schema.expenseShares.userId, query.member),
                ),
              ),
          ),
        );
        if (memberMatch) predicates.push(memberMatch);
      }
      if (query.from !== undefined) predicates.push(gte(schema.expenses.spentAt, query.from));
      if (query.to !== undefined) predicates.push(lte(schema.expenses.spentAt, query.to));
      if (decoded) predicates.push(expenseCursorPredicate(decoded));

      // pageSize + 1 sentinel: know whether a next page exists without ever
      // minting a cursor that dereferences to an empty page. Shares ride the
      // SAME statement as a correlated json_agg — one snapshot, so a
      // concurrent share replacement can never desync amount vs shares on a
      // read (round-1; `expenseSharesJsonExpr` doc owns the reasoning).
      const rows = await deps.db
        .select({
          expense: schema.expenses,
          shares: expenseSharesJsonExpr(),
          createdMicros: epochMicrosExpr(schema.expenses.createdAt),
        })
        .from(schema.expenses)
        .where(and(...predicates))
        .orderBy(
          sql`${schema.expenses.spentAt} DESC, ${schema.expenses.createdAt} DESC, ${schema.expenses.id} DESC`,
        )
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > pageSize && last
          ? encodeExpenseCursor({
              spentAt: last.expense.spentAt,
              createdMicros: last.createdMicros,
              id: last.expense.id,
            })
          : null;

      const body: Paginated<Expense> = {
        items: page.map((row) => toExpenseWire(row.expense, row.shares)),
        nextCursor,
      };
      return c.json(body);
    },
  );

  // -------------------------------------------------------------------------
  // POST /trips/:tripId/expenses — E1: expense + RESOLVED shares, atomic
  // (R-money-1/2; split math ran client-side — the server only ever
  // re-validates, §3.3). Gate stays `viewer`: R-money-26. 201.
  // -------------------------------------------------------------------------
  router.post(
    moneyEndpoints.createExpense.path,
    zValidator("json", moneyEndpoints.createExpense.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const input = c.req.valid("json");

      const result = await createExpense(deps.db, { tripId, userId, input });
      return c.json(toExpenseWire(result.expense, result.shares) satisfies Expense, 201);
    },
  );

  // -------------------------------------------------------------------------
  // GET /trips/:tripId/expenses/:expenseId — E3: detail + shares. Returns
  // soft-deleted expenses WITH the audit pair (module-doc interpretation 2).
  // -------------------------------------------------------------------------
  router.get(moneyEndpoints.getExpense.path, requireTripMember(), async (c) => {
    const { tripId } = tripContextOf(c);
    const expenseId = validExpenseId(c.req.param("expenseId"));
    if (!expenseId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const found = await getExpenseWithShares(deps.db, { tripId, expenseId });
    if (!found) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
    return c.json(toExpenseWire(found.expense, found.shares) satisfies Expense);
  });

  // -------------------------------------------------------------------------
  // PATCH /trips/:tripId/expenses/:expenseId — E4: partial update; coupling
  // rule in the wire schema; accepted shares REPLACE the set atomically;
  // creator-or-owner in the service (module doc). Post-state response.
  // -------------------------------------------------------------------------
  router.patch(
    moneyEndpoints.updateExpense.path,
    zValidator("json", moneyEndpoints.updateExpense.body, (result, c) =>
      result.success ? undefined : rejectInvalidBody(c, result.error),
    ),
    requireTripMember(),
    async (c) => {
      const { tripId, role } = tripContextOf(c);
      const { userId } = authContextOf(c);
      const expenseId = validExpenseId(c.req.param("expenseId"));
      if (!expenseId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);
      const input = c.req.valid("json");

      const result = await updateExpense(deps.db, { tripId, expenseId, userId, role, input });
      return c.json(toExpenseWire(result.expense, result.shares) satisfies Expense);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /trips/:tripId/expenses/:expenseId — E5: SOFT delete, audit pair
  // set (R-money-27); idempotent on the already-deleted row (module-doc
  // interpretation 4). 204.
  // -------------------------------------------------------------------------
  router.delete(moneyEndpoints.deleteExpense.path, requireTripMember(), async (c) => {
    const { tripId, role } = tripContextOf(c);
    const { userId } = authContextOf(c);
    const expenseId = validExpenseId(c.req.param("expenseId"));
    if (!expenseId) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    const result = await softDeleteExpense(deps.db, { tripId, expenseId, userId, role });
    if (!result) return apiError(c, "NOT_FOUND", NOT_FOUND_MESSAGE);

    return c.body(null, 204);
  });

  return router;
}
