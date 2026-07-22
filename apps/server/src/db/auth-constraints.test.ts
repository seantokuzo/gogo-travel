/**
 * T-5.1 auth-table suite (auth-users spec §3.3; AU-2) — structural
 * invariants of `auth_sessions` / `refresh_tokens` / `apple_credentials`
 * beyond the DB-1 baseline (which owns the token_hash-unique and
 * user-cascade cases), plus the §3.3.2 prune job.
 *
 * Driver: postgres-js on an ephemeral testcontainers Postgres, same harness
 * contract as `constraints.test.ts`: requires Docker; a Docker-less CI run
 * is a HARD FAILURE, a local Docker-less run skips with a loud banner.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUserWithEntitlements } from "./create-user.js";
import {
  EXPIRED_REFRESH_TOKEN_RETENTION_DAYS,
  pruneAuthRows,
  REVOKED_SESSION_RETENTION_DAYS,
} from "./prune-auth.js";
import * as schema from "./schema/index.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — T-5.1 AUTH CONSTRAINT SUITE SKIPPED         ║\n" +
      "║  The auth-table invariants (auth-users spec §3.3) were NOT        ║\n" +
      "║  verified. Start Docker and re-run `pnpm --filter @gogo/server    ║\n" +
      "║  test` before treating this branch as green.                      ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

// Same contract as DB-1: in CI a skip must never be mistaken for a pass.
if (!dockerAvailable && process.env.CI) {
  it("T-5.1 auth constraint suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-5.1 auth constraint suite " +
        "could not verify auth-users spec §3.3. A skip here is NOT a pass. " +
        "Provision Docker or a Postgres service container and re-run.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!dockerAvailable)("T-5.1 auth-table constraint suite", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  async function expectPgError(promise: Promise<unknown>, pattern: RegExp) {
    const error = await promise.then(
      () => {
        throw new Error(`expected query to reject with ${String(pattern)}`);
      },
      (e: unknown) => e,
    );
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join(" | ")).toMatch(pattern);
  }

  async function seedUser() {
    const { user } = await createUserWithEntitlements(db, {
      email: `u-${uniq()}@example.com`,
      displayName: "Auth Fixture",
      appleSub: `apple-${uniq()}`,
    });
    return user;
  }

  async function seedSession(userId: string, revokedAt?: Date) {
    const [session] = await db
      .insert(schema.authSessions)
      .values({ userId, platform: "ios", revokedAt })
      .returning();
    if (!session) throw new Error("auth_sessions insert returned no row");
    return session;
  }

  async function seedToken(sessionId: string, expiresAt: Date) {
    const [token] = await db
      .insert(schema.refreshTokens)
      .values({ sessionId, tokenHash: `hash-${uniq()}`, expiresAt })
      .returning();
    if (!token) throw new Error("refresh_tokens insert returned no row");
    return token;
  }

  // -----------------------------------------------------------------------
  // Structure (§3.3.1–§3.3.3)
  // -----------------------------------------------------------------------

  it("auth_sessions: FK to users enforced; defaults populate; revoked_at starts NULL", async () => {
    await expectPgError(
      db.insert(schema.authSessions).values({ userId: randomUUID(), platform: "ios" }),
      /violates foreign key constraint/,
    );

    const user = await seedUser();
    const session = await seedSession(user.id);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.lastUsedAt).toBeInstanceOf(Date);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.revokedAt).toBeNull();
    expect(session.deviceName).toBeNull();
  });

  it("auth_sessions: platform is the shared push_platform enum — 'web' is unrepresentable", async () => {
    const user = await seedUser();
    await expectPgError(
      db.execute(sql`INSERT INTO auth_sessions (user_id, platform) VALUES (${user.id}, 'web')`),
      /invalid input value for enum push_platform/,
    );
  });

  it("refresh_tokens: FK to auth_sessions enforced; rotated_at starts NULL (R-auth-11 structure)", async () => {
    await expectPgError(
      db.insert(schema.refreshTokens).values({
        sessionId: randomUUID(),
        tokenHash: `hash-${uniq()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      /violates foreign key constraint/,
    );

    const user = await seedUser();
    const session = await seedSession(user.id);
    const token = await seedToken(session.id, new Date(Date.now() + 3600_000));
    expect(token.rotatedAt).toBeNull();
    expect(token.createdAt).toBeInstanceOf(Date);
  });

  it("deleting a session cascades its refresh tokens directly", async () => {
    const user = await seedUser();
    const session = await seedSession(user.id);
    await seedToken(session.id, new Date(Date.now() + 3600_000));

    await db.delete(schema.authSessions).where(eq(schema.authSessions.id, session.id));

    const tokens = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.sessionId, session.id));
    expect(tokens).toHaveLength(0);
  });

  it("apple_credentials: FK to users enforced; PK is user_id — one row per user", async () => {
    await expectPgError(
      db
        .insert(schema.appleCredentials)
        .values({ userId: randomUUID(), refreshTokenCiphertext: "ct" }),
      /violates foreign key constraint/,
    );

    const user = await seedUser();
    await db
      .insert(schema.appleCredentials)
      .values({ userId: user.id, refreshTokenCiphertext: "ct-1" });
    await expectPgError(
      db
        .insert(schema.appleCredentials)
        .values({ userId: user.id, refreshTokenCiphertext: "ct-2" }),
      /apple_credentials_pkey/,
    );
  });

  it("apple_credentials upsert EXEMPLAR: refresh on re-sign-in replaces ciphertext and bumps updated_at by hand", async () => {
    const user = await seedUser();
    await db
      .insert(schema.appleCredentials)
      .values({ userId: user.id, refreshTokenCiphertext: "ct-old" });
    const [before] = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, user.id));

    // R-auth-7: each Apple sign-in refreshes the stored (encrypted) token.
    // Correctness landmine (schema/_shared.ts): `$onUpdate` does NOT fire
    // through `onConflictDoUpdate` — the set-clause bumps updated_at itself.
    await db
      .insert(schema.appleCredentials)
      .values({ userId: user.id, refreshTokenCiphertext: "ct-new" })
      .onConflictDoUpdate({
        target: schema.appleCredentials.userId,
        set: { refreshTokenCiphertext: "ct-new", updatedAt: sql`now()` },
      });

    const rows = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refreshTokenCiphertext).toBe("ct-new");
    expect(rows[0]!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  // -----------------------------------------------------------------------
  // Prune job (§3.3.2)
  // -----------------------------------------------------------------------

  it("pruneAuthRows: retention matrix — expired>30d tokens and revoked>90d sessions go; everything live stays", async () => {
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);
    const user = await seedUser();

    // Live session with the full token spread.
    const liveSession = await seedSession(user.id);
    const tokenLongExpired = await seedToken(liveSession.id, daysAgo(31));
    const tokenRecentlyExpired = await seedToken(liveSession.id, daysAgo(29));
    const tokenCurrent = await seedToken(liveSession.id, daysAgo(-30));

    // Revoked long ago (91d) — pruned, its unexpired token cascades.
    const sessionRevokedOld = await seedSession(user.id, daysAgo(91));
    const tokenOnRevokedOld = await seedToken(sessionRevokedOld.id, daysAgo(-30));

    // Revoked recently (89d) — retained.
    const sessionRevokedRecent = await seedSession(user.id, daysAgo(89));

    // Never revoked, ancient — age alone never prunes a live session.
    const [sessionAncient] = await db
      .insert(schema.authSessions)
      .values({ userId: user.id, platform: "android", lastUsedAt: daysAgo(200) })
      .returning();

    const result = await pruneAuthRows(db, now);
    // Only the expiry-rule token is counted; the cascaded one is not.
    expect(result).toEqual({ refreshTokensDeleted: 1, sessionsDeleted: 1 });

    const remainingTokenIds = (
      await db.select({ id: schema.refreshTokens.id }).from(schema.refreshTokens)
    ).map((r) => r.id);
    expect(remainingTokenIds).not.toContain(tokenLongExpired.id);
    expect(remainingTokenIds).not.toContain(tokenOnRevokedOld.id); // cascaded
    expect(remainingTokenIds).toContain(tokenRecentlyExpired.id);
    expect(remainingTokenIds).toContain(tokenCurrent.id);

    const remainingSessionIds = (
      await db.select({ id: schema.authSessions.id }).from(schema.authSessions)
    ).map((r) => r.id);
    expect(remainingSessionIds).not.toContain(sessionRevokedOld.id);
    expect(remainingSessionIds).toContain(liveSession.id);
    expect(remainingSessionIds).toContain(sessionRevokedRecent.id);
    expect(remainingSessionIds).toContain(sessionAncient!.id);

    // Idempotent: an immediate re-run finds nothing left to prune.
    expect(await pruneAuthRows(db, now)).toEqual({
      refreshTokensDeleted: 0,
      sessionsDeleted: 0,
    });
  });

  it("prune cutoffs are the spec constants (30d / 90d)", () => {
    expect(EXPIRED_REFRESH_TOKEN_RETENTION_DAYS).toBe(30);
    expect(REVOKED_SESSION_RETENTION_DAYS).toBe(90);
  });
});
