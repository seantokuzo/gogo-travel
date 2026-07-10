import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ---------------------------------------------------------------------------
// Enum tuples ↔ schema spec §3.2 parity (SH-1 test requirement).
// The §3.2 markdown table IS the input: we parse it and diff against the
// shipped tuples, so drift is caught in BOTH directions — a tuple edit that
// leaves the spec behind AND a spec edit that leaves the tuples behind.
// ---------------------------------------------------------------------------

const SPEC_PATH = join(import.meta.dirname, "../../../.specs/database/schema.spec.md");

/**
 * Parses the §3.2 table. Row shape: `| \`name\` | \`v1\`, \`v2\`, … | notes |`.
 * Cells are split on unescaped `|` (notes legitimately contain `\|`); the
 * name cell must be a single backticked identifier and the values cell a
 * comma-separated list of backticked values.
 */
function parseSpecEnums(markdown: string): Map<string, string[]> {
  const section = /^### 3\.2 .*$([\s\S]*?)(?=^### )/m.exec(markdown)?.[1];
  if (!section) throw new Error(`schema.spec.md §3.2 section not found at ${SPEC_PATH}`);
  const enums = new Map<string, string[]>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    const nameCell = /^`(\w+)`$/.exec(cells[1] ?? "");
    if (!nameCell) continue; // header / separator rows
    const values = [...(cells[2] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    if (values.length === 0) throw new Error(`§3.2 row for '${nameCell[1]}' has no values`);
    enums.set(nameCell[1] as string, values);
  }
  return enums;
}

const specEnums = parseSpecEnums(readFileSync(SPEC_PATH, "utf8"));

const PG_ENUM_TUPLES: Readonly<Record<string, readonly string[]>> = {
  place_source: PLACE_SOURCES,
  trip_status: TRIP_STATUSES,
  trip_member_role: TRIP_MEMBER_ROLES,
  booking_category: BOOKING_CATEGORIES,
  booking_status: BOOKING_STATUSES,
  booking_source: BOOKING_SOURCES,
  itinerary_item_kind: ITINERARY_ITEM_KINDS,
  travel_mode: TRAVEL_MODES,
  expense_category: EXPENSE_CATEGORIES,
  settlement_method: SETTLEMENT_METHODS,
  request_status: REQUEST_STATUSES,
  capture_source: CAPTURE_SOURCES,
  parse_status: PARSE_STATUSES,
  photo_visibility: PHOTO_VISIBILITIES,
  ai_feature: AI_FEATURES,
  document_kind: DOCUMENT_KINDS,
  plan: PLANS,
  push_platform: PUSH_PLATFORMS,
  bundle_status: BUNDLE_STATUSES,
};

describe("enum tuples mirror schema spec §3.2 exactly (parsed from the spec)", () => {
  it("parses a sane number of enums out of §3.2 (parser self-check)", () => {
    expect(specEnums.size).toBeGreaterThanOrEqual(19);
  });

  it("the SET of enums matches — no spec enum missing a tuple, no orphan tuple", () => {
    expect([...specEnums.keys()].sort()).toEqual(Object.keys(PG_ENUM_TUPLES).sort());
  });

  it.each([...specEnums.entries()])("%s values match the spec, in spec order", (name, values) => {
    expect([...(PG_ENUM_TUPLES[name] ?? [])]).toEqual(values);
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
