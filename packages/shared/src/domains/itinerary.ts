/**
 * Itinerary domain (contracts spec §3.4; schema spec §3.3.10/§3.3.11;
 * itinerary-bookings spec §3.4/§3.7 — IB-2 request/response shapes and
 * endpoint descriptors live here; the §3.3 time-derivation helpers live in
 * `domains/booking.ts` beside the detail shapes they derive from).
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { NoContentSchema } from "../api/envelope.js";
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

// ---------------------------------------------------------------------------
// §3.7 shared additions — request/response shapes (IB-2)
// ---------------------------------------------------------------------------

/**
 * Free-text caps — DoS headroom, the T-6.1 convention (`booking.ts` tiers):
 * name-like 200, notes-like prose 2000. Bounds are string lengths only —
 * these shapes are not AI-reused, but the convention holds everywhere a
 * client-writable string lands in a row.
 */
const ItemTitleSchema = z.string().trim().min(1).max(200);
const ItemNotesSchema = z.string().max(2000);

/**
 * R-ib-14: kinds a client may create directly. `booking`-kind items exist
 * only via the booking service (R-ib-5/R-ib-8) — unrepresentable here, so a
 * `kind: 'booking'` body fails validation (the §3.4 400 arm).
 */
export const CREATABLE_ITEM_KINDS = ["place_visit", "custom"] as const;
export const CreatableItemKindSchema = z.enum(CREATABLE_ITEM_KINDS);
export type CreatableItemKind = z.infer<typeof CreatableItemKindSchema>;

/**
 * The R-ib-17 structural time rule, shared by create (body-complete) and the
 * service's merged-row update check: on a SINGLE-day item with both times
 * set, `end_time ≥ start_time`. Multi-day spans are exempt (the end time is
 * on a later wall-date). Overlaps with other items are always legal.
 */
export function violatesSingleDayTimeOrder(item: {
  day: string;
  end_day?: string | null | undefined;
  start_time?: string | null | undefined;
  end_time?: string | null | undefined;
}): boolean {
  const singleDay =
    item.end_day === undefined || item.end_day === null || item.end_day === item.day;
  return (
    singleDay &&
    item.start_time !== undefined &&
    item.start_time !== null &&
    item.end_time !== undefined &&
    item.end_time !== null &&
    item.end_time < item.start_time
  );
}

/**
 * `POST /trips/:tripId/itinerary/items` (§3.4, R-ib-14/15/17):
 *
 *  - `place_visit` requires `place_id`; `custom` requires `title`.
 *  - `title` is `custom`-only (mirrors the PATCH field rule — a place_visit's
 *    display title derives from its place); `place_id` is additionally
 *    allowed on `custom` (R-ib-20 resolves any item's location via its
 *    `place_id`; the server's visibility gate applies to both kinds).
 *  - Structural time rules per R-ib-17: `end_day ≥ day`; single-day items
 *    with both times need `end_time ≥ start_time`. Overlaps are legal.
 *  - `after_item_id` positions within the day (default: append with a +1024
 *    gap, R-ib-15).
 */
export const ItineraryItemCreateSchema = z
  .object({
    kind: CreatableItemKindSchema,
    place_id: UuidSchema.optional(),
    title: ItemTitleSchema.optional(),
    notes: ItemNotesSchema.optional(),
    day: ISODateSchema,
    end_day: ISODateSchema.optional(),
    start_time: ISOTimeSchema.optional(),
    end_time: ISOTimeSchema.optional(),
    after_item_id: UuidSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.kind === "place_visit" && val.place_id === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "kind 'place_visit' requires place_id",
        path: ["place_id"],
      });
    }
    if (val.kind === "place_visit" && val.title !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "title is only writable on 'custom' items",
        path: ["title"],
      });
    }
    if (val.kind === "custom" && val.title === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "kind 'custom' requires title",
        path: ["title"],
      });
    }
    if (val.end_day !== undefined && val.end_day < val.day) {
      ctx.addIssue({
        code: "custom",
        message: "end_day must be on or after day",
        path: ["end_day"],
      });
    }
    if (violatesSingleDayTimeOrder(val)) {
      ctx.addIssue({
        code: "custom",
        message: "end_time must be on or after start_time on a single-day item",
        path: ["end_time"],
      });
    }
  });
export type ItineraryItemCreate = z.infer<typeof ItineraryItemCreateSchema>;

/**
 * `PATCH /trips/:tripId/itinerary/items/:itemId` (§3.4, R-ib-16/17/18).
 * Field legality against the STORED row is the service's: `title` is
 * `custom`-only, `place_id` is `place_visit`-only (spec §3.4 PATCH), and
 * `day`/`end_day`/`start_time`/`end_time` on a `booking`-kind item are
 * accepted only while the parent booking's `starts_at` IS NULL (R-ib-16 —
 * `notes`/`sort_order` are always editable). Explicit `null` clears a
 * nullable field; `title`/`place_id` are non-nullable (clearing either would
 * break the row's kind-shape CHECK). Merged-row structural checks (end_day ≥
 * day; the single-day time rule) are the service's too. Concurrency is
 * collab-v1 LWW — no version token (§1).
 */
export const ItineraryItemUpdateSchema = z
  .object({
    title: ItemTitleSchema.optional(),
    notes: ItemNotesSchema.nullable().optional(),
    place_id: UuidSchema.optional(),
    day: ISODateSchema.optional(),
    end_day: ISODateSchema.nullable().optional(),
    start_time: ISOTimeSchema.nullable().optional(),
    end_time: ISOTimeSchema.nullable().optional(),
    sort_order: z.int().optional(),
  })
  .superRefine((val, ctx) => {
    // Body-internal arm only: both sides present in ONE body can never merge
    // valid. The merged-row check against stored values is the service's.
    if (
      val.day !== undefined &&
      val.end_day !== undefined &&
      val.end_day !== null &&
      val.end_day < val.day
    ) {
      ctx.addIssue({
        code: "custom",
        message: "end_day must be on or after day",
        path: ["end_day"],
      });
    }
  });
export type ItineraryItemUpdate = z.infer<typeof ItineraryItemUpdateSchema>;

/**
 * Bound on one day's reorder payload — far above any real day, small enough
 * that the atomic reassign transaction stays cheap (DoS posture, the T-6.1
 * bounded-array convention).
 */
export const DAY_ORDER_MAX_ITEMS = 500;

/**
 * `PUT /trips/:tripId/itinerary/days/:day/order` body (R-ib-15): the day's
 * FULL intended order. Ids that no longer exist are ignored (LWW); ids from
 * another trip are rejected; a duplicate id makes the "full intended order"
 * self-contradictory — malformed by construction, rejected here.
 */
export const DayOrderInputSchema = z
  .object({
    item_ids: z.array(UuidSchema).max(DAY_ORDER_MAX_ITEMS),
  })
  .superRefine((val, ctx) => {
    if (new Set(val.item_ids).size !== val.item_ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "item_ids must not contain duplicates",
        path: ["item_ids"],
      });
    }
  });
export type DayOrderInput = z.infer<typeof DayOrderInputSchema>;

/** Reorder post-state (R-ib-18): the day's resulting ordered items. */
export const DayOrderResultSchema = z.object({
  items: z.array(ItineraryItemSchema),
});
export type DayOrderResult = z.infer<typeof DayOrderResultSchema>;

/**
 * `GET /trips/:tripId/itinerary` query (§3.4): optional range bounds. An
 * absent side falls back to the server's default range (trip dates unioned
 * with the min→max of existing item days). `to < from` is the documented
 * 400 (checked here when both are present).
 */
export const ItineraryRangeQuerySchema = z
  .object({
    from: ISODateSchema.optional(),
    to: ISODateSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.from !== undefined && val.to !== undefined && val.to < val.from) {
      ctx.addIssue({
        code: "custom",
        message: "to must be on or after from",
        path: ["to"],
      });
    }
  });
export type ItineraryRangeQuery = z.infer<typeof ItineraryRangeQuerySchema>;

/**
 * The one-shot calendar read (R-ib-13): items ordered `(day, sort_order)`
 * plus the legs whose endpoints are both in range — mutually consistent in
 * one response, deliberately NOT `Paginated<T>` (bounded by trip length).
 */
export const ItineraryReadSchema = z.object({
  items: z.array(ItineraryItemSchema),
  legs: z.array(TravelLegSchema),
});
export type ItineraryRead = z.infer<typeof ItineraryReadSchema>;

// ---------------------------------------------------------------------------
// Endpoint descriptors (§3.4; contracts spec §3.6)
// ---------------------------------------------------------------------------

const tripIdParams = z.object({ tripId: UuidSchema });
const itemParams = z.object({ tripId: UuidSchema, itemId: UuidSchema });
const dayOrderParams = z.object({ tripId: UuidSchema, day: ISODateSchema });

/**
 * Machine-readable mirror of the itinerary routes (IB-2). All run behind
 * `requireAuth` + the trip-membership gate — a non-member's 404 is
 * indistinguishable from an absent trip (R-ib-24, F-038 posture). Reads are
 * any-role; writes are editor/owner (viewer → 403, server-enforced). The
 * `refresh-legs` descriptor lands with IB-3 (its endpoint).
 */
export const itineraryEndpoints = {
  /** R-ib-13 composite read; range default per §3.4. */
  getItinerary: {
    method: "GET",
    path: "/trips/:tripId/itinerary",
    params: tripIdParams,
    query: ItineraryRangeQuerySchema,
    response: ItineraryReadSchema,
  },
  /** R-ib-14/15/17; side effect: legs dirty for the item's day(s). 201. */
  createItineraryItem: {
    method: "POST",
    path: "/trips/:tripId/itinerary/items",
    params: tripIdParams,
    body: ItineraryItemCreateSchema,
    response: ItineraryItemSchema,
  },
  /** R-ib-16 field protection; post-state (R-ib-18). */
  updateItineraryItem: {
    method: "PATCH",
    path: "/trips/:tripId/itinerary/items/:itemId",
    params: itemParams,
    body: ItineraryItemUpdateSchema,
    response: ItineraryItemSchema,
  },
  /** R-ib-9 unschedule semantics for `booking`-kind. 204. */
  deleteItineraryItem: {
    method: "DELETE",
    path: "/trips/:tripId/itinerary/items/:itemId",
    params: itemParams,
    response: NoContentSchema,
  },
  /** R-ib-15 atomic reassign; LWW tolerance; cross-day pull rules (R-ib-16). */
  putDayOrder: {
    method: "PUT",
    path: "/trips/:tripId/itinerary/days/:day/order",
    params: dayOrderParams,
    body: DayOrderInputSchema,
    response: DayOrderResultSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
