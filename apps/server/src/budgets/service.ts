/**
 * Budgets domain service (T-9.4 / MON-6) — G1/G2, money spec §2 R-money-20 +
 * §3.2; schema spec §3.3.15. Plain functions over a transaction-capable
 * `DbClient` + typed inputs, no Hono imports; failures are typed
 * `HttpError`s (the sibling money services' pattern).
 *
 * LAW #2: every amount below is integer cents; `spent_cents` is computed on
 * read (never stored — R-money-20) as Σ `COALESCE(base_amount_cents,
 * amount_cents)` over non-deleted expenses, summed IN SQL over bigint —
 * no float ever enters the path.
 *
 * LOCK ORDER (canonical chain: expenses/service.ts module doc — trips lead,
 * budgets tail): every budget WRITE takes the trip row `FOR UPDATE` FIRST,
 * then upserts the budgets row (QUEUE T-9.4 obligation 4; PR #30 interp #7).
 * That order is load-bearing, not ceremony: the base-currency PATCH
 * (trips/routes.ts) already holds trips-then-budgets when it syncs
 * `budgets.currency` — a budgets write acquiring in the opposite order
 * (budgets row first, trips read second) could AB-BA deadlock against it,
 * and a write NOT holding the trips lock could stamp a row with the
 * pre-PATCH base currency (the T-6.1 TOCTOU's budgets face). Under the lock,
 * `currency = trips.base_currency` is correct by definition (the §3.3.15
 * invariant; T-6.1's sync maintains it on the PATCH side).
 *
 * IMPLICIT-LOCK AUDIT (the PR #30 landmine — a no-cycle claim must audit RI
 * `FOR KEY SHARE` too): `budgets` has exactly ONE foreign key — `trip_id` →
 * `trips` — so the upsert's RI key-share lands on a row THIS transaction
 * already holds `FOR UPDATE` (no new edge). Unlike expense / settle-request
 * inserts there is NO users FK, hence no trips → users implicit edge and no
 * AB-BA window against account deletion's users-first chain — no deadlock
 * retry is needed here, and that claim audits BOTH lock kinds.
 *
 * DRIVER: writes run in `db.transaction` — prod client is the Neon WebSocket
 * `Pool`, never Neon-HTTP (landmine #1: its `.transaction()` throws).
 *
 * INTERPRETATIONS (Law #4 — numbered; mirrored in the PR body):
 *  [I-1] G1 `total.ai_estimate_cents` = Σ of the non-null per-category
 *        `ai_estimate_cents`, `null` when every category is null — §3.2
 *        shows the field but pins no formula; a sum-of-knowns mirrors how
 *        `total.spent_cents` aggregates the items and degrades to null
 *        exactly when there is nothing to sum.
 *  [I-2] The G2 upsert's conflict arm re-stamps `currency` from
 *        `trips.base_currency` (read under the trips lock) alongside
 *        `cap_cents`: same-value in every reachable state (the §3.3.15
 *        invariant), self-healing if a row ever drifted; `ai_estimate_cents`
 *        / `ai_estimated_at` are deliberately NOT in the set — R-money-20
 *        pins "null clears the cap, preserving any AI estimate".
 *  [I-3] `spent_cents` counts an expense's FULL effective-base amount under
 *        its category — including any share held by the payer and zero-share
 *        participants; §3.2 pins "Σ effective base per category" (expense
 *        grain, not share grain).
 */
import { EXPENSE_CATEGORIES } from "@gogo/shared/enums";
import type {
  BudgetCategorySegment,
  BudgetItemRead,
  BudgetsRead,
} from "@gogo/shared/domains/money";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { HttpError, NOT_FOUND_MESSAGE } from "../http/errors.js";

/** Any transaction scope (or the client itself) usable for reads. */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Reader = DbClient | Tx;

/**
 * G1: the budgets document — one item per `expense_category` (absent rows
 * synthesized with nulls, `currency = trips.base_currency`), computed
 * `spent_cents`, and the `total` block off `trips.budget_cap_cents`
 * (R-money-20; overall-cap storage per schema spec §3.3.15, resolved
 * Gate 2). Read-only — no locks (the gate proved membership; a vanished trip
 * degrades to the canonical 404).
 */
export async function loadBudgetsDoc(db: Reader, args: { tripId: string }): Promise<BudgetsRead> {
  const { tripId } = args;

  const [trip] = await db
    .select({
      baseCurrency: schema.trips.baseCurrency,
      budgetCapCents: schema.trips.budgetCapCents,
    })
    .from(schema.trips)
    .where(eq(schema.trips.id, tripId));
  if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

  const budgetRows = await db
    .select()
    .from(schema.budgets)
    .where(eq(schema.budgets.tripId, tripId));

  // Σ effective base per category, in SQL over bigint (Law #2 — the module
  // doc). Soft-deleted expenses are excluded (R-db-21 / R-money-27).
  const spentRows = await db
    .select({
      category: schema.expenses.category,
      spent: sql<number>`sum(coalesce(${schema.expenses.baseAmountCents}, ${schema.expenses.amountCents}))::bigint`.mapWith(
        Number,
      ),
    })
    .from(schema.expenses)
    .where(and(eq(schema.expenses.tripId, tripId), isNull(schema.expenses.deletedAt)))
    .groupBy(schema.expenses.category);

  const rowByCategory = new Map(budgetRows.map((row) => [row.category, row]));
  const spentByCategory = new Map(spentRows.map((row) => [row.category, row.spent]));

  // Full-taxonomy synthesis (§3.2): every category renders, absent rows as
  // nulls — driven off the canonical shared tuple so the two can never drift.
  const items: BudgetItemRead[] = EXPENSE_CATEGORIES.map((category) => {
    const row = rowByCategory.get(category);
    return {
      category,
      cap_cents: row?.capCents ?? null,
      ai_estimate_cents: row?.aiEstimateCents ?? null,
      ai_estimated_at: row?.aiEstimatedAt?.toISOString() ?? null,
      currency: row?.currency ?? trip.baseCurrency,
      spent_cents: spentByCategory.get(category) ?? 0,
    };
  });

  // [I-1] total block: overall cap from trips; spent = Σ items; estimate =
  // Σ non-null estimates or null when none exist.
  const estimates = items.filter((item) => item.ai_estimate_cents !== null);
  return {
    items,
    total: {
      cap_cents: trip.budgetCapCents,
      spent_cents: items.reduce((acc, item) => acc + item.spent_cents, 0),
      ai_estimate_cents:
        estimates.length > 0
          ? estimates.reduce((acc, item) => acc + (item.ai_estimate_cents ?? 0), 0)
          : null,
    },
  };
}

/**
 * G2: upsert one category cap — or the overall trip cap via the `total`
 * pseudo-category (R-money-20, resolved Gate 2). `null` clears the cap,
 * PRESERVING any AI estimate ([I-2]). Takes the trip row `FOR UPDATE` FIRST
 * (module doc — the load-bearing acquisition order), writes, and returns the
 * recomputed G1 document from the SAME transaction snapshot.
 */
export async function putBudgetCap(
  db: DbClient,
  args: { tripId: string; segment: BudgetCategorySegment; capCents: number | null },
): Promise<BudgetsRead> {
  const { tripId, segment, capCents } = args;

  return db.transaction(async (tx) => {
    // FIRST acquisition (lock order: trips leads the chain — module doc).
    const [trip] = await tx
      .select({ baseCurrency: schema.trips.baseCurrency })
      .from(schema.trips)
      .where(eq(schema.trips.id, tripId))
      .for("update");
    if (!trip) throw new HttpError("NOT_FOUND", NOT_FOUND_MESSAGE);

    if (segment === "total") {
      // Overall cap lives on the trips row (§3.3.15 storage call). The row is
      // locked above, so this can never race the base-currency PATCH.
      await tx
        .update(schema.trips)
        .set({ budgetCapCents: capCents })
        .where(eq(schema.trips.id, tripId));
    } else {
      await tx
        .insert(schema.budgets)
        .values({
          tripId,
          category: segment,
          capCents,
          currency: trip.baseCurrency,
        })
        .onConflictDoUpdate({
          target: [schema.budgets.tripId, schema.budgets.category],
          // [I-2] cap + currency only — the AI estimate pair survives.
          // `$onUpdate` does NOT fire through upserts (db/schema/_shared.ts
          // landmine): set `updated_at` by hand.
          set: {
            capCents,
            currency: trip.baseCurrency,
            updatedAt: sql`now()`,
          },
        });
    }

    return loadBudgetsDoc(tx, { tripId });
  });
}
