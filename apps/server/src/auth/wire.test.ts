/**
 * T-5.2 env wiring — all-or-nothing auth config (offline; the remote JWKS
 * set and exchanger are constructed but never fetched).
 */
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { buildAuthDepsFromEnv } from "./wire.js";

let es256Pem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  es256Pem = await exportPKCS8(pair.privateKey);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

function fullAuthEnv(): Record<string, string> {
  return {
    AUTH_ES256_PRIVATE_KEY: es256Pem,
    AUTH_ES256_KID: "kid-2026-07",
    APPLE_CLIENT_ID: "com.gogo.travel",
    GOOGLE_CLIENT_IDS: " gid-one.apps.example , gid-two.apps.example ",
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_KEY_ID: "APPLEKEY01",
    APPLE_PRIVATE_KEY: es256Pem,
    APPLE_CREDENTIALS_KEY: Buffer.alloc(32, 5).toString("base64"),
  };
}

const DB_URL = "postgresql://user:pass@localhost:5432/gogo_test";

describe("buildAuthDepsFromEnv", () => {
  it("returns null when the auth env is wholly unconfigured (health-only boot)", async () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(await buildAuthDepsFromEnv(env)).toBeNull();
  });

  it("throws on PARTIAL config, naming missing variables — names only, never values", async () => {
    const partial = fullAuthEnv();
    delete partial.APPLE_CREDENTIALS_KEY;
    delete partial.AUTH_ES256_KID;
    const env = loadEnv({ NODE_ENV: "test", ...partial });

    const error = await buildAuthDepsFromEnv(env).then(
      () => {
        throw new Error("expected partial config to throw");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain("AUTH_ES256_KID");
    expect(error.message).toContain("APPLE_CREDENTIALS_KEY");
    expect(error.message).not.toContain("TEAM123456");
    expect(error.message).not.toContain("BEGIN PRIVATE KEY");
  });

  it("throws when auth is configured but DATABASE_URL is absent", async () => {
    const env = loadEnv({ NODE_ENV: "test", ...fullAuthEnv() });
    await expect(buildAuthDepsFromEnv(env)).rejects.toThrowError(/DATABASE_URL/);
  });

  it("builds deps from a complete config — audiences split/trimmed, kid carried, key parsed", async () => {
    vi.stubEnv("DATABASE_URL", DB_URL);
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: DB_URL, ...fullAuthEnv() });

    const deps = await buildAuthDepsFromEnv(env);
    expect(deps).not.toBeNull();
    expect(deps!.signer.kid).toBe("kid-2026-07");
    expect(deps!.verifier.appleAudience).toBe("com.gogo.travel");
    expect(deps!.verifier.googleAudiences).toEqual([
      "gid-one.apps.example",
      "gid-two.apps.example",
    ]);
    expect(deps!.appleCredentialsKey.length).toBe(32);
    expect(typeof deps!.appleExchange.exchange).toBe("function");
  });

  it("throws when GOOGLE_CLIENT_IDS is non-empty but parses to zero client ids (fail-closed footgun)", async () => {
    vi.stubEnv("DATABASE_URL", DB_URL);
    // " , " passes env's `min(1)` and the all-or-nothing gate, yet yields an
    // empty audience allowlist — jose fails CLOSED on `audience: []`, so every
    // Google sign-in would 401 with no boot signal. Must fail loudly instead.
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      ...fullAuthEnv(),
      GOOGLE_CLIENT_IDS: " , ",
    });

    const error = await buildAuthDepsFromEnv(env).then(
      () => {
        throw new Error("expected empty-audience config to throw");
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain("GOOGLE_CLIENT_IDS");
    expect(error.message).not.toContain("BEGIN PRIVATE KEY");
  });

  it("normalizes \\n-escaped PEM env values", async () => {
    vi.stubEnv("DATABASE_URL", DB_URL);
    const escaped = { ...fullAuthEnv() };
    escaped.AUTH_ES256_PRIVATE_KEY = es256Pem.replaceAll("\n", "\\n");
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: DB_URL, ...escaped });

    const deps = await buildAuthDepsFromEnv(env);
    expect(deps).not.toBeNull();
    expect(deps!.signer.kid).toBe("kid-2026-07");
  });
});
