/**
 * T-S3.1 boot-shape suite (testing-overhaul spec §3.5, R-test-5; ADR-006
 * "Env strategy").
 *
 * THE GAP THIS CLOSES: server suites never read env (DI injects in-test jose
 * keys — good design, but it left the composition path loadEnv →
 * `buildAuthDepsFromEnv` → `createApp` with ZERO tests), CI ran no env beyond
 * `CI=true`, and the full authed boot shape had only ever run on the
 * hand-built QA rig (2026-08-29). This suite runs every boot SHAPE — full
 * auth, partial auth, empty auth, mangled key material — locally and in CI,
 * with runtime-generated throwaway keys only (Law #1).
 *
 * Level: this pins the boot COMPOSITION (which surfaces mount per env shape,
 * end to end through real requests) plus the real composition root
 * `src/index.ts` via subprocess. Wire-level unit facts (audience splitting,
 * Apple-key parse, GOOGLE_CLIENT_IDS footgun) stay in `auth/wire.test.ts` —
 * not restated here.
 *
 * `src/index.ts` is qa-owned (in flight on `qa/device-integration`) and is
 * exercised UNMODIFIED as a subprocess; extracting a testable `boot()` is a
 * recorded post-qa-merge rider (spec §5).
 *
 * Falsification (R-test-7) is stated per pin. The partial-env sweep is
 * mutation-verified: degrade the wire gate to `if (missing.length > 0)
 * return null;` and the sweep + its control go RED (evidence in the T-S3.1
 * PR).
 *
 * B-28 round-2 (R-test-3): the dev-refuse migration gate had NO executed
 * test anywhere — every existing composition-root arm below is deliberately
 * DB-free (see that section's own header), because `getDb()`'s Neon
 * serverless WebSocket driver cannot reach a vanilla Postgres without a
 * WS↔TCP proxy this repo doesn't run. The "composition root migration
 * gate" describe block at the bottom of this file closes that gap using the
 * SAME already-established workaround every other DB suite in this repo
 * uses (`migration-fixtures.ts`'s own header): inject a `postgres-js`
 * client directly instead of going through `getDb()` — applied here to a
 * genuine SUBPROCESS boot (`src/test/migration-gate-harness.ts`, which
 * calls the exact same `checkMigrationState`/`decideBootMigrationAction`
 * production functions `src/index.ts` calls) rather than `src/index.ts`
 * itself, so the dev-refuse decision gets one real, executed, out-of-process
 * test against a real database and a real on-disk journal.
 */
import { spawn } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "./app.js";
import { buildAuthDepsFromEnv } from "./auth/wire.js";
import { shapeMigrationStateForHealth } from "./boot-migration-check.js";
import { closeDb } from "./db/index.js";
import { MIGRATE_COMMAND, type MigrationState } from "./db/migration-state.js";
import { loadEnv } from "./env.js";
import type { Env } from "./env.js";
import { AUTH_ENV_VAR_NAMES, makeFullAuthTestEnv, TEST_AUTH_KID } from "./test/env-builder.js";
import { createDatabaseBehindByOne, type BehindDatabase } from "./test/migration-fixtures.js";
import { createSuiteDb, type SuiteDb } from "./test/suite-db.js";

const dockerAvailable = inject("dbAvailable");

/**
 * Never connected: the db pool is constructed lazily and nothing in this
 * suite issues a query — boot shape is deliberately DB-free (DB behavior is
 * the fresh-database suite's job, T-S3.3).
 */
const FAKE_DB_URL = "postgresql://gogo:gogo@localhost:5432/gogo_boot_shape";

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

/** Build full-auth deps the way index.ts does: loadEnv → buildAuthDepsFromEnv. */
async function buildFullAuthDeps(style: "pem" | "env-file" = "pem") {
  const { vars } = await makeFullAuthTestEnv({ style, databaseUrl: FAKE_DB_URL });
  // `getDb()` (called inside buildAuthDepsFromEnv) reads process.env, not the
  // env object — stub the process var too.
  vi.stubEnv("DATABASE_URL", FAKE_DB_URL);
  const env = loadEnv({ NODE_ENV: "test", ...vars });
  return buildAuthDepsFromEnv(env);
}

/** The three shape probes every boot variant is measured by. */
async function probeShapes(app: ReturnType<typeof createApp>) {
  const health = await app.request("/api/health");
  // Public auth route, invalid body: 400 VALIDATION_FAILED iff the auth
  // surface is mounted; 404 iff it is not. Never touches the DB.
  const refresh = await app.request("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  // Non-allowlisted path: 401 iff the app-wide requireAuth guard mounted
  // (it mounts with auth); 404 iff nothing guards it.
  const guarded = await app.request("/api/trips");
  return { health, refresh, guarded };
}

describe("boot shape: FULL auth env (R-test-5)", () => {
  it("builder env clears the real EnvSchema and builds non-null auth deps", async () => {
    // Falsification: rename/add an auth var in env.ts or the wire gate
    // without updating env-builder.ts → loadEnv throws or deps come back
    // null, RED here.
    const deps = await buildFullAuthDeps();
    expect(deps).not.toBeNull();
    expect(deps!.signer.kid).toBe(TEST_AUTH_KID);
    expect(deps!.appleCredentialsKey.length).toBe(32);
  });

  it("mounts /auth and the app-wide guard: health 200, refresh 400 (not 404), protected path 401 (not 404)", async () => {
    // Falsification: createApp dropping the auth router mount → refresh 404;
    // dropping the requireAuth mount → guarded probe 404. The health-only
    // suite below is the control proving these statuses are shape-dependent,
    // not universal.
    const deps = await buildFullAuthDeps();
    const app = createApp({ auth: deps! });
    const { health, refresh, guarded } = await probeShapes(app);

    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    expect(refresh.status).toBe(400);
    const refreshBody = (await refresh.json()) as { error: { code: string } };
    expect(refreshBody.error.code).toBe("VALIDATION_FAILED");

    expect(guarded.status).toBe(401);
    const guardedBody = (await guarded.json()) as { error: { code: string } };
    expect(guardedBody.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("boot shape: PARTIAL auth env throws — all-or-nothing across all 8 (landmine pin)", () => {
  // The 2026-08-29 QA rig landmine: a partial set must THROW at boot naming
  // the gap, never degrade to a health-only boot that looks alive while
  // sign-in is silently gone.
  //
  // Falsification / mutation verification: change wire.ts's partial gate to
  // `return null` (silent degrade) and every row of this sweep goes RED
  // (deps resolve null instead of rejecting). Verified in the T-S3.1 PR.
  it.each(AUTH_ENV_VAR_NAMES)("missing %s alone → boot throws naming it", async (name) => {
    const { vars } = await makeFullAuthTestEnv({ databaseUrl: FAKE_DB_URL });
    const aesKey = vars.APPLE_CREDENTIALS_KEY!;
    delete vars[name];

    const env = loadEnv({ NODE_ENV: "test", ...vars });
    const error = await buildAuthDepsFromEnv(env).then(
      () => {
        throw new Error(`expected partial config (missing ${name}) to throw`);
      },
      (e: unknown) => e as Error,
    );
    expect(error.message).toContain(name);
    // Names only, never values (Law #1).
    expect(error.message).not.toContain("BEGIN PRIVATE KEY");
    expect(error.message).not.toContain(aesKey);
  });

  it("control: the same env with nothing removed builds deps (the sweep is not vacuous)", async () => {
    // Without this arm, a builder that emits a broken env would make every
    // sweep row pass for the wrong reason (vacuous-pin taxonomy).
    const deps = await buildFullAuthDeps();
    expect(deps).not.toBeNull();
  });
});

describe("boot shape: EMPTY auth env → health-only (no auth surface, no guard)", () => {
  it("wholly unconfigured auth env yields null deps", async () => {
    // Falsification: the wire gate throwing on empty (instead of null) kills
    // the documented health-only dev boot → RED here.
    const env = loadEnv({ NODE_ENV: "test" });
    expect(await buildAuthDepsFromEnv(env)).toBeNull();
  });

  it("health-only app: health 200, refresh 404, unguarded unknown path 404 (control for the full-auth arm)", async () => {
    const app = createApp({});
    const { health, refresh, guarded } = await probeShapes(app);

    expect(health.status).toBe(200);
    expect(refresh.status).toBe(404); // auth surface absent — NOT 400
    expect(guarded.status).toBe(404); // no requireAuth mounted — NOT 401
  });
});

describe("boot shape: key-material forms (landmine pin — DECODER::unsupported)", () => {
  it("literal-\\n \\n-escaped PEMs (CI-secret / env-UI channel shape) boot the full authed shape (wire pem() arm)", async () => {
    // Delivery-fact note (PR #41 R1 corrected an inverted claim here): node
    // --env-file EXPANDS `\n` inside double-quoted values (char-code-verified,
    // node 24.12), so a generated .env.test delivers REAL-newline PEMs — the
    // "pem" style covered above. THIS arm pins the other delivery class:
    // channels that hand the backslash-n over literally (CI secret stores,
    // hosting env-var UIs, raw exports, single-quoted/unquoted env entries).
    // Falsification: remove the `pem()` normalization in wire.ts →
    // importPKCS8 rejects → RED.
    const deps = await buildFullAuthDeps("env-file");
    expect(deps).not.toBeNull();
    const app = createApp({ auth: deps! });
    const { health, refresh } = await probeShapes(app);
    expect(health.status).toBe(200);
    expect(refresh.status).toBe(400);
  });

  it("builder style discriminator: 'env-file' folds PEMs to literal-\\n single lines; 'pem' keeps real newlines", async () => {
    // Kills the fold()→identity mutation R1 found surviving 20/20 green:
    // without these pins an identity fold makes the literal-\n arm above
    // exercise the same real-newline shape as the pem arm — vacuously green.
    // Falsification: fold() returning its input (or folding both styles) →
    // RED here.
    const escaped = await makeFullAuthTestEnv({ style: "env-file" });
    const plain = await makeFullAuthTestEnv();
    for (const key of ["AUTH_ES256_PRIVATE_KEY", "APPLE_PRIVATE_KEY"] as const) {
      expect(escaped.vars[key]).toContain("\\n");
      expect(escaped.vars[key]).not.toContain("\n");
      expect(plain.vars[key]).toContain("\n");
      expect(plain.vars[key]).not.toContain("\\n");
    }
  });

  it("armor-less AUTH_ES256_PRIVATE_KEY (bare base64 DER) fails the boot LOUDLY, leaking no material", async () => {
    // The QA-rig landmine: pasting the key without PEM armor. pem() only
    // normalizes `\n` escapes — it cannot invent armor, so boot must throw,
    // never limp onward.
    const { vars, appleCredentialsKeyBase64 } = await makeFullAuthTestEnv({
      databaseUrl: FAKE_DB_URL,
    });
    vi.stubEnv("DATABASE_URL", FAKE_DB_URL);
    const bareDer = vars
      .AUTH_ES256_PRIVATE_KEY!.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "");
    vars.AUTH_ES256_PRIVATE_KEY = bareDer;

    const env = loadEnv({ NODE_ENV: "test", ...vars });
    const error = await buildAuthDepsFromEnv(env).then(
      () => {
        throw new Error("expected an armor-less signing key to fail the boot");
      },
      (e: unknown) => e as Error,
    );
    // jose's importPKCS8 armor check fires first in wire's order (before
    // createPublicKey/createPrivateKey at the accessVerify seam).
    expect(error.message).toMatch(/PKCS#?8/i);
    expect(error.message).not.toContain(bareDer);
    expect(error.message).not.toContain(appleCredentialsKeyBase64);
  });

  it("control: node createPrivateKey rejects bare DER (ERR_OSSL DECODER::unsupported) but accepts the armored PEM", async () => {
    // Pins the RAW failure mode underneath the arm above, proving the
    // negative isn't an artifact of our gate: the same DER bytes flip
    // fail→parse purely on armor. Falsification: a node/OpenSSL upgrade that
    // starts accepting bare base64 DER strings — at which point the
    // armor-less arm above needs rethinking, and this control says so.
    const { es256PrivateKeyPem } = await makeFullAuthTestEnv();
    const bareDer = es256PrivateKeyPem
      .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
      .replace(/\s+/g, "");

    let rawError: unknown;
    try {
      createPrivateKey(bareDer);
    } catch (e) {
      rawError = e;
    }
    expect(rawError).toBeInstanceOf(Error);
    expect((rawError as NodeJS.ErrnoException).code).toBe("ERR_OSSL_UNSUPPORTED");
    expect((rawError as Error).message).toContain("DECODER routines::unsupported");

    expect(() => createPrivateKey(es256PrivateKeyPem)).not.toThrow();
  });
});

describe("index.ts wiring: shapeMigrationStateForHealth feeds BOTH the initial /health value AND the refresh hook (B-28 round-2, R-test-4 — this exact call site had no test)", () => {
  // `src/index.ts` builds `appOptions.migrations`/`migrationsRefresh` as:
  //   migrations: shapeMigrationStateForHealth(env.NODE_ENV, migrationState),
  //   migrationsRefresh: async () =>
  //     shapeMigrationStateForHealth(env.NODE_ENV, await checkMigrationState(getDb())),
  // Neither half is untested in isolation — `shapeMigrationStateForHealth`
  // has its own exhaustive matrix in `boot-migration-check.test.ts`, and
  // `createApp`'s handling of `migrations`/`migrationsRefresh` has its own
  // matrix in `app.test.ts` — but nothing proved `index.ts` actually THREADS
  // one into the other for BOTH the boot-time value and the refresh
  // closure. `index.ts` itself can't be driven through this in-process
  // (module docblock) or as a DB-reachable subprocess (Neon WS driver
  // landmine — same reasoning as the migration-gate-harness section below),
  // so this wires the exact two PRODUCTION functions together the same way,
  // in-process, and drives them through a REAL `createApp` + `/health`
  // request — the smallest faithful reproduction of the actual call site.
  const CURRENT: MigrationState = {
    onDisk: 4,
    applied: 4,
    pending: [],
    pendingCount: 0,
    modified: [],
    modifiedCount: 0,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
  const BEHIND: MigrationState = {
    onDisk: 4,
    applied: 2,
    pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
    pendingCount: 2,
    modified: ["0001_edited_after_apply"],
    modifiedCount: 1,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };

  /** `index.ts`'s exact wiring expression, parameterized over env + the boot-time state + what a later refresh would return. */
  function wireMigrationsLikeIndexTs(
    nodeEnv: Env["NODE_ENV"],
    bootState: MigrationState,
    refreshedState: MigrationState,
  ) {
    return {
      migrations: shapeMigrationStateForHealth(nodeEnv, bootState),
      migrationsRefresh: async () =>
        shapeMigrationStateForHealth(nodeEnv, await Promise.resolve(refreshedState)),
    };
  }

  it("development: /health carries FULL pending AND modified tag names (dev/test are HEALTH_TAG_NAME_ENVS)", async () => {
    const app = createApp(wireMigrationsLikeIndexTs("development", BEHIND, BEHIND));
    const res = await app.request("/api/health");
    const body = (await res.json()) as { migrations: MigrationState };
    expect(body.migrations.pending).toEqual(BEHIND.pending);
    expect(body.migrations.modified).toEqual(BEHIND.modified);
  });

  it("production: /health redacts pending AND modified NAMES but keeps the counts truthful", async () => {
    // Falsification: dropping the `shapeMigrationStateForHealth` call at
    // this wiring site (echoing the raw, unshaped `migrationState` instead)
    // makes this red — the exact unauthenticated-disclosure architecture
    // review round-1 #3 flagged, now verified at the ACTUAL wiring site
    // instead of only at the pure-function level.
    const app = createApp(wireMigrationsLikeIndexTs("production", BEHIND, BEHIND));
    const res = await app.request("/api/health");
    const body = (await res.json()) as { migrations: MigrationState };
    expect(body.migrations.pending).toEqual([]);
    expect(body.migrations.pendingCount).toBe(2);
    expect(body.migrations.modified).toEqual([]);
    expect(body.migrations.modifiedCount).toBe(1);
  });

  it("production: a BACKGROUND REFRESH is ALSO shaped — not just the boot-time initial value", async () => {
    vi.useFakeTimers();
    try {
      const app = createApp(wireMigrationsLikeIndexTs("production", CURRENT, BEHIND));
      vi.advanceTimersByTime(31_000);
      await app.request("/api/health"); // stale-while-revalidate: triggers the background refresh
      for (let i = 0; i < 5; i++) await Promise.resolve(); // flush the refresh's microtask chain
      const res = await app.request("/api/health");
      const body = (await res.json()) as { migrations: MigrationState };
      // Falsification: wiring the refresh hook to the RAW `checkMigrationState`
      // result (skipping `shapeMigrationStateForHealth`) makes this red —
      // it would leak the pending/modified tag names in production on the
      // refreshed value even though the boot-time value redacted them.
      expect(body.migrations.pending).toEqual([]);
      expect(body.migrations.pendingCount).toBe(2);
      expect(body.migrations.modified).toEqual([]);
      expect(body.migrations.modifiedCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Composition root: src/index.ts, run UNMODIFIED as a subprocess (it serves
// at import time, so in-process import is off the table until the boot()
// extraction rider lands). Each arm is DB-free: the pool is lazy and the
// travel-legs staleness sweep first fires after TRAVEL_LEGS_SWEEP_INTERVAL_MS
// (1h) — the process is killed long before either touches the network.
// ---------------------------------------------------------------------------

const SERVER_DIR = fileURLToPath(new URL("../", import.meta.url));
const BANNER_RE = /listening on http:\/\/localhost:\d+/;
const BOOT_TIMEOUT_MS = 25_000;
const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

interface CompositionRootBoot {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sawBanner: boolean;
}

/**
 * Spawn `node --import tsx src/index.ts` with EXACTLY the given env (plus
 * PATH/HOME/TMPDIR so node itself runs) — no inherited vars, so a real
 * `.env`-loaded shell can't contaminate the shape under test. Resolves when
 * the process exits on its own OR after it prints the listen banner (we
 * SIGTERM it and wait for stdio to drain).
 */
function bootCompositionRoot(env: Record<string, string>): Promise<CompositionRootBoot> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (BANNER_RE.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(guard);
      if (timedOut) {
        reject(
          new Error(
            `composition root neither exited nor printed the banner in ${BOOT_TIMEOUT_MS}ms\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      } else {
        resolve({ exitCode: code, stdout, stderr, sawBanner: BANNER_RE.test(stdout) });
      }
    });
    child.on("error", (err) => {
      clearTimeout(guard);
      reject(err);
    });
  });
}

/**
 * OS-assigned free port (bind 0, read, release). loadEnv rejects PORT=0
 * (min 1), so the child can't self-assign — we probe on its behalf.
 */
function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(String(address.port));
        else reject(new Error("port probe returned no address"));
      });
    });
  });
}

const PORT_ATTEMPTS = 3;

/**
 * Boot a banner-expected arm on a probed-free port, with a bounded retry if
 * another process races us into the probe→bind window (R1 finding: a raw
 * random port could collide with a live dev server → bannerless child →
 * misleading false RED).
 */
async function bootOnFreePort(env: Record<string, string>): Promise<CompositionRootBoot> {
  let last: CompositionRootBoot | undefined;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    last = await bootCompositionRoot({ ...env, PORT: await freePort() });
    if (last.sawBanner || !last.stderr.includes("EADDRINUSE")) return last;
  }
  return last!;
}

describe("composition root (src/index.ts) boot shapes — subprocess", () => {
  it(
    "production + EMPTY auth env → refuses to boot (never health-only in prod)",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      // The production-never-boots-health-only guard, pinned against the real
      // root. Falsification: delete the `!authDeps && production` throw in
      // index.ts → the process banners up health-only and this arm goes RED
      // (sawBanner true / non-zero exit assertion fails).
      const boot = await bootCompositionRoot({ NODE_ENV: "production" });
      expect(boot.sawBanner).toBe(false);
      expect(boot.exitCode).not.toBe(0);
      expect(boot.exitCode).not.toBeNull();
      expect(boot.stderr).toContain("refusing to boot production");
    },
  );

  it(
    "production + FULL auth env → boots and listens (control: prod refuses emptiness, not production itself)",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      // The FULL authed shape through the real composition root, in CI, on
      // throwaway generated keys — the R-test-5 sentence, executable.
      // Falsification: any wire/createApp regression that breaks the full
      // authed boot (e.g. an eagerly-connecting dep) → no banner → RED.
      const { vars } = await makeFullAuthTestEnv({ databaseUrl: FAKE_DB_URL });
      const boot = await bootOnFreePort({ NODE_ENV: "production", ...vars });
      expect(boot.sawBanner).toBe(true);
      expect(boot.stderr).not.toContain("health-only");
      // Architecture review round-1 #2: this is the ONE arm that actually
      // exercises `index.ts`'s new B-28 migration-check wiring (full auth →
      // `if (authDeps)` block runs → `checkMigrationState(getDb())` against
      // the deliberately-unreachable FAKE_DB_URL → caught → warned). No
      // other suite touches `src/index.ts` at all. Falsification: moving the
      // migration-state block after `appOptions` is built, or dropping the
      // `await` on `checkMigrationState`, makes this warn line never appear
      // (or appear malformed) → RED.
      expect(boot.stderr).toContain("[boot] could not determine migration state");
    },
  );

  it(
    "production + PARTIAL auth env (7 of 8) → boot fails naming the missing var",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      // All-or-nothing enforced through the real root, not just the wire
      // unit: partial config must never be mistaken for the empty shape's
      // sanctioned dev degrade. Falsification: same mutation as the
      // in-process sweep (gate → return null) — in production that degrade
      // then hits the health-only refusal, but in ANY other NODE_ENV it
      // would banner up silently; the named-var assertion here is what
      // stays red regardless.
      const { vars } = await makeFullAuthTestEnv({ databaseUrl: FAKE_DB_URL });
      delete vars.APPLE_KEY_ID;
      const boot = await bootCompositionRoot({ NODE_ENV: "production", ...vars });
      expect(boot.sawBanner).toBe(false);
      expect(boot.exitCode).not.toBe(0);
      expect(boot.exitCode).not.toBeNull();
      expect(boot.stderr).toContain("auth configuration incomplete");
      expect(boot.stderr).toContain("APPLE_KEY_ID");
      expect(boot.stderr).not.toContain("BEGIN PRIVATE KEY");
    },
  );

  it(
    "development + EMPTY auth env → health-only boot with the loud warning (the sanctioned degrade)",
    { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
    async () => {
      // Control for the production-refusal arm: same empty env, NODE_ENV
      // flipped → banners up. Falsification: the health-only path breaking
      // (no banner) or its warning disappearing (silent degrade) → RED.
      const boot = await bootOnFreePort({ NODE_ENV: "development" });
      expect(boot.sawBanner).toBe(true);
      expect(boot.stderr).toContain("auth env not configured");
      expect(boot.stderr).toContain("health-only");
    },
  );
});

// ---------------------------------------------------------------------------
// Composition-root migration gate, subprocess, against REAL Postgres (B-28
// round-2, R-test-3: "the dev REFUSE path has no executed test"). See the
// file header for why this spawns `src/test/migration-gate-harness.ts`
// (calling the exact same production `checkMigrationState`/
// `decideBootMigrationAction` functions `src/index.ts` calls) instead of
// `src/index.ts` itself — `getDb()`'s Neon WebSocket driver cannot reach
// these testcontainers databases.
// ---------------------------------------------------------------------------

const HARNESS_TIMEOUT_MS = 15_000;

/** Spawn `src/test/migration-gate-harness.ts` with exactly `DATABASE_URL` + `NODE_ENV` — same no-inherited-env posture as `bootCompositionRoot`. Always exits on its own (no server to bind, no banner to wait for), bounded so a genuine hang fails the test instead of the suite. */
function spawnMigrationGateHarness(env: Record<string, string>): Promise<CompositionRootBoot> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/test/migration-gate-harness.ts"],
      {
        cwd: SERVER_DIR,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, HARNESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(guard);
      if (timedOut) {
        reject(
          new Error(
            `migration-gate-harness did not exit within ${HARNESS_TIMEOUT_MS}ms\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      } else {
        resolve({ exitCode: code, stdout, stderr, sawBanner: false });
      }
    });
    child.on("error", (err) => {
      clearTimeout(guard);
      reject(err);
    });
  });
}

describe.skipIf(!dockerAvailable)(
  "composition root migration gate — REAL Postgres, subprocess (B-28 round-2, R-test-3)",
  () => {
    let suiteDb: SuiteDb | undefined;
    let behindDb: BehindDatabase | undefined;

    afterEach(async () => {
      await suiteDb?.drop();
      suiteDb = undefined;
      await behindDb?.drop();
      behindDb = undefined;
    });

    it(
      "development + one genuinely pending migration → non-zero exit naming the tag and the migrate command",
      { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
      async () => {
        // Falsification: reverting `decideBootMigrationAction` (or the
        // matching algorithm feeding it) to ever return "ok"/"warn" for a
        // genuinely pending migration in `development` makes this exit 0
        // (or the message assertions fail) — this is the exact "dev REFUSE
        // path has no executed test" gap the round-2 verifier found.
        behindDb = await createDatabaseBehindByOne("boot_shape_dev_refuse");
        const boot = await spawnMigrationGateHarness({
          DATABASE_URL: behindDb.uri,
          NODE_ENV: "development",
        });
        expect(boot.exitCode).not.toBe(0);
        expect(boot.exitCode).not.toBeNull();
        expect(boot.stderr).toContain(behindDb.pendingTag);
        expect(boot.stderr).toContain(MIGRATE_COMMAND);
      },
    );

    it(
      "development + a fully current DB → boots (exit 0, no refuse)",
      { timeout: SUBPROCESS_TEST_TIMEOUT_MS },
      async () => {
        // The control for the arm above: same env shape, a database with
        // NOTHING pending — proves the refuse above is driven by the actual
        // migration state, not by `development` unconditionally refusing.
        suiteDb = await createSuiteDb("boot_shape_dev_current");
        const boot = await spawnMigrationGateHarness({
          DATABASE_URL: suiteDb.uri,
          NODE_ENV: "development",
        });
        expect(boot.exitCode).toBe(0);
        expect(boot.stdout).toContain("migration-gate-harness: booted");
        expect(boot.stderr).not.toContain("pending migration");
      },
    );
  },
);
