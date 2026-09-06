/**
 * Settle-request domain service (T-9.4 / MON-5) — Q1–Q3, money spec §2
 * R-money-16..19 + §3.2, §3.6; schema spec §3.3.25. Plain functions over a
 * transaction-capable `DbClient` + typed inputs, no Hono imports; failures
 * are typed `HttpError`s (the sibling service.ts pattern).
 *
 * LAW #2: the pairwise-debt default (R-money-16) is read straight from the
 * T-9.3 balances service (`loadBalancesDoc` — shared `computeBalances`
 * underneath); this module never re-implements netting. `pairwiseDebt` below
 * only PROJECTS one directed edge out of the already-computed document.
 *
 * LOCK ORDER (canonical chain: expenses/service.ts module doc — trips lead):
 * `createSettleRequest` takes the trip row `FOR UPDATE` FIRST, then inserts
 * the request; `cancelSettleRequest` locks only the request row (tail
 * position — no transaction here acquires anything after it). The trips lock
 * on create is the R-trips-22 twin: the request row is one of the PATCH
 * probe's three EXISTS arms, so it must never be born carrying a stale base
 * currency — creation serializes against a racing base-currency PATCH
 * exactly like the first expense does (expenses/service.ts, T-6.1 TOCTOU).
 *
 * IMPLICIT-LOCK AUDIT (the PR #30 landmine — a no-cycle claim must audit RI
 * `FOR KEY SHARE` too): the request insert key-shares its parents — `trips`
 * (already explicitly held by THIS transaction — no new edge) and `users`
 * (from/to) — so the trips → users edge exists here exactly as on expense
 * create, and account deletion runs the opposite users-first chain. Same
 * class, same absorption: ONE bounded 40P01 retry (`withDeadlockRetry`
 * below; the class is QUEUE-tracked repo-wide at PR #30 R1). Cancel updates
 * only `status` on the request row — no FK column moves, so RI takes no
 * parent locks and no retry is needed.
 *
 * DRIVER: writes run in `db.transaction` — prod client is the Neon WebSocket
 * `Pool`, never Neon-HTTP (landmine #1: its `.transaction()` throws).
 *
 * INTERPRETATIONS (Law #4 — numbered; mirrored in the PR body):
 *  [I-1] `resolved` is derived purely from the live directed debt:
 *        `pairwiseDebt(from → to) ≤ 0`, regardless of `status`. R-money-18
 *        pins only debt-zero ⇒ resolved; no status⇒resolved rule exists and
 *        none is invented (a request settled through S1 with residual debt
 *        reads `status: 'settled', resolved: false` — both fields are
 *        truthful and the client renders both).
 *  [I-2] An EXPLICIT `amount_cents` is accepted regardless of the current
 *        debt (zero, negative, smaller, larger): R-money-16's CONFLICT arm
 *        fires only on the defaulting path ("… when that debt is zero or
 *        negative AND no explicit amount is given"), and no amount
 *        constraint exists elsewhere — the S1 [I-9] precedent (balances stay
 *        truthful because they are computed).
 *  [I-3] `created_by` on the wire = `to_user_id`: creditor = creator is the
 *        R-money-16 invariant and the §3.3.25 entity carries no separate
 *        column (requests-serialize.ts).
 *  [I-4] The wire `link` is the https universal form on the shared
 *        `LINK_DOMAIN` placeholder; the `gogo://` mirror is client-composed
 *        (requests-serialize.ts module doc — the ruling's "primary" half is
 *        the client share flow's).
 *  [I-5] Q1 error split: debtor = caller and debtor-not-a-member are 400
 *        VALIDATION_FAILED (§3.2 error table pins both under 400); a proven
 *        member naming the ids leaks nothing (§3.4 member visibility).
 *  [I-6] Q3 cancel of a non-open request folds `settled` and `cancelled`
 *        into ONE 409 (§3.2: "cancel of a non-open request" — no
 *        per-status code is documented). Cancel is NOT idempotent: a second
 *        cancel 409s, matching the spec's wording over converge-to-204.
 */
import type { Balance, SettleRequestCreate } from "@gogo/shared/domains/money";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { isDeadlockError } from "../expenses/service.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";
import { loadBalancesDoc } from "./service.js";
import type { SettlementRequestRow } from "./serialize.js";

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

/** The requester (creditor) row joined for Q2's R-money-17 disclosure. */
type UserRow = typeof schema.users.$inferSelect;

export interface SettleRequestReadResult {
  row: SettlementRequestRow;
  /** [I-1] — live directed debt ≤ 0. */
  resolved: boolean;
}

export interface SettleRequestDetailResult extends SettleRequestReadResult {
  requester: UserRow;
}

/**
 * Project the directed debt `from → to` out of a computed pairwise document
 * (rows are one per unordered pair, `net_cents` positive = counterparty owes
 * user_id; zero-net pairs are omitted). Pure — unit-tested.
 */
export function pairwiseDebt(
  pairwise: readonly Balance[],
  fromUserId: string,
  toUserId: string,
): number {
  for (const row of pairwise) {
    if (row.user_id === toUserId && row.counterparty_id === fromUserId) {
      // Positive net: counterparty (the debtor) owes user_id (the creditor).
      return row.net_cents > 0 ? row.net_cents : 0;
    }
    if (row.user_id === fromUserId && row.counterparty_id === toUserId) {
      // Positive net: counterparty (the creditor) owes user_id (the debtor) —
      // the debt in OUR direction is the negative side.
      return row.net_cents < 0 ? -row.net_cents : 0;
    }
  }
  return 0;
}

/** ONE bounded 40P01 retry — module-doc implicit-lock residual (PR #30 class). */
async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDeadlockError(error)) throw error;
    return run();
  }
}

/** The live directed debt, read through the T-9.3 balances service. */
async function currentDebt(
  reader: Reader,
  tripId: string,
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  const doc = await loadBalancesDoc(reader, { tripId });
  return pairwiseDebt(doc.pairwise, fromUserId, toUserId);
}

/**
 * Q1: create a settle-up request (R-money-16) — creditor-only by
 * construction (`to_user_id` = caller; the body carries no recipient field),
 * `amount_cents` defaulting to the live pairwise debt (409 when that debt is
 * ≤ 0 and no explicit amount rides the body — [I-2]), currency stamped from
 * the trip base under the trips lock (module doc).
 */
export async function createSettleRequest(
  db: DbClient,
  args: { tripId: string; callerId: string; input: SettleRequestCreate },
): Promise<SettleRequestReadResult> {
  return withDeadlockRetry(() => createSettleRequestOnce(db, args));
}

async function createSettleRequestOnce(
  db: DbClient,
  args: { tripId: string; callerId: string; input: SettleRequestCreate },
): Promise<SettleRequestReadResult> {
  const { tripId, callerId, input } = args;

  return db.transaction(async (tx) => {
    // FIRST acquisition (lock order: trips leads the chain — module doc).
    const [trip] = await tx
      .select({ baseCurrency: schema.trips.baseCurrency })
      .from(schema.trips)
      .where(eq(schema.trips.id, tripId))
      .for("update");
    if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    // [I-5] debtor = caller → 400 (§3.2 "debtor = caller"). The caller is the
    // creditor by construction, so this also makes the DB's from≠to CHECK
    // unreachable through the API.
    if (input.from_user_id === callerId) {
      throw new HttpError("VALIDATION_FAILED", "you cannot send yourself the bill", {
        from_user_id: "must not be the caller",
      });
    }

    // [I-5] debtor must be a CURRENT trip member (§3.2 "debtor not a member").
    const [debtor] = await tx
      .select({ userId: schema.tripMembers.userId })
      .from(schema.tripMembers)
      .where(
        and(
          eq(schema.tripMembers.tripId, tripId),
          eq(schema.tripMembers.userId, input.from_user_id),
        ),
      );
    if (!debtor) {
      throw new HttpError("VALIDATION_FAILED", "from_user_id must be a current trip member", {
        from_user_id: "not a member",
      });
    }

    // R-money-16 default: the live directed debt from the debtor to the
    // caller, via the T-9.3 balances service (never re-implemented — Law #2).
    const debt = await currentDebt(tx, tripId, input.from_user_id, callerId);
    let amountCents: number;
    if (input.amount_cents !== undefined) {
      amountCents = input.amount_cents; // [I-2] explicit amount always accepted
    } else {
      if (debt <= 0) {
        throw new HttpError("CONFLICT", "no outstanding debt to bill and no amount given", {
          reason: "no_outstanding_debt",
        });
      }
      amountCents = debt;
    }

    const [row] = await tx
      .insert(schema.settlementRequests)
      .values({
        tripId,
        fromUserId: input.from_user_id,
        toUserId: callerId,
        amountCents,
        // R-money-13 convention (§3.3.25): trip base, read under the lock.
        currency: trip.baseCurrency,
        note: input.note ?? null,
      })
      .returning();
    if (!row) throw new HttpError("INTERNAL", "settle-request insert returned no row");

    return { row, resolved: debt <= 0 };
  });
}

/**
 * Q2: trip-scoped detail read — the request plus the requester's (creditor's)
 * user row for the R-money-17 minimum-disclosure profile. `null` = absent /
 * wrong-trip (the route folds it into the indistinguishable 404). Cancelled
 * and settled requests ARE returned — the deep link must render a resolved /
 * cancelled state, never 404 (nav §2.3 registry row).
 */
export async function getSettleRequestDetail(
  db: Reader,
  args: { tripId: string; requestId: string },
): Promise<SettleRequestDetailResult | null> {
  const [found] = await db
    .select({ request: schema.settlementRequests, requester: schema.users })
    .from(schema.settlementRequests)
    .innerJoin(schema.users, eq(schema.users.id, schema.settlementRequests.toUserId))
    .where(
      and(
        eq(schema.settlementRequests.id, args.requestId),
        eq(schema.settlementRequests.tripId, args.tripId),
      ),
    );
  if (!found) return null;

  const resolved =
    (await currentDebt(db, args.tripId, found.request.fromUserId, found.request.toUserId)) <= 0;
  return { row: found.request, requester: found.requester, resolved };
}

/**
 * Q3: cancel (soft — `status = 'cancelled'`, R-money-16/Q3 descriptor;
 * the row survives so the link keeps rendering). Creator-only ([I-3]:
 * creator = creditor = `to_user_id`); non-open → 409 ([I-6]). `FOR UPDATE`
 * fences a concurrent S1 settle racing the cancel — the loser re-reads a
 * non-open status and 409s.
 */
export async function cancelSettleRequest(
  db: DbClient,
  args: { tripId: string; requestId: string; callerId: string },
): Promise<void> {
  const { tripId, requestId, callerId } = args;

  await db.transaction(async (tx) => {
    // Lock order: the request row is the chain tail — nothing follows it.
    const [row] = await tx
      .select({
        id: schema.settlementRequests.id,
        toUserId: schema.settlementRequests.toUserId,
        status: schema.settlementRequests.status,
      })
      .from(schema.settlementRequests)
      .where(
        and(
          eq(schema.settlementRequests.id, requestId),
          eq(schema.settlementRequests.tripId, tripId),
        ),
      )
      .for("update");
    if (!row) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    // 403 is safe — membership already proved the trip exists (gate posture),
    // and request existence is member-visible via Q2.
    if (row.toUserId !== callerId) {
      throw new HttpError("FORBIDDEN", "only the request creator may cancel it");
    }

    // [I-6] settled and already-cancelled fold into one 409.
    if (row.status !== "open") {
      throw new HttpError("CONFLICT", "only an open settle-request can be cancelled", {
        reason: "request_not_open",
      });
    }

    await tx
      .update(schema.settlementRequests)
      .set({ status: "cancelled" })
      .where(eq(schema.settlementRequests.id, row.id));
  });
}
