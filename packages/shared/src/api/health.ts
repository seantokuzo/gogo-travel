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
 * database. `pending` names each on-disk migration tag not yet applied, in
 * journal order (oldest first) — never a bare count, so a human (or the
 * mobile diagnostics panel) can act on it directly.
 */
export const MigrationStateSchema = z.object({
  onDisk: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  pending: z.array(z.string()),
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
