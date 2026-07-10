/**
 * Bookings domain (contracts spec §3.4; schema spec §3.3.9/§3.4.1).
 *
 * `BookingDetails` is a discriminated union on `category` — 8 shapes, every
 * field optional by design (an `idea` may know nothing; capture fills what it
 * finds; the UI prompts for gaps). Every shape is FLAT (no nesting beyond one
 * array of flat objects) and free of numeric range constraints because the
 * SAME shapes are reused by `ai/capture-extract.ts` as Claude structured
 * output (contracts spec §3.7) — keep it that way.
 *
 * Local times are ISO-8601 with UTC offset plus an IANA `*_tz` field where a
 * timezone is display-relevant (flights/trains show local time).
 */
import { z } from "zod";
import { BookingCategorySchema, BookingSourceSchema, BookingStatusSchema } from "../enums.js";
import { CentsSchema, CurrencyCodeSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";

const localTime = ISODateTimeSchema.optional();
const optionalString = z.string().optional();
/** Plain int — range rules are server-side refiners when reused for AI (§3.7). */
const optionalInt = z.int().optional();

// ---------------------------------------------------------------------------
// Per-category detail shapes (schema spec §3.4.1)
// ---------------------------------------------------------------------------

const flightFields = {
  airline: optionalString,
  flight_number: optionalString,
  origin_iata: optionalString,
  destination_iata: optionalString,
  departs_at: localTime,
  departs_tz: optionalString,
  arrives_at: localTime,
  arrives_tz: optionalString,
  cabin_class: optionalString,
  seat: optionalString,
  passenger_names: z.array(z.string()).optional(),
  notes: optionalString,
} as const;

/** Same fields minus `segments` — one level, no recursion. */
export const FlightSegmentSchema = z.object(flightFields);
export type FlightSegment = z.infer<typeof FlightSegmentSchema>;

export const FlightDetailsSchema = z.object({
  category: z.literal("flight"),
  ...flightFields,
  segments: z.array(FlightSegmentSchema).optional(),
});
export type FlightDetails = z.infer<typeof FlightDetailsSchema>;

export const LODGING_PROVIDERS = [
  "airbnb",
  "booking",
  "expedia",
  "vrbo",
  "direct",
  "other",
] as const;
export const LodgingProviderSchema = z.enum(LODGING_PROVIDERS);
export type LodgingProvider = z.infer<typeof LodgingProviderSchema>;

export const LodgingDetailsSchema = z.object({
  category: z.literal("lodging"),
  property_name: optionalString,
  address: optionalString,
  check_in: localTime,
  check_out: localTime,
  guests: optionalInt,
  room_type: optionalString,
  provider: LodgingProviderSchema.optional(),
  notes: optionalString,
});
export type LodgingDetails = z.infer<typeof LodgingDetailsSchema>;

export const TrainDetailsSchema = z.object({
  category: z.literal("train"),
  carrier: optionalString,
  train_number: optionalString,
  origin_station: optionalString,
  destination_station: optionalString,
  departs_at: localTime,
  departs_tz: optionalString,
  arrives_at: localTime,
  arrives_tz: optionalString,
  coach: optionalString,
  seat: optionalString,
  notes: optionalString,
});
export type TrainDetails = z.infer<typeof TrainDetailsSchema>;

export const CarRentalDetailsSchema = z.object({
  category: z.literal("car_rental"),
  company: optionalString,
  pickup_location: optionalString,
  dropoff_location: optionalString,
  pickup_at: localTime,
  dropoff_at: localTime,
  vehicle_class: optionalString,
  notes: optionalString,
});
export type CarRentalDetails = z.infer<typeof CarRentalDetailsSchema>;

export const MopedRentalDetailsSchema = z.object({
  category: z.literal("moped_rental"),
  company: optionalString,
  pickup_location: optionalString,
  dropoff_location: optionalString,
  pickup_at: localTime,
  dropoff_at: localTime,
  vehicle_description: optionalString,
  helmet_count: optionalInt,
  notes: optionalString,
});
export type MopedRentalDetails = z.infer<typeof MopedRentalDetailsSchema>;

export const ACTIVITY_PROVIDERS = ["viator", "ticketmaster", "other"] as const;
export const ActivityProviderSchema = z.enum(ACTIVITY_PROVIDERS);
export type ActivityProvider = z.infer<typeof ActivityProviderSchema>;

export const ActivityDetailsSchema = z.object({
  category: z.literal("activity"),
  provider: ActivityProviderSchema.optional(),
  venue_name: optionalString,
  address: optionalString,
  starts_at: localTime,
  ends_at: localTime,
  ticket_count: optionalInt,
  ticket_type: optionalString,
  external_url: optionalString,
  notes: optionalString,
});
export type ActivityDetails = z.infer<typeof ActivityDetailsSchema>;

export const RestaurantDetailsSchema = z.object({
  category: z.literal("restaurant"),
  address: optionalString,
  reserved_at: localTime,
  party_size: optionalInt,
  provider: optionalString,
  notes: optionalString,
});
export type RestaurantDetails = z.infer<typeof RestaurantDetailsSchema>;

export const OtherDetailsSchema = z.object({
  category: z.literal("other"),
  description: optionalString,
  starts_at: localTime,
  ends_at: localTime,
  external_url: optionalString,
  notes: optionalString,
});
export type OtherDetails = z.infer<typeof OtherDetailsSchema>;

/**
 * `bookings.details` — discriminated by `category` (R-db-11). Unknown keys
 * are stripped on parse (R-shared-10).
 */
export const BookingDetailsSchema = z.discriminatedUnion("category", [
  LodgingDetailsSchema,
  FlightDetailsSchema,
  TrainDetailsSchema,
  CarRentalDetailsSchema,
  MopedRentalDetailsSchema,
  ActivityDetailsSchema,
  RestaurantDetailsSchema,
  OtherDetailsSchema,
]);
export type BookingDetails = z.infer<typeof BookingDetailsSchema>;

// ---------------------------------------------------------------------------
// Booking row
// ---------------------------------------------------------------------------

/**
 * The `bookings` row as the API returns it. `starts_at`/`ends_at` (UTC) are
 * denormalized from `details` for sorting; source of truth for display times
 * (incl. local-time semantics) is `details`.
 */
export const BookingSchema = z
  .object({
    id: UuidSchema,
    trip_id: UuidSchema,
    category: BookingCategorySchema,
    status: BookingStatusSchema,
    /** Display name ("UA 837 SFO→NRT", "Park Hyatt Tokyo"). */
    title: z.string(),
    details: BookingDetailsSchema,
    starts_at: ISODateTimeSchema.nullable(),
    ends_at: ISODateTimeSchema.nullable(),
    /** null = unknown (ideas often have no price). */
    price_cents: CentsSchema.nullable(),
    currency: CurrencyCodeSchema.nullable(),
    confirmation_code: z.string().nullable(),
    source: BookingSourceSchema,
    /** "Capture landed" = this reverse reference exists. */
    capture_id: UuidSchema.nullable(),
    place_id: UuidSchema.nullable(),
    created_by: UuidSchema,
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .superRefine((val, ctx) => {
    if (val.details.category !== val.category) {
      ctx.addIssue({
        code: "custom",
        message: `details.category '${val.details.category}' must match booking category '${val.category}'`,
        path: ["details", "category"],
      });
    }
  });
export type Booking = z.infer<typeof BookingSchema>;
