/**
 * Packing lists domain (contracts spec §3.4; schema spec §3.3.21/§3.4.4).
 */
import { z } from "zod";
import { ISODateTimeSchema, UuidSchema } from "../scalars.js";

/**
 * `packing_lists.items[]` entry. `id` is a client-generated stable key
 * (check-off mutations target items without index races — use the shared
 * `IdGenerator` port). `qty` is a plain int here because the shape minus
 * `id`/`checked` is reused by `ai/packing-list.ts` (no numeric range
 * constraints in AI schemas, §3.7).
 */
export const PackingItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: z.string().optional(),
  qty: z.int().optional(),
  checked: z.boolean(),
});
export type PackingItem = z.infer<typeof PackingItemSchema>;

/**
 * One SHARED list per trip in v1 (`user_id` always null — Gate 2); the
 * nullable `user_id` is the seam for later per-member lists. Items live in
 * JSONB; edits are whole-list PATCHes.
 */
export const PackingListSchema = z.object({
  id: UuidSchema,
  trip_id: UuidSchema,
  user_id: UuidSchema.nullable(),
  title: z.string(),
  items: z.array(PackingItemSchema),
  /** Seeded from `/ai/packing-list` then user-edited. */
  ai_generated: z.boolean(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type PackingList = z.infer<typeof PackingListSchema>;
