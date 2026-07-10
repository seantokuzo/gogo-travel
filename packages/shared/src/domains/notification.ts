/**
 * Notification payloads (contracts spec §3.4; notifications spec §3.3).
 * Discriminated union on the wire-only `NotificationCategory` enum.
 */
import { z } from "zod";
import { ISODateSchema, ISODateTimeSchema, UuidSchema } from "../scalars.js";

const commonFields = {
  /** Template output (R-push-9/10). */
  title: z.string(),
  body: z.string(),
  /** Deep-link registry path (R-push-7). */
  route: z.string(),
  trip_id: UuidSchema.optional(),
} as const;

/** Client maps these scopes → TanStack Query key invalidation (today spec §2.7). */
export const INVALIDATE_SCOPES = ["itinerary", "bookings", "legs", "expenses", "members"] as const;
export const InvalidateScopeSchema = z.enum(INVALIDATE_SCOPES);
export type InvalidateScope = z.infer<typeof InvalidateScopeSchema>;

export const ItineraryChangePayloadSchema = z.object({
  category: z.literal("itinerary_change"),
  ...commonFields,
  invalidate: z.array(InvalidateScopeSchema),
  /** Lets a device suppress self-echo. */
  actor_id: UuidSchema,
});
export type ItineraryChangePayload = z.infer<typeof ItineraryChangePayloadSchema>;

export const DailyDigestPayloadSchema = z.object({
  category: z.literal("daily_digest"),
  ...commonFields,
  day: ISODateSchema,
});
export type DailyDigestPayload = z.infer<typeof DailyDigestPayloadSchema>;

/** LOCAL-ONLY — never crosses the wire; same schema for uniformity (R-notif-3). */
export const LeaveByPayloadSchema = z.object({
  category: z.literal("leave_by"),
  ...commonFields,
  item_id: UuidSchema,
  leave_at: ISODateTimeSchema,
});
export type LeaveByPayload = z.infer<typeof LeaveByPayloadSchema>;

export const DocumentExpiryPayloadSchema = z.object({
  category: z.literal("document_expiry"),
  ...commonFields,
  document_id: UuidSchema,
});
export type DocumentExpiryPayload = z.infer<typeof DocumentExpiryPayloadSchema>;

export const SettleUpPayloadSchema = z.object({
  category: z.literal("settle_up"),
  ...commonFields,
  request_id: UuidSchema,
});
export type SettleUpPayload = z.infer<typeof SettleUpPayloadSchema>;

/** Reserved — deferred to v2 (R-notif-6); common fields only. */
export const FlightStatusPayloadSchema = z.object({
  category: z.literal("flight_status"),
  ...commonFields,
});
export type FlightStatusPayload = z.infer<typeof FlightStatusPayloadSchema>;

export const NotificationPayloadSchema = z.discriminatedUnion("category", [
  ItineraryChangePayloadSchema,
  DailyDigestPayloadSchema,
  LeaveByPayloadSchema,
  DocumentExpiryPayloadSchema,
  SettleUpPayloadSchema,
  FlightStatusPayloadSchema,
]);
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;
