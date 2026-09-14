import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { e2eDoorGatesPass } from "./auth/e2e-door.js";

describe("loadEnv", () => {
  it("applies defaults for an empty environment", () => {
    const env = loadEnv({});
    expect(env).toEqual({
      NODE_ENV: "development",
      // S-4/T3 (session-door spec R-door-1/G1): NODE_ENV was NOT in the
      // source object here, so it's `false` even though the value resolved
      // to the schema's "development" default.
      NODE_ENV_EXPLICIT: false,
      PORT: 3000,
      // T-7.3: the community Transitous instance is keyless, so the base URL
      // DEFAULTS instead of degrading (unlike the Mapbox token, absent here).
      TRANSITOUS_BASE_URL: "https://api.transitous.org",
    });
  });

  it("coerces PORT to a number", () => {
    expect(loadEnv({ PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects an invalid PORT without leaking values", () => {
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrowError(/PORT/);
    expect(() => loadEnv({ PORT: "not-a-port" })).not.toThrowError(/not-a-port/);
  });

  it("accepts a well-formed DATABASE_URL", () => {
    const url = "postgres://u:p@localhost:5432/gogo";
    expect(loadEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it("rejects a malformed DATABASE_URL without leaking values", () => {
    expect(() => loadEnv({ DATABASE_URL: "nope" })).toThrowError(/DATABASE_URL/);
    expect(() => loadEnv({ DATABASE_URL: "nope" })).not.toThrowError(/nope/);
  });

  // T-6.4: places-ingest dataset locations — plain strings (s3:// globs AND
  // local fixture paths are valid values), optional at boot (unset ⇒ ingests
  // record `failed` visibly; nothing else breaks).
  it("passes places dataset URLs through verbatim and leaves them undefined when unset", () => {
    const env = loadEnv({
      PLACES_OVERTURE_PARQUET_URL:
        "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=places/type=place/*",
      PLACES_FSQ_OS_PARQUET_URL: "/var/data/fsq-os-places/*.parquet",
    });
    expect(env.PLACES_OVERTURE_PARQUET_URL).toBe(
      "s3://overturemaps-us-west-2/release/2026-07-22.0/theme=places/type=place/*",
    );
    expect(env.PLACES_FSQ_OS_PARQUET_URL).toBe("/var/data/fsq-os-places/*.parquet");

    const bare = loadEnv({});
    expect(bare.PLACES_OVERTURE_PARQUET_URL).toBeUndefined();
    expect(bare.PLACES_FSQ_OS_PARQUET_URL).toBeUndefined();
  });

  it("rejects empty-string places dataset URLs (unset ≠ empty)", () => {
    expect(() => loadEnv({ PLACES_OVERTURE_PARQUET_URL: "" })).toThrowError(
      /PLACES_OVERTURE_PARQUET_URL/,
    );
    expect(() => loadEnv({ PLACES_FSQ_OS_PARQUET_URL: "" })).toThrowError(
      /PLACES_FSQ_OS_PARQUET_URL/,
    );
  });

  // T-7.3: travel-leg provider seams (itinerary-bookings §3.5/R-ib-21).
  it("MAPBOX_ACCESS_TOKEN is optional (absent ⇒ modes degrade) and never empty", () => {
    expect(loadEnv({}).MAPBOX_ACCESS_TOKEN).toBeUndefined();
    expect(loadEnv({ MAPBOX_ACCESS_TOKEN: "pk.test" }).MAPBOX_ACCESS_TOKEN).toBe("pk.test");
    expect(() => loadEnv({ MAPBOX_ACCESS_TOKEN: "" })).toThrowError(/MAPBOX_ACCESS_TOKEN/);
  });

  it("TRANSITOUS_BASE_URL accepts overrides and rejects non-URLs without leaking values", () => {
    expect(
      loadEnv({ TRANSITOUS_BASE_URL: "https://staging.api.transitous.org" }).TRANSITOUS_BASE_URL,
    ).toBe("https://staging.api.transitous.org");
    expect(() => loadEnv({ TRANSITOUS_BASE_URL: "not-a-url" })).toThrowError(/TRANSITOUS_BASE_URL/);
    expect(() => loadEnv({ TRANSITOUS_BASE_URL: "not-a-url" })).not.toThrowError(/not-a-url/);
  });

  // ===========================================================================
  // S-4/T3 — session-door spec §2.1 R-door-1/R-door-2 test obligations.
  // ===========================================================================

  describe("NODE_ENV_EXPLICIT (R-door-1 / G1)", () => {
    it("is false when NODE_ENV is absent from the source, even though the value defaults to development", () => {
      const env = loadEnv({});
      expect(env.NODE_ENV).toBe("development");
      expect(env.NODE_ENV_EXPLICIT).toBe(false);
    });

    it("is true whenever the source object carries its OWN NODE_ENV key", () => {
      expect(loadEnv({ NODE_ENV: "development" }).NODE_ENV_EXPLICIT).toBe(true);
      expect(loadEnv({ NODE_ENV: "test" }).NODE_ENV_EXPLICIT).toBe(true);
      expect(loadEnv({ NODE_ENV: "production" }).NODE_ENV_EXPLICIT).toBe(true);
    });

    it("a misspelled NODE_ENV (e.g. Production) fails the enum outright — loadEnv() throws before NODE_ENV_EXPLICIT is ever computed", () => {
      expect(() => loadEnv({ NODE_ENV: "Production" })).toThrowError(/NODE_ENV/);
    });
  });

  describe("G2 secret length is a GATE, not a schema violation (R-door-1)", () => {
    it("a short E2E_SESSION_DOOR_SECRET does NOT throw loadEnv() — it's carried through for the gate evaluator to reject", () => {
      const env = loadEnv({ E2E_SESSION_DOOR_SECRET: "x".repeat(31) });
      expect(env.E2E_SESSION_DOOR_SECRET).toBe("x".repeat(31));
    });

    it("absent E2E_SESSION_DOOR/E2E_SESSION_DOOR_SECRET are undefined, never empty strings", () => {
      const env = loadEnv({});
      expect(env.E2E_SESSION_DOOR).toBeUndefined();
      expect(env.E2E_SESSION_DOOR_SECRET).toBeUndefined();
    });
  });

  describe("R-door-2 / G4: production + any door var throws, naming the variable(s) and never a value", () => {
    it("NODE_ENV=production + E2E_SESSION_DOOR_SECRET set throws", () => {
      const secret = "s".repeat(40);
      const err = (() => {
        try {
          loadEnv({ NODE_ENV: "production", E2E_SESSION_DOOR_SECRET: secret });
          return undefined;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("E2E_SESSION_DOOR_SECRET");
      expect(err!.message).toContain("E2E_SESSION_DOOR");
      expect(err!.message).not.toContain(secret);
    });

    it("NODE_ENV=production + E2E_SESSION_DOOR=1 set (no secret) ALSO throws", () => {
      const err = (() => {
        try {
          loadEnv({ NODE_ENV: "production", E2E_SESSION_DOOR: "1" });
          return undefined;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("E2E_SESSION_DOOR");
    });

    it("control: production with NEITHER door var set boots fine (the throw is conditional on the door vars, not production itself)", () => {
      expect(() => loadEnv({ NODE_ENV: "production" })).not.toThrow();
    });

    it("control: development/test with both door vars set does NOT throw (G4 only fires in production)", () => {
      expect(() =>
        loadEnv({
          NODE_ENV: "development",
          E2E_SESSION_DOOR: "1",
          E2E_SESSION_DOOR_SECRET: "s".repeat(40),
        }),
      ).not.toThrow();
      expect(() =>
        loadEnv({
          NODE_ENV: "test",
          E2E_SESSION_DOOR: "1",
          E2E_SESSION_DOOR_SECRET: "s".repeat(40),
        }),
      ).not.toThrow();
    });
  });

  describe("R-door-1 mount matrix (e2eDoorGatesPass): only the all-pass cell mounts", () => {
    const SECRET_32 = "s".repeat(32);
    const SECRET_31 = "s".repeat(31);

    it("the ONE all-pass cell: explicit development/test + door=1 + a 32+ char secret", () => {
      expect(
        e2eDoorGatesPass(
          loadEnv({
            NODE_ENV: "development",
            E2E_SESSION_DOOR: "1",
            E2E_SESSION_DOOR_SECRET: SECRET_32,
          }),
        ),
      ).toBe(true);
      expect(
        e2eDoorGatesPass(
          loadEnv({ NODE_ENV: "test", E2E_SESSION_DOOR: "1", E2E_SESSION_DOOR_SECRET: SECRET_32 }),
        ),
      ).toBe(true);
    });

    it.each([
      // [label, env]
      ["NODE_ENV unset (defaulted)", { E2E_SESSION_DOOR: "1", E2E_SESSION_DOOR_SECRET: SECRET_32 }],
      ["E2E_SESSION_DOOR unset", { NODE_ENV: "development", E2E_SESSION_DOOR_SECRET: SECRET_32 }],
      [
        'E2E_SESSION_DOOR="true" (not the literal "1")',
        { NODE_ENV: "development", E2E_SESSION_DOOR: "true", E2E_SESSION_DOOR_SECRET: SECRET_32 },
      ],
      ["secret absent", { NODE_ENV: "development", E2E_SESSION_DOOR: "1" }],
      [
        "secret 31 chars (one short of the floor)",
        { NODE_ENV: "development", E2E_SESSION_DOOR: "1", E2E_SESSION_DOOR_SECRET: SECRET_31 },
      ],
    ] as const)("fails closed: %s", (_label, source) => {
      expect(e2eDoorGatesPass(loadEnv(source))).toBe(false);
    });

    it("fails closed: NODE_ENV explicitly production (G1) — checked independent of G4's separate throw, via a hand-built Env shape", () => {
      // production + door vars set THROWS at loadEnv (G4, tested above) —
      // this pins the G1 gate-logic fact itself (never mount on
      // "production", full stop) against a directly-constructed Env shape,
      // the way a future caller building `Env` by hand (§3.8 layer 3) would.
      expect(
        e2eDoorGatesPass({
          NODE_ENV: "production",
          NODE_ENV_EXPLICIT: true,
          PORT: 3000,
          TRANSITOUS_BASE_URL: "https://api.transitous.org",
          E2E_SESSION_DOOR: "1",
          E2E_SESSION_DOOR_SECRET: SECRET_32,
        }),
      ).toBe(false);
    });
  });
});
