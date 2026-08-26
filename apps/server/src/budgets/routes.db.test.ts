/**
 * T-9.4 budgets integration suite (MON-6): GET budgets (G1), PUT
 * budgets/:category (G2) — end-to-end over a real Postgres, behind the real
 * app-wide `requireAuth` + `requireTripMember` gates. Covers every money-spec
 * §3.2 "Tests required" bullet for G1/G2: upsert create-then-update, null
 * clears the cap while the AI estimate survives, the overall (`total`) cap
 * set/cleared through the trips row, `spent_cents` against expense fixtures
 * including FX-allocated and soft-deleted ones, unknown category → 400, and
 * authz on both verbs (viewer 403 on PUT; F-038 IDOR harness on the trip
 * axis) — plus the trips-lock acquisition-order race pin (QUEUE T-9.4
 * obligation 4: a budgets write must serialize behind a concurrent
 * base-currency change, never stamp a stale currency).
 *
 * MOUNTING: the T-9.3 precedent — production middleware stack via
 * `createApp({ auth, trips })`, the budgets factory mounted onto the SAME
 * `/api` base the T-9.4 app.ts wiring uses.
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
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetsReadSchema, type BudgetsRead } from "@gogo/shared/domains/money";
import { TripWithRoleSchema } from "@gogo/shared/domains/trip";
import { EXPENSE_CATEGORIES, type TripMemberRole } from "@gogo/shared/enums";
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
import { createBudgetsRouter } from "./routes.js";

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
      "║  DOCKER UNAVAILABLE — T-9.4 BUDGETS SUITE SKIPPED                 ║\n" +
      "║  G1/G2 (R-money-20: taxonomy synthesis, computed spend, cap       ║\n" +
      "║  upsert + estimate preservation, total block) and the F-038       ║\n" +
      "║  IDOR harness were NOT verified. Start Docker and re-run          ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-9.4 budgets suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-9.4 budgets suite could " +
        "not verify money spec §2 G1/G2 (R-money-20, 25/26). A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

describe.skipIf(!dockerAvailable)("T-9.4 budgets routes (integration)", () => {
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
    app = createApp({ auth: authDeps, trips: { db } });
    app.route("/api", createBudgetsRouter({ db }));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `budgets-${uniq()}@example.com`,
      displayName: "Budget Tester",
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

  const getBudgets = (tripId: string, token: string) =>
    request(`/api/trips/${tripId}/budgets`, token);
  const putBudget = (tripId: string, category: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/budgets/${category}`, token, {
      method: "PUT",
      body: JSON.stringify(body),
    });

  async function createTripVia(token: string) {
    const res = await request("/api/trips", token, {
      method: "POST",
      body: JSON.stringify({
        name: `Trip ${uniq()}`,
        destination_name: "Lisbon, Portugal",
        destination_lat: 38.7223,
        destination_lng: -9.1393,
        start_date: "2026-10-01",
        end_date: "2026-10-08",
      }),
    });
    expect(res.status).toBe(201);
    return TripWithRoleSchema.parse(await res.json());
  }

  async function addMember(tripId: string, userId: string, role: TripMemberRole) {
    await db.insert(schema.tripMembers).values({ tripId, userId, role });
  }

  /** Direct expense seed (category-targeted; optional FX pair / soft delete). */
  async function seedExpense(args: {
    tripId: string;
    userId: string;
    category: (typeof EXPENSE_CATEGORIES)[number];
    amountCents: number;
    fxRate?: string;
    baseAmountCents?: number;
    deleted?: boolean;
  }) {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId: args.tripId,
        description: `seed-${uniq()}`,
        category: args.category,
        paidBy: args.userId,
        amountCents: args.amountCents,
        currency: args.fxRate !== undefined ? "EUR" : "USD",
        fxRate: args.fxRate ?? null,
        baseAmountCents: args.baseAmountCents ?? null,
        createdBy: args.userId,
        ...(args.deleted ? { deletedAt: new Date(), deletedBy: args.userId } : {}),
      })
      .returning();
    expect(expense).toBeDefined();
    await db.insert(schema.expenseShares).values({
      expenseId: expense!.id,
      userId: args.userId,
      shareCents: args.amountCents,
    });
  }

  const itemOf = (doc: BudgetsRead, category: string) => {
    const item = doc.items.find((entry) => entry.category === category);
    expect(item).toBeDefined();
    return item!;
  };

  // -------------------------------------------------------------------------
  // G1 — read
  // -------------------------------------------------------------------------

  it("G1: a fresh trip synthesizes ALL categories with nulls, base currency, zero spend", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    const res = await getBudgets(trip.id, owner.accessToken);
    expect(res.status).toBe(200);
    const doc = BudgetsReadSchema.parse(await res.json());

    expect(doc.items.map((item) => item.category)).toEqual([...EXPENSE_CATEGORIES]);
    for (const item of doc.items) {
      expect(item.cap_cents).toBeNull();
      expect(item.ai_estimate_cents).toBeNull();
      expect(item.ai_estimated_at).toBeNull();
      expect(item.currency).toBe("USD");
      expect(item.spent_cents).toBe(0);
    }
    expect(doc.total).toEqual({ cap_cents: null, spent_cents: 0, ai_estimate_cents: null });
  });

  it("G1: spent_cents = Σ effective base per category — FX rows count base, soft-deleted rows don't", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    await seedExpense({ tripId: trip.id, userId: owner.userId, category: "food", amountCents: 700 });
    await seedExpense({ tripId: trip.id, userId: owner.userId, category: "food", amountCents: 300 });
    // FX expense: 1000 EUR-cents at 1.08 → effective base 1080 (base column wins).
    await seedExpense({
      tripId: trip.id,
      userId: owner.userId,
      category: "transport",
      amountCents: 1000,
      fxRate: "1.08000000",
      baseAmountCents: 1080,
    });
    // Soft-deleted: excluded from spend entirely (R-money-27).
    await seedExpense({
      tripId: trip.id,
      userId: owner.userId,
      category: "food",
      amountCents: 99999,
      deleted: true,
    });

    const doc = BudgetsReadSchema.parse(await (await getBudgets(trip.id, owner.accessToken)).json());
    expect(itemOf(doc, "food").spent_cents).toBe(1000);
    expect(itemOf(doc, "transport").spent_cents).toBe(1080);
    expect(itemOf(doc, "lodging").spent_cents).toBe(0);
    expect(doc.total.spent_cents).toBe(2080);
  });

  // -------------------------------------------------------------------------
  // G2 — upsert
  // -------------------------------------------------------------------------

  it("G2: upsert create-then-update; null clears the cap and the AI estimate SURVIVES", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    // Create.
    const created = BudgetsReadSchema.parse(
      await (await putBudget(trip.id, "food", owner.accessToken, { cap_cents: 50_000 })).json(),
    );
    expect(itemOf(created, "food").cap_cents).toBe(50_000);
    expect(itemOf(created, "food").currency).toBe("USD");

    // Simulate a prior AI estimate on the SAME row (the P-10 write surface).
    const estimatedAt = new Date("2026-08-01T00:00:00.000Z");
    await db
      .update(schema.budgets)
      .set({ aiEstimateCents: 42_000, aiEstimatedAt: estimatedAt })
      .where(and(eq(schema.budgets.tripId, trip.id), eq(schema.budgets.category, "food")));

    // Update.
    const updated = BudgetsReadSchema.parse(
      await (await putBudget(trip.id, "food", owner.accessToken, { cap_cents: 60_000 })).json(),
    );
    expect(itemOf(updated, "food").cap_cents).toBe(60_000);
    expect(itemOf(updated, "food").ai_estimate_cents).toBe(42_000);

    // Null clears the cap, estimate intact (R-money-20).
    const cleared = BudgetsReadSchema.parse(
      await (await putBudget(trip.id, "food", owner.accessToken, { cap_cents: null })).json(),
    );
    expect(itemOf(cleared, "food").cap_cents).toBeNull();
    expect(itemOf(cleared, "food").ai_estimate_cents).toBe(42_000);
    expect(itemOf(cleared, "food").ai_estimated_at).toBe(estimatedAt.toISOString());

    // One row per (trip, category) — the upsert never duplicated.
    const rows = await db
      .select()
      .from(schema.budgets)
      .where(and(eq(schema.budgets.tripId, trip.id), eq(schema.budgets.category, "food")));
    expect(rows).toHaveLength(1);
  });

  it("G2: the overall cap rides the `total` pseudo-category onto trips.budget_cap_cents", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    const set = BudgetsReadSchema.parse(
      await (await putBudget(trip.id, "total", owner.accessToken, { cap_cents: 250_000 })).json(),
    );
    expect(set.total.cap_cents).toBe(250_000);
    const [row] = await db
      .select({ budgetCapCents: schema.trips.budgetCapCents })
      .from(schema.trips)
      .where(eq(schema.trips.id, trip.id));
    expect(row?.budgetCapCents).toBe(250_000);

    // `total` writes NO budgets row (it has none — descriptor JSDoc).
    const budgetRows = await db
      .select()
      .from(schema.budgets)
      .where(eq(schema.budgets.tripId, trip.id));
    expect(budgetRows).toHaveLength(0);

    const cleared = BudgetsReadSchema.parse(
      await (await putBudget(trip.id, "total", owner.accessToken, { cap_cents: null })).json(),
    );
    expect(cleared.total.cap_cents).toBeNull();
  });

  it("G1 [I-1]: total.ai_estimate_cents sums the non-null category estimates, null when none", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    // Two estimated categories, seeded directly (the P-10 surface's writes).
    for (const [category, estimate] of [
      ["food", 30_000],
      ["lodging", 80_000],
    ] as const) {
      await db.insert(schema.budgets).values({
        tripId: trip.id,
        category,
        capCents: null,
        aiEstimateCents: estimate,
        aiEstimatedAt: new Date(),
        currency: "USD",
      });
    }

    const doc = BudgetsReadSchema.parse(await (await getBudgets(trip.id, owner.accessToken)).json());
    expect(doc.total.ai_estimate_cents).toBe(110_000);
  });

  it("G2: unknown category → 400 VALIDATION_FAILED; the body is still schema-gated (bad cap → 400)", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    const unknown = await putBudget(trip.id, "souvenirs", owner.accessToken, { cap_cents: 100 });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    // Law #2 at the boundary: float cents fail validation.
    const float = await putBudget(trip.id, "food", owner.accessToken, { cap_cents: 25.5 });
    expect(float.status).toBe(400);
    const negative = await putBudget(trip.id, "food", owner.accessToken, { cap_cents: -1 });
    expect(negative.status).toBe(400);
  });

  it("G2 authz: viewer → 403 on PUT (both real and `total` segments); editor writes fine", async () => {
    const owner = await seedUserWithToken();
    const editor = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    await addMember(trip.id, editor.userId, "editor");
    await addMember(trip.id, viewer.userId, "viewer");

    expect((await putBudget(trip.id, "food", viewer.accessToken, { cap_cents: 1 })).status).toBe(
      403,
    );
    expect((await putBudget(trip.id, "total", viewer.accessToken, { cap_cents: 1 })).status).toBe(
      403,
    );
    expect((await putBudget(trip.id, "food", editor.accessToken, { cap_cents: 1 })).status).toBe(
      200,
    );
    // Viewer can still READ (member-wide G1).
    expect((await getBudgets(trip.id, viewer.accessToken)).status).toBe(200);
  });

  it("F-038: non-member vs nonexistent vs malformed trip — byte-identical 404s on both verbs", async () => {
    const owner = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    await expectIndistinguishable404s([
      await getBudgets(trip.id, stranger.accessToken),
      await getBudgets(NONEXISTENT_UUID, owner.accessToken),
      await getBudgets("not-a-uuid", owner.accessToken),
      await putBudget(trip.id, "food", stranger.accessToken, { cap_cents: 1 }),
      await putBudget(NONEXISTENT_UUID, "food", owner.accessToken, { cap_cents: 1 }),
    ]);
  });

  it("G2 lock order: a budgets write serializes behind a concurrent base-currency change (obligation 4)", async () => {
    const owner = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);

    // A raw transaction plays the base-currency PATCH: trips FOR UPDATE →
    // flip base → commit. The concurrent PUT must WAIT on the trips lock and
    // stamp the NEW currency; a service that skipped the trips lock would
    // read the pre-PATCH snapshot and strand budgets.currency = 'USD' on a
    // EUR trip (the §3.3.15 invariant violation this order exists to
    // prevent).
    let inFlight!: Response | Promise<Response>;
    await client.begin(async (tx) => {
      await tx`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`;
      inFlight = putBudget(trip.id, "food", owner.accessToken, { cap_cents: 12_345 });
      // Give the PUT time to reach (and block on) the trips lock; commit
      // happens when this callback resolves — never await inFlight here.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`UPDATE trips SET base_currency = 'EUR' WHERE id = ${trip.id}`;
    });
    const res = await inFlight;
    expect(res.status).toBe(200);
    const doc = BudgetsReadSchema.parse(await res.json());
    expect(itemOf(doc, "food").cap_cents).toBe(12_345);
    expect(itemOf(doc, "food").currency).toBe("EUR"); // the PUT serialized behind the flip

    const [row] = await db
      .select({ currency: schema.budgets.currency })
      .from(schema.budgets)
      .where(and(eq(schema.budgets.tripId, trip.id), eq(schema.budgets.category, "food")));
    expect(row?.currency).toBe("EUR");
  });

  it("401 without a token (app-wide requireAuth fronts the surface)", async () => {
    expect((await request(`/api/trips/${NONEXISTENT_UUID}/budgets`)).status).toBe(401);
  });
});
