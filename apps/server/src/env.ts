import { z } from "zod";

/**
 * Typed environment loading — parse once at boot, consume the typed object
 * everywhere. Never read process.env directly outside this module.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Postgres (Neon) connection string. Optional at boot so the health
   * endpoint can run DB-less; `getDb()` (src/db) throws without it on first
   * database access.
   */
  DATABASE_URL: z.url().optional(),

  // -------------------------------------------------------------------------
  // Auth (T-5.2, auth-users spec §3.2/§3.6.4 — Law #1: values only ever live
  // in env; never logged, never in git). All optional at boot so health/dev
  // can run auth-less; `buildAuthDepsFromEnv` (src/auth/wire.ts) enforces
  // all-or-nothing when auth routes mount.
  // -------------------------------------------------------------------------

  /** ES256 private key (PKCS#8 PEM) that signs our access tokens (§3.2). */
  AUTH_ES256_PRIVATE_KEY: z.string().min(1).optional(),
  /** `kid` stamped on access tokens — rotation = add key, retire old (§3.2). */
  AUTH_ES256_KID: z.string().min(1).optional(),
  /** Apple `aud` — our bundle id (R-auth-1). */
  APPLE_CLIENT_ID: z.string().min(1).optional(),
  /** Google `aud` — comma-separated OAuth client id(s) (R-auth-2). */
  GOOGLE_CLIENT_IDS: z.string().min(1).optional(),
  /** Apple developer team id — code-exchange client secret `iss` (R-auth-7). */
  APPLE_TEAM_ID: z.string().min(1).optional(),
  /** Apple Sign-in key id — code-exchange client secret `kid` (R-auth-7). */
  APPLE_KEY_ID: z.string().min(1).optional(),
  /** Apple Sign-in private key (.p8 PKCS#8 PEM) — signs the client secret. */
  APPLE_PRIVATE_KEY: z.string().min(1).optional(),
  /**
   * AES-256-GCM key (base64, exactly 32 bytes decoded) encrypting the stored
   * Apple refresh token (§3.3.3 `apple_credentials`).
   */
  APPLE_CREDENTIALS_KEY: z.string().min(1).optional(),

  // -------------------------------------------------------------------------
  // Places spine ingest datasets (T-6.4, places spec §3.1.4 step 1). Release
  // snapshots are DATED, so the release pin is deploy-time config, not code
  // (spec: "release discovery pinned at implementation — never guessed").
  // Optional at boot: unset ⇒ ingest jobs mark their region rows `failed`
  // with a visible not-configured error (R-places-4 posture), nothing else
  // breaks. Local paths are valid values (fixtures/dev).
  // -------------------------------------------------------------------------

  /**
   * Overture places GeoParquet glob. Verified pattern (2026-07-25):
   * `s3://overturemaps-us-west-2/release/<release>/theme=places/type=place/*`
   * (current release at verification: 2026-07-22.0).
   */
  PLACES_OVERTURE_PARQUET_URL: z.string().min(1).optional(),
  /**
   * FSQ OS Places parquet glob. NOTE (verified 2026-07-25): Foursquare is
   * migrating OS Places delivery to its Places Portal (Iceberg catalog,
   * token-gated) — if the legacy public S3 bucket
   * (`s3://fsq-os-places-us-east-1/release/dt=<date>/places/parquet/*`) is
   * gone when this gets wired for real, that's an Autonomy-Contract #3
   * escalation (account signup), not a config value to improvise.
   */
  PLACES_FSQ_OS_PARQUET_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Report variable names + validation messages only — never values (Law #1).
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return result.data;
}
