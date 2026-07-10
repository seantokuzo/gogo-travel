import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults for an empty environment", () => {
    const env = loadEnv({});
    expect(env).toEqual({ NODE_ENV: "development", PORT: 3000 });
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
});
