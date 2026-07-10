/**
 * Recommendations structured output (contracts spec §3.7; ai spec §3.8.1).
 *
 * Grounding contract IN the schema shape: items reference provided
 * `place_id`s from our spine (the prompt's candidate list) — inventing
 * venues is unrepresentable; the paired refiner drops any id outside the
 * candidate set (cite-or-retract, mechanically enforced).
 */
import { z } from "zod";

/** Bump on ANY shape change (R-shared-8) — feeds `deriveAiCacheKey`. */
export const SCHEMA_VERSION = 1;

export const RecommendationItemSchema = z.object({
  /** MUST be one of the prompt's candidate place ids — refiner-enforced. */
  place_id: z.uuid(),
  category: z.string(),
  /** LLM annotation. */
  pitch: z.string(),
  fit_reasons: z.array(z.string()),
});
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;

/** Ranked. */
export const RecommendationsOutputSchema = z.object({
  items: z.array(RecommendationItemSchema),
});
export type RecommendationsOutput = z.infer<typeof RecommendationsOutputSchema>;

/**
 * Paired server-side refiner (§3.7 rule 2/4): drops items whose `place_id`
 * is not in the prompt's candidate set, and duplicate place ids (first
 * occurrence wins — output is ranked).
 */
export function refineRecommendations(
  output: RecommendationsOutput,
  candidatePlaceIds: ReadonlySet<string>,
): RecommendationsOutput {
  const seen = new Set<string>();
  const items = output.items.filter((item) => {
    if (!candidatePlaceIds.has(item.place_id) || seen.has(item.place_id)) return false;
    seen.add(item.place_id);
    return true;
  });
  return { items };
}

