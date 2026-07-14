/**
 * Money domain — `expenses`, `expense_shares`, `settlements`,
 * `settlement_requests`, `budgets` (schema spec §3.3.12–§3.3.15, §3.3.25).
 *
 * Law #2: money is bigint integer cents, columns suffixed `_cents` — never
 * float. Expense + shares write atomically (R-db-2, transaction body lands
 * with the money API). Balances are computed, never stored.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { bookings } from "./bookings.js";
import { expenseCategory, requestStatus, settlementMethod } from "./enums.js";
import { createdAt, timestamps } from "./_shared.js";
import { users } from "./identity.js";
import { trips } from "./trips.js";

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    category: expenseCategory("category").notNull(),
    paidBy: uuid("paid_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    /** As logged (spend-in-local-currency). */
    currency: char("currency", { length: 3 }).notNull(),
    /** Rate `currency → trip.base_currency` captured at entry (R-db-20). */
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }),
    /** App invariant: equals `amount_cents` (rate 1) when currency = base. */
    baseAmountCents: bigint("base_amount_cents", { mode: "number" }),
    /** Expense spawned from a booking's price; ledger outlives the booking. */
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    spentAt: date("spent_at")
      .notNull()
      .default(sql`CURRENT_DATE`),
    /** Logger may differ from payer. */
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Soft delete (R-db-21); balance/budget queries filter `deleted_at IS NULL`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    // Money screen lists and daily rollups.
    index("expenses_trip_spent_at_idx").on(t.tripId, t.spentAt),
    index("expenses_paid_by_idx").on(t.paidBy),
    index("expenses_booking_id_idx").on(t.bookingId),
    index("expenses_created_by_idx").on(t.createdBy),
    index("expenses_deleted_by_idx").on(t.deletedBy),
    check("expenses_amount_positive_ck", sql`${t.amountCents} > 0`),
    check("expenses_currency_upper_ck", sql`${t.currency} = upper(${t.currency})`),
    check("expenses_fx_pair_ck", sql`(${t.fxRate} IS NULL) = (${t.baseAmountCents} IS NULL)`),
    check("expenses_deleted_pair_ck", sql`(${t.deletedAt} IS NULL) = (${t.deletedBy} IS NULL)`),
  ],
);

/**
 * Currency inherited from the parent expense (R-db-13) — no per-share
 * currency column. The payer normally holds a share too; a zero share is
 * legal (payer covered others entirely). Immutable ledger part — no
 * `updated_at` (rows are rewritten with their expense, R-db-2).
 */
export const expenseShares = pgTable(
  "expense_shares",
  {
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expenses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    shareCents: bigint("share_cents", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.userId] }),
    // Cross-trip "what do I owe" summaries.
    index("expense_shares_user_id_idx").on(t.userId),
    check("expense_shares_nonnegative_ck", sql`${t.shareCents} >= 0`),
  ],
);

/**
 * Record-only ledger entries (R-db-14) — no external transaction IDs, no
 * payment-state machine. Immutable once written (no `updated_at`).
 */
export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    /** Trip base currency by convention (balances are computed in base). */
    currency: char("currency", { length: 3 }).notNull(),
    /** How the user says they paid; self-reported everywhere. */
    method: settlementMethod("method").notNull(),
    note: text("note"),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who recorded it (either party may). */
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (t) => [
    // Balance computation scans per trip.
    index("settlements_trip_id_idx").on(t.tripId),
    index("settlements_from_user_id_idx").on(t.fromUserId),
    index("settlements_to_user_id_idx").on(t.toUserId),
    index("settlements_created_by_idx").on(t.createdBy),
    check("settlements_not_self_ck", sql`${t.fromUserId} <> ${t.toUserId}`),
    check("settlements_amount_positive_ck", sql`${t.amountCents} > 0`),
    check("settlements_currency_upper_ck", sql`${t.currency} = upper(${t.currency})`),
  ],
);

/**
 * "Send the bill" requests (money spec §3.6). `id` is the `requestId` in the
 * universal link — member-guarded route, authz-checked, not a bearer secret.
 */
export const settlementRequests = pgTable(
  "settlement_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    /** Debtor. */
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Creditor = creator. */
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    /** Trip base currency by convention. */
    currency: char("currency", { length: 3 }).notNull(),
    note: text("note"),
    status: requestStatus("status").notNull().default("open"),
    /** Set when settled through the request; record outlives a corrected settlement. */
    settlementId: uuid("settlement_id").references(() => settlements.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    // Open-requests list.
    index("settlement_requests_trip_status_idx").on(t.tripId, t.status),
    index("settlement_requests_from_user_id_idx").on(t.fromUserId),
    index("settlement_requests_to_user_id_idx").on(t.toUserId),
    index("settlement_requests_settlement_id_idx").on(t.settlementId),
    check("settlement_requests_not_self_ck", sql`${t.fromUserId} <> ${t.toUserId}`),
    check("settlement_requests_amount_positive_ck", sql`${t.amountCents} > 0`),
    check("settlement_requests_currency_upper_ck", sql`${t.currency} = upper(${t.currency})`),
  ],
);

/** One row per trip per category ("category caps + AI estimate"). */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    category: expenseCategory("category").notNull(),
    /** User-set cap; NULL = no cap, estimate only. */
    capCents: bigint("cap_cents", { mode: "number" }),
    aiEstimateCents: bigint("ai_estimate_cents", { mode: "number" }),
    aiEstimatedAt: timestamp("ai_estimated_at", { withTimezone: true }),
    /** App invariant: equals `trips.base_currency` (self-describing rows). */
    currency: char("currency", { length: 3 }).notNull(),
    ...timestamps(),
  },
  (t) => [
    // One row per category; also the budget-screen query.
    unique("budgets_trip_category_uq").on(t.tripId, t.category),
    check("budgets_cap_nonnegative_ck", sql`${t.capCents} >= 0`),
    check("budgets_ai_estimate_nonnegative_ck", sql`${t.aiEstimateCents} >= 0`),
    check("budgets_currency_upper_ck", sql`${t.currency} = upper(${t.currency})`),
  ],
);
