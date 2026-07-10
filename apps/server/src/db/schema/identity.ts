/**
 * Identity domain — `users`, `entitlements`, `push_tokens`
 * (schema spec §3.3.1–§3.3.3).
 */
import type { EntitlementOverrides } from "@gogo/shared/domains/entitlement";
import type { UserPrefs } from "@gogo/shared/domains/user";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { plan, pushPlatform } from "./enums.js";
import { timestamps } from "./_shared.js";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    avatarKey: text("avatar_key"),
    appleSub: text("apple_sub").unique(),
    googleSub: text("google_sub").unique(),
    prefs: jsonb("prefs")
      .$type<UserPrefs>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    venmoUsername: text("venmo_username"),
    cashtag: text("cashtag"),
    paypalmeUsername: text("paypalme_username"),
    zelleHandle: text("zelle_handle"),
    zelleDisplayName: text("zelle_display_name"),
    forwardEmailSlug: text("forward_email_slug").unique(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // Unique on lower(email) — Apple private-relay addresses are still emails;
    // lower(email) is the identity-linking merge key (§3.3.1).
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    // Every live account has ≥1 provider identity; scrubbed accounts have none.
    check(
      "users_identity_or_scrubbed_ck",
      sql`${t.deletedAt} IS NOT NULL OR ${t.appleSub} IS NOT NULL OR ${t.googleSub} IS NOT NULL`,
    ),
  ],
);

export const entitlements = pgTable("entitlements", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  plan: plan("plan").notNull().default("free"),
  overrides: jsonb("overrides")
    .$type<EntitlementOverrides>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  ...timestamps(),
});

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: pushPlatform("platform").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    timezone: text("timezone"),
    ...timestamps(),
  },
  (t) => [index("push_tokens_user_id_idx").on(t.userId)],
);
