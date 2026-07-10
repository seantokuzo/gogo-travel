import { describe, expect, it } from "vitest";
import {
  AI_FEATURES,
  BOOKING_CATEGORIES,
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  BUNDLE_STATUSES,
  BookingCategorySchema,
  CAPTURE_SOURCES,
  DOCUMENT_KINDS,
  EXPENSE_CATEGORIES,
  ITINERARY_ITEM_KINDS,
  NOTIFICATION_CATEGORIES,
  PARSE_STATUSES,
  PHOTO_VISIBILITIES,
  PLACE_SOURCES,
  PLANS,
  PUSH_PLATFORMS,
  REQUEST_STATUSES,
  SETTLEMENT_METHODS,
  TRAVEL_MODES,
  TRAVEL_STYLES,
  TRIP_MEMBER_ROLES,
  TRIP_STATUSES,
  TripStatusSchema,
} from "./enums.js";

// Enum tuples ↔ schema spec §3.2 parity (SH-1 test requirement). Value lists
// below are transcribed verbatim from `.specs/database/schema.spec.md` §3.2 —
// a mismatch here means the tuple drifted from the canonical spec.
describe("enum tuples mirror schema spec §3.2 exactly", () => {
  it.each([
    ["place_source", PLACE_SOURCES, ["overture", "fsq_os", "custom"]],
    ["trip_status", TRIP_STATUSES, ["planning", "active", "past"]],
    ["trip_member_role", TRIP_MEMBER_ROLES, ["owner", "editor", "viewer"]],
    [
      "booking_category",
      BOOKING_CATEGORIES,
      [
        "lodging",
        "flight",
        "train",
        "car_rental",
        "moped_rental",
        "activity",
        "restaurant",
        "other",
      ],
    ],
    ["booking_status", BOOKING_STATUSES, ["idea", "planned", "booked", "cancelled"]],
    ["booking_source", BOOKING_SOURCES, ["manual", "email", "share", "deeplink_return"]],
    ["itinerary_item_kind", ITINERARY_ITEM_KINDS, ["booking", "place_visit", "custom"]],
    ["travel_mode", TRAVEL_MODES, ["driving", "walking", "cycling", "transit"]],
    [
      "expense_category",
      EXPENSE_CATEGORIES,
      ["lodging", "transport", "food", "activities", "shopping", "other"],
    ],
    ["settlement_method", SETTLEMENT_METHODS, ["venmo", "cashapp", "paypal", "zelle", "cash"]],
    ["request_status", REQUEST_STATUSES, ["open", "settled", "cancelled"]],
    ["capture_source", CAPTURE_SOURCES, ["email", "share"]],
    ["parse_status", PARSE_STATUSES, ["pending", "parsed", "needs_review", "failed"]],
    ["photo_visibility", PHOTO_VISIBILITIES, ["private", "trip", "public"]],
    [
      "ai_feature",
      AI_FEATURES,
      [
        "recommendations",
        "expense_estimate",
        "tour_guide",
        "packing_list",
        "recap",
        "capture_parse",
      ],
    ],
    ["document_kind", DOCUMENT_KINDS, ["passport", "visa", "insurance", "other"]],
    ["plan", PLANS, ["free"]],
    ["push_platform", PUSH_PLATFORMS, ["ios", "android"]],
    ["bundle_status", BUNDLE_STATUSES, ["pending", "ready", "failed"]],
  ])("%s", (_name, tuple, expected) => {
    expect([...tuple]).toEqual(expected);
  });

  it("wire-only tuples (no pgEnum) match their specs", () => {
    // notifications spec §3.2
    expect([...NOTIFICATION_CATEGORIES]).toEqual([
      "itinerary_change",
      "daily_digest",
      "leave_by",
      "document_expiry",
      "settle_up",
      "flight_status",
    ]);
    // contracts spec §3.4 user.ts (Gate 2)
    expect([...TRAVEL_STYLES]).toEqual([
      "budget",
      "comfort",
      "luxury",
      "foodie",
      "adventure",
      "culture",
      "nightlife",
      "family",
      "relaxation",
    ]);
  });
});

describe("z.enum schemas are built from the tuples", () => {
  it("accepts tuple members and rejects outsiders", () => {
    expect(BookingCategorySchema.parse("moped_rental")).toBe("moped_rental");
    expect(BookingCategorySchema.safeParse("submarine").success).toBe(false);
    expect(TripStatusSchema.safeParse("archived").success).toBe(false);
  });
});
