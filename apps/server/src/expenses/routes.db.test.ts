/**
 * T-9.2 expenses integration suite (MON-2): GET/POST list+create,
 * GET/PATCH/DELETE detail — end-to-end over a real Postgres, behind the
 * real app-wide `requireAuth` + `requireTripMember` gates. Covers every
 * money spec §3.2 "Tests required" bullet for E1–E5 PLUS the §4
 * cross-cutting bullets in this surface's scope: the money-law float
 * fixture, the two-PATCH LWW/never-mixed concurrency pin, and envelope
 * conformance on every asserted error path.
 *
 * Headline adversarial assertions: expense+shares atomicity via a REAL
 * forced share-insert failure (DB trigger) rolling back the expense row
 * (R-money-1); the F-038 IDOR harness on trip AND expense ids (R-money-25);
 * the base-currency lock race pinned with a second connection — an expense
 * create BLOCKS on a held trip-row lock and re-validates `base_currency`
 * under it (the T-6.1 TOCTOU's expense side; the PATCH side is pinned in
 * trips/routes.db.test.ts); the R-money-26 role matrix incl. viewer-creates
 * and creator-or-owner edit/delete; MAX_EXPENSE_SHARES at the boundary
 * (50 real members split, 51 rejected).
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — a Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5). Run the server DB
 * suites with `--no-file-parallelism` (Testcontainers contention, QUEUE P1).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import {
  ExpenseSchema,
  MAX_EXPENSE_SHARES,
  type Expense,
  type ExpenseShare,
} from "@gogo/shared/domains/money";
import { TripWithRoleSchema, type TripWithRole } from "@gogo/shared/domains/trip";
import type { TripMemberRole } from "@gogo/shared/enums";
import { createApp } from "../app.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import {
  expectIndistinguishable404s,
  NONEXISTENT_UUID,
  type ErrorEnvelope,
} from "../http/idor-404.test-util.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — T-9.2 EXPENSES SUITE SKIPPED                ║\n" +
      "║  Expense CRUD E1–E5, atomic expense+shares writes, the FX pair    ║\n" +
      "║  gate, soft-delete + audit, the R-money-26 authz matrix, the      ║\n" +
      "║  F-038 IDOR harness, and the base-currency lock race (money spec  ║\n" +
      "║  §2/§3.2, R-money-1..7/25/26/27) were NOT verified. Start Docker  ║\n" +
      "║  and re-run `pnpm --filter @gogo/server test` before treating     ║\n" +
      "║  this green.                                                      ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-9.2 expenses suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-9.2 expenses suite could " +
        "not verify money spec §2/§3.2 (R-money-1..7/25/26/27). A skip is " +
        "NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const PaginatedExpensesSchema = paginatedSchema(ExpenseSchema);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!dockerAvailable)("T-9.2 expenses routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let authDeps: AuthRouterDeps;
  let signer: AccessTokenSigner;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });

    const signerPair = await generateKeyPair("ES256");
    signer = { privateKey: signerPair.privateKey, kid: SIGNER_KID };
    authDeps = {
      db,
      verifier: {
        appleJwks: createLocalJWKSet({ keys: [] }),
        googleJwks: createLocalJWKSet({ keys: [] }),
        appleAudience: "com.gogo.travel",
        googleAudiences: ["gid.apps.example"],
      },
      signer,
      accessVerify: { publicKey: signerPair.publicKey },
      appleExchange: { exchange: () => Promise.reject(new Error("unused in this suite")) },
      appleCredentialsKey: Buffer.alloc(32, 7),
      logger: { warn: () => undefined },
    };
    app = createApp({
      auth: authDeps,
      trips: { db },
      expenses: { db },
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `expenses-${uniq()}@example.com`,
      displayName: "Expense Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  const request = (path: string, token?: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });

  const listExpenses = (tripId: string, token: string, query = "") =>
    request(`/api/trips/${tripId}/expenses${query}`, token);
  const postExpense = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/expenses`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const getExpense = (tripId: string, expenseId: string, token: string) =>
    request(`/api/trips/${tripId}/expenses/${expenseId}`, token);
  const patchExpense = (tripId: string, expenseId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/expenses/${expenseId}`, token, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  const deleteExpense = (tripId: string, expenseId: string, token: string) =>
    request(`/api/trips/${tripId}/expenses/${expenseId}`, token, { method: "DELETE" });

  /** POST a trip through the real route; returns the parsed wire trip. */
  async function createTripVia(
    token: string,
    overrides: { base_currency?: string } = {},
  ): Promise<TripWithRole> {
    const res = await request("/api/trips", token, {
      method: "POST",
      body: JSON.stringify({
        name: `Trip ${uniq()}`,
        destination_name: "Tokyo, Japan",
        destination_lat: 35.6895,
        destination_lng: 139.6917,
        start_date: "2026-09-01",
        end_date: "2026-09-10",
        ...overrides,
      }),
    });
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  /** Owner + editor + viewer on one trip (memberships seeded directly). */
  async function seedCollabTrip(overrides: { base_currency?: string } = {}) {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken, overrides);
    await db.insert(schema.tripMembers).values([
      { tripId: trip.id, userId: editor.userId, role: "editor" as TripMemberRole },
      { tripId: trip.id, userId: viewer.userId, role: "viewer" as TripMemberRole },
    ]);
    return { owner, editor, viewer, trip };
  }

  /** A schema-valid single-payer body (the payer holds the whole share). */
  const expenseBody = (paidBy: string, overrides: Record<string, unknown> = {}) => ({
    description: "Dinner",
    category: "food",
    paid_by: paidBy,
    amount_cents: 3000,
    currency: "USD",
    shares: [{ user_id: paidBy, share_cents: 3000 }],
    ...overrides,
  });

  const dbExpensesOf = (tripId: string) =>
    db.select().from(schema.expenses).where(eq(schema.expenses.tripId, tripId));
  const dbSharesOf = (expenseId: string) =>
    db.select().from(schema.expenseShares).where(eq(schema.expenseShares.expenseId, expenseId));

  // ===========================================================================
  // E1 — POST /trips/:tripId/expenses
  // ===========================================================================

  it("POST: expense + N shares committed atomically; sum invariant; effective base; spent_at defaults (R-money-1/2)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();

    const res = await postExpense(trip.id, owner.accessToken, {
      description: "Izakaya night",
      category: "food",
      paid_by: owner.userId,
      amount_cents: 3001,
      currency: "USD",
      shares: [
        { user_id: owner.userId, share_cents: 1501 },
        { user_id: editor.userId, share_cents: 1500 },
      ],
    });
    expect(res.status).toBe(201);
    const expense = ExpenseSchema.parse(await res.json());
    expect(expense.trip_id).toBe(trip.id);
    expect(expense.amount_cents).toBe(3001);
    expect(expense.shares.reduce((acc, s) => acc + s.share_cents, 0)).toBe(3001);
    // Shares travel sorted ascending by user_id (canonical §3.3 ordering).
    const sorted = [...expense.shares].sort((a, b) => (a.user_id < b.user_id ? -1 : 1));
    expect(expense.shares).toEqual(sorted);
    // Base-currency expense: no FX pair, effective base = amount.
    expect(expense.fx_rate).toBeNull();
    expect(expense.base_amount_cents).toBeNull();
    expect(expense.effective_base_cents).toBe(3001);
    // Server CURRENT_DATE default (§3.2).
    expect(expense.spent_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(expense.deleted_at).toBeNull();
    expect(expense.created_by).toBe(owner.userId);

    // DB agrees: one expense row, two share rows.
    const rows = await dbExpensesOf(trip.id);
    expect(rows).toHaveLength(1);
    expect(await dbSharesOf(expense.id)).toHaveLength(2);
  });

  it("POST: a zero-cent share is legal and persists (payer covered them — schema §3.3.13); explicit spent_at is stored", async () => {
    const { owner, viewer, trip } = await seedCollabTrip();
    const res = await postExpense(trip.id, owner.accessToken, {
      ...expenseBody(owner.userId, { spent_at: "2026-09-03" }),
      shares: [
        { user_id: owner.userId, share_cents: 3000 },
        { user_id: viewer.userId, share_cents: 0 },
      ],
    });
    expect(res.status).toBe(201);
    const expense = ExpenseSchema.parse(await res.json());
    expect(expense.spent_at).toBe("2026-09-03");
    expect(expense.shares).toContainEqual({ user_id: viewer.userId, share_cents: 0 });
    expect(await dbSharesOf(expense.id)).toHaveLength(2);
  });

  it("POST: viewer CAN create (R-money-26 — travelers, not spectators)", async () => {
    const { viewer, trip } = await seedCollabTrip();
    const res = await postExpense(trip.id, viewer.accessToken, expenseBody(viewer.userId));
    expect(res.status).toBe(201);
    expect(ExpenseSchema.parse(await res.json()).created_by).toBe(viewer.userId);
  });

  it("POST: sum mismatch by ONE cent → 400, zero rows written (R-money-2 exact-sum)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const res = await postExpense(trip.id, owner.accessToken, {
      ...expenseBody(owner.userId, { amount_cents: 3000 }),
      shares: [
        { user_id: owner.userId, share_cents: 1500 },
        { user_id: editor.userId, share_cents: 1499 },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    expect(await dbExpensesOf(trip.id)).toHaveLength(0);
  });

  it("POST: the money-law fixture — float amount_cents 25.5 fails validation (§4; Law #2); negative share too", async () => {
    const { owner, trip } = await seedCollabTrip();
    const floatRes = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        amount_cents: 25.5,
        shares: [{ user_id: owner.userId, share_cents: 25.5 }],
      }),
    );
    expect(floatRes.status).toBe(400);
    expect(((await floatRes.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const negativeRes = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        amount_cents: 1000,
        shares: [
          { user_id: owner.userId, share_cents: 1500 },
          { user_id: owner.userId, share_cents: -500 },
        ],
      }),
    );
    expect(negativeRes.status).toBe(400);
    expect(await dbExpensesOf(trip.id)).toHaveLength(0);
  });

  it("POST: duplicate share user_id → 400 (shared schema)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const res = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        shares: [
          { user_id: owner.userId, share_cents: 1500 },
          { user_id: owner.userId, share_cents: 1500 },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST: non-member participants → 400 with the offending ids (R-money-5) — share-holder AND paid_by arms", async () => {
    const { owner, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();

    const shareArm = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        shares: [
          { user_id: owner.userId, share_cents: 1000 },
          { user_id: stranger.userId, share_cents: 2000 },
        ],
      }),
    );
    expect(shareArm.status).toBe(400);
    const shareEnvelope = (await shareArm.json()) as ErrorEnvelope;
    expect(shareEnvelope.error.code).toBe("VALIDATION_FAILED");
    expect(shareEnvelope.error.details).toEqual({ non_members: [stranger.userId] });

    const payerArm = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(stranger.userId, {
        shares: [{ user_id: stranger.userId, share_cents: 3000 }],
      }),
    );
    expect(payerArm.status).toBe(400);
    expect(await dbExpensesOf(trip.id)).toHaveLength(0);
  });

  it("POST/PATCH: MAX_EXPENSE_SHARES at the boundary — 50 REAL members → 201; 51 REAL members → 400 naming shares (schema cap, both verbs)", async () => {
    const { owner, trip } = await seedCollabTrip();

    // 50 extra members (owner makes 51 possible participants), seeded
    // directly. A provider sub is required: `users_identity_or_scrubbed_ck`
    // rejects a live row with neither identity. ALL 51 are real members —
    // round-1 surviving mutant: the old over-cap arm used a NON-member id,
    // so the membership 400 masked the cap (probe-proven: cap deleted, test
    // stayed green). With real members only the cap can reject.
    const extras = Array.from({ length: 50 }, (_, i) => ({
      email: `bulk-${uniq()}-${i}@example.com`,
      displayName: `Bulk Member ${i}`,
      googleSub: `bulk-google-${uniq()}-${i}`,
    }));
    const users = await db.insert(schema.users).values(extras).returning({ id: schema.users.id });
    await db.insert(schema.tripMembers).values(
      users.map((user) => ({
        tripId: trip.id,
        userId: user.id,
        role: "viewer" as const,
      })),
    );

    const memberIds = [owner.userId, ...users.map((user) => user.id)];
    const atCapIds = memberIds.slice(0, MAX_EXPENSE_SHARES);
    expect(atCapIds).toHaveLength(MAX_EXPENSE_SHARES);
    const atCapShares: ExpenseShare[] = atCapIds.map((user_id) => ({ user_id, share_cents: 2 }));
    const atCap = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { amount_cents: 100, shares: atCapShares }),
    );
    expect(atCap.status).toBe(201);
    const atCapExpense = ExpenseSchema.parse(await atCap.json());
    expect(atCapExpense.shares).toHaveLength(MAX_EXPENSE_SHARES);

    // 51 REAL members, exact sum: ONLY the cap can say no — and the zod
    // details must name `shares` (proves it was the cap, not membership).
    const overCapShares: ExpenseShare[] = memberIds.map((user_id) => ({
      user_id,
      share_cents: 2,
    }));
    const overCap = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { amount_cents: 102, shares: overCapShares }),
    );
    expect(overCap.status).toBe(400);
    const overCapEnvelope = (await overCap.json()) as ErrorEnvelope;
    expect(overCapEnvelope.error.code).toBe("VALIDATION_FAILED");
    const overCapDetails = overCapEnvelope.error.details as {
      fieldErrors?: Record<string, unknown>;
    };
    expect(overCapDetails.fieldErrors?.shares).toBeTruthy();

    // ExpenseUpdateSchema carries the same cap: shares-only PATCH with 51
    // real members summing to the STORED amount → only the cap rejects.
    const patchOverCap = await patchExpense(trip.id, atCapExpense.id, owner.accessToken, {
      shares: memberIds.map((user_id, i) => ({ user_id, share_cents: i === 0 ? 0 : 2 })),
    });
    expect(patchOverCap.status).toBe(400);
    const patchDetails = ((await patchOverCap.json()) as ErrorEnvelope).error.details as {
      fieldErrors?: Record<string, unknown>;
    };
    expect(patchDetails.fieldErrors?.shares).toBeTruthy();
  });

  it("POST: booking link — this trip's booking → 201; another trip's booking → 400, not 404 (§3.2)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const other = await seedCollabTrip();

    const [ownBooking] = await db
      .insert(schema.bookings)
      .values({
        tripId: trip.id,
        category: "restaurant",
        title: "Sushi bar",
        createdBy: owner.userId,
      })
      .returning({ id: schema.bookings.id });
    const [foreignBooking] = await db
      .insert(schema.bookings)
      .values({
        tripId: other.trip.id,
        category: "restaurant",
        title: "Wrong trip",
        createdBy: other.owner.userId,
      })
      .returning({ id: schema.bookings.id });
    if (!ownBooking || !foreignBooking) throw new Error("booking seed failed");

    const linked = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { booking_id: ownBooking.id }),
    );
    expect(linked.status).toBe(201);
    expect(ExpenseSchema.parse(await linked.json()).booking_id).toBe(ownBooking.id);

    const foreign = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { booking_id: foreignBooking.id }),
    );
    expect(foreign.status).toBe(400);
    const envelope = (await foreign.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.details).toEqual({ booking_id: "not in this trip" });
  });

  it("POST: FX gate (R-money-6) — non-base without pair → 400; half-pairs → 400; base-currency WITH pair → 400", async () => {
    const { owner, trip } = await seedCollabTrip(); // base USD

    const missing = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { currency: "EUR" }),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    // Half-present pairs die at the shared schema (pair-together rule).
    const rateOnly = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { currency: "EUR", fx_rate: "1.08" }),
    );
    expect(rateOnly.status).toBe(400);
    const baseOnly = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { currency: "EUR", base_amount_cents: 3240 }),
    );
    expect(baseOnly.status).toBe(400);

    // Pair on a base-currency expense: presence ⟺ currency ≠ base.
    const spurious = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, { fx_rate: "1.00000000", base_amount_cents: 3000 }),
    );
    expect(spurious.status).toBe(400);

    expect(await dbExpensesOf(trip.id)).toHaveLength(0);
  });

  it("POST: FX gate — consistent pair → 201 with captured rate; inconsistent base_amount_cents → 400 (R-money-6)", async () => {
    const { owner, trip } = await seedCollabTrip(); // base USD

    const good = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        amount_cents: 1000,
        currency: "EUR",
        fx_rate: "1.08",
        base_amount_cents: 1080,
        shares: [{ user_id: owner.userId, share_cents: 1000 }],
      }),
    );
    expect(good.status).toBe(201);
    const expense = ExpenseSchema.parse(await good.json());
    expect(expense.fx_rate).toMatch(/^1\.08/); // numeric(18,8) may zero-pad
    expect(expense.base_amount_cents).toBe(1080);
    expect(expense.effective_base_cents).toBe(1080);

    const bad = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        amount_cents: 1000,
        currency: "EUR",
        fx_rate: "1.08",
        base_amount_cents: 1200, // a full cent past 1080 exact
        shares: [{ user_id: owner.userId, share_cents: 1000 }],
      }),
    );
    expect(bad.status).toBe(400);
    const envelope = (await bad.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.details).toEqual({ base_amount_cents: "inconsistent with fx_rate" });
  });

  it("POST: expense+shares write is ATOMIC — a forced share-insert failure rolls back the expense row (R-money-1)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION t92_reject_marker_share() RETURNS trigger AS $$
      BEGIN
        IF NEW.share_cents = 4242 THEN
          RAISE EXCEPTION 'forced failure (T-9.2 atomicity probe)';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
    `);
    await db.execute(
      sql`CREATE TRIGGER t92_reject_marker_share BEFORE INSERT ON expense_shares FOR EACH ROW EXECUTE FUNCTION t92_reject_marker_share()`,
    );
    try {
      const res = await postExpense(trip.id, owner.accessToken, {
        ...expenseBody(owner.userId, { amount_cents: 5000 }),
        shares: [
          { user_id: owner.userId, share_cents: 758 },
          { user_id: editor.userId, share_cents: 4242 },
        ],
      });
      expect(res.status).toBe(500);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("INTERNAL");
      // The expense row rolled back with its shares — zero orphans.
      expect(await dbExpensesOf(trip.id)).toHaveLength(0);
    } finally {
      await db.execute(sql`DROP TRIGGER t92_reject_marker_share ON expense_shares`);
      await db.execute(sql`DROP FUNCTION t92_reject_marker_share`);
    }
  });

  it("POST: create BLOCKS on a held trip-row lock and re-validates base_currency under it (T-6.1 TOCTOU, expense side)", async () => {
    const { owner, trip } = await seedCollabTrip(); // base USD
    // A USD body with no FX pair — valid against the CURRENT base, invalid
    // against the base another transaction is about to commit.
    const body = expenseBody(owner.userId);

    // Holder object: TS control-flow can't track a `let` assigned inside the
    // begin-callback closure — a property read re-widens correctly.
    const holder: { pending?: Promise<Response> } = {};
    let settled = false;
    await client.begin(async (tx) => {
      await tx`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`;
      const pending = Promise.resolve(postExpense(trip.id, owner.accessToken, body));
      holder.pending = pending;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await sleep(200);
      // The create is parked on the trip-row lock — not settled.
      expect(settled).toBe(false);
      // Simulate the racing base-currency PATCH committing first.
      await tx`UPDATE trips SET base_currency = 'EUR' WHERE id = ${trip.id}`;
    });

    if (!holder.pending) throw new Error("pending create never fired");
    const res = await holder.pending;
    // Re-checked under the lock: base is now EUR, the USD body has no FX
    // pair → 400 — the stale-snapshot 201 the TOCTOU allowed is dead.
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    expect(await dbExpensesOf(trip.id)).toHaveLength(0);

    // Control: the same body WITH a consistent pair for the new base lands.
    const control = await postExpense(
      trip.id,
      owner.accessToken,
      expenseBody(owner.userId, {
        fx_rate: "1.08",
        base_amount_cents: 3240,
      }),
    );
    expect(control.status).toBe(201);
  });

  // ===========================================================================
  // E2 — GET /trips/:tripId/expenses
  // ===========================================================================

  it("GET list: ordered spent_at DESC, created_at DESC, id DESC; cursor round-trip walks the full set exactly once", async () => {
    const { owner, trip } = await seedCollabTrip();
    const days = ["2026-09-01", "2026-09-02", "2026-09-02", "2026-09-03", "2026-09-03"];
    for (const [i, day] of days.entries()) {
      const res = await postExpense(
        trip.id,
        owner.accessToken,
        expenseBody(owner.userId, {
          description: `expense-${i}`,
          spent_at: day,
          amount_cents: 100 + i,
          shares: [{ user_id: owner.userId, share_cents: 100 + i }],
        }),
      );
      expect(res.status).toBe(201);
      await sleep(5); // distinct created_at instants within a day
    }

    const seen: Expense[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const res = await listExpenses(trip.id, owner.accessToken, query);
      expect(res.status).toBe(200);
      const body = PaginatedExpensesSchema.parse(await res.json());
      seen.push(...body.items);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((e) => e.id)).size).toBe(5); // no dup, no skip
    // Newest day first; within a day, newest created first.
    expect(seen.map((e) => e.spent_at)).toEqual([
      "2026-09-03",
      "2026-09-03",
      "2026-09-02",
      "2026-09-02",
      "2026-09-01",
    ]);
    expect(seen.map((e) => e.description)).toEqual([
      "expense-4",
      "expense-3",
      "expense-2",
      "expense-1",
      "expense-0",
    ]);

    // Malformed cursor → page 1 (opaque token; no cursor 400 documented).
    const malformed = await listExpenses(trip.id, owner.accessToken, "?limit=2&cursor=%25junk");
    expect(malformed.status).toBe(200);
    const first = PaginatedExpensesSchema.parse(await malformed.json());
    expect(first.items.map((e) => e.description)).toEqual(["expense-4", "expense-3"]);

    // Round-1 blocking pin: a shape-valid IMPOSSIBLE date ('2026-02-31')
    // must fold to page 1 — before the calendar-exact check it reached the
    // `::date` cast and 500'd (Postgres 22008) on an authed surface.
    const impossible = Buffer.from(
      `2026-02-31|1|${seen[0]?.id ?? NONEXISTENT_UUID}`,
      "utf8",
    ).toString("base64url");
    const crafted = await listExpenses(
      trip.id,
      owner.accessToken,
      `?limit=2&cursor=${encodeURIComponent(impossible)}`,
    );
    expect(crafted.status).toBe(200);
    const craftedPage = PaginatedExpensesSchema.parse(await crafted.json());
    expect(craftedPage.items.map((e) => e.description)).toEqual(["expense-4", "expense-3"]);
  });

  it("GET list: filters — category, member-as-payer, member-as-share-holder, date range (§3.2)", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();

    // food, paid by owner, split with viewer (viewer holds a share only).
    const food = await postExpense(trip.id, owner.accessToken, {
      description: "food-split",
      category: "food",
      paid_by: owner.userId,
      amount_cents: 2000,
      currency: "USD",
      spent_at: "2026-09-02",
      shares: [
        { user_id: owner.userId, share_cents: 1000 },
        { user_id: viewer.userId, share_cents: 1000 },
      ],
    });
    expect(food.status).toBe(201);
    // transport, paid by editor, solo.
    const transport = await postExpense(trip.id, editor.accessToken, {
      description: "transport-solo",
      category: "transport",
      paid_by: editor.userId,
      amount_cents: 900,
      currency: "USD",
      spent_at: "2026-09-05",
      shares: [{ user_id: editor.userId, share_cents: 900 }],
    });
    expect(transport.status).toBe(201);

    const byCategory = PaginatedExpensesSchema.parse(
      await (await listExpenses(trip.id, owner.accessToken, "?category=transport")).json(),
    );
    expect(byCategory.items.map((e) => e.description)).toEqual(["transport-solo"]);

    const byPayer = PaginatedExpensesSchema.parse(
      await (await listExpenses(trip.id, owner.accessToken, `?member=${editor.userId}`)).json(),
    );
    expect(byPayer.items.map((e) => e.description)).toEqual(["transport-solo"]);

    // Share-holder match: viewer never paid, only holds a share.
    const byShareHolder = PaginatedExpensesSchema.parse(
      await (await listExpenses(trip.id, owner.accessToken, `?member=${viewer.userId}`)).json(),
    );
    expect(byShareHolder.items.map((e) => e.description)).toEqual(["food-split"]);

    const byRange = PaginatedExpensesSchema.parse(
      await (
        await listExpenses(trip.id, owner.accessToken, "?from=2026-09-01&to=2026-09-03")
      ).json(),
    );
    expect(byRange.items.map((e) => e.description)).toEqual(["food-split"]);

    // Bad query values are a documented 400 (§3.2).
    expect((await listExpenses(trip.id, owner.accessToken, "?member=not-a-uuid")).status).toBe(
      400,
    );
    expect((await listExpenses(trip.id, owner.accessToken, "?limit=101")).status).toBe(400);
  });

  // ===========================================================================
  // E3 — GET /trips/:tripId/expenses/:expenseId
  // ===========================================================================

  it("GET detail: full document with sorted shares; wrong-trip expenseId is indistinguishable from absent (IDOR posture)", async () => {
    const a = await seedCollabTrip();
    const b = await seedCollabTrip();

    const created = ExpenseSchema.parse(
      await (
        await postExpense(a.trip.id, a.owner.accessToken, expenseBody(a.owner.userId))
      ).json(),
    );

    const res = await getExpense(a.trip.id, created.id, a.owner.accessToken);
    expect(res.status).toBe(200);
    expect(ExpenseSchema.parse(await res.json()).id).toBe(created.id);

    // Trip B's member probing trip B's route with trip A's expense id, a
    // nonexistent id, and a malformed id — byte-identical 404s (F-038).
    await expectIndistinguishable404s([
      await getExpense(b.trip.id, created.id, b.owner.accessToken),
      await getExpense(b.trip.id, NONEXISTENT_UUID, b.owner.accessToken),
      await getExpense(b.trip.id, "not-a-uuid", b.owner.accessToken),
    ]);
  });

  // ===========================================================================
  // E4 — PATCH /trips/:tripId/expenses/:expenseId
  // ===========================================================================

  it("PATCH: amount without shares → 400 (coupling rule); shares-only summing to STORED amount → 200 with FULL replacement", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const created = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, owner.accessToken, {
          ...expenseBody(owner.userId, { amount_cents: 3000 }),
          shares: [
            { user_id: owner.userId, share_cents: 1500 },
            { user_id: editor.userId, share_cents: 1500 },
          ],
        })
      ).json(),
    );

    const uncoupled = await patchExpense(trip.id, created.id, owner.accessToken, {
      amount_cents: 4000,
    });
    expect(uncoupled.status).toBe(400);

    // Shares-only: re-split the stored 3000 entirely onto the editor.
    await sleep(10); // updated_at must visibly move
    const replaced = await patchExpense(trip.id, created.id, owner.accessToken, {
      shares: [{ user_id: editor.userId, share_cents: 3000 }],
    });
    expect(replaced.status).toBe(200);
    const after = ExpenseSchema.parse(await replaced.json());
    expect(after.amount_cents).toBe(3000);
    expect(after.shares).toEqual([{ user_id: editor.userId, share_cents: 3000 }]);
    // A shares replacement is a document change — updated_at moves.
    expect(after.updated_at).not.toBe(created.updated_at);
    // DB: the old share set fully replaced, zero stale rows (R-money-1/2).
    const dbShares = await dbSharesOf(created.id);
    expect(dbShares).toHaveLength(1);
    expect(dbShares[0]?.userId).toBe(editor.userId);

    // Shares-only NOT summing to the stored amount → 400.
    const badSum = await patchExpense(trip.id, created.id, owner.accessToken, {
      shares: [{ user_id: editor.userId, share_cents: 2999 }],
    });
    expect(badSum.status).toBe(400);
    expect(((await badSum.json()) as ErrorEnvelope).error.details).toEqual({
      shares: "sum mismatch with stored amount",
    });
  });

  it("PATCH: amount + shares move together; merged FX rules re-run (currency change needs the pair; pair dies when back to base)", async () => {
    const { owner, trip } = await seedCollabTrip(); // base USD
    const created = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, owner.accessToken, expenseBody(owner.userId))
      ).json(),
    );

    // Currency → EUR without the pair: merged row violates R-money-6.
    const bare = await patchExpense(trip.id, created.id, owner.accessToken, {
      currency: "EUR",
    });
    expect(bare.status).toBe(400);

    // Currency → EUR with a consistent pair.
    const toEur = await patchExpense(trip.id, created.id, owner.accessToken, {
      currency: "EUR",
      fx_rate: "1.08",
      base_amount_cents: 3240,
    });
    expect(toEur.status).toBe(200);
    const eur = ExpenseSchema.parse(await toEur.json());
    expect(eur.currency).toBe("EUR");
    expect(eur.effective_base_cents).toBe(3240);

    // Clearing the pair while the currency stays EUR → 400.
    const cleared = await patchExpense(trip.id, created.id, owner.accessToken, {
      fx_rate: null,
      base_amount_cents: null,
    });
    expect(cleared.status).toBe(400);

    // Back to base currency: the pair must clear WITH it.
    const backKeepingPair = await patchExpense(trip.id, created.id, owner.accessToken, {
      currency: "USD",
    });
    expect(backKeepingPair.status).toBe(400); // merged: USD + stored pair

    const back = await patchExpense(trip.id, created.id, owner.accessToken, {
      currency: "USD",
      fx_rate: null,
      base_amount_cents: null,
    });
    expect(back.status).toBe(200);
    const usd = ExpenseSchema.parse(await back.json());
    expect(usd.fx_rate).toBeNull();
    expect(usd.effective_base_cents).toBe(3000);

    // Amount + shares change atomically (both present, schema-coupled).
    const grow = await patchExpense(trip.id, created.id, owner.accessToken, {
      amount_cents: 5000,
      shares: [{ user_id: owner.userId, share_cents: 5000 }],
    });
    expect(grow.status).toBe(200);
    expect(ExpenseSchema.parse(await grow.json()).amount_cents).toBe(5000);
  });

  it("PATCH authz matrix (R-money-26): creator-viewer edits own; owner edits any; editor on another's → 403; incoming participants re-checked", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();

    // Viewer creates their own expense…
    const viewersExpense = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, viewer.accessToken, expenseBody(viewer.userId))
      ).json(),
    );
    // …and CAN edit it (creator of any role).
    const ownEdit = await patchExpense(trip.id, viewersExpense.id, viewer.accessToken, {
      description: "renamed by creator",
    });
    expect(ownEdit.status).toBe(200);

    // Editor is NOT the creator and not the owner → 403 (proven member).
    const editorEdit = await patchExpense(trip.id, viewersExpense.id, editor.accessToken, {
      description: "nope",
    });
    expect(editorEdit.status).toBe(403);
    expect(((await editorEdit.json()) as ErrorEnvelope).error.code).toBe("FORBIDDEN");

    // Owner is the dispute-breaker: edits ANY expense.
    const ownerEdit = await patchExpense(trip.id, viewersExpense.id, owner.accessToken, {
      description: "owner override",
    });
    expect(ownerEdit.status).toBe(200);

    // Incoming paid_by must be a member (R-money-5 on the merged write).
    const badPayer = await patchExpense(trip.id, viewersExpense.id, owner.accessToken, {
      paid_by: stranger.userId,
    });
    expect(badPayer.status).toBe(400);
  });

  it("PATCH: ex-member history stays editable — description-only PATCH on a departed payer's expense → 200 (R-money-5 incoming-only, interp #4)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const created = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, editor.accessToken, expenseBody(editor.userId))
      ).json(),
    );

    // The payer leaves the trip; their expense/share rows survive (R-money-28).
    await db
      .delete(schema.tripMembers)
      .where(
        and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, editor.userId)),
      );

    // Owner edits description only: no incoming participant ids, so the
    // membership check must NOT re-litigate the stored ex-member rows.
    const res = await patchExpense(trip.id, created.id, owner.accessToken, {
      description: "ex-member history edit",
    });
    expect(res.status).toBe(200);
    const after = ExpenseSchema.parse(await res.json());
    expect(after.description).toBe("ex-member history edit");
    expect(after.paid_by).toBe(editor.userId); // history intact

    // Control: naming the departed member as an INCOMING participant fails.
    const incoming = await patchExpense(trip.id, created.id, owner.accessToken, {
      paid_by: editor.userId,
    });
    expect(incoming.status).toBe(400);
  });

  it("PATCH: booking link re-validated on update — foreign trip's booking_id → 400; null clears → 200 (update-side assertBookingInTrip)", async () => {
    const a = await seedCollabTrip();
    const b = await seedCollabTrip();
    const [ownBooking] = await db
      .insert(schema.bookings)
      .values({
        tripId: a.trip.id,
        category: "restaurant",
        title: "Linked",
        createdBy: a.owner.userId,
      })
      .returning({ id: schema.bookings.id });
    const [foreignBooking] = await db
      .insert(schema.bookings)
      .values({
        tripId: b.trip.id,
        category: "restaurant",
        title: "Foreign",
        createdBy: b.owner.userId,
      })
      .returning({ id: schema.bookings.id });
    if (!ownBooking || !foreignBooking) throw new Error("booking seed failed");

    const created = ExpenseSchema.parse(
      await (
        await postExpense(
          a.trip.id,
          a.owner.accessToken,
          expenseBody(a.owner.userId, { booking_id: ownBooking.id }),
        )
      ).json(),
    );

    const foreign = await patchExpense(a.trip.id, created.id, a.owner.accessToken, {
      booking_id: foreignBooking.id,
    });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as ErrorEnvelope).error.details).toEqual({
      booking_id: "not in this trip",
    });

    const cleared = await patchExpense(a.trip.id, created.id, a.owner.accessToken, {
      booking_id: null,
    });
    expect(cleared.status).toBe(200);
    expect(ExpenseSchema.parse(await cleared.json()).booking_id).toBeNull();
  });

  it("PATCH: two concurrent PATCHes serialize — final state is ONE complete write, never mixed (§4 concurrency)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const created = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, owner.accessToken, expenseBody(owner.userId, { amount_cents: 1000, shares: [{ user_id: owner.userId, share_cents: 1000 }] }))
      ).json(),
    );

    const writeA = {
      amount_cents: 2000,
      shares: [{ user_id: owner.userId, share_cents: 2000 }],
    };
    const writeB = {
      amount_cents: 3000,
      shares: [
        { user_id: owner.userId, share_cents: 1500 },
        { user_id: editor.userId, share_cents: 1500 },
      ],
    };
    const [resA, resB] = await Promise.all([
      patchExpense(trip.id, created.id, owner.accessToken, writeA),
      patchExpense(trip.id, created.id, owner.accessToken, writeB),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, created.id));
    const shares = await dbSharesOf(created.id);
    const sum = shares.reduce((acc, share) => acc + share.shareCents, 0);
    if (!row) throw new Error("expense vanished");
    // Exact-sum invariant holds no matter who won…
    expect(sum).toBe(row.amountCents);
    // …and the winner is one COMPLETE write, never an interleaving.
    if (row.amountCents === 2000) {
      expect(shares).toHaveLength(1);
    } else {
      expect(row.amountCents).toBe(3000);
      expect(shares).toHaveLength(2);
    }
  });

  // ===========================================================================
  // E5 — DELETE /trips/:tripId/expenses/:expenseId (+ deleted-state surface)
  // ===========================================================================

  it("DELETE: soft-delete sets the audit pair; row + shares survive; default list excludes; detail stays visible (R-money-27)", async () => {
    const { owner, editor, trip } = await seedCollabTrip();
    const keep = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, owner.accessToken, expenseBody(owner.userId, { description: "keeper" }))
      ).json(),
    );
    const doomed = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, editor.accessToken, {
          ...expenseBody(editor.userId, { description: "doomed", amount_cents: 1200 }),
          shares: [{ user_id: editor.userId, share_cents: 1200 }],
        })
      ).json(),
    );

    const res = await deleteExpense(trip.id, doomed.id, editor.accessToken);
    expect(res.status).toBe(204);

    // Row + shares SURVIVE with the audit pair set (never a hard delete).
    const [row] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, doomed.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(editor.userId);
    expect(await dbSharesOf(doomed.id)).toHaveLength(1);

    // Default list excludes it…
    const list = PaginatedExpensesSchema.parse(
      await (await listExpenses(trip.id, owner.accessToken)).json(),
    );
    expect(list.items.map((e) => e.id)).toEqual([keep.id]);

    // …while detail remains the visible audit surface (interpretation 2).
    const detail = await getExpense(trip.id, doomed.id, owner.accessToken);
    expect(detail.status).toBe(200);
    const audited = ExpenseSchema.parse(await detail.json());
    expect(audited.deleted_at).not.toBeNull();
    expect(audited.deleted_by).toBe(editor.userId);

    // A deleted expense is not editable (interpretation 3).
    const edit = await patchExpense(trip.id, doomed.id, editor.accessToken, {
      description: "necro-edit",
    });
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as ErrorEnvelope).error.details).toEqual({
      reason: "expense_deleted",
    });

    // Idempotent re-delete (owner this time): 204, FIRST deleter's audit
    // pair preserved (interpretation 4).
    const again = await deleteExpense(trip.id, doomed.id, owner.accessToken);
    expect(again.status).toBe(204);
    const [after] = await db
      .select()
      .from(schema.expenses)
      .where(eq(schema.expenses.id, doomed.id));
    expect(after?.deletedBy).toBe(editor.userId);
    expect(after?.deletedAt?.getTime()).toBe(row?.deletedAt?.getTime());
  });

  it("DELETE authz matrix: creator (any role) deletes own; owner deletes any; editor/viewer on another's → 403", async () => {
    const { owner, editor, viewer, trip } = await seedCollabTrip();
    const viewersExpense = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, viewer.accessToken, expenseBody(viewer.userId))
      ).json(),
    );

    expect((await deleteExpense(trip.id, viewersExpense.id, editor.accessToken)).status).toBe(
      403,
    );
    // Viewer deletes their OWN.
    expect((await deleteExpense(trip.id, viewersExpense.id, viewer.accessToken)).status).toBe(
      204,
    );

    const ownersExpense = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, editor.accessToken, expenseBody(editor.userId))
      ).json(),
    );
    // Viewer on ANOTHER's → 403.
    expect((await deleteExpense(trip.id, ownersExpense.id, viewer.accessToken)).status).toBe(403);
    // Owner deletes ANY (dispute-breaker).
    expect((await deleteExpense(trip.id, ownersExpense.id, owner.accessToken)).status).toBe(204);
  });

  // ===========================================================================
  // Trip-level IDOR posture (R-money-25 / F-038)
  // ===========================================================================

  it("non-members get byte-identical 404s across every verb — real trip, nonexistent trip, malformed trip id (F-038)", async () => {
    const { owner, trip } = await seedCollabTrip();
    const stranger = await seedUserWithToken();
    const created = ExpenseSchema.parse(
      await (
        await postExpense(trip.id, owner.accessToken, expenseBody(owner.userId))
      ).json(),
    );

    // List.
    await expectIndistinguishable404s([
      await listExpenses(trip.id, stranger.accessToken),
      await listExpenses(NONEXISTENT_UUID, stranger.accessToken),
      await listExpenses("not-a-uuid", stranger.accessToken),
    ]);
    // Create (valid body — validation must not open a distinguishable door
    // before the gate).
    await expectIndistinguishable404s([
      await postExpense(trip.id, stranger.accessToken, expenseBody(stranger.userId)),
      await postExpense(NONEXISTENT_UUID, stranger.accessToken, expenseBody(stranger.userId)),
      await postExpense("not-a-uuid", stranger.accessToken, expenseBody(stranger.userId)),
    ]);
    // Detail / PATCH / DELETE on a REAL expense id — its existence must not
    // leak through any verb.
    await expectIndistinguishable404s([
      await getExpense(trip.id, created.id, stranger.accessToken),
      await getExpense(NONEXISTENT_UUID, created.id, stranger.accessToken),
      await getExpense(trip.id, "not-a-uuid", stranger.accessToken),
    ]);
    await expectIndistinguishable404s([
      await patchExpense(trip.id, created.id, stranger.accessToken, { description: "probe" }),
      await patchExpense(NONEXISTENT_UUID, created.id, stranger.accessToken, {
        description: "probe",
      }),
    ]);
    await expectIndistinguishable404s([
      await deleteExpense(trip.id, created.id, stranger.accessToken),
      await deleteExpense(NONEXISTENT_UUID, created.id, stranger.accessToken),
    ]);

    // Nothing changed under the probes.
    expect(await dbExpensesOf(trip.id)).toHaveLength(1);
  });
});
