/**
 * Tour-guide bundle (contracts spec §3.7; schema spec §3.4.3; ai spec §3.9).
 * Also the `tour_guide_bundles.content` JSONB shape.
 *
 * Cite-or-retract anti-hallucination pattern: every fact carries a
 * `source_ref` into `sources[]`; the refiner DROPS facts whose ref doesn't
 * resolve. Evergreen narrative only — volatile facts (hours, prices) have no
 * fields by design.
 */
import { z } from "zod";
import { AiRefinementError } from "./refinement.js";

/** Bump on ANY shape change (R-shared-8) — feeds `deriveAiCacheKey`. */
export const SCHEMA_VERSION = 1;

export const TOUR_GUIDE_SOURCE_KINDS = ["wikipedia", "wikivoyage", "spine"] as const;
export const TourGuideSourceKindSchema = z.enum(TOUR_GUIDE_SOURCE_KINDS);
export type TourGuideSourceKind = z.infer<typeof TourGuideSourceKindSchema>;

export const TourGuideSourceSchema = z.object({
  id: z.string(),
  kind: TourGuideSourceKindSchema,
  ref: z.string(),
});
export type TourGuideSource = z.infer<typeof TourGuideSourceSchema>;

export const TourGuideBundleSchema = z.object({
  place_name: z.string(),
  summary: z.string(),
  sections: z.array(z.object({ title: z.string(), body: z.string() })),
  facts: z.array(z.object({ text: z.string(), source_ref: z.string() })),
  sources: z.array(TourGuideSourceSchema),
});
export type TourGuideBundle = z.infer<typeof TourGuideBundleSchema>;

/**
 * Paired server-side refiner: cite-or-retract — facts whose `source_ref`
 * doesn't resolve into `sources[].id` are DROPPED (never fail the bundle; a
 * thin, honest bundle beats an invented one). Throws only when the bundle
 * has no resolvable identity at all (empty place_name).
 */
export function refineTourGuideBundle(bundle: TourGuideBundle): TourGuideBundle {
  if (bundle.place_name.trim().length === 0) {
    throw new AiRefinementError(["place_name is empty"]);
  }
  const sourceIds = new Set(bundle.sources.map((s) => s.id));
  return {
    ...bundle,
    facts: bundle.facts.filter((fact) => sourceIds.has(fact.source_ref)),
  };
}
