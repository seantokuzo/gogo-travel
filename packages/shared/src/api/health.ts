/**
 * `/api/health` response shape (B-28, migration-state check).
 *
 * The landmine this closes: a stale local DB (behind on migrations) booted
 * clean, served requests, and CI stayed green (CI always migrates fresh) —
 * the only symptom was 500s on the routes that touched the missing schema.
 * `migrations` gives any client a boot-time snapshot of on-disk vs applied
 * migrations so drift is visible instead of silent.
 */
import { z } from "zod";

/**
 * on-disk migration count vs the count actually applied to the connected
 * database.
 *
 * `pending` names each on-disk migration tag not yet applied, in journal
 * order (oldest first) — but ONLY in `development`/`test`
 * (`apps/server/src/boot-migration-check.ts`'s `HEALTH_TAG_NAME_ENVS`).
 * Every OTHER `NODE_ENV` echoes an EMPTY array here even when migrations
 * ARE pending: `/api/health` is the one unauthenticated public route
 * (R-authz-1), and exact schema-change slugs are internal state a prod
 * deploy shouldn't hand to anyone on the internet during a deploy-ordering
 * race (architecture review round-1 #3). `pendingCount` is the trustworthy
 * count in EVERY env — read it instead of `pending.length` when you can't
 * assume dev/test.
 */
export const MigrationStateSchema = z.object({
  onDisk: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  pending: z.array(z.string()),
  pendingCount: z.number().int().nonnegative(),
  /** ISO-8601 timestamp of when this snapshot was computed (R-shared-11) — a
   * boot-time value refreshed lazily on `/health` at most once per TTL
   * (`apps/server/src/app.ts`), never a live per-request re-check. */
  checkedAt: z.string().datetime(),
});
export type MigrationState = z.infer<typeof MigrationStateSchema>;

/**
 * `migrations` is OPTIONAL: an older server (pre-B-28) omits it entirely,
 * and a client must treat that absence as a distinct "unknown" state — never
 * conflate it with "current" (R-shared-1: the schema is the single source of
 * truth for this distinction, not a client-side convention).
 */
export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  migrations: MigrationStateSchema.optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
