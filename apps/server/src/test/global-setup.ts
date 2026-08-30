/**
 * T-S3.3 (testing-overhaul spec §3.3, R-test-6) — the ONE Postgres
 * testcontainer per vitest run, replacing 21 per-suite boots (the QUEUE P1
 * Testcontainers-contention real fix; `--no-file-parallelism` retires).
 *
 * Boot order: probe Docker once → start ONE `postgres:17-alpine` → create a
 * TEMPLATE database → run the drizzle migrations into it ONCE → lock it
 * against connections → `provide()` the coordinates. Suites then clone their
 * own throwaway database via `createSuiteDb()` (`src/test/suite-db.ts`) —
 * `CREATE DATABASE … TEMPLATE` is a near-instant file-level copy, so suites
 * run file-parallel with hard cross-suite isolation and zero extra
 * containers.
 *
 * Docker-less posture — unchanged, now enforced in THIS one place instead of
 * 21 copies: a local run prints ONE loud banner and every DB suite skips
 * (`describe.skipIf`); a CI run throws here, failing the whole run — a skip
 * is NOT a pass (T-3.3 lesson).
 *
 * Falsification (R-test-7): drop the `migrate()` call and the fresh-install
 * suite's template-carries-migrations pin (plus every DB suite) goes red on
 * missing relations; point two `createSuiteDb` calls at one database name
 * and the isolation probes (`suite-db-isolation-{a,b}.db.test.ts`) go red on
 * a primary-key collision.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { TestProject } from "vitest/node";

/** The migrated template every suite database is cloned from. */
export const TEMPLATE_DB_NAME = "gogo_template";

async function probeDocker(): Promise<boolean> {
  try {
    await promisify(execFile)("docker", ["info"], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dockerAvailable = await probeDocker();

  if (!dockerAvailable) {
    if (process.env.CI) {
      // CI posture (single home — the per-suite copies of this guard are
      // gone): a Docker-less CI run must fail the run, never skip-to-green.
      throw new Error(
        "Docker unavailable during a CI run — the shared Postgres container " +
          "could not boot, so NO server DB suite can verify anything. A skip " +
          "is NOT a pass. Provision Docker and re-run.",
      );
    }
    console.warn(
      "\n" +
        "╔══════════════════════════════════════════════════════════════════╗\n" +
        "║  DOCKER UNAVAILABLE — ALL SERVER DB SUITES SKIPPED                ║\n" +
        "║  The shared Postgres container (src/test/global-setup.ts) could   ║\n" +
        "║  not boot, so every DB suite (auth, trips, places, bookings,      ║\n" +
        "║  itinerary, travel-legs, expenses, settlements, users, http,      ║\n" +
        "║  db-constraints, fresh-install) verified NOTHING this run.        ║\n" +
        "║  Start Docker and re-run `pnpm --filter @gogo/server test`        ║\n" +
        "║  before treating this branch as green.                            ║\n" +
        "╚══════════════════════════════════════════════════════════════════╝\n",
    );
    project.provide("dbAvailable", false);
    project.provide("dbAdminUri", "");
    project.provide("dbTemplateName", "");
    return async () => {};
  }

  // ONE container per run. 60s startup budget (first-time image pulls and
  // slow daemons blew the 10s default back when suites booted their own —
  // T-5.2 round-1 flake); max_connections raised because up to
  // maxWorkers × (pool max 5) suite connections now share this instance.
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:17-alpine")
    .withCommand(["postgres", "-c", "max_connections=200"])
    .withStartupTimeout(60_000)
    .start();

  const adminUri = container.getConnectionUri();
  const admin = postgres(adminUri, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);

    // Migrate ONCE into the template; every clone inherits the full schema
    // plus the drizzle journal (so an in-suite `migrate()` over a clone is a
    // provable no-op — db/constraints.test.ts pins that idempotence).
    const templateUrl = new URL(adminUri);
    templateUrl.pathname = `/${TEMPLATE_DB_NAME}`;
    const templateClient = postgres(templateUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await migrate(drizzle({ client: templateClient }), {
        migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
      });
    } finally {
      // `CREATE DATABASE … TEMPLATE` requires the template to have zero
      // active connections — release ours before any suite can clone.
      await templateClient.end();
    }

    // Belt and braces: no session may ever connect to the template again, so
    // a stray connection can never wedge a clone mid-run. `CREATE DATABASE …
    // TEMPLATE` still works — it copies files, it does not connect.
    await admin.unsafe(
      `UPDATE pg_database SET datallowconn = false WHERE datname = '${TEMPLATE_DB_NAME}'`,
    );
  } finally {
    await admin.end();
  }

  project.provide("dbAvailable", true);
  project.provide("dbAdminUri", adminUri);
  project.provide("dbTemplateName", TEMPLATE_DB_NAME);

  return async () => {
    await container.stop();
  };
}
