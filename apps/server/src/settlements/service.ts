/**
 * Settlements + balances domain service (T-9.3 / MON-3, MON-4) — money spec
 * §2 B1 + S1–S3, §3.4 balance computation, §3.5 simplification; schema spec
 * §3.3.14. Plain functions over a transaction-capable `DbClient` + typed
 * inputs, no Hono imports; failures are typed `HttpError`s (the bookings
 * service.ts module-boundary pattern).
 *
 * LAW #2: every cent of math below is the SHARED implementation —
 * `computeBalances` / `allocateProportional` (inside it) / `simplifyDebts`
 * from `@gogo/shared/domains/money` (merged cf6f991). This module assembles
 * rows and documents; it never re-implements allocation or netting.
 *
 * DRIVER: multi-row atomic writes (settlement + request flip — R-money-18;
 * settlement delete + request reopen — R-money-15) run in `db.transaction` —
 * prod client is the Neon WebSocket `Pool`, never Neon-HTTP (landmine #1:
 * its `.transaction()` throws; postgres-js tests can't catch it).
 *
 * LOCK ORDER (this module's segment of the global chain — canonical full
 * chain: expenses/service.ts module doc, synced T-9.4; the chain leads with
 * **trips** and tails … → **settlements → settlement_requests** → budgets).
 * `deleteSettlement` takes the settlement row FOR UPDATE first, then its
 * linked request rows; `createSettlement` locks only the linked request row
 * (its settlement row is a fresh insert). No transaction ever acquires a
 * settlement lock while holding a request lock — no EXPLICIT cycle. ⚠️ A
 * no-cycle claim must audit IMPLICIT locks too (PR #30 R1 landmine): the
 * settlement insert takes RI `FOR KEY SHARE` on `users` (from/to/created_by)
 * and `trips`, so the insert-vs-account-deletion AB-BA class documented at
 * the canonical home exists on S1 as well (repo-wide class, QUEUE-tracked
 * at PR #30 R1; Postgres breaks the cycle — the narrow same-user window
 * surfaces as a rare 40P01). Settle-request creation (T-9.4,
 * requests-service.ts) takes the trips lock first and absorbs its instance
 * of the class with a bounded retry.
 *
 * INTERPRETATIONS (Law #4 — numbered; mirrored in the PR body):
 *  [I-1] B1 `members[]` membership: current trip members ALWAYS appear (net 0
 *        when they have no history); a user referenced only by history (an
 *        ex-member, R-money-8/28) appears only while at least one NONZERO
 *        pairwise edge references them — fully-settled ex-members drop out.
 *        Derived from R-money-8 ("participates in the math"), the B1 note
 *        ("ex-members appear wherever history references them" — the
 *        zero-omitted pairwise IS where history still references them), and
 *        the W2 dispatch ruling ("members who left still appear while
 *        non-zero"). Σ nets stays 0: dropped users provably net 0 (all their
 *        edges are zero), added users net 0.
 *  [I-2] S1 counterparty membership: BOTH settlement parties must be current
 *        trip members → non-member counterparty is 400 VALIDATION_FAILED
 *        (W2 dispatch/QUEUE party rule "payer/payee distinct trip members";
 *        mirrors R-money-5's posture for expense participants). Consequence
 *        flagged for the spec pass: an ex-member's frozen debt can only be
 *        corrected among current members (counter-entries also bind to the
 *        party rule).
 *  [I-3] S1 request-link failures all fold into 409 CONFLICT — unknown id,
 *        another trip's request, non-open status (the spec's S1 error table
 *        defines only 409 for request problems; a nonexistent request "is
 *        not open", and one shared code gives a member probing foreign
 *        request ids no existence oracle).
 *  [I-4] S1 "between a different pair" = the ORDERED pair: the settlement's
 *        from/to must equal the request's from/to exactly. A reverse-
 *        direction payment INCREASES the billed debt — flipping the request
 *        to `settled` off it would be a correctness bug, so it 409s.
 *  [I-5] S3 "within 24 hours" is inclusive: `now − created_at ≤ 24 h`
 *        deletes; strictly past the window → 403 (counter-entry path).
 *  [I-6] S1 `settled_at` "not future" is strict against the server clock —
 *        the spec allows no skew tolerance, so none is granted.
 *  [I-9] A request-linked settlement's amount is NOT constrained to the
 *        request's amount — R-money-18 links + flips only; no amount rule
 *        exists in the spec and none is invented (partial/over-settlement is
 *        representable; balances stay truthful because they are computed).
 * [I-10] Degenerate ledger rows (an expense with zero share rows, or an FX
 *        expense whose shares sum to 0) are SKIPPED in balance math. Both are
 *        unreachable through the only write path (E1/E4's R-money-2 exact-sum
 *        invariant: shares must sum to `amount_cents > 0`), but a
 *        hand-corrupted row must degrade to "ignored", not 500 the balances
 *        read from inside `allocateProportional`.
 */
import {
  computeBalances,
  simplifyDebts,
  type BalancesRead,
  type ExpenseForBalance,
  type SettlementCreate,
  type SettlementForBalance,
} from "@gogo/shared/domains/money";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";
import type { SettlementRow } from "./serialize.js";

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

/** R-money-15 fat-finger window — recorder-only hard delete, then immutable. */
export const SETTLEMENT_DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Ordering-only comparator matching the shared module's canonical order
 * (money spec §3.3: ascending canonical lowercase `user_id`). Used to keep
 * the assembled `members[]` deterministic — all MATH stays in `@gogo/shared`.
 */
function canonicalCompare(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Balances (B1 — R-money-8/9/10)
// ---------------------------------------------------------------------------

export interface BalancesLedger {
  expenses: readonly ExpenseForBalance[];
  settlements: readonly SettlementForBalance[];
}

/**
 * Assemble the B1 response document from pre-loaded rows — PURE (unit-tested
 * against the money spec §3.4 fixtures). The math is the shared
 * `computeBalances` (which base-allocates FX expenses via
 * `allocateProportional` per §3.4 step 2 — R-money-9) + `simplifyDebts`
 * (§3.5 — R-money-10); this function only applies the [I-1] membership rule,
 * stamps `trip_id` onto pairwise rows, and returns both views (the
 * pairwise/simplified toggle is client-side — R-money-10, resolved Gate 2).
 */
export function assembleBalancesDoc(args: {
  tripId: string;
  baseCurrency: string;
  currentMemberIds: readonly string[];
  ledger: BalancesLedger;
}): BalancesRead {
  // [I-10] degenerate-row guard — see the module doc. `allocateProportional`
  // (rightly) throws on an empty or all-zero weight set; those states are
  // unreachable via E1/E4's exact-sum invariant, so a corrupted row degrades
  // to "ignored" instead of failing every balance read for the trip.
  const usable = args.ledger.expenses.filter((expense) => {
    if (expense.shares.length === 0) return false;
    const base = expense.base_amount_cents ?? expense.amount_cents;
    if (base !== expense.amount_cents && expense.shares.every((s) => s.share_cents === 0)) {
      return false;
    }
    return true;
  });

  const { members: computed, pairwise } = computeBalances(usable, args.ledger.settlements);

  // Users still referenced by an outstanding (nonzero) pairwise edge — the
  // shared function already omits zero-net pairs, so presence here IS the
  // [I-1] "history still references them while non-zero" condition.
  const outstanding = new Set<string>();
  for (const pair of pairwise) {
    outstanding.add(pair.user_id);
    outstanding.add(pair.counterparty_id);
  }
  const memberSet = new Set(args.currentMemberIds);
  const referenced = new Set(computed.map((m) => m.user_id));

  const members = [
    // Referenced users: current members always; ex-members per [I-1].
    ...computed.filter((m) => memberSet.has(m.user_id) || outstanding.has(m.user_id)),
    // Current members with no ledger history at all: net 0 (Σ unchanged).
    ...args.currentMemberIds
      .filter((id) => !referenced.has(id))
      .map((user_id) => ({ user_id, net_cents: 0 })),
  ].sort((a, b) => canonicalCompare(a.user_id, b.user_id));

  return {
    currency: args.baseCurrency,
    members,
    pairwise: pairwise.map((pair) => ({
      trip_id: args.tripId,
      user_id: pair.user_id,
      counterparty_id: pair.counterparty_id,
      net_cents: pair.net_cents,
    })),
    // Always returned (R-money-10); Σ members = 0 holds by construction
    // ([I-1] note), which is `simplifyDebts`' input contract.
    simplified: simplifyDebts(members),
  };
}

/** The trip's base currency. Gate-proven trips always resolve; defensive 404. */
export async function readTripBaseCurrency(db: Reader, tripId: string): Promise<string> {
  const [trip] = await db
    .select({ baseCurrency: schema.trips.baseCurrency })
    .from(schema.trips)
    .where(eq(schema.trips.id, tripId));
  if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return trip.baseCurrency;
}

/**
 * B1: load the trip's ledger and compute balances ON READ (R-money-8 —
 * computed, never stored) in the trip base currency. Soft-deleted expenses
 * and their shares are excluded at the query (R-db-21; R-money-27).
 */
export async function loadBalancesDoc(db: Reader, args: { tripId: string }): Promise<BalancesRead> {
  const { tripId } = args;

  const baseCurrency = await readTripBaseCurrency(db, tripId);

  const memberRows = await db
    .select({ userId: schema.tripMembers.userId })
    .from(schema.tripMembers)
    .where(eq(schema.tripMembers.tripId, tripId));

  const expenseRows = await db
    .select({
      id: schema.expenses.id,
      paidBy: schema.expenses.paidBy,
      amountCents: schema.expenses.amountCents,
      baseAmountCents: schema.expenses.baseAmountCents,
    })
    .from(schema.expenses)
    .where(and(eq(schema.expenses.tripId, tripId), isNull(schema.expenses.deletedAt)));

  const shareRows = await db
    .select({
      expenseId: schema.expenseShares.expenseId,
      userId: schema.expenseShares.userId,
      shareCents: schema.expenseShares.shareCents,
    })
    .from(schema.expenseShares)
    .innerJoin(schema.expenses, eq(schema.expenses.id, schema.expenseShares.expenseId))
    .where(and(eq(schema.expenses.tripId, tripId), isNull(schema.expenses.deletedAt)));

  const settlementRows = await db
    .select({
      fromUserId: schema.settlements.fromUserId,
      toUserId: schema.settlements.toUserId,
      amountCents: schema.settlements.amountCents,
      currency: schema.settlements.currency,
    })
    .from(schema.settlements)
    .where(eq(schema.settlements.tripId, tripId));

  // R1 blocking (PR #29 review): the R-trips-22 base-currency lock probed
  // only `expenses`, so a settlements-only trip could re-denominate its base
  // and silently corrupt member nets (USD→JPY is a ≈150× mis-statement while
  // the doc claims the new base). The ROOT CAUSE is the trips lock probe —
  // fixed on PR #30's fix leg (outside this module's W2 ownership); THIS is
  // the in-module belt-and-suspenders half: a settlement row whose currency
  // differs from the trip base is a ledger-integrity violation, and the read
  // fails LOUDLY (500 INTERNAL) instead of feeding mis-denominated cents
  // into the math. S1 makes the state unreachable through the API
  // (R-money-13); only direct-DB corruption or the pre-#30 lock gap can
  // produce it — silent mis-denomination is the failure mode this kills.
  for (const row of settlementRows) {
    if (row.currency !== baseCurrency) {
      throw new HttpError(
        "INTERNAL",
        "settlement ledger integrity violation: settlement currency differs from trip base currency",
        { settlements: "currency mismatch" },
      );
    }
  }

  const sharesByExpense = new Map<string, { user_id: string; share_cents: number }[]>();
  for (const share of shareRows) {
    let list = sharesByExpense.get(share.expenseId);
    if (!list) {
      list = [];
      sharesByExpense.set(share.expenseId, list);
    }
    list.push({ user_id: share.userId, share_cents: share.shareCents });
  }

  return assembleBalancesDoc({
    tripId,
    baseCurrency,
    currentMemberIds: memberRows.map((row) => row.userId),
    ledger: {
      expenses: expenseRows.map((row) => ({
        paid_by: row.paidBy,
        amount_cents: row.amountCents,
        base_amount_cents: row.baseAmountCents,
        shares: sharesByExpense.get(row.id) ?? [],
      })),
      settlements: settlementRows.map((row) => ({
        from_user_id: row.fromUserId,
        to_user_id: row.toUserId,
        amount_cents: row.amountCents,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// Settlements (S1–S3 — R-money-11..15, 18)
// ---------------------------------------------------------------------------

/**
 * S1: record a settlement — record-only ledger entry (R-money-11), party-only
 * (R-money-12), always trip base currency (R-money-13), optional request link
 * flipped `settled` in the SAME transaction (R-money-18). Effects are visible
 * to the next balance read by construction (R-money-14 — balances are
 * computed on read from committed rows).
 */
export async function createSettlement(
  db: DbClient,
  args: { tripId: string; callerId: string; input: SettlementCreate },
): Promise<SettlementRow> {
  const { tripId, callerId, input } = args;

  // R-money-12: only one of the two parties may record, regardless of role
  // (a viewer settles their own debts — R-money-26). Caller is gate-proven a
  // member; a member 403 leaks nothing new (require-trip-member posture).
  if (callerId !== input.from_user_id && callerId !== input.to_user_id) {
    throw new HttpError("FORBIDDEN", "only a settlement party may record it");
  }

  // [I-6] settled_at defaults to DB now(); an explicit value must not be in
  // the future (S1 error table), strict against the server clock.
  let settledAt: Date | undefined;
  if (input.settled_at !== undefined) {
    settledAt = new Date(input.settled_at);
    if (settledAt.getTime() > Date.now()) {
      throw new HttpError("VALIDATION_FAILED", "settled_at must not be in the future", {
        settled_at: "future",
      });
    }
  }

  return db.transaction(async (tx) => {
    // R-money-13: settlements are ALWAYS recorded in trip base currency —
    // balances are computed in base, so any other unit would corrupt netting.
    const baseCurrency = await readTripBaseCurrency(tx, tripId);
    if (input.currency !== baseCurrency) {
      throw new HttpError(
        "VALIDATION_FAILED",
        `settlements are recorded in the trip base currency '${baseCurrency}'`,
        { currency: "must equal trip base" },
      );
    }

    // [I-2] both parties must be current trip members (`from ≠ to` is already
    // schema-enforced at the boundary + the DB CHECK).
    const partyIds = [input.from_user_id, input.to_user_id];
    const partyRows = await tx
      .select({ userId: schema.tripMembers.userId })
      .from(schema.tripMembers)
      .where(
        and(eq(schema.tripMembers.tripId, tripId), inArray(schema.tripMembers.userId, partyIds)),
      );
    const partyMembers = new Set(partyRows.map((row) => row.userId));
    if (!partyIds.every((id) => partyMembers.has(id))) {
      throw new HttpError(
        "VALIDATION_FAILED",
        "both settlement parties must be current trip members",
        { party: "not a member" },
      );
    }

    // R-money-18: validate + flip the linked request in the SAME transaction.
    // FOR UPDATE serializes concurrent settles of one request — the loser
    // re-reads a non-open status and 409s instead of double-settling.
    let requestId: string | null = null;
    if (input.request_id !== undefined) {
      const [request] = await tx
        .select({
          id: schema.settlementRequests.id,
          fromUserId: schema.settlementRequests.fromUserId,
          toUserId: schema.settlementRequests.toUserId,
          status: schema.settlementRequests.status,
        })
        .from(schema.settlementRequests)
        .where(
          and(
            eq(schema.settlementRequests.id, input.request_id),
            eq(schema.settlementRequests.tripId, tripId),
          ),
        )
        .for("update");
      // [I-3] unknown / other-trip / non-open all fold into one 409.
      if (!request || request.status !== "open") {
        throw new HttpError("CONFLICT", "settle-request is not open for settlement", {
          reason: "request_not_open",
        });
      }
      // [I-4] ordered-pair match — a reverse payment must not settle it.
      if (request.fromUserId !== input.from_user_id || request.toUserId !== input.to_user_id) {
        throw new HttpError("CONFLICT", "settle-request is between a different pair", {
          reason: "request_pair_mismatch",
        });
      }
      requestId = request.id;
    }

    const [settlement] = await tx
      .insert(schema.settlements)
      .values({
        tripId,
        fromUserId: input.from_user_id,
        toUserId: input.to_user_id,
        amountCents: input.amount_cents,
        currency: input.currency,
        method: input.method,
        note: input.note ?? null,
        ...(settledAt !== undefined ? { settledAt } : {}),
        createdBy: callerId,
      })
      .returning();
    if (!settlement) throw new HttpError("INTERNAL", "settlement insert returned no row");

    if (requestId !== null) {
      // Row is locked + proven `open` above; a zero-row update here is a bug.
      const flipped = await tx
        .update(schema.settlementRequests)
        .set({ status: "settled", settlementId: settlement.id })
        .where(eq(schema.settlementRequests.id, requestId))
        .returning({ id: schema.settlementRequests.id });
      if (flipped.length === 0) {
        throw new HttpError("INTERNAL", "settle-request flip affected no row");
      }
    }

    return settlement;
  });
}

/**
 * S3: the fat-finger correction window (R-money-15) — recorder-only hard
 * delete within 24 h of `created_at` ([I-5] inclusive); afterwards the ledger
 * is immutable and the correction path is a counter-entry. Any linked
 * settle-request reverts to `open` (link cleared) in the SAME transaction.
 *
 * Absent / wrong-trip / (route-level) malformed ids all converge on the
 * indistinguishable 404; member non-recorders get 403 — settlement existence
 * is already member-visible via S2, so the 403 leaks nothing (the
 * require-trip-member 403-after-proven-membership rationale).
 */
export async function deleteSettlement(
  db: DbClient,
  args: { tripId: string; settlementId: string; callerId: string },
): Promise<void> {
  const { tripId, settlementId, callerId } = args;

  await db.transaction(async (tx) => {
    // Lock order: settlements → settlement_requests (module doc).
    const [settlement] = await tx
      .select({
        id: schema.settlements.id,
        createdBy: schema.settlements.createdBy,
        createdAt: schema.settlements.createdAt,
      })
      .from(schema.settlements)
      .where(and(eq(schema.settlements.id, settlementId), eq(schema.settlements.tripId, tripId)))
      .for("update");
    if (!settlement) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    if (settlement.createdBy !== callerId) {
      throw new HttpError("FORBIDDEN", "only the recorder may delete a settlement");
    }
    if (Date.now() - settlement.createdAt.getTime() > SETTLEMENT_DELETE_WINDOW_MS) {
      throw new HttpError(
        "FORBIDDEN",
        "the 24-hour correction window has passed — record a counter-entry instead",
      );
    }

    // Reopen any linked request BEFORE the delete (the FK's ON DELETE SET
    // NULL would clear the link, but the status flip is ours — R-money-15's
    // "linked request reopens" is one atomic unit with the delete). FOR
    // UPDATE fences a concurrent settle racing this correction.
    const linked = await tx
      .select({ id: schema.settlementRequests.id })
      .from(schema.settlementRequests)
      .where(eq(schema.settlementRequests.settlementId, settlement.id))
      .for("update");
    for (const request of linked) {
      await tx
        .update(schema.settlementRequests)
        .set({ status: "open", settlementId: null })
        .where(eq(schema.settlementRequests.id, request.id));
    }

    await tx.delete(schema.settlements).where(eq(schema.settlements.id, settlement.id));
  });
}
