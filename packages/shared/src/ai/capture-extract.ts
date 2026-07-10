/**
 * Capture LLM-fallback extraction schema (contracts spec §3.7; capture spec
 * §3.2 stage 2). Reuses the `BookingDetails` shapes — which is WHY those
 * stay flat and range-free.
 *
 * The model produces this subset of `ProposedBooking`; the pipeline adds
 * `parser: 'llm'` and `trip_guess` (date-overlap inference) after refine.
 * Cross-field and numeric rules live in `refineCaptureExtraction` (§3.7
 * rule 2) — NOT in the schema.
 */
import { z } from "zod";
import { BookingCategorySchema } from "../enums.js";
import { CurrencyCodeSchema } from "../scalars.js";
import { BookingDetailsSchema, type BookingDetails } from "../domains/booking.js";
import { CaptureConfidenceSchema } from "../domains/capture.js";
import { AiRefinementError } from "./refinement.js";

/** Bump on ANY shape change (R-shared-8). Never cached (per-email). */
export const SCHEMA_VERSION = 1;

export const CaptureExtractionSchema = z.object({
  category: BookingCategorySchema,
  title: z.string().optional(),
  details: BookingDetailsSchema,
  /** Plain int — non-negativity is the refiner's (§3.7 rule 2). */
  price_cents: z.int().optional(),
  currency: CurrencyCodeSchema.optional(),
  confirmation_code: z.string().optional(),
  /** Self-assessed; drives routing with the R-cap-11 threshold. */
  confidence: CaptureConfidenceSchema,
});
export type CaptureExtraction = z.infer<typeof CaptureExtractionSchema>;

/**
 * Minimal structural declaration of the WHATWG `URL` global: the package
 * builds against `lib: ["ES2023"]` with no platform type packages
 * (R-shared-9), which has no `URL` type. Runtime coverage is a non-issue —
 * paired refiners run server-side (Node ships `URL` as a global), and every
 * browser/RN-with-polyfill environment has it too.
 */
declare const URL: new (input: string) => { protocol: string };

/**
 * `external_url` sanitizer: the LLM runs over ATTACKER-CONTROLLED email/share
 * input and the field ends up as a tappable link in the mobile UI
 * (`Linking.openURL`), so the refiner DROPS it — sanitize-not-throw, matching
 * the `refineRecommendations` drop precedent — unless it parses as a URL with
 * an `http:`/`https:` scheme. `javascript:`/`file:`/app-deeplink schemes and
 * unparseable garbage never survive.
 */
function sanitizeExternalUrl(details: BookingDetails): BookingDetails {
  if (!("external_url" in details) || details.external_url === undefined) return details;
  try {
    const { protocol } = new URL(details.external_url);
    if (protocol === "http:" || protocol === "https:") return details;
  } catch {
    // unparseable → drop below
  }
  const { external_url: _dropped, ...rest } = details;
  return rest;
}

/**
 * Paired server-side refiner: `details.category` must match `category`
 * (cross-field), `price_cents ≥ 0` (numeric). Violations throw
 * `AiRefinementError` → the pipeline retries once, then routes the capture
 * to `needs_review`/`failed` (R-cap-14) — never silent. Additionally,
 * non-http(s) `details.external_url` is dropped (sanitized, not thrown —
 * see `sanitizeExternalUrl`).
 */
export function refineCaptureExtraction(output: CaptureExtraction): CaptureExtraction {
  const issues: string[] = [];
  if (output.details.category !== output.category) {
    issues.push(
      `details.category '${output.details.category}' does not match category '${output.category}'`,
    );
  }
  if (output.price_cents !== undefined && output.price_cents < 0) {
    issues.push("price_cents < 0");
  }
  if (issues.length > 0) throw new AiRefinementError(issues);
  const details = sanitizeExternalUrl(output.details);
  return details === output.details ? output : { ...output, details };
}
