/**
 * User-creation helper — R-db-5: WHEN a `users` row is created THE SYSTEM
 * SHALL create its `entitlements` row (plan `'free'`) in the same
 * transaction. This is the ONE way to create a user; auth flows (T-3.x)
 * call this, never `insert(users)` directly.
 *
 * Requires a transaction-capable driver — Neon WebSocket `Pool` in prod/dev,
 * `postgres-js` in tests (landmine #1: the Neon HTTP driver would throw
 * here).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

/** Any transaction-capable Drizzle Postgres client over our schema. */
export type DbClient = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface CreateUserInput {
  email: string;
  displayName: string;
  /** At least one provider sub is required for live accounts (users CHECK). */
  appleSub?: string;
  googleSub?: string;
}

export interface CreatedUser {
  user: typeof schema.users.$inferSelect;
  entitlements: typeof schema.entitlements.$inferSelect;
}

export async function createUserWithEntitlements(
  db: DbClient,
  input: CreateUserInput,
): Promise<CreatedUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email: input.email,
        displayName: input.displayName,
        appleSub: input.appleSub,
        googleSub: input.googleSub,
      })
      .returning();
    // Drizzle types `[row]` as defined, but it's undefined when no row comes
    // back — guard it (landmine: array-destructure lies).
    if (!user) {
      throw new Error("users insert returned no row");
    }

    const [entitlementsRow] = await tx
      .insert(schema.entitlements)
      .values({ userId: user.id })
      .returning();
    if (!entitlementsRow) {
      throw new Error("entitlements insert returned no row");
    }

    return { user, entitlements: entitlementsRow };
  });
}
