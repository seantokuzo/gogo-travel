import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for an empty environment", () => {
    const env = loadEnv({});
    expect(env).toEqual({
      NODE_ENV: "development",
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
});
