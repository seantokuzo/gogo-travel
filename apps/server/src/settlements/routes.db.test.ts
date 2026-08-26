/**
 * T-9.3 settlements + balances integration suite (MON-3, MON-4): GET
 * balances (B1), POST/GET settlements (S1/S2), DELETE settlement (S3) —
 * end-to-end over a real Postgres, behind the real app-wide `requireAuth` +
 * `requireTripMember` gates. Covers every money-spec §3.2 "Tests required"
 * bullet for B1/S1/S2/S3: the §3.4 balance fixtures (multi-expense,
 * multi-payer, settlement offset, zero shares, FX prime-÷-3 allocation,
 * ex-members), the S1 party/currency/membership/future-`settled_at` arms,
 * the R-money-18 request-link transaction (flip AND settlement, or neither —
 * pinned with a REAL forced flip failure via a DB trigger), the R-money-15
 * 24 h recorder-delete window with boundary probes, keyset pagination
 * (including a pre-1970 `settled_at` — the signed-cursor case), and the
 * F-038 IDOR harness on trip AND settlement ids.
 *
 * MOUNTING: the settlements router is deliberately NOT in app.ts (its mount
 * rides T-9.4 — P-9 W2 file-ownership split), so this suite constructs the
 * production middleware stack via `createApp({ auth, trips })` and mounts
 * the factory onto it directly — same `/api` base, same requestId → auth →
 * bodyLimit → error-serializer chain every prod route runs.
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
  BalancesReadSchema,
  SettlementSchema,
  type BalancesRead,
  type Settlement,
} from "@gogo/shared/domains/money";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
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
import { createSettlementsRouter } from "./routes.js";
import { SETTLEMENT_DELETE_WINDOW_MS } from "./service.js";

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
      "║  DOCKER UNAVAILABLE — T-9.3 SETTLEMENTS SUITE SKIPPED             ║\n" +
      "║  Balances (B1: §3.4 fixtures, FX allocation, ex-members),         ║\n" +
      "║  settlements S1–S3 (party/currency rules, R-money-18 atomic       ║\n" +
      "║  request link, R-money-15 24 h window), pagination, and the       ║\n" +
      "║  F-038 IDOR harness were NOT verified. Start Docker and re-run    ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-9.3 settlements suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-9.3 settlements suite could " +
        "not verify money spec §2 B1 + S1–S3 (R-money-8..15, 18, 25). " +
        "A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const PaginatedSettlementsSchema = paginatedSchema(SettlementSchema);

describe.skipIf(!dockerAvailable)("T-9.3 settlements routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
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
    const authDeps: AuthRouterDeps = {
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
    // Production middleware stack (requestId → requireAuth → bodyLimit →
    // error serializer) + the trips surface for trip creation; the
    // settlements factory mounts onto the SAME `/api` base the T-9.4 wiring
    // will use (module doc — app.ts deliberately untouched by this task).
    app = createApp({ auth: authDeps, trips: { db } });
    app.route("/api", createSettlementsRouter({ db }));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `settlements-${uniq()}@example.com`,
      displayName: "Settlement Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  /**
   * Pinned fixture users with KNOWN canonical ordering (money spec §3.3:
   * ascending lowercase user_id) — deterministic largest-remainder
   * expectations need it, and `gen_random_uuid()` can't provide it. One hex
   * group per call keeps ids unique across tests sharing the container.
   */
  let fixtureGroup = 0;
  async function seedFixtureUsers(count: number): Promise<string[]> {
    const group = (fixtureGroup++).toString(16).padStart(4, "0");
    const ids = Array.from(
      { length: count },
      (_, i) => `aaaaaaaa-${group}-4000-8000-00000000000${i + 1}`,
    );
    for (const id of ids) {
      await db.insert(schema.users).values({
        id,
        email: `fixture-${group}-${id.slice(-1)}@example.com`,
        displayName: "Fixture User",
        googleSub: `google-fixture-${group}-${id.slice(-1)}`,
      });
      await db.insert(schema.entitlements).values({ userId: id });
    }
    return ids;
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

  const getBalances = (tripId: string, token: string) =>
    request(`/api/trips/${tripId}/balances`, token);
  const postSettlement = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/settlements`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const listSettlements = (tripId: string, token: string, query = "") =>
    request(`/api/trips/${tripId}/settlements${query}`, token);
  const deleteSettlementReq = (tripId: string, settlementId: string, token: string) =>
    request(`/api/trips/${tripId}/settlements/${settlementId}`, token, { method: "DELETE" });

  async function createTripVia(token: string) {
    const res = await request("/api/trips", token, {
      method: "POST",
      body: JSON.stringify({
        name: `Trip ${uniq()}`,
        destination_name: "Tokyo, Japan",
        destination_lat: 35.6895,
        destination_lng: 139.6917,
        start_date: "2026-09-01",
        end_date: "2026-09-10",
      }),
    });
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  /** Direct expense + shares seed (T-9.2's E1 rides a parallel worktree). */
  async function seedExpense(args: {
    tripId: string;
    paidBy: string;
    amountCents: number;
    shares: ReadonlyArray<{ userId: string; shareCents: number }>;
    fxRate?: string;
    baseAmountCents?: number;
    deleted?: boolean;
  }) {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId: args.tripId,
        description: `seed-${uniq()}`,
        category: "food",
        paidBy: args.paidBy,
        amountCents: args.amountCents,
        currency: args.fxRate !== undefined ? "EUR" : "USD",
        fxRate: args.fxRate ?? null,
        baseAmountCents: args.baseAmountCents ?? null,
        createdBy: args.paidBy,
        ...(args.deleted ? { deletedAt: new Date(), deletedBy: args.paidBy } : {}),
      })
      .returning();
    expect(expense).toBeDefined();
    for (const share of args.shares) {
      await db.insert(schema.expenseShares).values({
        expenseId: expense!.id,
        userId: share.userId,
        shareCents: share.shareCents,
      });
    }
    return expense!;
  }

  /** Direct settlement seed — historical rows (e.g. from a departed member). */
  async function seedSettlementRow(args: {
    tripId: string;
    fromUserId: string;
    toUserId: string;
    amountCents: number;
    settledAt?: Date;
    createdBy?: string;
  }) {
    const [row] = await db
      .insert(schema.settlements)
      .values({
        tripId: args.tripId,
        fromUserId: args.fromUserId,
        toUserId: args.toUserId,
        amountCents: args.amountCents,
        currency: "USD",
        method: "cash",
        createdBy: args.createdBy ?? args.fromUserId,
        ...(args.settledAt ? { settledAt: args.settledAt } : {}),
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  async function seedRequestRow(args: {
    tripId: string;
    fromUserId: string;
    toUserId: string;
    amountCents?: number;
    status?: "open" | "settled" | "cancelled";
    note?: string;
  }) {
    const [row] = await db
      .insert(schema.settlementRequests)
      .values({
        tripId: args.tripId,
        fromUserId: args.fromUserId,
        toUserId: args.toUserId,
        amountCents: args.amountCents ?? 500,
        currency: "USD",
        status: args.status ?? "open",
        note: args.note ?? null,
      })
      .returning();
    expect(row).toBeDefined();
    return row!;
  }

  async function readRequestRow(id: string) {
    const [row] = await db
      .select()
      .from(schema.settlementRequests)
      .where(eq(schema.settlementRequests.id, id));
    expect(row).toBeDefined();
    return row!;
  }

  async function settlementCount(tripId: string): Promise<number> {
    const rows = await db
      .select({ id: schema.settlements.id })
      .from(schema.settlements)
      .where(eq(schema.settlements.tripId, tripId));
    return rows.length;
  }

  const netOf = (doc: BalancesRead, userId: string) =>
    doc.members.find((m) => m.user_id === userId)?.net_cents;

  async function balancesOf(tripId: string, token: string): Promise<BalancesRead> {
    const res = await getBalances(tripId, token);
    expect(res.status).toBe(200);
    return BalancesReadSchema.parse(await res.json());
  }

  // ===========================================================================
  // GET /trips/:tripId/balances (B1)
  // ===========================================================================

  describe("GET balances", () => {
    it("empty trip: every current member at net 0, empty pairwise/simplified, trip base currency", async () => {
      const owner = await seedUserWithToken();
      const member = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, member.userId, "editor");

      const doc = await balancesOf(trip.id, owner.accessToken);
      expect(doc.currency).toBe("USD");
      expect(doc.members).toHaveLength(2);
      expect(netOf(doc, owner.userId)).toBe(0);
      expect(netOf(doc, member.userId)).toBe(0);
      expect(doc.pairwise).toEqual([]);
      expect(doc.simplified).toEqual([]);
    });

    it("multi-expense, multi-payer, settlement offset — §3.4 fixture over real rows; Σ nets = 0", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const [f1, f2, f3] = await seedFixtureUsers(3);
      for (const id of [f1!, f2!, f3!]) await addMember(trip.id, id, "editor");

      // f1 paid 3000 split equally; f2 paid 900 shared with f1.
      await seedExpense({
        tripId: trip.id,
        paidBy: f1!,
        amountCents: 3000,
        shares: [
          { userId: f1!, shareCents: 1000 },
          { userId: f2!, shareCents: 1000 },
          { userId: f3!, shareCents: 1000 },
        ],
      });
      await seedExpense({
        tripId: trip.id,
        paidBy: f2!,
        amountCents: 900,
        shares: [
          { userId: f1!, shareCents: 450 },
          { userId: f2!, shareCents: 450 },
        ],
      });
      // f3 paid f1 back 500.
      await seedSettlementRow({
        tripId: trip.id,
        fromUserId: f3!,
        toUserId: f1!,
        amountCents: 500,
      });

      const doc = await balancesOf(trip.id, owner.accessToken);
      expect(netOf(doc, f1!)).toBe(1050);
      expect(netOf(doc, f2!)).toBe(-550);
      expect(netOf(doc, f3!)).toBe(-500);
      expect(netOf(doc, owner.userId)).toBe(0);
      expect(doc.members.reduce((acc, m) => acc + m.net_cents, 0)).toBe(0);
      expect(doc.pairwise).toEqual([
        { trip_id: trip.id, user_id: f1, counterparty_id: f2, net_cents: 550 },
        { trip_id: trip.id, user_id: f1, counterparty_id: f3, net_cents: 500 },
      ]);
      expect(doc.simplified).toEqual([
        { from_user_id: f2, to_user_id: f1, amount_cents: 550 },
        { from_user_id: f3, to_user_id: f1, amount_cents: 500 },
      ]);
      // ≤ members − 1 transfers (R-money-10).
      expect(doc.simplified.length).toBeLessThanOrEqual(doc.members.length - 1);
    });

    it("FX expense: base allocated via shared largest remainder — prime 1097 over 334/333/333, no per-share drift (R-money-9)", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const [f1, f2, f3] = await seedFixtureUsers(3);
      for (const id of [f1!, f2!, f3!]) await addMember(trip.id, id, "editor");

      // €10.00 at 1.097 → $10.97 base; independent per-share rounding would
      // lose a cent (Σ 1096) — the shared allocator must land 367/365/365.
      await seedExpense({
        tripId: trip.id,
        paidBy: f1!,
        amountCents: 1000,
        fxRate: "1.09700000",
        baseAmountCents: 1097,
        shares: [
          { userId: f1!, shareCents: 334 },
          { userId: f2!, shareCents: 333 },
          { userId: f3!, shareCents: 333 },
        ],
      });

      const doc = await balancesOf(trip.id, owner.accessToken);
      expect(netOf(doc, f1!)).toBe(730);
      expect(netOf(doc, f2!)).toBe(-365);
      expect(netOf(doc, f3!)).toBe(-365);
      expect(doc.members.reduce((acc, m) => acc + m.net_cents, 0)).toBe(0);
    });

    it("soft-deleted expenses are excluded (R-money-27 / R-db-21)", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const [f1, f2] = await seedFixtureUsers(2);
      for (const id of [f1!, f2!]) await addMember(trip.id, id, "editor");

      await seedExpense({
        tripId: trip.id,
        paidBy: f1!,
        amountCents: 800,
        shares: [{ userId: f2!, shareCents: 800 }],
        deleted: true,
      });

      const doc = await balancesOf(trip.id, owner.accessToken);
      expect(netOf(doc, f1!)).toBe(0);
      expect(netOf(doc, f2!)).toBe(0);
      expect(doc.pairwise).toEqual([]);
    });

    it("ex-member appears while non-zero, drops once fully settled ([I-1] — R-money-8/28)", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const [ex] = await seedFixtureUsers(1);
      await addMember(trip.id, ex!, "editor");

      await seedExpense({
        tripId: trip.id,
        paidBy: owner.userId,
        amountCents: 1000,
        shares: [{ userId: ex!, shareCents: 1000 }],
      });
      // The member leaves with a nonzero balance (allowed — R-money-28).
      await db
        .delete(schema.tripMembers)
        .where(and(eq(schema.tripMembers.tripId, trip.id), eq(schema.tripMembers.userId, ex!)));

      const outstanding = await balancesOf(trip.id, owner.accessToken);
      expect(netOf(outstanding, ex!)).toBe(-1000);
      expect(netOf(outstanding, owner.userId)).toBe(1000);
      expect(outstanding.pairwise).toHaveLength(1);

      // Historical settlement zeroes the departed member's ledger …
      await seedSettlementRow({
        tripId: trip.id,
        fromUserId: ex!,
        toUserId: owner.userId,
        amountCents: 1000,
      });

      // … and they drop out of the document; the current member remains at 0.
      const settled = await balancesOf(trip.id, owner.accessToken);
      expect(settled.members).toEqual([{ user_id: owner.userId, net_cents: 0 }]);
      expect(settled.pairwise).toEqual([]);
      expect(settled.simplified).toEqual([]);
    });

    it("viewer can read balances (§3.8 matrix)", async () => {
      const owner = await seedUserWithToken();
      const viewer = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, viewer.userId, "viewer");

      const res = await getBalances(trip.id, viewer.accessToken);
      expect(res.status).toBe(200);
    });

    it("authz: non-member / absent / malformed trip are indistinguishable 404s (F-038)", async () => {
      const owner = await seedUserWithToken();
      const stranger = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);

      await expectIndistinguishable404s([
        await getBalances(trip.id, stranger.accessToken),
        await getBalances(NONEXISTENT_UUID, stranger.accessToken),
        await getBalances("not-a-uuid", stranger.accessToken),
      ]);
    });
  });

  // ===========================================================================
  // POST /trips/:tripId/settlements (S1)
  // ===========================================================================

  describe("POST settlement", () => {
    it("payer records; the next balance read reflects it immediately (R-money-12/14)", async () => {
      const owner = await seedUserWithToken();
      const payer = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, payer.userId, "editor");

      await seedExpense({
        tripId: trip.id,
        paidBy: owner.userId,
        amountCents: 1000,
        shares: [{ userId: payer.userId, shareCents: 1000 }],
      });

      const res = await postSettlement(trip.id, payer.accessToken, {
        from_user_id: payer.userId,
        to_user_id: owner.userId,
        amount_cents: 600,
        currency: "USD",
        method: "venmo",
        note: "first installment",
      });
      expect(res.status).toBe(201);
      const settlement = SettlementSchema.parse(await res.json());
      expect(settlement.trip_id).toBe(trip.id);
      expect(settlement.created_by).toBe(payer.userId);
      expect(settlement.amount_cents).toBe(600);

      const doc = await balancesOf(trip.id, owner.accessToken);
      expect(netOf(doc, payer.userId)).toBe(-400);
      expect(netOf(doc, owner.userId)).toBe(400);
    });

    it("payee records (either party may — R-money-12)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const res = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 250,
        currency: "USD",
        method: "cash",
      });
      expect(res.status).toBe(201);
      expect(SettlementSchema.parse(await res.json()).created_by).toBe(owner.userId);
    });

    it("a viewer can settle their own debts (R-money-26 — party rules are role-independent)", async () => {
      const owner = await seedUserWithToken();
      const viewer = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, viewer.userId, "viewer");

      const res = await postSettlement(trip.id, viewer.accessToken, {
        from_user_id: viewer.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "zelle",
      });
      expect(res.status).toBe(201);
    });

    it("a member who is not a party gets 403 (R-money-12)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const third = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");
      await addMember(trip.id, third.userId, "editor");

      const res = await postSettlement(trip.id, third.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("non-base currency → 400 (R-money-13: settlements are ALWAYS trip base)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const res = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "EUR",
        method: "cash",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("VALIDATION_FAILED");
      expect(await settlementCount(trip.id)).toBe(0);
    });

    it("self-settlement → 400 at the boundary (shared schema superRefine)", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);

      const res = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: owner.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    });

    it("float cents → 400 (Law #2 wire check)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const res = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 25.5,
        currency: "USD",
        method: "cash",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    });

    it("future settled_at → 400; past settled_at is stored verbatim ([I-6])", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const future = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
        settled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      expect(future.status).toBe(400);
      expect(((await future.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

      const past = "2026-08-20T10:00:00.000Z";
      const ok = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
        settled_at: past,
      });
      expect(ok.status).toBe(201);
      expect(SettlementSchema.parse(await ok.json()).settled_at).toBe(past);
    });

    it("non-member counterparty → 400 ([I-2] party rule: both parties current members)", async () => {
      const owner = await seedUserWithToken();
      const outsider = await seedUserWithToken(); // a real user, NOT a member
      const trip = await createTripVia(owner.accessToken);

      const res = await postSettlement(trip.id, owner.accessToken, {
        from_user_id: owner.userId,
        to_user_id: outsider.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
      expect(await settlementCount(trip.id)).toBe(0);
    });

    it("authz: non-member caller gets the indistinguishable 404 (F-038)", async () => {
      const owner = await seedUserWithToken();
      const stranger = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const body = {
        from_user_id: stranger.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
      };

      await expectIndistinguishable404s([
        await postSettlement(trip.id, stranger.accessToken, body),
        await postSettlement(NONEXISTENT_UUID, stranger.accessToken, body),
        await postSettlement("not-a-uuid", stranger.accessToken, body),
      ]);
    });

    describe("request linking (R-money-18)", () => {
      it("settlement + request flip commit together; settlement_id set", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        const request = await seedRequestRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
        });

        const res = await postSettlement(trip.id, debtor.accessToken, {
          from_user_id: debtor.userId,
          to_user_id: owner.userId,
          amount_cents: 500,
          currency: "USD",
          method: "paypal",
          request_id: request.id,
        });
        expect(res.status).toBe(201);
        const settlement = SettlementSchema.parse(await res.json());

        const flipped = await readRequestRow(request.id);
        expect(flipped.status).toBe("settled");
        expect(flipped.settlementId).toBe(settlement.id);
      });

      it("non-open request → 409, nothing written ([I-3])", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        const cancelled = await seedRequestRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          status: "cancelled",
        });

        const res = await postSettlement(trip.id, debtor.accessToken, {
          from_user_id: debtor.userId,
          to_user_id: owner.userId,
          amount_cents: 500,
          currency: "USD",
          method: "cash",
          request_id: cancelled.id,
        });
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorEnvelope).error.code).toBe("CONFLICT");
        expect(await settlementCount(trip.id)).toBe(0);
        expect((await readRequestRow(cancelled.id)).status).toBe("cancelled");
      });

      it("request between a different pair → 409 ([I-3])", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const other = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        await addMember(trip.id, other.userId, "editor");
        const request = await seedRequestRow({
          tripId: trip.id,
          fromUserId: other.userId,
          toUserId: owner.userId,
        });

        const res = await postSettlement(trip.id, debtor.accessToken, {
          from_user_id: debtor.userId,
          to_user_id: owner.userId,
          amount_cents: 500,
          currency: "USD",
          method: "cash",
          request_id: request.id,
        });
        expect(res.status).toBe(409);
        expect(await settlementCount(trip.id)).toBe(0);
      });

      it("reverse-direction settlement does NOT settle the request → 409 ([I-4])", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        // Request bills debtor → owner …
        const request = await seedRequestRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
        });

        // … but the settlement claims owner paid debtor.
        const res = await postSettlement(trip.id, owner.accessToken, {
          from_user_id: owner.userId,
          to_user_id: debtor.userId,
          amount_cents: 500,
          currency: "USD",
          method: "cash",
          request_id: request.id,
        });
        expect(res.status).toBe(409);
        expect((await readRequestRow(request.id)).status).toBe("open");
        expect(await settlementCount(trip.id)).toBe(0);
      });

      it("unknown request id and another trip's request → 409 ([I-3] — one code, no oracle)", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        const otherTrip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        await addMember(otherTrip.id, debtor.userId, "editor");
        const foreign = await seedRequestRow({
          tripId: otherTrip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
        });

        const body = (requestId: string) => ({
          from_user_id: debtor.userId,
          to_user_id: owner.userId,
          amount_cents: 500,
          currency: "USD",
          method: "cash",
          request_id: requestId,
        });

        const unknown = await postSettlement(trip.id, debtor.accessToken, body(NONEXISTENT_UUID));
        expect(unknown.status).toBe(409);
        const crossTrip = await postSettlement(trip.id, debtor.accessToken, body(foreign.id));
        expect(crossTrip.status).toBe(409);
        // The foreign request is untouched.
        expect((await readRequestRow(foreign.id)).status).toBe("open");
        expect(await settlementCount(trip.id)).toBe(0);
      });

      it("a REAL forced flip failure rolls the settlement back — flip AND insert, or neither (R-money-18)", async () => {
        const owner = await seedUserWithToken();
        const debtor = await seedUserWithToken();
        const trip = await createTripVia(owner.accessToken);
        await addMember(trip.id, debtor.userId, "editor");
        const request = await seedRequestRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          note: "FORCE_FAIL",
        });

        // The settlement insert succeeds; the request flip then raises —
        // the transaction must roll BOTH back.
        await db.execute(sql`
          CREATE FUNCTION gogo_force_flip_fail() RETURNS trigger AS $$
          BEGIN
            IF NEW.note = 'FORCE_FAIL' AND NEW.status = 'settled' THEN
              RAISE EXCEPTION 'forced flip failure (T-9.3 atomicity pin)';
            END IF;
            RETURN NEW;
          END
          $$ LANGUAGE plpgsql
        `);
        await db.execute(sql`
          CREATE TRIGGER settlement_requests_force_fail
          BEFORE UPDATE ON settlement_requests
          FOR EACH ROW EXECUTE FUNCTION gogo_force_flip_fail()
        `);
        try {
          const res = await postSettlement(trip.id, debtor.accessToken, {
            from_user_id: debtor.userId,
            to_user_id: owner.userId,
            amount_cents: 500,
            currency: "USD",
            method: "cash",
            request_id: request.id,
          });
          expect(res.status).toBe(500);
          expect(((await res.json()) as ErrorEnvelope).error.code).toBe("INTERNAL");
        } finally {
          await db.execute(sql`DROP TRIGGER settlement_requests_force_fail ON settlement_requests`);
          await db.execute(sql`DROP FUNCTION gogo_force_flip_fail()`);
        }

        // Neither side landed: no settlement row, request still open+unlinked.
        expect(await settlementCount(trip.id)).toBe(0);
        const untouched = await readRequestRow(request.id);
        expect(untouched.status).toBe("open");
        expect(untouched.settlementId).toBeNull();
      });
    });
  });

  // ===========================================================================
  // GET /trips/:tripId/settlements (S2)
  // ===========================================================================

  describe("GET settlements list", () => {
    it("orders settled_at DESC (id DESC tiebreak) and walks the keyset cursor without skips or dupes — including a pre-1970 settled_at", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const at = (iso: string) => new Date(iso);
      const seeded = [
        await seedSettlementRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          amountCents: 101,
          settledAt: at("2026-08-01T10:00:00Z"),
        }),
        await seedSettlementRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          amountCents: 102,
          settledAt: at("2026-08-03T10:00:00Z"),
        }),
        // A tie pair — id DESC decides within it.
        await seedSettlementRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          amountCents: 103,
          settledAt: at("2026-08-02T10:00:00Z"),
        }),
        await seedSettlementRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          amountCents: 104,
          settledAt: at("2026-08-02T10:00:00Z"),
        }),
        // Pre-1970: negative epoch-micros — the signed-cursor case.
        await seedSettlementRow({
          tripId: trip.id,
          fromUserId: debtor.userId,
          toUserId: owner.userId,
          amountCents: 105,
          settledAt: at("1969-07-20T20:17:00Z"),
        }),
      ];

      const tiePair = [seeded[2]!, seeded[3]!].sort((a, b) => (a.id > b.id ? -1 : 1));
      const expectedIds = [
        seeded[1]!.id,
        tiePair[0]!.id,
        tiePair[1]!.id,
        seeded[0]!.id,
        seeded[4]!.id,
      ];

      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const query = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await listSettlements(trip.id, owner.accessToken, query);
        expect(res.status).toBe(200);
        const body = PaginatedSettlementsSchema.parse(await res.json());
        walked.push(...body.items.map((item: Settlement) => item.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(walked).toEqual(expectedIds);
    });

    it("malformed cursor falls back to page 1 (opaque token, no 400)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");
      await seedSettlementRow({
        tripId: trip.id,
        fromUserId: debtor.userId,
        toUserId: owner.userId,
        amountCents: 100,
      });

      const res = await listSettlements(trip.id, owner.accessToken, "?cursor=%25garbage%25");
      expect(res.status).toBe(200);
      expect(PaginatedSettlementsSchema.parse(await res.json()).items).toHaveLength(1);
    });

    it("limit above the shared cap → 400", async () => {
      const owner = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const res = await listSettlements(trip.id, owner.accessToken, "?limit=101");
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
    });

    it("authz: non-member → indistinguishable 404 (F-038)", async () => {
      const owner = await seedUserWithToken();
      const stranger = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);

      await expectIndistinguishable404s([
        await listSettlements(trip.id, stranger.accessToken),
        await listSettlements(NONEXISTENT_UUID, stranger.accessToken),
        await listSettlements("not-a-uuid", stranger.accessToken),
      ]);
    });
  });

  // ===========================================================================
  // DELETE /trips/:tripId/settlements/:settlementId (S3)
  // ===========================================================================

  describe("DELETE settlement", () => {
    it("recorder deletes within 24 h → 204; balances recompute; linked request reopens (R-money-15)", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");
      await seedExpense({
        tripId: trip.id,
        paidBy: owner.userId,
        amountCents: 500,
        shares: [{ userId: debtor.userId, shareCents: 500 }],
      });
      const request = await seedRequestRow({
        tripId: trip.id,
        fromUserId: debtor.userId,
        toUserId: owner.userId,
      });

      const created = await postSettlement(trip.id, debtor.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 500,
        currency: "USD",
        method: "venmo",
        request_id: request.id,
      });
      expect(created.status).toBe(201);
      const settlement = SettlementSchema.parse(await created.json());
      expect(netOf(await balancesOf(trip.id, owner.accessToken), debtor.userId)).toBe(0);

      const res = await deleteSettlementReq(trip.id, settlement.id, debtor.accessToken);
      expect(res.status).toBe(204);

      // Row hard-deleted; the debt is outstanding again; the request reopened.
      expect(await settlementCount(trip.id)).toBe(0);
      expect(netOf(await balancesOf(trip.id, owner.accessToken), debtor.userId)).toBe(-500);
      const reopened = await readRequestRow(request.id);
      expect(reopened.status).toBe("open");
      expect(reopened.settlementId).toBeNull();
    });

    it("24 h window boundary: just inside deletes, just past → 403 ([I-5])", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");

      const create = () =>
        postSettlement(trip.id, debtor.accessToken, {
          from_user_id: debtor.userId,
          to_user_id: owner.userId,
          amount_cents: 100,
          currency: "USD",
          method: "cash",
        });
      const backdate = (id: string, ageMs: number) =>
        db
          .update(schema.settlements)
          .set({ createdAt: new Date(Date.now() - ageMs) })
          .where(eq(schema.settlements.id, id));

      const inside = SettlementSchema.parse(await (await create()).json());
      await backdate(inside.id, SETTLEMENT_DELETE_WINDOW_MS - 60_000);
      expect((await deleteSettlementReq(trip.id, inside.id, debtor.accessToken)).status).toBe(204);

      const past = SettlementSchema.parse(await (await create()).json());
      await backdate(past.id, SETTLEMENT_DELETE_WINDOW_MS + 60_000);
      const res = await deleteSettlementReq(trip.id, past.id, debtor.accessToken);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe("FORBIDDEN");
      // Immutable ledger: the row survives.
      expect(await settlementCount(trip.id)).toBe(1);
    });

    it("only the recorder may delete — the other party and a third member get 403", async () => {
      const owner = await seedUserWithToken();
      const debtor = await seedUserWithToken();
      const third = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      await addMember(trip.id, debtor.userId, "editor");
      await addMember(trip.id, third.userId, "editor");

      const created = await postSettlement(trip.id, debtor.accessToken, {
        from_user_id: debtor.userId,
        to_user_id: owner.userId,
        amount_cents: 100,
        currency: "USD",
        method: "cash",
      });
      const settlement = SettlementSchema.parse(await created.json());

      // The payee (a party, but not the recorder) — 403.
      expect((await deleteSettlementReq(trip.id, settlement.id, owner.accessToken)).status).toBe(
        403,
      );
      // A non-party member — 403.
      expect((await deleteSettlementReq(trip.id, settlement.id, third.accessToken)).status).toBe(
        403,
      );
      expect(await settlementCount(trip.id)).toBe(1);
    });

    it("authz: stranger / absent / malformed / wrong-trip ids are indistinguishable 404s (F-038)", async () => {
      const owner = await seedUserWithToken();
      const stranger = await seedUserWithToken();
      const trip = await createTripVia(owner.accessToken);
      const otherTrip = await createTripVia(owner.accessToken);
      const row = await seedSettlementRow({
        tripId: trip.id,
        fromUserId: owner.userId,
        toUserId: (await seedFixtureUsers(1))[0]!,
        amountCents: 100,
        createdBy: owner.userId,
      });

      await expectIndistinguishable404s([
        // Exists, but the caller is not a member of its trip.
        await deleteSettlementReq(trip.id, row.id, stranger.accessToken),
        // Member of the trip, settlement does not exist.
        await deleteSettlementReq(trip.id, NONEXISTENT_UUID, owner.accessToken),
        // Member, malformed settlement id — same door.
        await deleteSettlementReq(trip.id, "not-a-uuid", owner.accessToken),
        // Member of ANOTHER trip using its scope on this trip's settlement.
        await deleteSettlementReq(otherTrip.id, row.id, owner.accessToken),
      ]);
    });
  });
});
