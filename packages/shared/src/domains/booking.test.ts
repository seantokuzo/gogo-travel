import { describe, expect, it } from "vitest";
import { BookingDetailsSchema, BookingSchema } from "./booking.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

// SH-1 test requirement: valid payload per category parses (all 8 shapes).
const validDetails: Record<string, unknown>[] = [
  {
    category: "lodging",
    property_name: "Park Hyatt Tokyo",
    check_in: "2026-09-01T15:00:00+09:00",
    check_out: "2026-09-05T11:00:00+09:00",
    guests: 2,
    provider: "booking",
  },
  {
    category: "flight",
    airline: "United",
    flight_number: "UA 837",
    origin_iata: "SFO",
    destination_iata: "NRT",
    departs_at: "2026-09-01T11:05:00-07:00",
    departs_tz: "America/Los_Angeles",
    arrives_at: "2026-09-02T14:25:00+09:00",
    arrives_tz: "Asia/Tokyo",
    passenger_names: ["Sean T"],
    segments: [{ airline: "United", flight_number: "UA 837" }],
  },
  {
    category: "train",
    carrier: "JR Central",
    train_number: "Nozomi 21",
    origin_station: "Tokyo",
    destination_station: "Kyoto",
    seat: "12A",
  },
  { category: "car_rental", company: "Toyota Rent a Car", vehicle_class: "compact" },
  { category: "moped_rental", company: "Kyoto Scooters", helmet_count: 2 },
  {
    category: "activity",
    provider: "viator",
    venue_name: "teamLab Planets",
    ticket_count: 2,
    external_url: "https://example.com/tickets",
  },
  { category: "restaurant", reserved_at: "2026-09-03T19:00:00+09:00", party_size: 4 },
  { category: "other", description: "Onsen day", notes: "bring towels" },
];

describe("BookingDetails discriminated union (schema spec §3.4.1)", () => {
  it.each(validDetails.map((d) => [d["category"] as string, d]))(
    "parses a valid %s payload",
    (_category, details) => {
      const parsed = BookingDetailsSchema.parse(details);
      expect(parsed.category).toBe(details["category"]);
    },
  );

  it("all fields are optional beyond the discriminator (ideas may know nothing)", () => {
    for (const category of validDetails.map((d) => d["category"])) {
      expect(BookingDetailsSchema.parse({ category }).category).toBe(category);
    }
  });

  it("rejects unknown categories", () => {
    expect(BookingDetailsSchema.safeParse({ category: "submarine" }).success).toBe(false);
  });

  it("strips unknown keys (R-shared-10)", () => {
    const parsed = BookingDetailsSchema.parse({
      category: "lodging",
      property_name: "Ryokan",
      star_rating: 5,
      nested_junk: { a: 1 },
    });
    expect(parsed).toEqual({ category: "lodging", property_name: "Ryokan" });
  });

  it("rejects non-offset datetimes in time fields", () => {
    expect(
      BookingDetailsSchema.safeParse({ category: "lodging", check_in: "2026-09-01" }).success,
    ).toBe(false);
  });

  it("flight segments carry the same fields but never recurse", () => {
    const ok = BookingDetailsSchema.parse({
      category: "flight",
      segments: [{ flight_number: "UA 837", segments: [{ flight_number: "NH 5" }] }],
    });
    // inner `segments` is an unknown key on FlightSegment — stripped, not recursive
    expect(ok.category === "flight" && ok.segments?.[0]).toEqual({ flight_number: "UA 837" });
  });
});

describe("Booking row schema", () => {
  const validBooking = {
    id: UUID,
    trip_id: UUID,
    category: "flight",
    status: "booked",
    title: "UA 837 SFO→NRT",
    details: { category: "flight", flight_number: "UA 837" },
    starts_at: "2026-09-01T18:05:00Z",
    ends_at: "2026-09-02T05:25:00Z",
    price_cents: 128500,
    currency: "USD",
    confirmation_code: "ABC123",
    source: "email",
    capture_id: null,
    place_id: null,
    created_by: UUID,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
  };

  it("parses a valid booking", () => {
    expect(BookingSchema.parse(validBooking).category).toBe("flight");
  });

  it("rejects mismatched category/details (contracts spec §3.4)", () => {
    expect(
      BookingSchema.safeParse({
        ...validBooking,
        details: { category: "lodging", property_name: "Hyatt" },
      }).success,
    ).toBe(false);
  });

  it("rejects float prices (Law #2)", () => {
    expect(BookingSchema.safeParse({ ...validBooking, price_cents: 1285.5 }).success).toBe(false);
  });
});
