/**
 * Boot-time migration-state DECISION (B-28) — pure, no I/O. `src/index.ts`
 * calls `checkMigrationState` (`db/migration-state.ts`) to get the facts,
 * then this module decides what to DO with them: refuse, warn, or nothing.
 * Kept separate from the DB/journal reads so the env-branching logic is
 * trivially unit-testable without Docker.
 *
 * Locked decision (orchestrator, 2026-09-13): refuse to serve in
 * `development` when migrations are pending; every OTHER `NODE_ENV` warns
 * loudly and keeps serving — this must never take prod down. Sean is being
 * asked whether to soften `development` to WARN-only too; if so,
 * `REFUSE_ON_PENDING_ENVS` below is the ONE line to change (e.g. to an empty
 * `Set()`) — nothing else in this file or its caller needs to move.
 */
import type { Env } from "./env.js";
import { formatMigrationStateMessage, type MigrationState } from "./db/migration-state.js";

/** THE switch. `NODE_ENV` values that refuse to boot on pending migrations; every other value warns and keeps serving. */
export const REFUSE_ON_PENDING_ENVS: ReadonlySet<Env["NODE_ENV"]> = new Set(["development"]);

export type BootMigrationDecision =
  { action: "ok" } | { action: "warn"; message: string } | { action: "refuse"; message: string };

/** Pure: given the env and an already-computed migration state, decide what boot should do. Never touches the filesystem or the database. */
export function decideBootMigrationAction(
  nodeEnv: Env["NODE_ENV"],
  state: MigrationState,
): BootMigrationDecision {
  if (state.pending.length === 0) return { action: "ok" };
  const message = formatMigrationStateMessage(state);
  return REFUSE_ON_PENDING_ENVS.has(nodeEnv)
    ? { action: "refuse", message }
    : { action: "warn", message };
}

/**
 * `NODE_ENV` values that get FULL pending migration tag names on
 * `/api/health`; every other env gets `pendingCount` only (architecture
 * review round-1 #3 — `/health` is the one unauthenticated public route,
 * R-authz-1, and exact schema-change slugs are internal state that shouldn't
 * leak to an unauthenticated caller in prod during a deploy-ordering race).
 * Deliberately the SAME two envs the test suites run under, so local dev and
 * CI both see the full names the panel is built to show.
 */
export const HEALTH_TAG_NAME_ENVS: ReadonlySet<Env["NODE_ENV"]> = new Set(["development", "test"]);

/**
 * Wire-shapes a `MigrationState` for `/api/health`: full pending tag names
 * in `development`/`test`, count-only (empty `pending`, real `pendingCount`)
 * everywhere else. Never affects the boot-time refuse/warn DECISION —
 * `decideBootMigrationAction` always runs against the untouched value
 * `checkMigrationState` returned; this only shapes what an unauthenticated
 * caller sees.
 */
export function shapeMigrationStateForHealth(
  nodeEnv: Env["NODE_ENV"],
  state: MigrationState,
): MigrationState {
  if (HEALTH_TAG_NAME_ENVS.has(nodeEnv)) return state;
  return { ...state, pending: [] };
}
