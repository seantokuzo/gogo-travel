/**
 * Itinerary domain (contracts spec §3.4; schema spec §3.3.10/§3.3.11).
 */
import { z } from "zod";
import { ItineraryItemKindSchema, TravelModeSchema } from "../enums.js";
import { ISODateSchema, ISODateTimeSchema, ISOTimeSchema, UuidSchema } from "../scalars.js";

/**
 * Everything on the calendar: booking refs, place visits, custom blocks.
 * `day`/`end_day` are trip-local wall-dates (no tz math); multi-day bookings
 * are ONE spanning row (`end_day` = check-out date — schema spec §3.3.10).
 */
export const ItineraryItemSchema = z
  .object({
    id: UuidSchema,
    trip_id: UuidSchema,
    kind: ItineraryItemKindSchema,
    booking_id: UuidSchema.nullable(),
    place_id: UuidSchema.nullable(),
    /** Required for `custom`; derived from booking/place otherwise. */
    title: z.string().nullable(),
    notes: z.string().nullable(),
    day: ISODateSchema,
    end_day: ISODateSchema.nullable(),
    /** Local wall-time on `day`; null = all-day/unscheduled. */
    start_time: ISOTimeSchema.nullable(),
    end_time: ISOTimeSchema.nullable(),
    /** Order within a day; app assigns gapped values (1024 steps). */
    sort_order: z.int(),
    created_by: UuidSchema,
    created_at: ISODateTimeSchema,
    updated_at: ISODateTimeSchema,
  })
  .superRefine((val, ctx) => {
    // Kind-shape checks (schema spec §3.3.10)
    if (val.kind === "booking" && val.booking_id === null) {
      ctx.addIssue({
        code: "custom",
        message: "kind 'booking' requires booking_id",
        path: ["booking_id"],
      });
    }
    if (val.kind === "place_visit" && val.place_id === null) {
      ctx.addIssue({
        code: "custom",
        message: "kind 'place_visit' requires place_id",
        path: ["place_id"],
      });
    }
    if (val.kind === "custom" && val.title === null) {
      ctx.addIssue({
        code: "custom",
        message: "kind 'custom' requires title",
        path: ["title"],
      });
    }
    if (val.kind !== "booking" && val.booking_id !== null) {
      ctx.addIssue({
        code: "custom",
        message: "booking_id is only allowed when kind is 'booking'",
        path: ["booking_id"],
      });
    }
    if (val.end_day !== null && val.end_day < val.day) {
      ctx.addIssue({
        code: "custom",
        message: "end_day must be on or after day",
        path: ["end_day"],
      });
    }
  });
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;

/**
 * Derived data — precomputed at trip sync for offline ETAs; rebuildable at
 * any time (R-db-15). Transit rows are simply absent when Transitous
 * degrades.
 */
export const TravelLegSchema = z
  .object({
    id: UuidSchema,
    trip_id: UuidSchema,
    from_item_id: UuidSchema,
    to_item_id: UuidSchema,
    mode: TravelModeSchema,
    duration_seconds: z.int().nonnegative(),
    distance_meters: z.int().nonnegative(),
    /** 'mapbox' / 'transitous' — text, not enum (providers are a moving target). */
    provider: z.string(),
    computed_at: ISODateTimeSchema,
    created_at: ISODateTimeSchema,
  })
  .superRefine((val, ctx) => {
    if (val.from_item_id === val.to_item_id) {
      ctx.addIssue({
        code: "custom",
        message: "from_item_id and to_item_id must differ",
        path: ["to_item_id"],
      });
    }
  });
export type TravelLeg = z.infer<typeof TravelLegSchema>;
