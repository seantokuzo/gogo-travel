/**
 * Packing-list structured output (contracts spec §3.7; ai spec §3.8.3).
 *
 * Output is `PackingItem` minus `checked` and minus `id`: `checked` is
 * always false on generation, and stable ids are SERVER-generated after
 * parse (ai spec §3.8.3) — the model never invents ids. Live/uncached
 * (Gate 2, H2), so `SCHEMA_VERSION` exists for the R-shared-8 convention
 * even though no `ai_cache` row carries it today.
 */
import { z } from "zod";
import { PackingItemSchema } from "../domains/packing.js";

/** Bump on ANY shape change (R-shared-8). */
export const SCHEMA_VERSION = 1;

export const AiPackingItemSchema = PackingItemSchema.omit({ id: true, checked: true });
export type AiPackingItem = z.infer<typeof AiPackingItemSchema>;

export const PackingListOutputSchema = z.object({
  items: z.array(AiPackingItemSchema),
});
export type PackingListOutput = z.infer<typeof PackingListOutputSchema>;

/**
 * Paired server-side refiner: drops items with blank labels; drops
 * non-positive quantities (qty is a plain int in the schema — §3.7 rule 2);
 * dedupes case-insensitively on label (first wins).
 */
export function refinePackingList(output: PackingListOutput): PackingListOutput {
  const seen = new Set<string>();
  const items: AiPackingItem[] = [];
  for (const item of output.items) {
    const label = item.label.trim();
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cleaned: AiPackingItem = { ...item, label };
    if (cleaned.qty !== undefined && cleaned.qty < 1) delete cleaned.qty;
    items.push(cleaned);
  }
  return { items };
}
