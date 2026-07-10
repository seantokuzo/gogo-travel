/**
 * Expense-estimate structured output (contracts spec §3.7; money spec §3.2
 * A1). Per-`expense_category` low/high ranges in integer cents — bases are
 * per-person so duration/party never join the cache key (R-db-10).
 *
 * NO numeric range constraints here (§3.7 rule 2) — `refineExpenseEstimate`
 * enforces them server-side after parse. Omitted categories mean "can't
 * estimate" (permission to not know) — they are never invented.
 */
import { z } from "zod";
import { ExpenseCategorySchema } from "../enums.js";
import { AiRefinementError } from "./refinement.js";

/** Bump on ANY shape change (R-shared-8) — feeds `deriveAiCacheKey`. */
export const SCHEMA_VERSION = 1;

export const ESTIMATE_BASES = [
  "per_person_per_day",
  "per_person_per_night",
  "per_person_total",
] as const;
export const EstimateBasisSchema = z.enum(ESTIMATE_BASES);
export type EstimateBasis = z.infer<typeof EstimateBasisSchema>;

export const ExpenseEstimateItemSchema = z.object({
  category: ExpenseCategorySchema,
  basis: EstimateBasisSchema,
  /** USD integer cents, per basis. Ranges validated by the refiner, not here. */
  low_cents: z.int(),
  high_cents: z.int(),
});
export type ExpenseEstimateItem = z.infer<typeof ExpenseEstimateItemSchema>;

export const ExpenseEstimateOutputSchema = z.object({
  estimates: z.array(ExpenseEstimateItemSchema),
});
export type ExpenseEstimateOutput = z.infer<typeof ExpenseEstimateOutputSchema>;

/**
 * Paired server-side refiner: rejects negative lows, `low > high`, and
 * duplicate categories (throws `AiRefinementError` → pipeline treats as
 * parse failure; nothing cached, no budget write — money spec tests).
 */
export function refineExpenseEstimate(output: ExpenseEstimateOutput): ExpenseEstimateOutput {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const item of output.estimates) {
    if (seen.has(item.category)) issues.push(`duplicate category '${item.category}'`);
    seen.add(item.category);
    if (item.low_cents < 0) issues.push(`${item.category}: low_cents < 0`);
    if (item.high_cents < item.low_cents) issues.push(`${item.category}: high_cents < low_cents`);
  }
  if (issues.length > 0) throw new AiRefinementError(issues);
  return output;
}
