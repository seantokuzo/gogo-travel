/**
 * Auth-owned tables — `auth_sessions`, `refresh_tokens`, `apple_credentials`.
 * Specced canonically in `.specs/api/auth-users.spec.md` §3.3 (schema spec
 * §3.3.28 cross-reference); they follow every schema-spec §1 convention.
 */
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pushPlatform } from "./enums.js";
import { createdAt, timestamps } from "./_shared.js";
import { users } from "./identity.js";

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceName: text("device_name"),
    platform: pushPlatform("platform").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index("auth_sessions_user_id_idx").on(t.userId)],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => authSessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    // Write-once + a single `rotated_at` stamp — no `updated_at` (auth spec §3.3.2).
    createdAt: createdAt(),
  },
  (t) => [index("refresh_tokens_session_id_idx").on(t.sessionId)],
);

export const appleCredentials = pgTable("apple_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** AES-256-GCM app-level ciphertext (Law #1) — never returned, never logged. */
  refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
  ...timestamps(),
});
