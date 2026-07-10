/**
 * Postgres enums mirroring `@gogo/shared` tuples — the tuples are the single
 * source of truth (R-shared-2; schema spec §3.2). Never inline values here:
 * pgEnums IMPORT the shared tuples so the TS side and the DB side cannot
 * drift. Enum values are append-only (PG can't drop enum values without a
 * rewrite).
 */
import {
  AI_FEATURES,
  BOOKING_CATEGORIES,
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  BUNDLE_STATUSES,
  CAPTURE_SOURCES,
  DOCUMENT_KINDS,
  EXPENSE_CATEGORIES,
  ITINERARY_ITEM_KINDS,
  PARSE_STATUSES,
  PHOTO_VISIBILITIES,
  PLACE_SOURCES,
  PLANS,
  PUSH_PLATFORMS,
  REQUEST_STATUSES,
  SETTLEMENT_METHODS,
  TRAVEL_MODES,
  TRIP_MEMBER_ROLES,
  TRIP_STATUSES,
} from "@gogo/shared/enums";
import { pgEnum } from "drizzle-orm/pg-core";

export const placeSource = pgEnum("place_source", PLACE_SOURCES);
export const tripStatus = pgEnum("trip_status", TRIP_STATUSES);
export const tripMemberRole = pgEnum("trip_member_role", TRIP_MEMBER_ROLES);
export const bookingCategory = pgEnum("booking_category", BOOKING_CATEGORIES);
export const bookingStatus = pgEnum("booking_status", BOOKING_STATUSES);
export const bookingSource = pgEnum("booking_source", BOOKING_SOURCES);
export const itineraryItemKind = pgEnum("itinerary_item_kind", ITINERARY_ITEM_KINDS);
export const travelMode = pgEnum("travel_mode", TRAVEL_MODES);
export const expenseCategory = pgEnum("expense_category", EXPENSE_CATEGORIES);
export const settlementMethod = pgEnum("settlement_method", SETTLEMENT_METHODS);
export const requestStatus = pgEnum("request_status", REQUEST_STATUSES);
export const captureSource = pgEnum("capture_source", CAPTURE_SOURCES);
export const parseStatus = pgEnum("parse_status", PARSE_STATUSES);
export const photoVisibility = pgEnum("photo_visibility", PHOTO_VISIBILITIES);
export const aiFeature = pgEnum("ai_feature", AI_FEATURES);
export const documentKind = pgEnum("document_kind", DOCUMENT_KINDS);
export const plan = pgEnum("plan", PLANS);
export const pushPlatform = pgEnum("push_platform", PUSH_PLATFORMS);
export const bundleStatus = pgEnum("bundle_status", BUNDLE_STATUSES);
