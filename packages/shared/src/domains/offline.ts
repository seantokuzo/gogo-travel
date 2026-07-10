/**
 * Offline mutation queue entry (contracts spec §3.4 `offline.ts`).
 * Enqueue/drain/conflict semantics are the today spec's (§2.7); entries
 * replay through the standard descriptor-addressed `ApiClient` (§3.6) —
 * `descriptor_key` matches `descriptorKey()` in `api/descriptor.ts`.
 */
import { z } from "zod";
import { ISODateTimeSchema, UuidSchema } from "../scalars.js";

export const OFFLINE_MUTATION_STATUSES = ["pending", "failed"] as const;
export const OfflineMutationStatusSchema = z.enum(OFFLINE_MUTATION_STATUSES);
export type OfflineMutationStatus = z.infer<typeof OfflineMutationStatusSchema>;

export const OfflineMutationSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  descriptor_key: z.string().min(1),
  /** Path params for the descriptor. */
  params: z.record(z.string(), z.unknown()),
  /** Request body. */
  payload: z.record(z.string(), z.unknown()),
  queued_at: ISODateTimeSchema,
  attempts: z.int().nonnegative(),
  status: OfflineMutationStatusSchema,
});
export type OfflineMutation = z.infer<typeof OfflineMutationSchema>;
