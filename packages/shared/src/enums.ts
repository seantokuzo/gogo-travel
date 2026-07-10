/**
 * Canonical enum tuples — single source of truth (R-shared-2).
 *
 * Value lists are canonical in `.specs/database/schema.spec.md` §3.2; the
 * tuples live HERE and `apps/server` builds its Drizzle `pgEnum`s from these
 * same tuples. Tuples are append-only (Postgres constraint; keeps old
 * clients parsing).
 *
 * Wire-only enums (no DB column): `NOTIFICATION_CATEGORIES`, `TRAVEL_STYLES`
 * — same pattern minus the pgEnum mirror.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// pgEnum-mirrored tuples (schema spec §3.2)
// ---------------------------------------------------------------------------

export const PLACE_SOURCES = ["overture", "fsq_os", "custom"] as const;
export const PlaceSourceSchema = z.enum(PLACE_SOURCES);
export type PlaceSource = z.infer<typeof PlaceSourceSchema>;

export const TRIP_STATUSES = ["planning", "active", "past"] as const;
export const TripStatusSchema = z.enum(TRIP_STATUSES);
export type TripStatus = z.infer<typeof TripStatusSchema>;

export const TRIP_MEMBER_ROLES = ["owner", "editor", "viewer"] as const;
export const TripMemberRoleSchema = z.enum(TRIP_MEMBER_ROLES);
export type TripMemberRole = z.infer<typeof TripMemberRoleSchema>;

export const BOOKING_CATEGORIES = [
  "lodging",
  "flight",
  "train",
  "car_rental",
  "moped_rental",
  "activity",
  "restaurant",
  "other",
] as const;
export const BookingCategorySchema = z.enum(BOOKING_CATEGORIES);
export type BookingCategory = z.infer<typeof BookingCategorySchema>;

export const BOOKING_STATUSES = ["idea", "planned", "booked", "cancelled"] as const;
export const BookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const BOOKING_SOURCES = ["manual", "email", "share", "deeplink_return"] as const;
export const BookingSourceSchema = z.enum(BOOKING_SOURCES);
export type BookingSource = z.infer<typeof BookingSourceSchema>;

export const ITINERARY_ITEM_KINDS = ["booking", "place_visit", "custom"] as const;
export const ItineraryItemKindSchema = z.enum(ITINERARY_ITEM_KINDS);
export type ItineraryItemKind = z.infer<typeof ItineraryItemKindSchema>;

export const TRAVEL_MODES = ["driving", "walking", "cycling", "transit"] as const;
export const TravelModeSchema = z.enum(TRAVEL_MODES);
export type TravelMode = z.infer<typeof TravelModeSchema>;

export const EXPENSE_CATEGORIES = [
  "lodging",
  "transport",
  "food",
  "activities",
  "shopping",
  "other",
] as const;
export const ExpenseCategorySchema = z.enum(EXPENSE_CATEGORIES);
export type ExpenseCategory = z.infer<typeof ExpenseCategorySchema>;

export const SETTLEMENT_METHODS = ["venmo", "cashapp", "paypal", "zelle", "cash"] as const;
export const SettlementMethodSchema = z.enum(SETTLEMENT_METHODS);
export type SettlementMethod = z.infer<typeof SettlementMethodSchema>;

export const REQUEST_STATUSES = ["open", "settled", "cancelled"] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const CAPTURE_SOURCES = ["email", "share"] as const;
export const CaptureSourceSchema = z.enum(CAPTURE_SOURCES);
export type CaptureSource = z.infer<typeof CaptureSourceSchema>;

export const PARSE_STATUSES = ["pending", "parsed", "needs_review", "failed"] as const;
export const ParseStatusSchema = z.enum(PARSE_STATUSES);
export type ParseStatus = z.infer<typeof ParseStatusSchema>;

export const PHOTO_VISIBILITIES = ["private", "trip", "public"] as const;
export const PhotoVisibilitySchema = z.enum(PHOTO_VISIBILITIES);
export type PhotoVisibility = z.infer<typeof PhotoVisibilitySchema>;

export const AI_FEATURES = [
  "recommendations",
  "expense_estimate",
  "tour_guide",
  "packing_list",
  "recap",
  "capture_parse",
] as const;
export const AiFeatureSchema = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof AiFeatureSchema>;

export const DOCUMENT_KINDS = ["passport", "visa", "insurance", "other"] as const;
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

export const PLANS = ["free"] as const;
export const PlanSchema = z.enum(PLANS);
export type Plan = z.infer<typeof PlanSchema>;

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export const PushPlatformSchema = z.enum(PUSH_PLATFORMS);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

export const BUNDLE_STATUSES = ["pending", "ready", "failed"] as const;
export const BundleStatusSchema = z.enum(BUNDLE_STATUSES);
export type BundleStatus = z.infer<typeof BundleStatusSchema>;

// ---------------------------------------------------------------------------
// Wire-only tuples (no pgEnum mirror — schema spec §3.2 note)
// ---------------------------------------------------------------------------

/** Notifications spec §3.2 — prefs keys + payload discriminator. Append-only. */
export const NOTIFICATION_CATEGORIES = [
  "itinerary_change",
  "daily_digest",
  "leave_by",
  "document_expiry",
  "settle_up",
  "flight_status",
] as const;
export const NotificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/**
 * Contracts spec §3.4 `user.ts` (Gate 2, 2026-07-09) — fixed multi-tag
 * taxonomy living in `users.prefs` JSONB; feeds the AI cache key. Append-only.
 */
export const TRAVEL_STYLES = [
  "budget",
  "comfort",
  "luxury",
  "foodie",
  "adventure",
  "culture",
  "nightlife",
  "family",
  "relaxation",
] as const;
export const TravelStyleSchema = z.enum(TRAVEL_STYLES);
export type TravelStyle = z.infer<typeof TravelStyleSchema>;
