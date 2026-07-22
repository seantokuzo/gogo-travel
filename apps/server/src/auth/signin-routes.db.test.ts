/**
 * T-5.2 sign-in integration suite (AU-3): `POST /auth/apple` +
 * `POST /auth/google` end-to-end over a real Postgres — provider
 * verification (in-test keys via the JWKS seam), account resolution
 * (R-auth-4/5/6/15), Apple code exchange + encrypted credential storage
 * (R-auth-7), token issuance (R-auth-8/9 sign-in slice), uniform-401
 * posture (R-auth-1), and the token-hygiene sweep.
 *
 * Driver: postgres-js on ephemeral testcontainers Postgres — same harness
 * contract as `db/constraints.test.ts`: a Docker-less CI run is a HARD
 * FAILURE; a local Docker-less run skips with a loud banner. No network
 * beyond the local container (Law #5 — JWKS and Apple exchange are faked
 * through their DI seams).
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignInResponseSchema, type SignInResponse } from "@gogo/shared/domains/auth";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  REFRESH_TOKEN_TTL_MS,
} from "../config.js";
import { createUserWithEntitlements } from "../db/create-user.js";
import * as schema from "../db/schema/index.js";
import { decryptSecret, parseAesKey, sha256Hex } from "./crypto.js";
import type { AuthRouterDeps } from "./routes.js";

const dockerAvailable = await (async () => {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

if (!dockerAvailable) {
  console.warn(
    "\n" +
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  DOCKER UNAVAILABLE — T-5.2 SIGN-IN INTEGRATION SUITE SKIPPED     ║\n" +
      "║  The /auth/apple + /auth/google contracts (auth-users spec        ║\n" +
      "║  §3.4.1, R-auth-1..7/15) were NOT verified. Start Docker and      ║\n" +
      "║  re-run `pnpm --filter @gogo/server test` before treating this    ║\n" +
      "║  branch as green.                                                 ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
  );
}

// Same contract as DB-1: in CI a skip must never be mistaken for a pass.
if (!dockerAvailable && process.env.CI) {
  it("T-5.2 sign-in integration suite must run in CI (Docker unavailable ⇒ hard fail)", () => {
    throw new Error(
      "Docker unavailable during a CI run — the T-5.2 sign-in integration " +
        "suite could not verify auth-users spec §3.4.1. A skip here is NOT " +
        "a pass. Provision Docker or a Postgres service container and re-run.",
    );
  });
}

const BOOT_TIMEOUT_MS = 240_000;
const APPLE_AUD = "com.gogo.travel";
const GOOGLE_AUDS = ["gid-primary.apps.example"];
const PROVIDER_KID = "provider-kid-1";
const SIGNER_KID = "gogo-es256-2026-07";
const APPLE_REFRESH_PLAINTEXT = "apple-refresh-token-plaintext-secret";

describe.skipIf(!dockerAvailable)("T-5.2 sign-in routes (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: postgres.Sql;
  let db: PostgresJsDatabase<typeof schema>;
  let app: Hono;
  let providerKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let accessPublicKey: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"];
  const credentialsKey = parseAesKey(Buffer.alloc(32, 9).toString("base64"));
  const warnings: string[] = [];
  /** Per-test switchable exchange behavior (default: succeed). */
  let exchangeImpl: (code: string) => Promise<string>;
  const exchangedCodes: string[] = [];

  beforeAll(async () => {
    // 60s startup budget: three DB suites boot their own container
    // concurrently in the full gate; the default 10s port-bind wait went red
    // when the third hit it (T-5.2 round-1 flake).
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(60_000)
      .start();
    client = postgres(container.getConnectionUri(), { max: 5, onnotice: () => undefined });
    db = drizzle({ client, schema });
    const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
    await migrate(db, { migrationsFolder });

    const provider = await generateKeyPair("RS256", { extractable: true });
    providerKey = provider.privateKey;
    const jwk = { ...(await exportJWK(provider.publicKey)), kid: PROVIDER_KID, alg: "RS256" };
    const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

    const signerPair = await generateKeyPair("ES256");
    accessPublicKey = signerPair.publicKey;

    exchangeImpl = () => Promise.resolve(APPLE_REFRESH_PLAINTEXT);

    const deps: AuthRouterDeps = {
      db,
      verifier: {
        appleJwks: jwks,
        googleJwks: jwks,
        appleAudience: APPLE_AUD,
        googleAudiences: GOOGLE_AUDS,
      },
      signer: { privateKey: signerPair.privateKey, kid: SIGNER_KID },
      appleExchange: {
        exchange: (code) => {
          exchangedCodes.push(code);
          return exchangeImpl(code);
        },
      },
      appleCredentialsKey: credentialsKey,
      logger: { warn: (message) => warnings.push(message) },
    };
    app = createApp({ auth: deps });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  afterEach(() => {
    warnings.length = 0;
    exchangedCodes.length = 0;
    exchangeImpl = () => Promise.resolve(APPLE_REFRESH_PLAINTEXT);
  });

  let seq = 0;
  const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const RAW_NONCE = "raw-nonce-integration";

  interface MintOptions {
    iss?: string;
    aud?: string;
    expired?: boolean;
    kid?: string;
    claims?: Record<string, unknown>;
  }

  async function mintProviderToken(defaults: Record<string, unknown>, options: MintOptions) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...defaults, ...options.claims })
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? PROVIDER_KID })
      .setIssuedAt(options.expired ? now - 3600 : now)
      .setExpirationTime(options.expired ? now - 1800 : now + 600)
      .setIssuer(options.iss ?? "https://appleid.apple.com")
      .setAudience(options.aud ?? APPLE_AUD)
      .sign(providerKey);
  }

  const mintApple = (sub: string, email: string, options: MintOptions = {}) =>
    mintProviderToken({ sub, email, email_verified: "true", nonce: sha256Hex(RAW_NONCE) }, options);

  const mintGoogle = (sub: string, email: string, options: MintOptions = {}) =>
    mintProviderToken(
      { sub, email, email_verified: true, nonce: RAW_NONCE },
      { iss: "accounts.google.com", aud: GOOGLE_AUDS[0]!, ...options },
    );

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const appleBody = (identityToken: string, extra: Record<string, unknown> = {}) => ({
    identity_token: identityToken,
    authorization_code: "auth-code-secret-abc",
    raw_nonce: RAW_NONCE,
    device: { device_name: "Sean's iPhone 17", platform: "ios" },
    ...extra,
  });

  const googleBody = (idToken: string) => ({
    id_token: idToken,
    raw_nonce: RAW_NONCE,
    device: { platform: "android" },
  });

  async function expectSignInResponse(res: Response): Promise<SignInResponse> {
    expect(res.status).toBe(200);
    return SignInResponseSchema.parse(await res.json());
  }

  // -------------------------------------------------------------------------
  // Apple happy paths (R-auth-1/3/4/5/7/8/15)
  // -------------------------------------------------------------------------

  it("apple: new user — user + entitlements txn, ES256 token with exact claims, refresh stored hashed, credential encrypted", async () => {
    const email = `new-${uniq()}@example.com`;
    const sub = `apple-${uniq()}`;
    const before = Date.now();
    const body = await expectSignInResponse(
      await post(
        "/api/auth/apple",
        appleBody(await mintApple(sub, email), {
          given_name: "Sean",
          family_name: "Tokuzo",
        }),
      ),
    );

    // R-auth-5: account + seeded display name.
    expect(body.is_new_user).toBe(true);
    expect(body.user.email).toBe(email);
    expect(body.user.display_name).toBe("Sean Tokuzo");

    // Entitlements row exists with plan 'free' (single-txn mirror of R-db-5).
    const [ent] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, body.user.id));
    expect(ent?.plan).toBe("free");

    // R-auth-15: exactly one provider identity at creation.
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, body.user.id));
    expect(row?.appleSub).toBe(sub);
    expect(row?.googleSub).toBeNull();

    // R-auth-8: ES256 access token, claims exactly {iss, aud, sub, sid, iat, exp}.
    const { payload, protectedHeader } = await jwtVerify(
      body.tokens.access_token,
      accessPublicKey,
      { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithms: ["ES256"] },
    );
    expect(protectedHeader.kid).toBe(SIGNER_KID);
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "sid", "sub"]);
    expect(payload.sub).toBe(body.user.id);
    expect(payload.exp! - payload.iat!).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(body.tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);

    // Session row is the sid claim; device metadata stored.
    const [session] = await db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.id, payload.sid as string));
    expect(session?.userId).toBe(body.user.id);
    expect(session?.deviceName).toBe("Sean's iPhone 17");
    expect(session?.platform).toBe("ios");

    // R-auth-9: refresh persisted as SHA-256 hash only, TTL 30 days.
    const tokens = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.sessionId, session!.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toBe(sha256Hex(body.tokens.refresh_token));
    expect(tokens[0]!.tokenHash).not.toBe(body.tokens.refresh_token);
    const expectedExpiry = before + REFRESH_TOKEN_TTL_MS;
    expect(Math.abs(tokens[0]!.expiresAt.getTime() - expectedExpiry)).toBeLessThan(60_000);

    // R-auth-7: credential stored encrypted — decrypts to Apple's refresh
    // token, plaintext appears nowhere.
    expect(exchangedCodes).toEqual(["auth-code-secret-abc"]);
    const [cred] = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, body.user.id));
    expect(cred).toBeDefined();
    expect(cred!.refreshTokenCiphertext).not.toContain(APPLE_REFRESH_PLAINTEXT);
    expect(decryptSecret(credentialsKey, cred!.refreshTokenCiphertext)).toBe(
      APPLE_REFRESH_PLAINTEXT,
    );
  });

  it("apple: returning sub — same user, is_new_user:false, a second session (R-auth-4)", async () => {
    const email = `ret-${uniq()}@example.com`;
    const sub = `apple-${uniq()}`;
    const first = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(sub, email))),
    );
    const second = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(sub, email))),
    );

    expect(second.user.id).toBe(first.user.id);
    expect(second.is_new_user).toBe(false);

    const sessions = await db
      .select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, first.user.id));
    expect(sessions).toHaveLength(2);

    const rows = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(rows).toHaveLength(1);
  });

  it("apple: re-sign-in REFRESHES the stored credential — upsert overwrites with the new token (R-auth-7)", async () => {
    const email = `refresh-${uniq()}@example.com`;
    const sub = `apple-${uniq()}`;

    const first = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(sub, email))),
    );
    const [firstCred] = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, first.user.id));
    expect(decryptSecret(credentialsKey, firstCred!.refreshTokenCiphertext)).toBe(
      APPLE_REFRESH_PLAINTEXT,
    );

    // Apple returns a NEW refresh token on the next sign-in. The onConflictDoUpdate
    // MUST replace the stored ciphertext (a broken conflict target / set would
    // warn-and-continue and keep the stale token — and `storeAppleCredential`
    // swallows errors, so only asserting the refreshed value catches it).
    const rotated = "apple-refresh-token-plaintext-ROTATED";
    exchangeImpl = () => Promise.resolve(rotated);
    const second = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(sub, email))),
    );
    expect(second.user.id).toBe(first.user.id);

    const creds = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, first.user.id));
    expect(creds).toHaveLength(1); // upsert, never a second row
    expect(decryptSecret(credentialsKey, creds[0]!.refreshTokenCiphertext)).toBe(rotated);
    expect(creds[0]!.refreshTokenCiphertext).not.toContain(rotated);

    // Both exchanges succeeded — no exchange-failure warning was logged.
    expect(warnings.filter((w) => w.includes("apple code exchange failed"))).toHaveLength(0);
  });

  it("apple: unknown sub, email matches a Google-created account → auto-link, no second account (R-auth-6)", async () => {
    const email = `link-${uniq()}@example.com`;
    const { user: existing } = await createUserWithEntitlements(db, {
      email,
      displayName: "Google First",
      googleSub: `google-${uniq()}`,
    });

    const appleSub = `apple-${uniq()}`;
    const body = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(appleSub, email.toUpperCase()))),
    );

    expect(body.user.id).toBe(existing.id);
    expect(body.is_new_user).toBe(false);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(row?.appleSub).toBe(appleSub);
    expect(row?.googleSub).toBe(existing.googleSub);
  });

  it("apple: code-exchange failure never fails the sign-in — logged without token material (R-auth-7)", async () => {
    exchangeImpl = () => Promise.reject(new Error("apple token exchange failed (status 503)"));
    const email = `exfail-${uniq()}@example.com`;
    const body = await expectSignInResponse(
      await post("/api/auth/apple", appleBody(await mintApple(`apple-${uniq()}`, email))),
    );

    const [cred] = await db
      .select()
      .from(schema.appleCredentials)
      .where(eq(schema.appleCredentials.userId, body.user.id));
    expect(cred).toBeUndefined();

    const exchangeWarnings = warnings.filter((w) => w.includes("apple code exchange failed"));
    expect(exchangeWarnings).toHaveLength(1);
    expect(exchangeWarnings[0]).toContain("sign-in continues");
    expect(exchangeWarnings[0]).not.toContain("auth-code-secret-abc");
  });

  // -------------------------------------------------------------------------
  // Google happy paths (R-auth-2/3/4/5/6)
  // -------------------------------------------------------------------------

  it("google: new user (display name from token claims) + returning sub", async () => {
    const email = `gnew-${uniq()}@example.com`;
    const sub = `google-${uniq()}`;
    const token = await mintGoogle(sub, email, { claims: { name: "Toku Zo" } });

    const first = await expectSignInResponse(await post("/api/auth/google", googleBody(token)));
    expect(first.is_new_user).toBe(true);
    expect(first.user.display_name).toBe("Toku Zo");

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, first.user.id));
    expect(row?.googleSub).toBe(sub);
    expect(row?.appleSub).toBeNull();
    const [ent] = await db
      .select()
      .from(schema.entitlements)
      .where(eq(schema.entitlements.userId, first.user.id));
    expect(ent?.plan).toBe("free");

    const again = await expectSignInResponse(
      await post("/api/auth/google", googleBody(await mintGoogle(sub, email))),
    );
    expect(again.user.id).toBe(first.user.id);
    expect(again.is_new_user).toBe(false);
  });

  it("google: verified email matching an Apple-created account → auto-link (R-auth-6)", async () => {
    const email = `glink-${uniq()}@example.com`;
    const { user: existing } = await createUserWithEntitlements(db, {
      email,
      displayName: "Apple First",
      appleSub: `apple-${uniq()}`,
    });

    const googleSub = `google-${uniq()}`;
    const body = await expectSignInResponse(
      await post("/api/auth/google", googleBody(await mintGoogle(googleSub, email))),
    );
    expect(body.user.id).toBe(existing.id);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(row?.googleSub).toBe(googleSub);
    expect(row?.appleSub).toBe(existing.appleSub);
  });

  // -------------------------------------------------------------------------
  // Rejections — uniform 401, no oracle (R-auth-1/6; §3.6.4)
  // -------------------------------------------------------------------------

  interface ErrorEnvelope {
    error: { code: string; message: string; details?: unknown; requestId?: string };
  }

  async function expect401(res: Response): Promise<ErrorEnvelope> {
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.requestId).toBeTruthy();
    return body;
  }

  it("every verification AND account-state rejection is one undifferentiated 401 (no oracle, §3.6.4)", async () => {
    const email = `uni-${uniq()}@example.com`;
    const sub = `apple-${uniq()}`;

    const valid = await mintApple(sub, email);
    const [header, payload, signature] = valid.split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { sub: string };
    forged.sub = "attacker";
    const tampered = `${header}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;

    // Pre-existing accounts for the account-state (resolution) rejections.
    const occupiedEmail = `occ-${uniq()}@example.com`;
    await createUserWithEntitlements(db, {
      email: occupiedEmail,
      displayName: "Original",
      appleSub: `apple-orig-${uniq()}`,
    });
    const collisionEmail = `coll-${uniq()}@example.com`;
    await createUserWithEntitlements(db, {
      email: collisionEmail,
      displayName: "Apple Owner",
      appleSub: `apple-${uniq()}`,
    });
    const noEmailToken = await mintProviderToken(
      { sub: `g-${uniq()}`, nonce: RAW_NONCE },
      { iss: "accounts.google.com", aud: GOOGLE_AUDS[0]! },
    );

    const failures = await Promise.all([
      // Verification failures (crypto / claims).
      post("/api/auth/apple", appleBody(tampered)),
      post("/api/auth/apple", appleBody(await mintApple(sub, email, { aud: "com.other.app" }))),
      post("/api/auth/apple", appleBody(await mintApple(sub, email, { expired: true }))),
      post(
        "/api/auth/apple",
        appleBody(await mintApple(sub, email, { claims: { nonce: sha256Hex("other-nonce") } })),
      ),
      post("/api/auth/apple", appleBody(await mintApple(sub, email, { kid: "kid-unknown" }))),
      post(
        "/api/auth/google",
        googleBody(await mintGoogle(`g-${uniq()}`, email, { iss: "https://evil.example" })),
      ),
      post(
        "/api/auth/google",
        googleBody(await mintGoogle(`g-${uniq()}`, email, { expired: true })),
      ),
      // Account-state (resolution) rejections — MUST be byte-identical to the
      // verification failures above, else they become an account-existence
      // oracle (today they hold only because routes.ts serializes one constant).
      post(
        "/api/auth/apple",
        appleBody(await mintApple(`apple-imposter-${uniq()}`, occupiedEmail)),
      ), // occupied slot → provider_identity_conflict
      post(
        "/api/auth/google",
        googleBody(
          await mintGoogle(`google-${uniq()}`, collisionEmail, {
            claims: { email_verified: false },
          }),
        ),
      ), // unverified email collision
      post(
        "/api/auth/google",
        googleBody(
          await mintGoogle(`google-${uniq()}`, `unvnew-${uniq()}@example.com`, {
            claims: { email_verified: false },
          }),
        ),
      ), // unverified new account
      post("/api/auth/google", googleBody(noEmailToken)), // missing email
    ]);

    const bodies = await Promise.all(failures.map(expect401));
    for (const body of bodies) {
      // Identical modulo requestId: same code, same message, no details.
      expect(body.error.code).toBe("UNAUTHENTICATED");
      expect(body.error.message).toBe(bodies[0]!.error.message);
      expect(body.error.details).toBeUndefined();
    }

    // No account side effects from any verification failure on `email`.
    const rows = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(rows).toHaveLength(0);
  });

  it("google: email collision with email_verified:false → 401, no link, no new account (R-auth-6)", async () => {
    const email = `unv-${uniq()}@example.com`;
    const { user: existing } = await createUserWithEntitlements(db, {
      email,
      displayName: "Apple Owner",
      appleSub: `apple-${uniq()}`,
    });

    const token = await mintGoogle(`google-${uniq()}`, email, {
      claims: { email_verified: false },
    });
    const body = await expect401(await post("/api/auth/google", googleBody(token)));
    expect(body.error.code).toBe("UNAUTHENTICATED");

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(row?.googleSub).toBeNull();
  });

  it("google: unknown sub with unverified email → 401, no account created (creation-side twin of R-auth-6)", async () => {
    const email = `unvnew-${uniq()}@example.com`;
    const token = await mintGoogle(`google-${uniq()}`, email, {
      claims: { email_verified: false },
    });
    await expect401(await post("/api/auth/google", googleBody(token)));
    expect(await db.select().from(schema.users).where(eq(schema.users.email, email))).toHaveLength(
      0,
    );
  });

  it("google: unknown sub with no email claim → 401, no account", async () => {
    const token = await mintProviderToken(
      { sub: `google-${uniq()}`, nonce: RAW_NONCE },
      { iss: "accounts.google.com", aud: GOOGLE_AUDS[0]! },
    );
    await expect401(await post("/api/auth/google", googleBody(token)));
  });

  it("apple: same-provider slot occupied by a DIFFERENT sub → 401, identity never overwritten", async () => {
    const email = `occ-${uniq()}@example.com`;
    const originalSub = `apple-${uniq()}`;
    const { user: existing } = await createUserWithEntitlements(db, {
      email,
      displayName: "Original",
      appleSub: originalSub,
    });

    const body = await expect401(
      await post("/api/auth/apple", appleBody(await mintApple(`apple-imposter-${uniq()}`, email))),
    );
    expect(body.error.code).toBe("UNAUTHENTICATED");

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, existing.id));
    expect(row?.appleSub).toBe(originalSub);
  });

  it("cross-provider token posted to the wrong route → 401 (issuer pinning; guards a seam swap)", async () => {
    const email = `xprov-${uniq()}@example.com`;

    // A Google-issuer token to /auth/apple: the Apple verifier pins
    // iss = appleid.apple.com → rejected (the two prod JWKS are distinct;
    // this catches a future accidental swap of the seams in wire.ts).
    const googleToken = await mintGoogle(`google-${uniq()}`, email);
    await expect401(await post("/api/auth/apple", appleBody(googleToken)));

    // An Apple-issuer token to /auth/google: the Google verifier pins
    // iss ∈ the Google set → rejected.
    const appleToken = await mintApple(`apple-${uniq()}`, email);
    await expect401(await post("/api/auth/google", googleBody(appleToken)));

    // Neither attempt created an account.
    expect(await db.select().from(schema.users).where(eq(schema.users.email, email))).toHaveLength(
      0,
    );
  });

  // -------------------------------------------------------------------------
  // Validation envelope (400) — R-authz-4 error-shape discipline
  // -------------------------------------------------------------------------

  it("malformed body → 400 VALIDATION_FAILED envelope with details; malformed JSON → same envelope", async () => {
    const missingField = await post("/api/auth/apple", {
      authorization_code: "x",
      raw_nonce: RAW_NONCE,
      device: { platform: "ios" },
    });
    expect(missingField.status).toBe(400);
    const envelope = (await missingField.json()) as ErrorEnvelope;
    expect(envelope.error.code).toBe("VALIDATION_FAILED");
    expect(envelope.error.details).toBeDefined();
    expect(envelope.error.requestId).toBeTruthy();

    const badJson = await app.request("/api/auth/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    const badJsonEnvelope = (await badJson.json()) as ErrorEnvelope;
    expect(badJsonEnvelope.error.code).toBe("VALIDATION_FAILED");
  });

  // -------------------------------------------------------------------------
  // Concurrency (R-auth-4: one sub, one account — racing first sign-ins)
  // -------------------------------------------------------------------------

  it("two concurrent first sign-ins for the same sub yield ONE account", async () => {
    const email = `race-${uniq()}@example.com`;
    const sub = `google-${uniq()}`;
    const [a, b] = await Promise.all([
      post("/api/auth/google", googleBody(await mintGoogle(sub, email))),
      post("/api/auth/google", googleBody(await mintGoogle(sub, email))),
    ]);
    const bodyA = await expectSignInResponse(a);
    const bodyB = await expectSignInResponse(b);
    expect(bodyA.user.id).toBe(bodyB.user.id);
    expect(await db.select().from(schema.users).where(eq(schema.users.email, email))).toHaveLength(
      1,
    );
  });

  // -------------------------------------------------------------------------
  // Token hygiene (R-auth-9 / Quality gate #5)
  // -------------------------------------------------------------------------

  it("hygiene sweep: no token material in ANY log output across success and failure sign-ins", async () => {
    const consoleSpies = (["log", "warn", "error", "info"] as const).map((level) =>
      vi.spyOn(console, level),
    );
    try {
      const email = `hyg-${uniq()}@example.com`;
      const identityToken = await mintApple(`apple-${uniq()}`, email);

      // Success (incl. code exchange), then an exchange failure, then a 401.
      const success = await expectSignInResponse(
        await post("/api/auth/apple", appleBody(identityToken)),
      );
      exchangeImpl = () => Promise.reject(new Error("apple token exchange failed (status 500)"));
      await expectSignInResponse(
        await post(
          "/api/auth/apple",
          appleBody(await mintApple(`apple-${uniq()}`, `hyg2-${uniq()}@example.com`)),
        ),
      );
      await post(
        "/api/auth/apple",
        appleBody(await mintApple(`x-${uniq()}`, email, { expired: true })),
      );

      const secrets = [
        identityToken,
        success.tokens.access_token,
        success.tokens.refresh_token,
        APPLE_REFRESH_PLAINTEXT,
        "auth-code-secret-abc",
      ];
      const logged = [
        ...warnings,
        ...consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))),
      ].join("\n");
      for (const secret of secrets) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });

  it("unmounted auth (createApp without deps) exposes no /auth routes", async () => {
    const bare = createApp();
    const res = await bare.request("/api/auth/apple", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
