/**
 * Production wiring for the auth router (T-5.2). The ONLY place the DI seams
 * bind to the real world: remote JWKS (jose `createRemoteJWKSet` — cached,
 * `kid`-keyed, unknown-`kid` refetch with cooldown, spec §3.1), the real
 * Apple code exchanger, env-sourced key material (Law #1). Tests never call
 * this — they build `AuthRouterDeps` from in-test keys and fakes.
 *
 * All-or-nothing: a wholly unconfigured auth env returns `null` (health-only
 * dev boot); a PARTIAL config throws, naming the missing variables — names
 * only, never values.
 */
import { createRemoteJWKSet, importPKCS8 } from "jose";
import { APPLE_JWKS_URL, GOOGLE_JWKS_URL } from "../config.js";
import { getDb } from "../db/index.js";
import type { Env } from "../env.js";
import { createAppleCodeExchanger } from "./apple-exchange.js";
import { parseAesKey } from "./crypto.js";
import type { AuthRouterDeps } from "./routes.js";

/** Env vars may carry PEMs with escaped newlines — normalize before import. */
function pem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

export async function buildAuthDepsFromEnv(env: Env): Promise<AuthRouterDeps | null> {
  const authVars = {
    AUTH_ES256_PRIVATE_KEY: env.AUTH_ES256_PRIVATE_KEY,
    AUTH_ES256_KID: env.AUTH_ES256_KID,
    APPLE_CLIENT_ID: env.APPLE_CLIENT_ID,
    GOOGLE_CLIENT_IDS: env.GOOGLE_CLIENT_IDS,
    APPLE_TEAM_ID: env.APPLE_TEAM_ID,
    APPLE_KEY_ID: env.APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: env.APPLE_PRIVATE_KEY,
    APPLE_CREDENTIALS_KEY: env.APPLE_CREDENTIALS_KEY,
  };
  const missing = Object.entries(authVars)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length === Object.keys(authVars).length) return null;
  if (missing.length > 0) {
    throw new Error(`auth configuration incomplete — missing: ${missing.join(", ")}`);
  }
  if (!env.DATABASE_URL) {
    throw new Error("auth configuration requires DATABASE_URL");
  }

  // The filter above proves these — restate for the type system.
  const {
    AUTH_ES256_PRIVATE_KEY,
    AUTH_ES256_KID,
    APPLE_CLIENT_ID,
    GOOGLE_CLIENT_IDS,
    APPLE_TEAM_ID,
    APPLE_KEY_ID,
    APPLE_PRIVATE_KEY,
    APPLE_CREDENTIALS_KEY,
  } = authVars;
  if (
    !AUTH_ES256_PRIVATE_KEY ||
    !AUTH_ES256_KID ||
    !APPLE_CLIENT_ID ||
    !GOOGLE_CLIENT_IDS ||
    !APPLE_TEAM_ID ||
    !APPLE_KEY_ID ||
    !APPLE_PRIVATE_KEY ||
    !APPLE_CREDENTIALS_KEY
  ) {
    throw new Error("auth configuration incomplete");
  }

  const googleAudiences = GOOGLE_CLIENT_IDS.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (googleAudiences.length === 0) {
    // Non-empty env that parses to zero ids (e.g. "," or " , ") clears the
    // all-or-nothing gate but yields an empty audience allowlist. jose fails
    // CLOSED on `audience: []` → every Google sign-in 401s with no boot-time
    // signal, indistinguishable from user error in prod logs. Fail loudly
    // here instead (name only, never values — Law #1).
    throw new Error("auth configuration invalid — GOOGLE_CLIENT_IDS parsed to zero client ids");
  }

  return {
    db: getDb(),
    verifier: {
      appleJwks: createRemoteJWKSet(new URL(APPLE_JWKS_URL)),
      googleJwks: createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)),
      appleAudience: APPLE_CLIENT_ID,
      googleAudiences,
    },
    signer: {
      privateKey: await importPKCS8(pem(AUTH_ES256_PRIVATE_KEY), "ES256"),
      kid: AUTH_ES256_KID,
    },
    appleExchange: createAppleCodeExchanger({
      clientId: APPLE_CLIENT_ID,
      teamId: APPLE_TEAM_ID,
      keyId: APPLE_KEY_ID,
      privateKeyPem: pem(APPLE_PRIVATE_KEY),
    }),
    appleCredentialsKey: parseAesKey(APPLE_CREDENTIALS_KEY),
  };
}
