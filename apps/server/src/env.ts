import { z } from "zod";

/**
 * Typed environment loading — parse once at boot, consume the typed object
 * everywhere. Never read process.env directly outside this module.
 */
const EnvSchema = z
  .object({
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
    // E2E session door (S-4/T3 — `.specs/testing/session-door.spec.md` §3.2
    // gates G0/G1/G2/G4). Never set by any default build command, `.env.example`,
    // or `app.json` (§3.2) — both come from the gitignored
    // `apps/server/.env.test` (`scripts/gen-test-env.mjs`).
    // -------------------------------------------------------------------------

    /**
     * G0 — must be the literal `"1"` to opt in; ANY other value (including
     * absent) fails the gate (R-door-1). Kept as a raw string (not coerced to
     * boolean) so a typo like `E2E_SESSION_DOOR=true` fails closed instead of
     * silently coercing true.
     */
    E2E_SESSION_DOOR: z.string().optional(),
    /**
     * G2 — the door's shared secret. Deliberately NOT `.min(32)` here: a
     * too-short secret must fail the MOUNT gate (route absent, R-door-1),
     * never `loadEnv()` itself — otherwise a 31-char secret would crash boot
     * instead of just leaving the door unmounted. Length is checked by the
     * gate evaluator (`auth/e2e-door.ts`), not this schema.
     */
    E2E_SESSION_DOOR_SECRET: z.string().optional(),

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

    // -------------------------------------------------------------------------
    // Travel-leg providers (T-7.3, itinerary-bookings spec §3.5/R-ib-21 —
    // server-side only, keys never reach the client). Law #1: values only ever
    // live in env; never logged, never in error messages (the Mapbox token
    // rides provider URLs — adapters redact, see travel-legs/providers.ts).
    // -------------------------------------------------------------------------

    /**
     * Mapbox Directions token (driving/walking/cycling legs). Absent ⇒ the
     * Mapbox port is not constructed and those modes DEGRADE per R-ib-19/21 —
     * legs absent, never an error on any mutation path. The account/token is
     * the PARKED Sean item (QUEUE Blocked row); the build is fixture-driven.
     */
    MAPBOX_ACCESS_TOKEN: z.string().min(1).optional(),
    /**
     * Transitous (MOTIS) instance for `transit` legs — the public community
     * instance is keyless, so this defaults instead of degrading. Override for
     * staging (`https://staging.api.transitous.org`) or a self-hosted MOTIS.
     */
    TRANSITOUS_BASE_URL: z.url().default("https://api.transitous.org"),
  })
  .superRefine((data, ctx) => {
    // R-door-2 / G4 (session-door spec §3.2, §3.8): production + ANY door var
    // set ⇒ refuse to boot naming the variable(s), never a value. Fires
    // regardless of the secret's length or the door var's exact value — the
    // point is that NEITHER should ever be touched on a production env at
    // all, not that they're well-formed.
    const doorVarsSet =
      data.E2E_SESSION_DOOR !== undefined || data.E2E_SESSION_DOOR_SECRET !== undefined;
    if (data.NODE_ENV === "production" && doorVarsSet) {
      ctx.addIssue({
        code: "custom",
        message:
          "E2E_SESSION_DOOR_SECRET (or E2E_SESSION_DOOR): must not be set when NODE_ENV is production",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema> & {
  /**
   * R-door-1 / G1: `true` iff the caller's `source` object had an OWN
   * `NODE_ENV` key — never `true` off the schema's `"development"` default.
   * Computed in `loadEnv` from the raw `source`, since by the time zod's
   * `.default()` runs there is no way to tell "explicitly development" apart
   * from "defaulted to development" from the parsed value alone.
   */
  NODE_ENV_EXPLICIT: boolean;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Report variable names + validation messages only — never values (Law #1).
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return { ...result.data, NODE_ENV_EXPLICIT: source.NODE_ENV !== undefined };
}
