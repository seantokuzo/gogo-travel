/**
 * Capture domain (contracts spec §3.4; schema spec §3.3.16/§3.4.2).
 * `parser` + `confidence` enums are local to this domain (wire/JSONB only).
 */
import { z } from "zod";
import { BookingCategorySchema, CaptureSourceSchema, ParseStatusSchema } from "../enums.js";
import { CentsSchema, CurrencyCodeSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";
import { BookingDetailsSchema } from "./booking.js";

export const CAPTURE_PARSERS = ["jsonld", "llm"] as const;
export const CaptureParserSchema = z.enum(CAPTURE_PARSERS);
export type CaptureParser = z.infer<typeof CaptureParserSchema>;

export const CAPTURE_CONFIDENCES = ["high", "medium", "low"] as const;
export const CaptureConfidenceSchema = z.enum(CAPTURE_CONFIDENCES);
export type CaptureConfidence = z.infer<typeof CaptureConfidenceSchema>;

/**
 * `capture_inbox.parsed` JSONB (schema spec §3.4.2). `confidence` + `parser`
 * drive routing: JSON-LD or high-confidence LLM → `parsed`; low/medium →
 * `needs_review` (threshold pinned in the capture spec, R-cap-11).
 */
export const ProposedBookingSchema = z
  .object({
    category: BookingCategorySchema,
    title: z.string().optional(),
    details: BookingDetailsSchema,
    price_cents: CentsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    confirmation_code: z.string().optional(),
    /** Trip inferred by date overlap (capture spec stage 4). */
    trip_guess: UuidSchema.optional(),
    confidence: CaptureConfidenceSchema,
    parser: CaptureParserSchema,
  })
  .superRefine((val, ctx) => {
    if (val.details.category !== val.category) {
      ctx.addIssue({
        code: "custom",
        message: `details.category '${val.details.category}' must match proposed category '${val.category}'`,
        path: ["details", "category"],
      });
    }
  });
export type ProposedBooking = z.infer<typeof ProposedBookingSchema>;

/**
 * The `capture_inbox` row — the visible review queue. Capture rows are never
 * deleted as a failure-handling path (R-db-7); "landed" is the reverse
 * `bookings.capture_id` reference, not a status.
 */
export const CaptureItemSchema = z.object({
  id: UuidSchema,
  user_id: UuidSchema,
  /** NULL until inferred/assigned at review. */
  trip_id: UuidSchema.nullable(),
  source: CaptureSourceSchema,
  /** Object-storage key of the raw payload; NULL after purge (R-db-22). */
  raw_ref: z.string().nullable(),
  parse_status: ParseStatusSchema,
  parsed: ProposedBookingSchema.nullable(),
  /** Failure reason, user-visible in the review queue. */
  error: z.string().nullable(),
  parsed_at: ISODateTimeSchema.nullable(),
  created_at: ISODateTimeSchema,
  updated_at: ISODateTimeSchema,
});
export type CaptureItem = z.infer<typeof CaptureItemSchema>;
