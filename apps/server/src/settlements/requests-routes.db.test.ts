/**
 * T-9.4 settle-requests integration suite (MON-5): POST settle-requests
 * (Q1), GET/DELETE settle-requests/:requestId (Q2/Q3) — end-to-end over a
 * real Postgres, behind the real app-wide `requireAuth` + `requireTripMember`
 * gates. Covers every money-spec §3.2 "Tests required" bullet for Q1–Q3:
 * default amount = live pairwise debt, zero-debt 409, the R-money-17
 * minimum-disclosure snapshot (exact key set against a rich trip), the
 * settled-elsewhere `resolved: true` while `status: 'open'` derivation
 * (R-money-18/19), cancel authz + non-open 409, and the F-038 IDOR harness
 * on trip AND request ids — plus the trips-lock serialization pin (a request
 * must never be born carrying a pre-PATCH base currency) and the [I-2]
 * explicit-amount arm.
 *
 * MOUNTING: the T-9.3 precedent — production middleware stack via
 * `createApp({ auth, trips })`, factories mounted onto the SAME `/api` base
 * the T-9.4 app.ts wiring uses (the settlements router rides along for the
 * S1 settle arms).
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
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLocalJWKSet, generateKeyPair } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LINK_DOMAIN } from "@gogo/shared/config/links";
import {
  SettleRequestDetailSchema,
  SettleRequestSchema,
  type SettleRequestDetail,
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
import { createSettleRequestsRouter } from "./requests-routes.js";
import { createSettlementsRouter } from "./routes.js";

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
      "║  DOCKER UNAVAILABLE — T-9.4 SETTLE-REQUESTS SUITE SKIPPED         ║\n" +
      "║  Q1–Q3 (R-money-16..19: debt-defaulted create, minimum            ║\n" +
      "║  disclosure, resolved derivation, cancel authz) and the F-038     ║\n" +
      "║  IDOR harness were NOT verified. Start Docker and re-run          ║\n" +
      "║  `pnpm --filter @gogo/server test` before treating this green.    ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

if (!dockerAvailable && process.env.CI) {
  it("T-9.4 settle-requests suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-9.4 settle-requests suite " +
        "could not verify money spec §2 Q1–Q3 (R-money-16..19, 25). " +
        "A skip is NOT a pass.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

describe.skipIf(!dockerAvailable)("T-9.4 settle-requests routes (integration)", () => {
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
    app = createApp({ auth: authDeps, trips: { db } });
    app.route("/api", createSettleRequestsRouter({ db }));
    // S1 rides along for the settled-elsewhere / settled-through arms.
    app.route("/api", createSettlementsRouter({ db }));
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  // ---- seeding helpers ------------------------------------------------------

  async function seedUserWithToken(handles?: { venmo?: string }) {
    const { user } = await createUserWithEntitlements(db, {
      email: `requests-${uniq()}@example.com`,
      displayName: "Request Tester",
      googleSub: `google-${uniq()}`,
    });
    if (handles?.venmo) {
      await db
        .update(schema.users)
        .set({ venmoUsername: handles.venmo })
        .where(eq(schema.users.id, user.id));
    }
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

  const postRequest = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/settle-requests`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const getRequest = (tripId: string, requestId: string, token: string) =>
    request(`/api/trips/${tripId}/settle-requests/${requestId}`, token);
  const cancelRequest = (tripId: string, requestId: string, token: string) =>
    request(`/api/trips/${tripId}/settle-requests/${requestId}`, token, { method: "DELETE" });
  const postSettlement = (tripId: string, token: string, body: unknown) =>
    request(`/api/trips/${tripId}/settlements`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });

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

  /** Direct expense + shares seed — a debt `debtor → payer` of `cents`. */
  async function seedDebt(tripId: string, payer: string, debtor: string, cents: number) {
    const [expense] = await db
      .insert(schema.expenses)
      .values({
        tripId,
        description: `seed-${uniq()}`,
        category: "food",
        paidBy: payer,
        amountCents: cents,
        currency: "USD",
        createdBy: payer,
      })
      .returning();
    expect(expense).toBeDefined();
    await db.insert(schema.expenseShares).values({
      expenseId: expense!.id,
      userId: debtor,
      shareCents: cents,
    });
  }

  // -------------------------------------------------------------------------
  // Q1 — create (R-money-16)
  // -------------------------------------------------------------------------

  it("Q1: amount defaults to the live pairwise debt; currency = trip base; link on LINK_DOMAIN", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 4321);

    const res = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: debtor.userId,
      note: "dinner + cab",
    });
    expect(res.status).toBe(201);
    const body = SettleRequestSchema.parse(await res.json());
    expect(body.amount_cents).toBe(4321);
    expect(body.from_user_id).toBe(debtor.userId);
    expect(body.to_user_id).toBe(creditor.userId); // creditor = caller by construction
    expect(body.created_by).toBe(creditor.userId);
    expect(body.currency).toBe("USD"); // trip base
    expect(body.status).toBe("open");
    expect(body.resolved).toBe(false);
    expect(body.settlement_id).toBeNull();
    expect(body.link).toBe(`https://${LINK_DOMAIN}/t/${trip.id}/request/${body.id}`);
  });

  it("Q1: zero debt without an explicit amount → 409; negative debt (caller owes) → 409", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");

    // No ledger at all — zero debt.
    const zero = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: debtor.userId,
    });
    expect(zero.status).toBe(409);
    const zeroBody = (await zero.json()) as ErrorEnvelope;
    expect(zeroBody.error.code).toBe("CONFLICT");

    // Debt runs the OTHER way: the caller owes the debtor.
    await seedDebt(trip.id, debtor.userId, creditor.userId, 900);
    const negative = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: debtor.userId,
    });
    expect(negative.status).toBe(409);
  });

  it("Q1 [I-2]: an explicit amount is accepted at zero debt — and the request is born resolved", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");

    const res = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: debtor.userId,
      amount_cents: 1500,
    });
    expect(res.status).toBe(201);
    const body = SettleRequestSchema.parse(await res.json());
    expect(body.amount_cents).toBe(1500);
    expect(body.status).toBe("open");
    expect(body.resolved).toBe(true); // [I-1]: live debt ≤ 0
  });

  it("Q1: debtor = caller → 400; debtor not a member → 400 (both VALIDATION_FAILED)", async () => {
    const creditor = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);

    const self = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: creditor.userId,
      amount_cents: 100,
    });
    expect(self.status).toBe(400);
    expect(((await self.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");

    const nonMember = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: stranger.userId,
      amount_cents: 100,
    });
    expect(nonMember.status).toBe(400);
    expect(((await nonMember.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_FAILED");
  });

  it("Q1: a viewer CAN send the bill (party rules are role-independent, R-money-26)", async () => {
    const owner = await seedUserWithToken();
    const viewer = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    await addMember(trip.id, viewer.userId, "viewer");
    await seedDebt(trip.id, viewer.userId, owner.userId, 777);

    const res = await postRequest(trip.id, viewer.accessToken, { from_user_id: owner.userId });
    expect(res.status).toBe(201);
    expect(SettleRequestSchema.parse(await res.json()).amount_cents).toBe(777);
  });

  it("Q1: creation takes the trips lock — a request is never born with a pre-PATCH base currency", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");

    // A raw transaction plays the base-currency PATCH: trips FOR UPDATE →
    // flip base → commit. The concurrent Q1 must WAIT on the trips lock and
    // stamp the NEW base; without the service's `.for("update")` it would
    // read the pre-PATCH snapshot and mint a EUR-trip request denominated
    // in USD (exactly the ledger state the R-trips-22 probe exists to
    // prevent).
    let inFlight!: Response | Promise<Response>;
    await client.begin(async (tx) => {
      await tx`SELECT id FROM trips WHERE id = ${trip.id} FOR UPDATE`;
      inFlight = postRequest(trip.id, creditor.accessToken, {
        from_user_id: debtor.userId,
        amount_cents: 2500,
      });
      // Give the request time to reach (and block on) the trips lock. The
      // in-flight promise must NOT be awaited inside this callback — commit
      // happens when the callback resolves, and the POST needs that commit.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await tx`UPDATE trips SET base_currency = 'EUR' WHERE id = ${trip.id}`;
    });
    const res = await inFlight;
    expect(res.status).toBe(201);
    const body = SettleRequestSchema.parse(await res.json());
    expect(body.currency).toBe("EUR"); // the POST serialized behind the PATCH
  });

  // -------------------------------------------------------------------------
  // Q2 — detail (R-money-17/18/19)
  // -------------------------------------------------------------------------

  it("Q2: detail exposes EXACTLY the R-money-17 fields — requester profile included, nothing more", async () => {
    const creditor = await seedUserWithToken({ venmo: "creditor-venmo" });
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "viewer");
    // A rich trip: extra ledger data that must NOT leak through Q2.
    await seedDebt(trip.id, creditor.userId, debtor.userId, 5000);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );

    const res = await getRequest(trip.id, created.id, debtor.accessToken);
    expect(res.status).toBe(200);
    const raw = (await res.json()) as Record<string, unknown>;
    const detail: SettleRequestDetail = SettleRequestDetailSchema.parse(raw);

    // Minimum-disclosure snapshot: the exact top-level key set, pinned.
    expect(Object.keys(raw).sort()).toEqual(
      [
        "id",
        "trip_id",
        "from_user_id",
        "to_user_id",
        "amount_cents",
        "currency",
        "note",
        "status",
        "resolved",
        "settlement_id",
        "created_by",
        "created_at",
        "link",
        "requester",
      ].sort(),
    );
    // Requester = the creditor's member-visible profile (handles included by
    // design, contracts §3.4) — and only UserProfile fields.
    expect(detail.requester.id).toBe(creditor.userId);
    expect(detail.requester.venmo_username).toBe("creditor-venmo");
    expect(Object.keys(raw.requester as Record<string, unknown>).sort()).toEqual(
      [
        "id",
        "display_name",
        "avatar_key",
        "venmo_username",
        "cashtag",
        "paypalme_username",
        "zelle_handle",
        "zelle_display_name",
      ].sort(),
    );
    expect(detail.resolved).toBe(false);
  });

  it("Q2: settled-elsewhere pair reads resolved: true while status stays 'open' (R-money-18/19)", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 3000);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );

    // The debtor settles the debt WITHOUT linking the request.
    const settle = await postSettlement(trip.id, debtor.accessToken, {
      from_user_id: debtor.userId,
      to_user_id: creditor.userId,
      amount_cents: 3000,
      currency: "USD",
      method: "venmo",
    });
    expect(settle.status).toBe(201);

    const res = await getRequest(trip.id, created.id, creditor.accessToken);
    const detail = SettleRequestDetailSchema.parse(await res.json());
    expect(detail.status).toBe("open");
    expect(detail.resolved).toBe(true);
    expect(detail.settlement_id).toBeNull();
  });

  it("Q2 [R1 blocking]: PARTIAL settle-through discriminates the debt-only resolved rule — status 'settled' with resolved FALSE", async () => {
    // The reviewer's surviving mutant: `resolved = status !== 'open' || debt <= 0`
    // agreed with the pinned rule everywhere the suite previously looked.
    // [I-9] (a linked settlement may carry ANY amount) makes the
    // discriminating state reachable: settle 1000 of a 3000 debt THROUGH the
    // request → status flips 'settled' but 2000 remains outstanding, so the
    // debt-only [I-1] rule must read resolved FALSE while the status-OR
    // mutant reads true.
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 3000);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );
    expect(created.amount_cents).toBe(3000);

    const settle = await postSettlement(trip.id, debtor.accessToken, {
      from_user_id: debtor.userId,
      to_user_id: creditor.userId,
      amount_cents: 1000, // partial — [I-9]: no amount constraint on a linked settlement
      currency: "USD",
      method: "venmo",
      request_id: created.id,
    });
    expect(settle.status).toBe(201);

    const detail = SettleRequestDetailSchema.parse(
      await (await getRequest(trip.id, created.id, creditor.accessToken)).json(),
    );
    expect(detail.status).toBe("settled");
    expect(detail.settlement_id).not.toBeNull();
    expect(detail.resolved).toBe(false); // 2000 still outstanding — debt-only rule
  });

  it("Q1 [I-2]: an explicit amount BELOW the outstanding debt is taken verbatim, not defaulted", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 4321);

    const res = await postRequest(trip.id, creditor.accessToken, {
      from_user_id: debtor.userId,
      amount_cents: 1000,
    });
    expect(res.status).toBe(201);
    const body = SettleRequestSchema.parse(await res.json());
    expect(body.amount_cents).toBe(1000); // explicit wins over the 4321 default
    expect(body.resolved).toBe(false); // debt outstanding — [I-1]
  });

  it("Q2: a settlement recorded THROUGH the request reads status 'settled' + settlement_id (R-money-18)", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 2600);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );
    const settle = await postSettlement(trip.id, debtor.accessToken, {
      from_user_id: debtor.userId,
      to_user_id: creditor.userId,
      amount_cents: 2600,
      currency: "USD",
      method: "cash",
      request_id: created.id,
    });
    expect(settle.status).toBe(201);

    const detail = SettleRequestDetailSchema.parse(
      await (await getRequest(trip.id, created.id, creditor.accessToken)).json(),
    );
    expect(detail.status).toBe("settled");
    expect(detail.settlement_id).not.toBeNull();
    expect(detail.resolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Q3 — cancel
  // -------------------------------------------------------------------------

  it("Q3: creator cancels → 204, status 'cancelled', and the link still renders via Q2", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 1000);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );

    const cancelled = await cancelRequest(trip.id, created.id, creditor.accessToken);
    expect(cancelled.status).toBe(204);

    const [row] = await db
      .select({ status: schema.settlementRequests.status })
      .from(schema.settlementRequests)
      .where(eq(schema.settlementRequests.id, created.id));
    expect(row?.status).toBe("cancelled");

    // Soft cancel: the deep-link target keeps rendering (nav §2.3 row).
    const detail = SettleRequestDetailSchema.parse(
      await (await getRequest(trip.id, created.id, debtor.accessToken)).json(),
    );
    expect(detail.status).toBe("cancelled");

    // [I-6] a second cancel is a 409, not an idempotent 204.
    const again = await cancelRequest(trip.id, created.id, creditor.accessToken);
    expect(again.status).toBe(409);
  });

  it("Q3: a non-creator member (even the billed debtor / an owner) → 403; settled request → 409", async () => {
    const owner = await seedUserWithToken();
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(owner.accessToken);
    await addMember(trip.id, creditor.userId, "editor");
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 800);

    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );

    // The debtor is a party but not the creator; the OWNER holds the top
    // role — neither may cancel (creator-only regardless of role, §3.8).
    expect((await cancelRequest(trip.id, created.id, debtor.accessToken)).status).toBe(403);
    expect((await cancelRequest(trip.id, created.id, owner.accessToken)).status).toBe(403);

    // Settle through the request, then try to cancel: non-open → 409.
    const settle = await postSettlement(trip.id, debtor.accessToken, {
      from_user_id: debtor.userId,
      to_user_id: creditor.userId,
      amount_cents: 800,
      currency: "USD",
      method: "zelle",
      request_id: created.id,
    });
    expect(settle.status).toBe(201);
    expect((await cancelRequest(trip.id, created.id, creditor.accessToken)).status).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Authz — F-038 byte-identical 404s, both id axes
  // -------------------------------------------------------------------------

  it("F-038: non-member vs nonexistent trip vs malformed ids — byte-identical 404s on every verb", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const stranger = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken);
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 1200);
    const created = SettleRequestSchema.parse(
      await (
        await postRequest(trip.id, creditor.accessToken, { from_user_id: debtor.userId })
      ).json(),
    );

    // Trip axis (POST / GET / DELETE) — stranger on a real trip vs anyone on
    // an absent/malformed trip.
    await expectIndistinguishable404s([
      await postRequest(trip.id, stranger.accessToken, { from_user_id: debtor.userId }),
      await postRequest(NONEXISTENT_UUID, creditor.accessToken, { from_user_id: debtor.userId }),
      await getRequest(trip.id, created.id, stranger.accessToken),
      await getRequest(NONEXISTENT_UUID, created.id, creditor.accessToken),
      await cancelRequest(trip.id, created.id, stranger.accessToken),
      await cancelRequest("not-a-uuid", created.id, creditor.accessToken),
    ]);

    // Request-id axis for a proven member — absent, wrong-trip, malformed.
    const otherTrip = await createTripVia(creditor.accessToken);
    await expectIndistinguishable404s([
      await getRequest(trip.id, NONEXISTENT_UUID, creditor.accessToken),
      await getRequest(otherTrip.id, created.id, creditor.accessToken), // wrong trip
      await getRequest(trip.id, "not-a-uuid", creditor.accessToken),
      await cancelRequest(trip.id, NONEXISTENT_UUID, creditor.accessToken),
      await cancelRequest(otherTrip.id, created.id, creditor.accessToken),
      await cancelRequest(trip.id, "not-a-uuid", creditor.accessToken),
    ]);
  });

  it("401 without a token (app-wide requireAuth fronts the surface)", async () => {
    const res = await request(`/api/trips/${NONEXISTENT_UUID}/settle-requests`, undefined, {
      method: "POST",
      body: JSON.stringify({ from_user_id: NONEXISTENT_UUID }),
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Wiring closer (T-9.4 obligation 1): the PRODUCTION app-option mount path
  // — createApp({ settlements, budgets, fx }) — exposes all four surfaces,
  // not just the factory-mounted routers this suite otherwise exercises.
  // -------------------------------------------------------------------------
  it("app-option wiring exposes settlements, settle-requests, budgets AND fx end-to-end", async () => {
    const creditor = await seedUserWithToken();
    const debtor = await seedUserWithToken();
    const trip = await createTripVia(creditor.accessToken); // seeded via the shared db
    await addMember(trip.id, debtor.userId, "editor");
    await seedDebt(trip.id, creditor.userId, debtor.userId, 640);

    const wired = createApp({
      auth: authDeps,
      trips: { db },
      settlements: { db },
      budgets: { db },
      fx: {
        provider: {
          provider: "stub",
          rate: (base, quote) =>
            Promise.resolve({
              kind: "rate" as const,
              read: { base, quote, rate: "1.1675", as_of: "2026-08-26" },
            }),
        },
      },
    });
    const wiredRequest = (path: string, init?: RequestInit) =>
      wired.request(path, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${creditor.accessToken}`,
          ...(init?.headers ?? {}),
        },
      });

    // Settlements router (T-9.3, previously unmounted): B1 answers.
    expect((await wiredRequest(`/api/trips/${trip.id}/balances`)).status).toBe(200);
    // Settle-requests router: Q1 creates through the same option.
    const created = await wiredRequest(`/api/trips/${trip.id}/settle-requests`, {
      method: "POST",
      body: JSON.stringify({ from_user_id: debtor.userId }),
    });
    expect(created.status).toBe(201);
    expect(SettleRequestSchema.parse(await created.json()).amount_cents).toBe(640);
    // Budgets router: G1 answers.
    expect((await wiredRequest(`/api/trips/${trip.id}/budgets`)).status).toBe(200);
    // FX router: global route behind the same requireAuth.
    expect((await wiredRequest(`/api/fx/rate?base=EUR&quote=USD`)).status).toBe(200);
    // And the guard still fronts it all: no token → uniform 401.
    expect((await wired.request(`/api/trips/${trip.id}/budgets`)).status).toBe(401);
  });
});
