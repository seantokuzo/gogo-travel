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
import type { EndpointDescriptor } from "../api/descriptor.js";
import { CursorQuerySchema, NoContentSchema, paginatedSchema } from "../api/envelope.js";
import { BookingCategorySchema, BookingSourceSchema, BookingStatusSchema } from "../enums.js";
import {
  CentsSchema,
  CurrencyCodeSchema,
  ISODateSchema,
  ISODateTimeSchema,
  ISOTimeSchema,
  UuidSchema,
  type ISODate,
  type ISODateTime,
  type ISOTime,
} from "../scalars.js";
import { ItineraryItemSchema } from "./itinerary.js";

const localTime = ISODateTimeSchema.optional();
/**
 * Free-text caps — DoS headroom, the T-6.1 convention (`trip.ts`/`place.ts`
 * caps): generous for any real input, bounded so no client-writable string
 * lands unbounded in jsonb. Tiers: name/code-like fields 200 (the trip-name
 * magnitude), notes-like prose 2000, URLs 2048. Arrays are bounded too —
 * flight `segments` ≤ 8 (real multi-leg itineraries top out well under),
 * `passenger_names` ≤ 20 (group-booking headroom). Length caps are string
 * bounds, not the NUMERIC range constraints the AI-reuse rule keeps out of
 * these shapes (R-shared-7 — number ranges stay server-side refiners;
 * `optionalInt` below stays uncapped by design).
 */
const optionalString = z.string().max(200).optional();
const optionalNotes = z.string().max(2000).optional();
const optionalUrl = z.string().max(2048).optional();
const MAX_FLIGHT_SEGMENTS = 8;
const MAX_PASSENGER_NAMES = 20;
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
  passenger_names: z.array(z.string().max(200)).max(MAX_PASSENGER_NAMES).optional(),
  notes: optionalNotes,
} as const;

/** Same fields minus `segments` — one level, no recursion. */
export const FlightSegmentSchema = z.object(flightFields);
export type FlightSegment = z.infer<typeof FlightSegmentSchema>;

export const FlightDetailsSchema = z.object({
  category: z.literal("flight"),
  ...flightFields,
  segments: z.array(FlightSegmentSchema).max(MAX_FLIGHT_SEGMENTS).optional(),
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
  notes: optionalNotes,
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
  notes: optionalNotes,
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
  notes: optionalNotes,
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
  notes: optionalNotes,
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
  external_url: optionalUrl,
  notes: optionalNotes,
});
export type ActivityDetails = z.infer<typeof ActivityDetailsSchema>;

export const RestaurantDetailsSchema = z.object({
  category: z.literal("restaurant"),
  address: optionalString,
  reserved_at: localTime,
  party_size: optionalInt,
  provider: optionalString,
  notes: optionalNotes,
});
export type RestaurantDetails = z.infer<typeof RestaurantDetailsSchema>;

export const OtherDetailsSchema = z.object({
  category: z.literal("other"),
  description: optionalNotes,
  starts_at: localTime,
  ends_at: localTime,
  external_url: optionalUrl,
  notes: optionalNotes,
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

// ---------------------------------------------------------------------------
// §3.3 time model — details → instants → calendar (itinerary-bookings spec).
//
// Pure and platform-agnostic (R-shared-9): server booking writes and client
// optimistic updates run these EXACT functions, defined once alongside the
// booking schemas (§3.3 "all pure, defined once in @gogo/shared alongside the
// booking schemas so server and client agree"). Canonical facts (schema spec
// §3.4.1): detail-shape times are ISO-8601 WITH UTC OFFSET representing
// destination-local wall time; `bookings.starts_at/ends_at` are UTC instants
// denormalized from them; `itinerary_items.day/start_time/end_time` are
// trip-local WALL values — extracted from the local string, no tz math, no
// tz database.
// ---------------------------------------------------------------------------

/**
 * The category's primary start/end detail fields (§3.3 table), as the raw
 * local ISO strings (offset included). `null` = the field is absent — an
 * idea may know nothing (R-ib-4 leaves the instants NULL).
 */
export function bookingPrimaryTimes(details: BookingDetails): {
  start: ISODateTime | null;
  end: ISODateTime | null;
} {
  switch (details.category) {
    case "flight":
    case "train":
      return { start: details.departs_at ?? null, end: details.arrives_at ?? null };
    case "lodging":
      return { start: details.check_in ?? null, end: details.check_out ?? null };
    case "car_rental":
    case "moped_rental":
      return { start: details.pickup_at ?? null, end: details.dropoff_at ?? null };
    case "activity":
    case "other":
      return { start: details.starts_at ?? null, end: details.ends_at ?? null };
    case "restaurant":
      // Primary end: — (§3.3 table); the item's end_time is NULL.
      return { start: details.reserved_at ?? null, end: null };
  }
}

/**
 * Local ISO string (with offset) → the same instant serialized UTC. Inputs
 * come from `ISODateTimeSchema`-validated details, so a parse failure is a
 * corruption signal — folded to `null` (the "unknown" value) rather than a
 * throw, matching R-ib-4's absent-⇒-NULL posture.
 */
export function toUtcInstant(local: ISODateTime): ISODateTime | null {
  const ms = Date.parse(local);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Wall-date component of a local ISO string — offset dropped, no tz math (§3.3). */
export function wallDate(local: ISODateTime): ISODate {
  return local.slice(0, 10);
}

/** Wall-time (`HH:MM`) component of a local ISO string — offset dropped (§3.3). */
export function wallTime(local: ISODateTime): ISOTime {
  return local.slice(11, 16);
}

/**
 * R-ib-4: the denormalized UTC instants for `bookings.starts_at/ends_at`,
 * derived from the category's primary times. Absent primary time ⇒ `null`
 * (each side independently — a booking may know its end but not its start).
 */
export function deriveBookingInstants(details: BookingDetails): {
  starts_at: ISODateTime | null;
  ends_at: ISODateTime | null;
} {
  const { start, end } = bookingPrimaryTimes(details);
  return {
    starts_at: start !== null ? toUtcInstant(start) : null,
    ends_at: end !== null ? toUtcInstant(end) : null,
  };
}

/**
 * One derived auto-item's calendar placement (R-ib-5) — day/times only;
 * `sort_order` placement is the writer's concern (§3.3 midpoint rule needs
 * the day's current items). Not a wire shape — the derivation contract
 * between the booking service and client optimistic updates.
 */
export interface DerivedItemPlacement {
  day: ISODate;
  end_day: ISODate | null;
  start_time: ISOTime | null;
  end_time: ISOTime | null;
}

/**
 * §3.3 auto-item derivation (R-ib-5 "day/times derived per §3.3"):
 *
 *  - Primary start unknown ⇒ `[]` — the booking is timeless; its calendar
 *    presence is user-scheduled (R-ib-8) or absent (I-3).
 *  - `lodging` ⇒ ONE spanning item: `day` = check-in wall-date, `end_day` =
 *    check-out wall-date (§3.6 Branch A — resolved Gate 2).
 *  - `car_rental`/`moped_rental` ⇒ TWO point items (pickup + dropoff); the
 *    dropoff item exists only when `dropoff_at` is set (§3.3 table).
 *  - Everything else ⇒ one item; cross-midnight ends (end wall-date > start
 *    wall-date) set `end_day` = the arrival wall-date (§2 Gate-2 resolution).
 *
 * Note: a same-wall-date pair whose end wall-TIME precedes its start (real
 * for eastward date-line flights) is emitted as-derived — R-ib-17's
 * structural time rule governs DIRECT item writes, not physics-faithful
 * derivation, and neither the DB nor the item wire shape rejects it.
 */
export function deriveAutoItems(details: BookingDetails): DerivedItemPlacement[] {
  const { start, end } = bookingPrimaryTimes(details);
  if (start === null) return [];
  const day = wallDate(start);

  switch (details.category) {
    case "lodging":
      return [
        {
          day,
          end_day: end !== null ? wallDate(end) : null,
          start_time: wallTime(start),
          end_time: end !== null ? wallTime(end) : null,
        },
      ];
    case "car_rental":
    case "moped_rental": {
      const items: DerivedItemPlacement[] = [
        { day, end_day: null, start_time: wallTime(start), end_time: null },
      ];
      if (end !== null) {
        items.push({
          day: wallDate(end),
          end_day: null,
          start_time: wallTime(end),
          end_time: null,
        });
      }
      return items;
    }
    default: {
      const endDay = end !== null ? wallDate(end) : null;
      return [
        {
          day,
          end_day: endDay !== null && endDay > day ? endDay : null,
          start_time: wallTime(start),
          end_time: end !== null ? wallTime(end) : null,
        },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// §3.7 shared additions — request/response shapes (IB-1)
// ---------------------------------------------------------------------------

/**
 * Free-text caps — DoS headroom, the T-6.1 convention: generous for real
 * input, bounded so no write surface accepts megabyte strings.
 */
const BookingTitleSchema = z.string().trim().min(1).max(200);
const ConfirmationCodeSchema = z.string().trim().min(1).max(100);

/**
 * R-ib-11: direct-client `source` values. `email`/`share` are settable ONLY
 * by the capture pipeline's landing service (it calls the booking service
 * directly, not this wire schema) — unrepresentable here.
 */
export const CLIENT_BOOKING_SOURCES = ["manual", "deeplink_return"] as const;
export const ClientBookingSourceSchema = z.enum(CLIENT_BOOKING_SOURCES);
export type ClientBookingSource = z.infer<typeof ClientBookingSourceSchema>;

/** `cancelled` is not creatable (§3.4 POST — terminal states aren't born). */
export const CREATABLE_BOOKING_STATUSES = ["idea", "planned", "booked"] as const;
export const CreatableBookingStatusSchema = z.enum(CREATABLE_BOOKING_STATUSES);
export type CreatableBookingStatus = z.infer<typeof CreatableBookingStatusSchema>;

/**
 * `POST /trips/:tripId/bookings` (§3.4). `details` defaults server-side to
 * the minimal `{ category }` member (every detail field is optional by
 * design); `status` defaults to `'idea'`, `source` to `'manual'`.
 */
export const BookingCreateSchema = z
  .object({
    category: BookingCategorySchema,
    title: BookingTitleSchema,
    details: BookingDetailsSchema.optional(),
    status: CreatableBookingStatusSchema.optional(),
    price_cents: CentsSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    confirmation_code: ConfirmationCodeSchema.optional(),
    place_id: UuidSchema.optional(),
    source: ClientBookingSourceSchema.optional(),
  })
  .superRefine((val, ctx) => {
    // R-ib-1: a details payload whose discriminant mismatches the row
    // category is VALIDATION_FAILED.
    if (val.details !== undefined && val.details.category !== val.category) {
      ctx.addIssue({
        code: "custom",
        message: `details.category '${val.details.category}' must match booking category '${val.category}'`,
        path: ["details", "category"],
      });
    }
    // R-ib-12: a non-null price requires a currency.
    if (val.price_cents !== undefined && val.currency === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "price_cents requires a currency",
        path: ["currency"],
      });
    }
  });
export type BookingCreate = z.infer<typeof BookingCreateSchema>;

/**
 * `PATCH /trips/:tripId/bookings/:bookingId` (§3.4). Whole-value `details`
 * replacement; explicit `null` clears a nullable field. `category` is
 * DECLARED so an attempted change is rejected `VALIDATION_FAILED` (R-ib-2 —
 * default key-stripping would silently ignore it instead). The details
 * discriminant is re-checked against the STORED row category by the service
 * (R-ib-1), as is the merged-row price/currency pairing (R-ib-12) and the
 * §3.2 transition legality (R-ib-3). Concurrency is collab-v1 LWW — no
 * version token (§1; deliberately NOT the trips `expect_updated_at` shape).
 */
export const BookingUpdateSchema = z
  .object({
    category: z.never("category is immutable — delete and recreate (R-ib-2)").optional(),
    title: BookingTitleSchema.optional(),
    details: BookingDetailsSchema.optional(),
    status: BookingStatusSchema.optional(),
    price_cents: CentsSchema.nullable().optional(),
    currency: CurrencyCodeSchema.nullable().optional(),
    confirmation_code: ConfirmationCodeSchema.nullable().optional(),
    place_id: UuidSchema.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    // R-ib-12, body-only arm: setting a price while explicitly clearing the
    // currency can never merge valid. The merged-row check is the service's.
    if (val.price_cents !== undefined && val.price_cents !== null && val.currency === null) {
      ctx.addIssue({
        code: "custom",
        message: "price_cents requires a currency",
        path: ["currency"],
      });
    }
  });
export type BookingUpdate = z.infer<typeof BookingUpdateSchema>;

/**
 * `Booking` + its calendar presence (possibly empty) — GET detail and every
 * mutation's post-state (R-ib-18). `safeExtend` inherits the base schema's
 * category↔details refinement.
 */
export const BookingWithItemsSchema = BookingSchema.safeExtend({
  items: z.array(ItineraryItemSchema),
});
export type BookingWithItems = z.infer<typeof BookingWithItemsSchema>;

/**
 * `POST /trips/:tripId/bookings/:bookingId/schedule` body (R-ib-8) — place a
 * TIMELESS booking onto a day. `after_item_id` positions within the day
 * (default: append). The single-day structural time rule (R-ib-17) applies.
 */
export const ScheduleBookingInputSchema = z
  .object({
    day: ISODateSchema,
    start_time: ISOTimeSchema.optional(),
    end_time: ISOTimeSchema.optional(),
    after_item_id: UuidSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (
      val.start_time !== undefined &&
      val.end_time !== undefined &&
      val.end_time < val.start_time
    ) {
      ctx.addIssue({
        code: "custom",
        message: "end_time must be on or after start_time",
        path: ["end_time"],
      });
    }
  });
export type ScheduleBookingInput = z.infer<typeof ScheduleBookingInputSchema>;

/**
 * `GET /trips/:tripId/bookings` query (§3.4): `status` is REPEATABLE (Hono
 * hands a repeated key over as an array, a single one as a string — both
 * normalize to an array here); default (absent) = all except `cancelled`
 * (R-ib-10 exclusion rule included). `unscheduled` arrives as a query string
 * (`stringbool`). `limit` is coerced and server-capped — the bounds here ARE
 * the cap (trips convention).
 */
export const BookingListQuerySchema = CursorQuerySchema.extend({
  status: z
    .union([BookingStatusSchema, z.array(BookingStatusSchema)])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  category: BookingCategorySchema.optional(),
  unscheduled: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type BookingListQuery = z.infer<typeof BookingListQuerySchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (§3.4; contracts spec §3.6)
// ---------------------------------------------------------------------------

const tripIdParams = z.object({ tripId: UuidSchema });
const bookingParams = z.object({ tripId: UuidSchema, bookingId: UuidSchema });

/**
 * Machine-readable mirror of the bookings routes (IB-1). All run behind
 * `requireAuth` + the trip-membership gate — a non-member's 404 is
 * indistinguishable from an absent trip (R-ib-24, F-038 posture). Reads are
 * any-role; writes are editor/owner (viewer → 403, server-enforced).
 * Itinerary-router descriptors land with IB-2 in `domains/itinerary.ts`.
 */
export const bookingEndpoints = {
  /** R-ib-10 filters; ordered `starts_at ASC NULLS LAST, updated_at DESC`. */
  listBookings: {
    method: "GET",
    path: "/trips/:tripId/bookings",
    params: tripIdParams,
    query: BookingListQuerySchema,
    response: paginatedSchema(BookingSchema),
  },
  /** Side effects per §3.1: instants derived, auto-items when I-2 applies. */
  createBooking: {
    method: "POST",
    path: "/trips/:tripId/bookings",
    params: tripIdParams,
    body: BookingCreateSchema,
    response: BookingSchema,
  },
  /** Detail + calendar presence (possibly empty). */
  getBooking: {
    method: "GET",
    path: "/trips/:tripId/bookings/:bookingId",
    params: bookingParams,
    response: BookingWithItemsSchema,
  },
  /** §3.2 transitions with their item side effects; post-state (R-ib-18). */
  updateBooking: {
    method: "PATCH",
    path: "/trips/:tripId/bookings/:bookingId",
    params: bookingParams,
    body: BookingUpdateSchema,
    response: BookingWithItemsSchema,
  },
  /** Hard delete; items cascade, expense links SET NULL (schema §3.6). 204. */
  deleteBooking: {
    method: "DELETE",
    path: "/trips/:tripId/bookings/:bookingId",
    params: bookingParams,
    response: NoContentSchema,
  },
  /** R-ib-8: schedule a timeless booking; advances `idea → planned`. 201. */
  scheduleBooking: {
    method: "POST",
    path: "/trips/:tripId/bookings/:bookingId/schedule",
    params: bookingParams,
    body: ScheduleBookingInputSchema,
    response: BookingWithItemsSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
