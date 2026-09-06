/**
 * B-9 transport-reference integration suite: `GET /airports/search`,
 * `GET /airlines/search`, `GET /airlines/flight-lookup` end-to-end over a
 * real Postgres clone — which carries migration 0002's DDL AND its seed
 * (`reference-data/`), so every assertion here runs against the REAL
 * committed dataset, behind the real app-wide `requireAuth`.
 *
 * Substrate pins double as the template-migration discriminator: a template
 * migrated only through 0001 reds out here on missing relations, and a
 * regenerated dataset that breaks a fixture zone (NRT must be `Asia/Tokyo` —
 * the exact value the B-8 fix composes offsets from) goes red HERE, not in a
 * traveler's itinerary.
 *
 * Driver: postgres-js on the shared testcontainer (T-S3.3). A Docker-less
 * CI run is a HARD FAILURE; a local Docker-less run skips with a loud
 * banner. No network beyond the local container (Law #5) — the dataset is
 * the committed snapshot, seeded by the migration.
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, generateKeyPair } from "jose";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { paginatedSchema } from "@gogo/shared/api/envelope";
import {
  AirlineSchema,
  AirportSchema,
  FlightAirlineLookupResponseSchema,
} from "@gogo/shared/domains/airport";
import { RATE_LIMITS, REFERENCE_SEARCH_PAGE_SIZE_DEFAULT } from "../config.js";
import { createApp } from "../app.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { createSessionWithTokens, type AccessTokenSigner } from "../auth/token-issuer.js";
import type { AuthRouterDeps } from "../auth/routes.js";
import { InMemoryRateLimitStore } from "../http/rate-limit.js";
import { createSuiteDb, type SuiteDb } from "../test/suite-db.js";
import { escapeLikePattern } from "./routes.js";
import { toAirlineWire, toAirportWire } from "./serialize.js";

const dockerAvailable = inject("dbAvailable");

const BOOT_TIMEOUT_MS = 240_000;
const SIGNER_KID = "gogo-es256-2026-07";

const PaginatedAirports = paginatedSchema(AirportSchema);
const PaginatedAirlines = paginatedSchema(AirlineSchema);

type ErrorBody = { error: { code: string } };

describe.skipIf(!dockerAvailable)("B-9 reference routes (integration)", () => {
  let suiteDb: SuiteDb;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: ReturnType<typeof createApp>;
  let signer: AccessTokenSigner;
  let accessToken: string;

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

  async function seedUserWithToken() {
    const { user } = await createUserWithEntitlements(db, {
      email: `reference-${uniq()}@example.com`,
      displayName: "Reference Tester",
      googleSub: `google-${uniq()}`,
    });
    const issued = await createSessionWithTokens(db, {
      userId: user.id,
      device: { platform: "ios" },
      signer,
    });
    return { userId: user.id, accessToken: issued.accessToken };
  }

  beforeAll(async () => {
    suiteDb = await createSuiteDb("reference_routes");
    client = suiteDb.client;
    db = suiteDb.db;

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
    app = createApp({
      auth: authDeps,
      reference: {
        db,
        // Fixed store clock: one window for the whole suite — the 429 test
        // uses a dedicated user so per-user keying isolates every other test.
        rateLimit: { store: new InMemoryRateLimitStore(), now: () => 1_000_000 },
      },
    });

    ({ accessToken } = await seedUserWithToken());
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await suiteDb?.drop();
  });

  const request = (path: string, token?: string) =>
    app.request(path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  // `null` = anonymous (an explicit `undefined` would take the default).
  const searchAirports = (query: string, token: string | null = accessToken) =>
    request(`/api/airports/search?${query}`, token ?? undefined);
  const searchAirlines = (query: string, token: string | null = accessToken) =>
    request(`/api/airlines/search?${query}`, token ?? undefined);
  const flightLookup = (query: string, token: string | null = accessToken) =>
    request(`/api/airlines/flight-lookup?${query}`, token ?? undefined);

  // ---- substrate: the template carries 0002's DDL AND seed ---------------

  it("the pristine clone carries the seeded reference tables (0002 discriminator)", async () => {
    const [journal] = await client<
      { n: string }[]
    >`select count(*) as n from drizzle.__drizzle_migrations`;
    expect(Number(journal?.n)).toBeGreaterThanOrEqual(3);

    const [airportCount] = await client<{ n: string }[]>`select count(*) as n from airports`;
    const [airlineCount] = await client<{ n: string }[]>`select count(*) as n from airlines`;
    // Floors, not exact counts: a dataset refresh must not red this pin, an
    // empty/truncated seed must.
    expect(Number(airportCount?.n)).toBeGreaterThanOrEqual(4000);
    expect(Number(airlineCount?.n)).toBeGreaterThanOrEqual(800);
  });

  it("pins the B-8 fixture airports to their real zones (generation regression gate)", async () => {
    // The exact zones the T-S3.4 hostile fixtures + Sean's real flights
    // reason about (NRT→LAX date-line eastbound; AKL→PPT beyond-the-grace).
    const pins: Record<string, string> = {
      NRT: "Asia/Tokyo",
      HND: "Asia/Tokyo",
      LAX: "America/Los_Angeles",
      AKL: "Pacific/Auckland",
      PPT: "Pacific/Tahiti",
      // tz-lookup (the rejected CC0 derivation) got BOTH of these offset-
      // wrong; geo-tz polygons must keep them right.
      BAH: "Asia/Bahrain",
      PPG: "Pacific/Pago_Pago",
    };
    for (const [iata, tz] of Object.entries(pins)) {
      const [row] = await db.select().from(schema.airports).where(eq(schema.airports.iata, iata));
      expect(row, iata).toBeDefined();
      expect(row?.tz, iata).toBe(tz);
    }
  });

  it("every seeded zone is a real IANA zone (Intl accepts all of them)", async () => {
    const zones = await db.selectDistinct({ tz: schema.airports.tz }).from(schema.airports);
    expect(zones.length).toBeGreaterThan(100);
    for (const { tz } of zones) {
      // Throws on an unknown zone — the whole point of the pin.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }), tz).not.toThrow();
    }
  });

  it("EVERY seeded row serializes to a valid wire shape (dataset-refresh regression gate)", async () => {
    // R1 advisory fix: name/city caps, country shape, and lat/lng ranges are
    // enforced only by the GENERATOR — the DDL has no lat/lng bound. A future
    // refresh migration seeding one bad row (lat 95, 250-char name) would
    // apply cleanly, the server would return it unvalidated, and the CLIENT's
    // Zod parse would hard-error the WHOLE search response for any query
    // surfacing it — with CI green. This sweep makes that red HERE instead.
    const airportRows = await db.select().from(schema.airports);
    expect(airportRows.length).toBeGreaterThanOrEqual(4000);
    const badAirports = airportRows
      .filter((row) => !AirportSchema.safeParse(toAirportWire(row)).success)
      .map((row) => row.iata);
    expect(badAirports).toEqual([]);

    const airlineRows = await db.select().from(schema.airlines);
    expect(airlineRows.length).toBeGreaterThanOrEqual(800);
    const badAirlines = airlineRows
      .filter((row) => !AirlineSchema.safeParse(toAirlineWire(row)).success)
      .map((row) => row.iata);
    expect(badAirlines).toEqual([]);
  });

  // ---- auth posture -------------------------------------------------------

  it("all three routes sit behind requireAuth (401 without a token)", async () => {
    for (const res of await Promise.all([
      searchAirports("q=NRT", null),
      searchAirlines("q=NH", null),
      flightLookup("flight_number=NH204", null),
    ])) {
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorBody).error.code).toBe("UNAUTHENTICATED");
    }
  });

  // ---- airports search ----------------------------------------------------

  it("ranks an exact IATA hit first and answers the full wire shape", async () => {
    const res = await searchAirports("q=NRT");
    expect(res.status).toBe(200);
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items[0]?.iata).toBe("NRT");
    expect(body.items[0]?.tz).toBe("Asia/Tokyo");
    expect(body.items[0]?.city).toBe("Narita");
    // Bounded typeahead: never pages.
    expect(body.nextCursor).toBeNull();
  });

  it("uppercases the query for code matching (nrt === NRT)", async () => {
    const res = await searchAirports("q=nrt");
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items[0]?.iata).toBe("NRT");
  });

  it("matches by airport name (Narita → NRT)", async () => {
    const res = await searchAirports("q=Narita");
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items[0]?.iata).toBe("NRT");
  });

  it("ranks name-prefix above city-prefix on a COMPETITIVE query (Paris → ORY before CDG)", async () => {
    // R1 blocking fix: the previous pin (Tokyo → HND) was a single-match
    // query — swapping the tier-2/3 CASE arms stayed green. "Paris" is
    // competitive: ORY is a name-prefix hit ("Paris-Orly Airport", rank 2)
    // while CDG is a city-prefix hit ("Charles de Gaulle …" / city "Paris
    // (Roissy…)", rank 3) whose name sorts BEFORE ORY's — so a tier swap
    // (arm reorder OR rank-value swap: both collapse the pair to the name
    // tiebreak, "Charles…" < "Paris-Orly…") puts CDG first and reds this.
    const res = await searchAirports("q=Paris");
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items[0]?.iata).toBe("ORY");
    expect(body.items.map((a) => a.iata)).toContain("CDG");
  });

  it("ranks name-substring above city-substring on a COMPETITIVE query (alpes → GNB before NCE)", async () => {
    // Same discipline for tiers 4/5, with PURE matchers (a dual-matcher like
    // Rio's GIG — name AND city both containing the query — survives a swap
    // via the name tiebreak, proven while building this pin): "alpes" hits
    // exactly two rows — GNB by name substring ONLY ("Grenoble Alpes Isère
    // Airport", city "Grenoble", rank 4) and NCE by city substring ONLY
    // ("Nice-Côte d'Azur Airport", city "Nice, Alpes-Maritimes", rank 5).
    // A 4↔5 swap flips the pair unconditionally and reds this.
    const res = await searchAirports("q=alpes");
    const body = PaginatedAirports.parse(await res.json());
    const order = body.items.map((a) => a.iata);
    // Relative order, not an exact list — a dataset refresh may add matches,
    // but a tier swap must still flip this pair.
    expect(order).toContain("NCE");
    expect(order.indexOf("GNB")).toBe(0);
    expect(order.indexOf("NCE")).toBeGreaterThan(order.indexOf("GNB"));
  });

  it("finds NFC-stored names from decomposed input (Malé → MLE, the places NFC parity)", async () => {
    const decomposed = "Malé"; // "Malé" as e + combining acute
    const res = await searchAirports(`q=${encodeURIComponent(decomposed)}`);
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items.map((a) => a.iata)).toContain("MLE");
  });

  it("IATA prefix beats name/city hits for short code typing (q=NR)", async () => {
    const res = await searchAirports("q=NR");
    const body = PaginatedAirports.parse(await res.json());
    expect(body.items.length).toBeGreaterThan(0);
    // Every leading item is an NR* code before any name/city-only match.
    expect(body.items[0]?.iata.startsWith("NR")).toBe(true);
  });

  it("respects limit and its default", async () => {
    const limited = PaginatedAirports.parse(await (await searchAirports("q=a&limit=5")).json());
    expect(limited.items).toHaveLength(5);
    const defaulted = PaginatedAirports.parse(await (await searchAirports("q=a")).json());
    expect(defaulted.items).toHaveLength(REFERENCE_SEARCH_PAGE_SIZE_DEFAULT);
  });

  it("treats LIKE metacharacters literally (% and _ match nothing, not everything)", async () => {
    // Unescaped, `%` ranks the ENTIRE table and `_` matches every 1-char
    // position — either would return a full page here.
    for (const probe of ["%", "_", "%%", "_R_"]) {
      const res = await searchAirports(`q=${encodeURIComponent(probe)}`);
      expect(res.status).toBe(200);
      const body = PaginatedAirports.parse(await res.json());
      expect(body.items, probe).toHaveLength(0);
    }
    // The escape helper itself, pinned.
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("rejects out-of-cap queries (caps class)", async () => {
    const cases = [
      `q=${"x".repeat(101)}`, // q over the 100 cap
      "q=", // empty after trim
      "q=NRT&limit=21", // limit over the 20 cap
      "q=NRT&limit=0",
      "", // q missing
    ];
    for (const query of cases) {
      const res = await searchAirports(query);
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("VALIDATION_FAILED");
    }
  });

  // ---- airlines search ----------------------------------------------------

  it("ranks an exact designator hit first (NH → All Nippon Airways)", async () => {
    const res = await searchAirlines("q=NH");
    expect(res.status).toBe(200);
    const body = PaginatedAirlines.parse(await res.json());
    expect(body.items[0]).toEqual({ iata: "NH", name: "All Nippon Airways" });
    expect(body.nextCursor).toBeNull();
  });

  it("matches airlines by name (United → UA first)", async () => {
    const res = await searchAirlines("q=United");
    const body = PaginatedAirlines.parse(await res.json());
    expect(body.items[0]?.iata).toBe("UA");
  });

  it("applies the same caps as the airports query", async () => {
    const res = await searchAirlines(`q=${"x".repeat(101)}`);
    expect(res.status).toBe(400);
  });

  // ---- flight-number lookup ----------------------------------------------

  it("resolves a flight number to its airline (NH204, separators included)", async () => {
    for (const input of ["NH204", "nh 204", "NH-204"]) {
      const res = await flightLookup(`flight_number=${encodeURIComponent(input)}`);
      expect(res.status).toBe(200);
      const body = FlightAirlineLookupResponseSchema.parse(await res.json());
      expect(body.flight).toEqual({ airline_iata: "NH", number: "204" });
      expect(body.airline).toEqual({ iata: "NH", name: "All Nippon Airways" });
    }
  });

  it("answers a parsed-but-unknown designator softly (flight set, airline null)", async () => {
    // Find a designator provably absent from the CURRENT dataset so a seed
    // refresh can never flip this test's premise.
    let absent: string | undefined;
    for (const candidate of ["ZZ", "ZX", "XX", "QY", "ZQ"]) {
      const [row] = await db
        .select()
        .from(schema.airlines)
        .where(eq(schema.airlines.iata, candidate));
      if (!row) {
        absent = candidate;
        break;
      }
    }
    expect(absent).toBeDefined();
    const res = await flightLookup(`flight_number=${absent}42`);
    const body = FlightAirlineLookupResponseSchema.parse(await res.json());
    expect(body.flight).toEqual({ airline_iata: absent, number: "42" });
    expect(body.airline).toBeNull();
  });

  it("answers unparseable input softly (200 with nulls, never an error state)", async () => {
    for (const input of ["!!!", "12345", "ANA204", "NB"]) {
      const res = await flightLookup(`flight_number=${encodeURIComponent(input)}`);
      expect(res.status, input).toBe(200);
      const body = FlightAirlineLookupResponseSchema.parse(await res.json());
      expect(body, input).toEqual({ flight: null, airline: null });
    }
  });

  it("rejects an over-cap flight_number (caps class)", async () => {
    const res = await flightLookup(`flight_number=${"x".repeat(13)}`);
    expect(res.status).toBe(400);
    const missing = await flightLookup("");
    expect(missing.status).toBe(400);
  });

  // ---- rate limit: ONE per-user bucket across the whole surface -----------

  it("shares one per-user window across all three routes (429 crosses endpoints)", async () => {
    const { accessToken: dedicated } = await seedUserWithToken();
    const { limit } = RATE_LIMITS.referenceSearch;
    // Burn the window with criteria-less requests: the limiter sits BEFORE
    // validation (places-search posture — 400-spam charges the window,
    // flood-penalizing by design), which doubles as keeping the burn-down
    // off the DB so full-suite contention can't time this test out.
    for (let i = 0; i < limit; i++) {
      const res = await searchAirports("", dedicated);
      expect(res.status).toBe(400);
    }
    // The window is exhausted — EVERY reference route answers 429 now.
    const overAirports = await searchAirports("q=NRT", dedicated);
    expect(overAirports.status).toBe(429);
    expect(overAirports.headers.get("retry-after")).toBeTruthy();
    const overAirlines = await searchAirlines("q=NH", dedicated);
    expect(overAirlines.status).toBe(429);
    const overLookup = await flightLookup("flight_number=NH204", dedicated);
    expect(overLookup.status).toBe(429);
    expect(((await overLookup.json()) as ErrorBody).error.code).toBe("RATE_LIMITED");

    // Per-user keying: the suite's main user is untouched by the burn-down.
    const other = await searchAirports("q=NRT");
    expect(other.status).toBe(200);
  });
});
