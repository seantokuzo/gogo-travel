/**
 * T-S3.1 (testing-overhaul spec §3.5, R-test-5) — the ONE canonical full-auth
 * test env, in memory.
 *
 * Generates REAL throwaway key material at runtime — a P-256 keypair per PEM
 * slot (jose `generateKeyPair` → PKCS#8 PEM) and a 32-byte AES key
 * (`randomBytes`) — the pattern the 2026-08-29 QA rig proved by hand. Nothing
 * here is a secret (the keys guard nothing and die with the process), and
 * nothing here may ever be committed as a value (Law #1): consumers get fresh
 * material per call.
 *
 * Consumers: the boot-shape suite (`src/test/boot-shape.test.ts`), and
 * T-S3.3's fresh-install suite (builds authed deps from this env). The live
 * dev-rig twin is `scripts/gen-test-env.mjs`, which writes the same shape to
 * a gitignored `apps/server/.env.test`.
 *
 * Falsification (R-test-7): `loadEnv(makeFullAuthTestEnv().vars)` clearing the
 * real `EnvSchema` is pinned in the boot-shape suite — renaming an auth env
 * var in `src/env.ts` (or adding a ninth required auth var to
 * `buildAuthDepsFromEnv`) without updating this builder turns that suite RED.
 */
import { randomBytes } from "node:crypto";
import { exportPKCS8, generateKeyPair } from "jose";

/**
 * The 8 all-or-nothing auth vars, exactly as `buildAuthDepsFromEnv` gates
 * them (src/auth/wire.ts `authVars`). The boot-shape partial-env sweep drops
 * each in turn; keep in sync with the wire gate (drift = sweep goes red).
 */
export const AUTH_ENV_VAR_NAMES = [
  "AUTH_ES256_PRIVATE_KEY",
  "AUTH_ES256_KID",
  "APPLE_CLIENT_ID",
  "GOOGLE_CLIENT_IDS",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "APPLE_CREDENTIALS_KEY",
] as const;

export type AuthEnvVarName = (typeof AUTH_ENV_VAR_NAMES)[number];

/** Fixed fake ids — deliberately unmistakable for real config. */
export const TEST_AUTH_KID = "s3-test-kid-1";
export const TEST_APPLE_CLIENT_ID = "com.gogo.travel.s3test";
export const TEST_GOOGLE_CLIENT_IDS = "s3-ios.apps.example,s3-web.apps.example";
export const TEST_APPLE_TEAM_ID = "S3TESTTEAM";
export const TEST_APPLE_KEY_ID = "S3TESTKEY1";

export interface MakeFullAuthTestEnvOptions {
  /**
   * How the PEM values are folded:
   * - `"pem"` (default): real newlines — the shell-export / CI-secret shape.
   * - `"env-file"`: `\n`-escaped single lines, the `.env.example`-documented
   *   form. Node's `--env-file` passes quoted `\n` through UNEXPANDED
   *   (verified on node 24.12), so this is byte-for-byte what
   *   `--env-file-if-exists=.env.test` delivers to `loadEnv` — the arm the
   *   wire.ts `pem()` normalizer exists for.
   */
  style?: "pem" | "env-file";
  /**
   * Included as `DATABASE_URL` when set. `buildAuthDepsFromEnv` requires it
   * alongside the 8 auth vars; note `getDb()` reads `process.env`, not the
   * env object, so suites must ALSO stub the process var (see boot-shape).
   */
  databaseUrl?: string;
}

export interface FullAuthTestEnv {
  /**
   * A `loadEnv`-ready source holding all 8 auth vars (plus `DATABASE_URL`
   * when requested) — the FULL authed shape; nothing partial ever comes out
   * of this builder.
   */
  vars: Record<string, string>;
  /** PKCS#8 PEM (real newlines) of the ES256 access-token signing key. */
  es256PrivateKeyPem: string;
  /** PKCS#8 PEM (real newlines) of the fake Apple Sign-in `.p8` key. */
  applePrivateKeyPem: string;
  /** The AES-256-GCM credentials key, base64 (exactly 32 bytes decoded). */
  appleCredentialsKeyBase64: string;
}

/**
 * Build the canonical full-auth test env. Every call generates fresh
 * throwaway key material; two calls never share keys.
 */
export async function makeFullAuthTestEnv(
  options: MakeFullAuthTestEnvOptions = {},
): Promise<FullAuthTestEnv> {
  const style = options.style ?? "pem";
  // Two DISTINCT pairs: a suite that cross-wires the signing key and the
  // Apple .p8 must fail, not silently work because they happen to be equal.
  const [signing, apple] = await Promise.all([
    generateKeyPair("ES256", { extractable: true }),
    generateKeyPair("ES256", { extractable: true }),
  ]);
  const es256PrivateKeyPem = await exportPKCS8(signing.privateKey);
  const applePrivateKeyPem = await exportPKCS8(apple.privateKey);
  const appleCredentialsKeyBase64 = randomBytes(32).toString("base64");

  const fold = (pem: string): string => (style === "env-file" ? pem.replaceAll("\n", "\\n") : pem);

  const vars: Record<string, string> = {
    AUTH_ES256_PRIVATE_KEY: fold(es256PrivateKeyPem),
    AUTH_ES256_KID: TEST_AUTH_KID,
    APPLE_CLIENT_ID: TEST_APPLE_CLIENT_ID,
    GOOGLE_CLIENT_IDS: TEST_GOOGLE_CLIENT_IDS,
    APPLE_TEAM_ID: TEST_APPLE_TEAM_ID,
    APPLE_KEY_ID: TEST_APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: fold(applePrivateKeyPem),
    APPLE_CREDENTIALS_KEY: appleCredentialsKeyBase64,
  };
  if (options.databaseUrl !== undefined) {
    vars.DATABASE_URL = options.databaseUrl;
  }

  return { vars, es256PrivateKeyPem, applePrivateKeyPem, appleCredentialsKeyBase64 };
}
