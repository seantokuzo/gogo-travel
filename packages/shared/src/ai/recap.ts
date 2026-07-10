/**
 * Trip recap (contracts spec §3.7; schema spec §3.4.8; ai spec §3.10).
 *
 * `Recap` is the full `recaps.content` JSONB / wire shape. Stats, trace, and
 * highlight ids are SERVER-COMPUTED, never LLM output — the model generates
 * `narrative_sections` only (`RecapNarrativeOutputSchema`), grounded on the
 * computed facts (R-ai-30). `highlight_photo_ids` are filtered through
 * `canViewPhoto` per viewer at render time (Law #3).
 *
 * Both schemas stay within §3.7 constraints (no numeric ranges — the paired
 * refiner owns them) so the constraint walker can verify everything here.
 */
import { z } from "zod";
import { CurrencyCodeSchema, ISODateSchema } from "../scalars.js";
import { AiRefinementError } from "./refinement.js";

/** Bump on ANY shape change (R-shared-8). */
export const SCHEMA_VERSION = 1;

export const RecapNarrativeSectionSchema = z.object({
  title: z.string(),
  body: z.string(),
});
export type RecapNarrativeSection = z.infer<typeof RecapNarrativeSectionSchema>;

/** What the LLM produces (batch, Sonnet, CoVe pass) — narrative only. */
export const RecapNarrativeOutputSchema = z.object({
  narrative_sections: z.array(RecapNarrativeSectionSchema),
});
export type RecapNarrativeOutput = z.infer<typeof RecapNarrativeOutputSchema>;

export const RecapStatsSchema = z.object({
  days: z.int(),
  places_count: z.int(),
  distance_meters: z.int(),
  /** Integer cents (Law #2); matches the expenses rollup exactly. */
  spend_total_cents: z.int(),
  currency: CurrencyCodeSchema,
  photos_count: z.int(),
});
export type RecapStats = z.infer<typeof RecapStatsSchema>;

export const RecapTracePointSchema = z.object({
  place_id: z.uuid(),
  lat: z.number(),
  lng: z.number(),
  day: ISODateSchema,
});
export type RecapTracePoint = z.infer<typeof RecapTracePointSchema>;

/** The full `recaps.content` shape. */
export const RecapSchema = z.object({
  narrative_sections: z.array(RecapNarrativeSectionSchema),
  stats: RecapStatsSchema,
  highlight_photo_ids: z.array(z.uuid()),
  trace: z.array(RecapTracePointSchema),
});
export type Recap = z.infer<typeof RecapSchema>;

/**
 * Paired server-side refiner for the assembled recap: non-negative stats,
 * coordinate ranges on trace points. Throws `AiRefinementError` — an
 * ill-formed recap is a pipeline bug (stats are server-computed), never
 * something to silently clamp.
 */
export function refineRecap(recap: Recap): Recap {
  const issues: string[] = [];
  const stats: Array<[string, number]> = [
    ["days", recap.stats.days],
    ["places_count", recap.stats.places_count],
    ["distance_meters", recap.stats.distance_meters],
    ["spend_total_cents", recap.stats.spend_total_cents],
    ["photos_count", recap.stats.photos_count],
  ];
  for (const [label, value] of stats) {
    if (value < 0) issues.push(`stats.${label} < 0`);
  }
  recap.trace.forEach((point, i) => {
    if (point.lat < -90 || point.lat > 90) issues.push(`trace[${i}].lat out of range`);
    if (point.lng < -180 || point.lng > 180) issues.push(`trace[${i}].lng out of range`);
  });
  if (issues.length > 0) throw new AiRefinementError(issues);
  return recap;
}
