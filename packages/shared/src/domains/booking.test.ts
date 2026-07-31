import { describe, expect, it } from "vitest";
import {
  BookingCreateSchema,
  BookingDetailsSchema,
  BookingListQuerySchema,
  BookingSchema,
  BookingUpdateSchema,
  BookingWithItemsSchema,
  ScheduleBookingInputSchema,
  bookingEndpoints,
  bookingPrimaryTimes,
  deriveAutoItems,
  deriveBookingInstants,
  toUtcInstant,
  wallDate,
  wallTime,
  type BookingDetails,
} from "./booking.js";

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

// ---------------------------------------------------------------------------
// Free-text + array caps (round-1 B2 — the T-6.1 DoS convention; details land
// verbatim in jsonb, so every client-writable string and array is bounded).
// Tiers: name/code-like 200 · notes-like prose 2000 · URLs 2048 ·
// segments ≤ 8 · passenger_names ≤ 20 (elements 200).
// ---------------------------------------------------------------------------

describe("BookingDetails caps (B2 — T-6.1 DoS convention)", () => {
  const x = (n: number) => "x".repeat(n);

  it("name/code-like fields cap at 200 per shape (201 rejects, 200 passes)", () => {
    const overs: Record<string, unknown>[] = [
      { category: "flight", airline: x(201) },
      { category: "flight", flight_number: x(201) },
      { category: "lodging", property_name: x(201) },
      { category: "lodging", address: x(201) },
      { category: "train", carrier: x(201) },
      { category: "car_rental", company: x(201) },
      { category: "moped_rental", vehicle_description: x(201) },
      { category: "activity", venue_name: x(201) },
      { category: "restaurant", provider: x(201) },
    ];
    for (const details of overs) {
      expect(
        BookingDetailsSchema.safeParse(details).success,
        JSON.stringify(Object.keys(details)),
      ).toBe(false);
    }
    expect(
      BookingDetailsSchema.safeParse({ category: "lodging", property_name: x(200) }).success,
    ).toBe(true);
  });

  it("notes-like prose caps at 2000 on every shape; boundary passes", () => {
    for (const category of [
      "flight",
      "lodging",
      "train",
      "car_rental",
      "moped_rental",
      "activity",
      "restaurant",
      "other",
    ]) {
      expect(BookingDetailsSchema.safeParse({ category, notes: x(2001) }).success, category).toBe(
        false,
      );
    }
    expect(BookingDetailsSchema.safeParse({ category: "other", notes: x(2000) }).success).toBe(
      true,
    );
    // `other.description` is prose, same tier.
    expect(
      BookingDetailsSchema.safeParse({ category: "other", description: x(2001) }).success,
    ).toBe(false);
  });

  it("external_url caps at 2048 (activity and other)", () => {
    expect(
      BookingDetailsSchema.safeParse({ category: "activity", external_url: x(2049) }).success,
    ).toBe(false);
    expect(
      BookingDetailsSchema.safeParse({ category: "other", external_url: x(2049) }).success,
    ).toBe(false);
    expect(
      BookingDetailsSchema.safeParse({ category: "activity", external_url: x(2048) }).success,
    ).toBe(true);
  });

  it("arrays are bounded: segments ≤ 8", () => {
    const segment = { flight_number: "UA 837" };
    expect(
      BookingDetailsSchema.safeParse({ category: "flight", segments: Array(9).fill(segment) })
        .success,
    ).toBe(false);
    expect(
      BookingDetailsSchema.safeParse({ category: "flight", segments: Array(8).fill(segment) })
        .success,
    ).toBe(true);
    // Segment-level free text is capped too (same fields as the top level).
    expect(
      BookingDetailsSchema.safeParse({ category: "flight", segments: [{ airline: x(201) }] })
        .success,
    ).toBe(false);
  });

  it("arrays are bounded: passenger_names ≤ 20, elements ≤ 200", () => {
    expect(
      BookingDetailsSchema.safeParse({
        category: "flight",
        passenger_names: Array(21).fill("Sean T"),
      }).success,
    ).toBe(false);
    expect(
      BookingDetailsSchema.safeParse({
        category: "flight",
        passenger_names: Array(20).fill("Sean T"),
      }).success,
    ).toBe(true);
    expect(
      BookingDetailsSchema.safeParse({ category: "flight", passenger_names: [x(201)] }).success,
    ).toBe(false);
    // Caps apply inside segments' passenger lists as well.
    expect(
      BookingDetailsSchema.safeParse({
        category: "flight",
        segments: [{ passenger_names: Array(21).fill("Sean T") }],
      }).success,
    ).toBe(false);
  });

  it("local-time datetimes cap at 64 chars (round-2 B1 — iso.datetime puts no bound on fractional seconds)", () => {
    // Boundary pass: a real offset+milliseconds datetime is well under 64.
    expect(
      BookingDetailsSchema.safeParse({
        category: "flight",
        departs_at: "2026-09-01T11:05:00.123456+09:00",
      }).success,
    ).toBe(true);
    // Otherwise-valid ISO datetime whose fractional seconds run past 64 chars
    // — iso.datetime alone accepts it (any-length fraction); the cap rejects.
    const long = `2026-09-01T11:05:00.${"1".repeat(60)}+09:00`;
    expect(BookingDetailsSchema.safeParse({ category: "flight", departs_at: long }).success).toBe(
      false,
    );
    // The cap rides every localTime field, segments included.
    expect(
      BookingDetailsSchema.safeParse({
        category: "flight",
        segments: [{ departs_at: long }],
      }).success,
    ).toBe(false);
    expect(
      BookingDetailsSchema.safeParse({ category: "lodging", check_in: long }).success,
    ).toBe(false);
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

// ---------------------------------------------------------------------------
// §3.3 time model (T-7.1 / IB-1) — details → instants → calendar
// ---------------------------------------------------------------------------

describe("§3.3 primary times per category", () => {
  it("maps every category's primary start/end fields (§3.3 table)", () => {
    const cases: Array<[BookingDetails, string | null, string | null]> = [
      [
        { category: "flight", departs_at: "2026-09-01T11:05:00-07:00", arrives_at: "2026-09-02T14:25:00+09:00" },
        "2026-09-01T11:05:00-07:00",
        "2026-09-02T14:25:00+09:00",
      ],
      [
        { category: "train", departs_at: "2026-09-03T09:00:00+09:00" },
        "2026-09-03T09:00:00+09:00",
        null,
      ],
      [
        { category: "lodging", check_in: "2026-09-01T15:00:00+09:00", check_out: "2026-09-05T11:00:00+09:00" },
        "2026-09-01T15:00:00+09:00",
        "2026-09-05T11:00:00+09:00",
      ],
      [
        { category: "car_rental", pickup_at: "2026-09-02T10:00:00+09:00", dropoff_at: "2026-09-04T18:00:00+09:00" },
        "2026-09-02T10:00:00+09:00",
        "2026-09-04T18:00:00+09:00",
      ],
      [
        { category: "moped_rental", pickup_at: "2026-09-02T10:00:00+09:00" },
        "2026-09-02T10:00:00+09:00",
        null,
      ],
      [
        { category: "activity", starts_at: "2026-09-03T13:00:00+09:00", ends_at: "2026-09-03T16:00:00+09:00" },
        "2026-09-03T13:00:00+09:00",
        "2026-09-03T16:00:00+09:00",
      ],
      // restaurant has NO primary end (§3.3 table: "—") even if extra keys existed
      [{ category: "restaurant", reserved_at: "2026-09-03T19:00:00+09:00" }, "2026-09-03T19:00:00+09:00", null],
      [
        { category: "other", starts_at: "2026-09-04T08:00:00+09:00", ends_at: "2026-09-04T09:00:00+09:00" },
        "2026-09-04T08:00:00+09:00",
        "2026-09-04T09:00:00+09:00",
      ],
    ];
    for (const [details, start, end] of cases) {
      expect(bookingPrimaryTimes(details)).toEqual({ start, end });
    }
  });

  it("absent fields are null — an idea may know nothing (R-ib-4)", () => {
    expect(bookingPrimaryTimes({ category: "flight" })).toEqual({ start: null, end: null });
    // end may be known without start (independent sides)
    expect(bookingPrimaryTimes({ category: "flight", arrives_at: "2026-09-02T14:25:00+09:00" })).toEqual({
      start: null,
      end: "2026-09-02T14:25:00+09:00",
    });
  });
});

describe("§3.3 wall extraction + UTC instants", () => {
  it("wallDate/wallTime drop the offset — no tz math", () => {
    expect(wallDate("2026-09-01T11:05:00-07:00")).toBe("2026-09-01");
    expect(wallTime("2026-09-01T11:05:00-07:00")).toBe("11:05");
    // +09:00 local late evening stays the LOCAL date, not the UTC one
    expect(wallDate("2026-09-01T23:30:00+09:00")).toBe("2026-09-01");
    expect(wallTime("2026-09-01T23:30:00+09:00")).toBe("23:30");
  });

  it("toUtcInstant converts the offset to the true instant", () => {
    expect(toUtcInstant("2026-09-01T11:05:00-07:00")).toBe("2026-09-01T18:05:00.000Z");
    expect(toUtcInstant("2026-09-02T14:25:00+09:00")).toBe("2026-09-02T05:25:00.000Z");
  });

  it("toUtcInstant folds an unparseable input to null — the corruption-signal arm (R-ib-4 absent-⇒-NULL posture; round-1 A6)", () => {
    // Schema-validated inputs can't normally reach here malformed; the fold
    // is the corruption guard, pinned so it never silently becomes a throw.
    expect(toUtcInstant("9999-99-99T99:99:99+99:99")).toBeNull();
    expect(toUtcInstant("not a datetime")).toBeNull();
  });

  it("deriveBookingInstants: R-ib-4 — instants from primary times, NULL when absent", () => {
    expect(
      deriveBookingInstants({
        category: "flight",
        departs_at: "2026-09-01T11:05:00-07:00",
        arrives_at: "2026-09-02T14:25:00+09:00",
      }),
    ).toEqual({ starts_at: "2026-09-01T18:05:00.000Z", ends_at: "2026-09-02T05:25:00.000Z" });
    expect(deriveBookingInstants({ category: "flight" })).toEqual({
      starts_at: null,
      ends_at: null,
    });
  });
});

describe("§3.3 auto-item derivation (R-ib-5)", () => {
  it("no primary start ⇒ no items (timeless — the unscheduled bucket, I-3)", () => {
    expect(deriveAutoItems({ category: "activity" })).toEqual([]);
    // end-only is still timeless for the calendar
    expect(deriveAutoItems({ category: "flight", arrives_at: "2026-09-02T14:25:00+09:00" })).toEqual(
      [],
    );
  });

  it("flight/train: one item on the departure wall-date; same-day arrival sets no end_day", () => {
    expect(
      deriveAutoItems({
        category: "train",
        departs_at: "2026-09-03T09:00:00+09:00",
        arrives_at: "2026-09-03T11:15:00+09:00",
      }),
    ).toEqual([
      { day: "2026-09-03", end_day: null, start_time: "09:00", end_time: "11:15" },
    ]);
  });

  it("cross-midnight point event: end_day = arrival wall-date (§2 Gate-2 resolution)", () => {
    expect(
      deriveAutoItems({
        category: "flight",
        departs_at: "2026-09-01T11:05:00-07:00",
        arrives_at: "2026-09-02T14:25:00+09:00",
      }),
    ).toEqual([
      { day: "2026-09-01", end_day: "2026-09-02", start_time: "11:05", end_time: "14:25" },
    ]);
  });

  it("lodging: ONE spanning item — day = check-in date, end_day = check-out date (§3.6 Branch A)", () => {
    expect(
      deriveAutoItems({
        category: "lodging",
        check_in: "2026-09-01T15:00:00+09:00",
        check_out: "2026-09-05T11:00:00+09:00",
      }),
    ).toEqual([
      { day: "2026-09-01", end_day: "2026-09-05", start_time: "15:00", end_time: "11:00" },
    ]);
    // check-out unknown: spanning item degrades to an open point event
    expect(deriveAutoItems({ category: "lodging", check_in: "2026-09-01T15:00:00+09:00" })).toEqual([
      { day: "2026-09-01", end_day: null, start_time: "15:00", end_time: null },
    ]);
  });

  it("car/moped rental: pickup + dropoff POINT items; dropoff item only when dropoff_at set", () => {
    expect(
      deriveAutoItems({
        category: "car_rental",
        pickup_at: "2026-09-02T10:00:00+09:00",
        dropoff_at: "2026-09-04T18:00:00+09:00",
      }),
    ).toEqual([
      { day: "2026-09-02", end_day: null, start_time: "10:00", end_time: null },
      { day: "2026-09-04", end_day: null, start_time: "18:00", end_time: null },
    ]);
    expect(
      deriveAutoItems({ category: "moped_rental", pickup_at: "2026-09-02T10:00:00+09:00" }),
    ).toEqual([{ day: "2026-09-02", end_day: null, start_time: "10:00", end_time: null }]);
  });

  it("restaurant: one item, end_time NULL (§3.3 table)", () => {
    expect(
      deriveAutoItems({ category: "restaurant", reserved_at: "2026-09-03T19:00:00+09:00" }),
    ).toEqual([{ day: "2026-09-03", end_day: null, start_time: "19:00", end_time: null }]);
  });

  it("same-wall-date inverted wall-TIMES emit as-derived — eastward date-line flight (physics-faithful; R-ib-17 governs direct writes, not derivation)", () => {
    // AKL 14:00 +12:00 (02:00Z) → HNL 06:00 -10:00 (16:00Z): 14 real hours
    // later, same local calendar date, arrival wall-time before departure.
    expect(
      deriveAutoItems({
        category: "flight",
        departs_at: "2026-09-02T14:00:00+12:00",
        arrives_at: "2026-09-02T06:00:00-10:00",
      }),
    ).toEqual([{ day: "2026-09-02", end_day: null, start_time: "14:00", end_time: "06:00" }]);
  });

  it("lodging inverted wall-DATES also emit as-derived from the PURE helper — the server write path owns the 400 (round-1 A1 split pin)", () => {
    // UTC instants are ordered (check_in 2026-07-31T21:00Z < check_out
    // 2026-08-01T02:00Z) but the LOCAL dates invert. The helper stays
    // physics-faithful; the booking service mirrors the items-table
    // `end_day >= day` CHECK as VALIDATION_FAILED before any insert.
    expect(
      deriveAutoItems({
        category: "lodging",
        check_in: "2026-08-01T02:00:00+05:00",
        check_out: "2026-07-31T22:00:00-04:00",
      }),
    ).toEqual([
      { day: "2026-08-01", end_day: "2026-07-31", start_time: "02:00", end_time: "22:00" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// §3.7 request shapes (T-7.1 / IB-1)
// ---------------------------------------------------------------------------

describe("BookingCreateSchema (§3.4 POST)", () => {
  const valid = { category: "flight", title: "UA 837 SFO→NRT" };

  it("parses the minimal create; details/status/source are optional", () => {
    const parsed = BookingCreateSchema.parse(valid);
    expect(parsed).toEqual({ category: "flight", title: "UA 837 SFO→NRT" });
  });

  it("R-ib-1: mismatched category/details rejected", () => {
    expect(
      BookingCreateSchema.safeParse({
        ...valid,
        details: { category: "lodging", property_name: "Hyatt" },
      }).success,
    ).toBe(false);
  });

  it("R-ib-11: source 'email'/'share' unrepresentable from direct clients", () => {
    expect(BookingCreateSchema.safeParse({ ...valid, source: "email" }).success).toBe(false);
    expect(BookingCreateSchema.safeParse({ ...valid, source: "share" }).success).toBe(false);
    expect(BookingCreateSchema.safeParse({ ...valid, source: "deeplink_return" }).success).toBe(
      true,
    );
  });

  it("cancelled is not creatable (§3.4)", () => {
    expect(BookingCreateSchema.safeParse({ ...valid, status: "cancelled" }).success).toBe(false);
    expect(BookingCreateSchema.safeParse({ ...valid, status: "booked" }).success).toBe(true);
  });

  it("R-ib-12: price without currency rejected; paired passes", () => {
    expect(BookingCreateSchema.safeParse({ ...valid, price_cents: 12800 }).success).toBe(false);
    expect(
      BookingCreateSchema.safeParse({ ...valid, price_cents: 12800, currency: "USD" }).success,
    ).toBe(true);
    expect(
      BookingCreateSchema.safeParse({ ...valid, price_cents: 128.5, currency: "USD" }).success,
    ).toBe(false); // Law #2: floats fail
  });

  it("unknown detail keys are stripped through the create (R-shared-10)", () => {
    const parsed = BookingCreateSchema.parse({
      ...valid,
      details: { category: "flight", flight_number: "UA 837", star_rating: 5 },
    });
    expect(parsed.details).toEqual({ category: "flight", flight_number: "UA 837" });
  });
});

describe("BookingUpdateSchema (§3.4 PATCH)", () => {
  it("R-ib-2: a category key is rejected, not silently stripped", () => {
    expect(BookingUpdateSchema.safeParse({ category: "lodging" }).success).toBe(false);
    expect(BookingUpdateSchema.safeParse({ category: "flight" }).success).toBe(false);
  });

  it("explicit null clears nullable fields; price+currency-null pairing rejected", () => {
    const parsed = BookingUpdateSchema.parse({
      price_cents: null,
      currency: null,
      confirmation_code: null,
      place_id: null,
    });
    expect(parsed.price_cents).toBeNull();
    expect(
      BookingUpdateSchema.safeParse({ price_cents: 100, currency: null }).success,
    ).toBe(false);
  });

  it("status accepts the full enum (legality is the service's §3.2 concern)", () => {
    expect(BookingUpdateSchema.safeParse({ status: "cancelled" }).success).toBe(true);
  });
});

describe("ScheduleBookingInputSchema (R-ib-8)", () => {
  it("day required; times optional ISOTime; structural order enforced (R-ib-17)", () => {
    expect(ScheduleBookingInputSchema.safeParse({}).success).toBe(false);
    expect(ScheduleBookingInputSchema.safeParse({ day: "2026-09-03" }).success).toBe(true);
    expect(
      ScheduleBookingInputSchema.safeParse({
        day: "2026-09-03",
        start_time: "19:00",
        end_time: "21:00",
      }).success,
    ).toBe(true);
    expect(
      ScheduleBookingInputSchema.safeParse({
        day: "2026-09-03",
        start_time: "21:00",
        end_time: "19:00",
      }).success,
    ).toBe(false);
    expect(
      ScheduleBookingInputSchema.safeParse({ day: "2026-09-03", start_time: "25:00" }).success,
    ).toBe(false);
  });
});

describe("BookingListQuerySchema (§3.4 GET)", () => {
  it("status normalizes single and repeated values to an array", () => {
    expect(BookingListQuerySchema.parse({ status: "idea" }).status).toEqual(["idea"]);
    expect(BookingListQuerySchema.parse({ status: ["idea", "booked"] }).status).toEqual([
      "idea",
      "booked",
    ]);
    expect(BookingListQuerySchema.parse({}).status).toBeUndefined();
  });

  it("unscheduled is a string boolean (query params are strings)", () => {
    expect(BookingListQuerySchema.parse({ unscheduled: "true" }).unscheduled).toBe(true);
    expect(BookingListQuerySchema.parse({ unscheduled: "false" }).unscheduled).toBe(false);
    expect(BookingListQuerySchema.safeParse({ unscheduled: "maybe" }).success).toBe(false);
  });

  it("limit coerces and caps at 100", () => {
    expect(BookingListQuerySchema.parse({ limit: "25" }).limit).toBe(25);
    expect(BookingListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(BookingListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });
});

describe("BookingWithItemsSchema", () => {
  const base = {
    id: UUID,
    trip_id: UUID,
    category: "flight",
    status: "booked",
    title: "UA 837",
    details: { category: "flight" },
    starts_at: null,
    ends_at: null,
    price_cents: null,
    currency: null,
    confirmation_code: null,
    source: "manual",
    capture_id: null,
    place_id: null,
    created_by: UUID,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    items: [],
  };

  it("parses Booking + items", () => {
    expect(BookingWithItemsSchema.parse(base).items).toEqual([]);
  });

  it("INHERITS the category↔details refinement (safeExtend pin)", () => {
    expect(
      BookingWithItemsSchema.safeParse({ ...base, details: { category: "lodging" } }).success,
    ).toBe(false);
  });
});

describe("booking endpoint descriptors (contracts §3.6)", () => {
  it("mirror the §3.4 routes exactly", () => {
    expect(
      Object.values(bookingEndpoints).map((d) => `${d.method} ${d.path}`),
    ).toEqual([
      "GET /trips/:tripId/bookings",
      "POST /trips/:tripId/bookings",
      "GET /trips/:tripId/bookings/:bookingId",
      "PATCH /trips/:tripId/bookings/:bookingId",
      "DELETE /trips/:tripId/bookings/:bookingId",
      "POST /trips/:tripId/bookings/:bookingId/schedule",
    ]);
  });
});
