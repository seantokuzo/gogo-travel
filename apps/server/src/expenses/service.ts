/**
 * Expense domain service (T-9.2 / MON-2) — THE single write path for
 * `expenses` + their `expense_shares` (money spec §2 R-money-1: "the
 * `expenses` row and all its `expense_shares` rows in a single database
 * transaction — never partially"). Plain functions over a
 * transaction-capable `DbClient` + typed inputs, no Hono imports; failures
 * are typed `HttpError`s the router maps (bookings/service.ts precedent).
 *
 * INVARIANTS enforced here (in addition to the boundary-validated shared
 * schemas — exact-sum + share ≥ 0 ride `ExpenseCreateSchema` /
 * `ExpenseUpdateSchema`, the server-side R-money-2 re-validation):
 *  - R-money-5  `paid_by` and every INCOMING `shares[].user_id` are current
 *    trip members (bounded by `MAX_EXPENSE_SHARES` at the schema). Stored
 *    rows referencing ex-members stay legal history (R-money-8/28) — an
 *    update that does not touch `paid_by`/`shares` never re-litigates them.
 *  - R-money-6  FX pair presence ⟺ `currency ≠ trip.base_currency`, and the
 *    pair is arithmetically consistent (`fx.ts` — the recorded
 *    interpretation of "consistent").
 *  - E4 coupling  a shares-only PATCH must sum to the STORED amount (the
 *    wire schema can only check body-internal sums); an accepted shares
 *    payload REPLACES the full set in the same transaction.
 *  - R-money-27  DELETE is a soft delete: `deleted_at`/`deleted_by` audit
 *    pair (schema CHECK keeps them together), row + shares survive.
 *  - booking link  `booking_id` must reference a booking of THIS trip
 *    (§3.2: 400, not 404 — the caller is a proven member; the race-window
 *    FK residue converges on the same 400 via `isExpenseBookingFkViolation`).
 *
 * BASE-CURRENCY LOCK (R-trips-22 twin, closes the T-6.1 TOCTOU — QUEUE
 * deferred row): every expense CREATE takes the trip row `FOR UPDATE` first
 * and reads `base_currency` under that lock. The base-currency PATCH path
 * (trips/routes.ts) takes the SAME lock before its has-expenses check, so
 * the two serialize: a first expense either commits before the PATCH's
 * check (→ 409 base_currency_locked) or waits and then validates against
 * the NEW base. Create must always take the lock — "am I the first
 * expense?" cannot be answered race-free any other way. UPDATE/DELETE
 * deliberately do NOT take the trip lock: the expense being written already
 * exists, so the trip has ≥ 1 expense row and `base_currency` is immutable
 * for the rest of its life (soft-deleted rows still count — see the
 * router's interpretation notes).
 *
 * LOCK ORDER — THE CANONICAL CHAIN DOC (global; sibling module docs state
 * their segment and point here — synced at T-9.4, the QUEUE obligations
 * row). Never reorder:
 *
 *   **trips** → users → trip_members → invites → bookings → itinerary_items
 *   → travel_legs → **expenses → expense_shares** → settlements →
 *   settlement_requests → budgets
 *
 * The trip row slots at the FRONT: no existing transaction takes an
 * EXPLICIT trips-row lock before its other acquisitions (trip create locks
 * users only; trip PATCH locks trips first; the trip DELETE member-fence's
 * trip_members → trips-cascade order predates this and stays safe against
 * expense transactions, which take no trip_members locks at all). Expense
 * UPDATE/DELETE lock only the expenses row; shares rows are only ever
 * written while holding their parent expense's lock. Money-tail rules:
 * settlement writes lock settlements → settlement_requests (S3) or the
 * request row alone (S1); settle-request CREATE takes trips first, then
 * inserts the request (requests-service.ts); **budgets writes take the
 * trips row FOR UPDATE FIRST, then the budgets row** (T-9.4 / PR #30
 * interp #7 — the trips PATCH already holds trips-then-budgets for its
 * currency sync, so the opposite acquisition order would be an AB-BA;
 * budgets/service.ts owns the full justification, including its
 * implicit-FK audit: budgets' only FK is the already-held trips row).
 *
 * ⚠️ HONEST RESIDUAL (round-1 security finding — an earlier draft of this
 * doc claimed "no cycle exists", which audited only EXPLICIT locks and was
 * FALSE): row inserts take implicit RI `FOR KEY SHARE` locks on every
 * referenced parent — an expense insert key-shares its `users` rows
 * (paid_by / created_by / share holders) AFTER this transaction already
 * holds the trips lock, i.e. trips → users. Account deletion runs the
 * OPPOSITE chain (its step-0 users-row FOR UPDATE first, trip-scoped locks
 * later), so a user creating an expense while their own account deletion is
 * in flight can AB-BA into Postgres 40P01. The window is narrow (same-user
 * self-race) and Postgres always breaks it; each write path below absorbs
 * the breakage with ONE bounded retry (`withDeadlockRetry`) instead of
 * surfacing a 500. Do NOT "fix" this by reordering acquisitions here — the
 * repo-wide class (created_by-style FK key-shares vs the deletion chain
 * also exists on bookings/itinerary inserts) is tracked as its own QUEUE
 * row filed at PR #30 round 1; sibling modules sync their docs there.
 *
 * DRIVER: every multi-row write runs in `db.transaction` — the prod client
 * is the Neon WebSocket `Pool`, never Neon-HTTP (landmine #1: its
 * `.transaction()` throws; postgres-js tests can't catch it).
 */
import type { ExpenseCreate, ExpenseShare, ExpenseUpdate } from "@gogo/shared/domains/money";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";
import { isFxPairConsistent } from "./fx.js";
import type { ExpenseRow } from "./serialize.js";

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

export interface ExpenseWriteResult {
  expense: ExpenseRow;
  /** Wire-shaped shares (`user_id`/`share_cents`) — the serializer sorts. */
  shares: ExpenseShare[];
}

/**
 * The expense's shares as a single correlated `json_agg` column (round-1
 * A4-class fix): E2/E3 previously read expense row(s) and shares in SEPARATE
 * statements, so a concurrent E4 share replacement between them produced an
 * amount/shares mismatch that fails the wire schema's `sharesSumRule` on the
 * client — the whole page died. One statement = one READ COMMITTED snapshot;
 * the mismatch is structurally impossible (no pin: a race test would have to
 * prove single-statement-ness — pure theater; the existing suites regression
 * the aggregation path via `ExpenseSchema.parse` on every read).
 */
export function expenseSharesJsonExpr(): SQL<ExpenseShare[]> {
  return sql<ExpenseShare[]>`(
    SELECT coalesce(
      json_agg(json_build_object('user_id', es.user_id, 'share_cents', es.share_cents)
               ORDER BY es.user_id),
      '[]'::json
    )
    FROM expense_shares es
    WHERE es.expense_id = ${schema.expenses.id}
  )`;
}

/** The Drizzle-generated FK constraint guarding `expenses.booking_id`. */
export const EXPENSES_BOOKING_FK = "expenses_booking_id_bookings_id_fk";

/**
 * Is this the booking-FK 23503? The in-transaction "booking belongs to this
 * trip" check → insert window is a real race under READ COMMITTED (bookings
 * are hard-deletable), so the constraint is the last line and its violation
 * must converge on the SAME `VALIDATION_FAILED` the check answers — not a
 * 500. Constraint-PRECISE on purpose (the `isPlaceFkViolation` precedent,
 * bookings/service.ts): the other FKs on this write path (trip, users) are
 * gate-/check-proven and should stay loud if they ever fire. 🔴 Driver trap:
 * postgres-js exposes `constraint_name`; pg-protocol's `DatabaseError` (the
 * prod Neon driver) exposes `constraint`. Accept BOTH and walk `cause`.
 */
export function isExpenseBookingFkViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const candidate = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
    };
    if (candidate.code === "23503") {
      const constraint =
        typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : typeof candidate.constraint === "string"
            ? candidate.constraint
            : null;
      return constraint === EXPENSES_BOOKING_FK;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Postgres 40P01 (`deadlock_detected`), walked through `cause` like the FK
 * helper — both driver shapes expose `code` at the same spot.
 */
export function isDeadlockError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === "40P01") return true;
    current = current.cause;
  }
  return false;
}

/**
 * ONE bounded retry for the module-doc residual (trips-lock → implicit
 * users KEY SHARE vs account-deletion's users-first chain): Postgres broke
 * the cycle by aborting us; by rerun time the conflicting transaction has
 * committed or aborted, so the retry re-validates against settled state. A
 * second 40P01 propagates (bounded — never a retry loop). Safe to rerun:
 * the aborted transaction wrote nothing and every check runs again inside
 * the fresh one.
 */
async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDeadlockError(error)) throw error;
    return run();
  }
}

/** Rethrow, mapping the race-window booking-FK violation onto the check's 400. */
function rethrowBookingFkMapped(error: unknown): never {
  if (isExpenseBookingFkViolation(error)) {
    throw new HttpError("VALIDATION_FAILED", "booking_id must reference a booking of this trip", {
      booking_id: "not in this trip",
    });
  }
  throw error;
}

/**
 * R-money-6: FX-pair presence ⟺ non-base currency; present ⇒ consistent.
 * Pure — runs on the MERGED write (create: the body; update: body over
 * stored row).
 */
function assertFxRules(args: {
  amountCents: number;
  currency: string;
  fxRate: string | null;
  baseAmountCents: number | null;
  baseCurrency: string;
}): void {
  const { amountCents, currency, fxRate, baseAmountCents, baseCurrency } = args;
  if (currency === baseCurrency) {
    if (fxRate !== null || baseAmountCents !== null) {
      throw new HttpError(
        "VALIDATION_FAILED",
        "fx_rate and base_amount_cents must be absent when currency equals the trip base currency",
        { fx_rate: "must be absent for base-currency expenses" },
      );
    }
    return;
  }
  if (fxRate === null || baseAmountCents === null) {
    throw new HttpError(
      "VALIDATION_FAILED",
      "fx_rate and base_amount_cents are required when currency differs from the trip base currency",
      { fx_rate: "required with non-base currency" },
    );
  }
  if (!isFxPairConsistent({ amountCents, fxRate, baseAmountCents, currency, baseCurrency })) {
    throw new HttpError(
      "VALIDATION_FAILED",
      "base_amount_cents is inconsistent with amount_cents × fx_rate",
      { base_amount_cents: "inconsistent with fx_rate" },
    );
  }
}

/**
 * R-money-5: every INCOMING participant id must hold a current membership
 * row. One bounded query (`ids` ≤ MAX_EXPENSE_SHARES + 1 by schema cap).
 * The offending ids ride the details: the caller is a proven member and can
 * already read the member list, so naming them leaks nothing (§3.4 member
 * visibility).
 */
async function assertParticipantsAreMembers(
  reader: Reader,
  tripId: string,
  userIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const rows = await reader
    .select({ userId: schema.tripMembers.userId })
    .from(schema.tripMembers)
    .where(and(eq(schema.tripMembers.tripId, tripId), inArray(schema.tripMembers.userId, unique)));
  const members = new Set(rows.map((row) => row.userId));
  const nonMembers = unique.filter((id) => !members.has(id));
  if (nonMembers.length > 0) {
    throw new HttpError(
      "VALIDATION_FAILED",
      "paid_by and every shares[].user_id must be current trip members",
      { non_members: nonMembers },
    );
  }
}

/** §3.2: `booking_id` not in this trip (or absent — same observable) → 400. */
async function assertBookingInTrip(
  reader: Reader,
  tripId: string,
  bookingId: string,
): Promise<void> {
  const [booking] = await reader
    .select({ id: schema.bookings.id })
    .from(schema.bookings)
    .where(and(eq(schema.bookings.id, bookingId), eq(schema.bookings.tripId, tripId)));
  if (!booking) {
    throw new HttpError("VALIDATION_FAILED", "booking_id must reference a booking of this trip", {
      booking_id: "not in this trip",
    });
  }
}

/** The expense's shares, wire-shaped (insert order irrelevant — serializer sorts). */
async function sharesOf(reader: Reader, expenseId: string): Promise<ExpenseShare[]> {
  return reader
    .select({
      user_id: schema.expenseShares.userId,
      share_cents: schema.expenseShares.shareCents,
    })
    .from(schema.expenseShares)
    .where(eq(schema.expenseShares.expenseId, expenseId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Trip-scoped read: an expense id from another trip is unknown here (IDOR
 * posture — the gate's trip is the only world a route can see). `null` =
 * absent; the route folds it into the indistinguishable 404. Soft-deleted
 * expenses ARE returned — E3 is the "visible audit trail" surface
 * (R-money-27; interpretation recorded in the router doc). ONE statement —
 * row + aggregated shares share a snapshot (see `expenseSharesJsonExpr`).
 */
export async function getExpenseWithShares(
  db: Reader,
  args: { tripId: string; expenseId: string },
): Promise<ExpenseWriteResult | null> {
  const [found] = await db
    .select({ expense: schema.expenses, shares: expenseSharesJsonExpr() })
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, args.expenseId), eq(schema.expenses.tripId, args.tripId)));
  if (!found) return null;
  return { expense: found.expense, shares: found.shares };
}

// ---------------------------------------------------------------------------
// Writes (the single write path)
// ---------------------------------------------------------------------------

/**
 * Create (E1): expense + resolved shares, atomic (R-money-1/2). Takes the
 * trip row `FOR UPDATE` FIRST and validates against `base_currency` under
 * that lock (module doc: the T-6.1 TOCTOU's expense side).
 */
export async function createExpense(
  db: DbClient,
  args: { tripId: string; userId: string; input: ExpenseCreate },
): Promise<ExpenseWriteResult> {
  return withDeadlockRetry(() => createExpenseOnce(db, args));
}

async function createExpenseOnce(
  db: DbClient,
  args: { tripId: string; userId: string; input: ExpenseCreate },
): Promise<ExpenseWriteResult> {
  const { tripId, userId, input } = args;

  return db
    .transaction(async (tx) => {
      // FIRST acquisition (lock order: trips leads the chain). Guards the
      // base-currency lock race AND converges the gate-raced-a-delete window
      // on the canonical 404 (trips GET precedent).
      const [trip] = await tx
        .select({ baseCurrency: schema.trips.baseCurrency })
        .from(schema.trips)
        .where(eq(schema.trips.id, tripId))
        .for("update");
      if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      assertFxRules({
        amountCents: input.amount_cents,
        currency: input.currency,
        fxRate: input.fx_rate ?? null,
        baseAmountCents: input.base_amount_cents ?? null,
        baseCurrency: trip.baseCurrency,
      });

      await assertParticipantsAreMembers(tx, tripId, [
        input.paid_by,
        ...input.shares.map((share) => share.user_id),
      ]);

      if (input.booking_id !== undefined) {
        await assertBookingInTrip(tx, tripId, input.booking_id);
      }

      const [expense] = await tx
        .insert(schema.expenses)
        .values({
          tripId,
          description: input.description,
          category: input.category,
          paidBy: input.paid_by,
          amountCents: input.amount_cents,
          currency: input.currency,
          fxRate: input.fx_rate ?? null,
          baseAmountCents: input.base_amount_cents ?? null,
          bookingId: input.booking_id ?? null,
          // Omitted → schema default CURRENT_DATE (§3.2).
          ...(input.spent_at !== undefined ? { spentAt: input.spent_at } : {}),
          createdBy: userId,
        })
        .returning();
      if (!expense) throw new HttpError("INTERNAL", "expense insert returned no row");

      // Zero-cent shares persist as sent — a zero row records participation
      // ("payer covered someone entirely", schema §3.3.13). `.returning()`
      // IS the response share set — no post-insert re-read (round-1 perf).
      const shares = await tx
        .insert(schema.expenseShares)
        .values(
          input.shares.map((share) => ({
            expenseId: expense.id,
            userId: share.user_id,
            shareCents: share.share_cents,
          })),
        )
        .returning({
          user_id: schema.expenseShares.userId,
          share_cents: schema.expenseShares.shareCents,
        });

      return { expense, shares };
    })
    .catch(rethrowBookingFkMapped);
}

/**
 * Update (E4): creator-or-owner (R-money-26 — the router resolved `role`
 * from the membership gate), full merged-row re-validation, shares REPLACE
 * atomically. Locks the expense row `FOR UPDATE` first — concurrent PATCHes
 * serialize; each sees the previous committed state (LWW, the §4
 * "never mixed" concurrency bullet).
 */
export async function updateExpense(
  db: DbClient,
  args: {
    tripId: string;
    expenseId: string;
    userId: string;
    /** Caller's trip role, from the membership gate. */
    role: "owner" | "editor" | "viewer";
    input: ExpenseUpdate;
  },
): Promise<ExpenseWriteResult> {
  return withDeadlockRetry(() => updateExpenseOnce(db, args));
}

async function updateExpenseOnce(
  db: DbClient,
  args: {
    tripId: string;
    expenseId: string;
    userId: string;
    role: "owner" | "editor" | "viewer";
    input: ExpenseUpdate;
  },
): Promise<ExpenseWriteResult> {
  const { tripId, expenseId, userId, role, input } = args;

  return db
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.expenses)
        .where(and(eq(schema.expenses.id, expenseId), eq(schema.expenses.tripId, tripId)))
        .for("update");
      if (!current) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      // R-money-26: creator or trip owner. 403 is safe — membership already
      // proved the trip exists (gate posture).
      if (current.createdBy !== userId && role !== "owner") {
        throw new HttpError(
          "FORBIDDEN",
          "only the expense creator or the trip owner may modify an expense",
        );
      }

      // Soft-deleted expenses are not editable (interpretation — router doc):
      // the audit trail must stay what the deleter deleted.
      if (current.deletedAt !== null) {
        throw new HttpError("CONFLICT", "expense is deleted", { reason: "expense_deleted" });
      }

      // Base currency read WITHOUT a lock — safe by construction: this trip
      // provably has ≥ 1 expense row (the one locked above), so
      // `base_currency` is immutable (R-trips-22; module doc).
      const [trip] = await tx
        .select({ baseCurrency: schema.trips.baseCurrency })
        .from(schema.trips)
        .where(eq(schema.trips.id, tripId));
      if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

      // ---- merged-row validation (body over stored row) ---------------------
      const mergedAmount = input.amount_cents ?? current.amountCents;
      const mergedCurrency = input.currency ?? current.currency;
      const mergedFxRate = input.fx_rate !== undefined ? input.fx_rate : current.fxRate;
      const mergedBaseAmount =
        input.base_amount_cents !== undefined ? input.base_amount_cents : current.baseAmountCents;

      assertFxRules({
        amountCents: mergedAmount,
        currency: mergedCurrency,
        fxRate: mergedFxRate,
        baseAmountCents: mergedBaseAmount,
        baseCurrency: trip.baseCurrency,
      });

      // E4 coupling (§3.2): `amount_cents` present ⇒ `shares` present is
      // schema-enforced; a shares-only body must sum to the STORED amount.
      if (input.shares !== undefined && input.amount_cents === undefined) {
        const sum = input.shares.reduce((acc, share) => acc + share.share_cents, 0);
        if (sum !== current.amountCents) {
          throw new HttpError(
            "VALIDATION_FAILED",
            `shares must sum to the stored amount_cents exactly (got ${sum}, expected ${current.amountCents})`,
            { shares: "sum mismatch with stored amount" },
          );
        }
      }

      // R-money-5 on INCOMING ids only — stored rows referencing ex-members
      // are legal history (module doc).
      const incomingIds: string[] = [];
      if (input.paid_by !== undefined) incomingIds.push(input.paid_by);
      if (input.shares !== undefined) {
        incomingIds.push(...input.shares.map((share) => share.user_id));
      }
      await assertParticipantsAreMembers(tx, tripId, incomingIds);

      if (input.booking_id !== undefined && input.booking_id !== null) {
        await assertBookingInTrip(tx, tripId, input.booking_id);
      }

      const set: Partial<typeof schema.expenses.$inferInsert> = {};
      if (input.description !== undefined) set.description = input.description;
      if (input.category !== undefined) set.category = input.category;
      if (input.paid_by !== undefined) set.paidBy = input.paid_by;
      if (input.amount_cents !== undefined) set.amountCents = input.amount_cents;
      if (input.currency !== undefined) set.currency = input.currency;
      if (input.fx_rate !== undefined) set.fxRate = input.fx_rate;
      if (input.base_amount_cents !== undefined) set.baseAmountCents = input.base_amount_cents;
      if (input.booking_id !== undefined) set.bookingId = input.booking_id;
      if (input.spent_at !== undefined) set.spentAt = input.spent_at;

      // A shares replacement is a document change: bump `updated_at` even
      // when no expenses column moved ($onUpdate only fires on an UPDATE).
      if (input.shares !== undefined && Object.keys(set).length === 0) {
        set.updatedAt = new Date();
      }

      const expense =
        Object.keys(set).length > 0
          ? (
              await tx
                .update(schema.expenses)
                .set(set)
                .where(eq(schema.expenses.id, expenseId))
                .returning()
            )[0]
          : current;
      if (!expense) throw new HttpError("INTERNAL", "expense update returned no row");

      // Accepted shares payload REPLACES the full set (§3.2 PATCH), same
      // transaction — R-money-1/2 re-run in full; no orphans, never mixed.
      if (input.shares !== undefined) {
        await tx.delete(schema.expenseShares).where(eq(schema.expenseShares.expenseId, expenseId));
        await tx.insert(schema.expenseShares).values(
          input.shares.map((share) => ({
            expenseId,
            userId: share.user_id,
            shareCents: share.share_cents,
          })),
        );
      }

      return { expense, shares: await sharesOf(tx, expenseId) };
    })
    .catch(rethrowBookingFkMapped);
}

/**
 * Soft delete (E5, R-money-27): sets the `deleted_at`/`deleted_by` audit
 * pair (schema CHECK keeps them together); row + shares survive for the
 * visible audit trail. Idempotent: an already-deleted expense converges on
 * the same 204 WITHOUT touching the row — the FIRST deleter's audit pair is
 * the record (interpretation — router doc). `null` = absent (route folds
 * into the indistinguishable 404).
 */
export async function softDeleteExpense(
  db: DbClient,
  args: {
    tripId: string;
    expenseId: string;
    userId: string;
    role: "owner" | "editor" | "viewer";
  },
): Promise<{ alreadyDeleted: boolean } | null> {
  return withDeadlockRetry(() => softDeleteExpenseOnce(db, args));
}

async function softDeleteExpenseOnce(
  db: DbClient,
  args: {
    tripId: string;
    expenseId: string;
    userId: string;
    role: "owner" | "editor" | "viewer";
  },
): Promise<{ alreadyDeleted: boolean } | null> {
  const { tripId, expenseId, userId, role } = args;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: schema.expenses.id,
        createdBy: schema.expenses.createdBy,
        deletedAt: schema.expenses.deletedAt,
      })
      .from(schema.expenses)
      .where(and(eq(schema.expenses.id, expenseId), eq(schema.expenses.tripId, tripId)))
      .for("update");
    if (!current) return null;

    if (current.createdBy !== userId && role !== "owner") {
      throw new HttpError(
        "FORBIDDEN",
        "only the expense creator or the trip owner may modify an expense",
      );
    }

    if (current.deletedAt !== null) return { alreadyDeleted: true };

    await tx
      .update(schema.expenses)
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where(eq(schema.expenses.id, expenseId));
    return { alreadyDeleted: false };
  });
}
