/**
 * Booking domain × hostile fixtures (T-S3.4, R-test-4) — the shared §3.3
 * time model and wire schemas exercised against `@gogo/shared/testing`
 * (imported relatively here; external consumers use the subpath).
 *
 * WHICH FIX FLIPS WHAT (spec §3.4 "each consumer names which fix flips its
 * pins"): NOTHING here flips. The pure time model's contract is
 * "emit as-derived, physics-faithful" (see `deriveAutoItems`'s note), so
 * the B-8 signature pins below document the MECHANISM of the bug — how a
 * Z-stamped payload derives inverted/corrupted instants — and stay valid
 * after B-9: post-fix clients simply stop SENDING Z-stamped payloads. The
 * pins that flip with B-9 live in the consumers that embody current client
 * and server behavior (`form-model.hostile.test.ts` — the `it.failing`
 * repro + evidence pins; `bookings/service.hostile.test.ts` — the
 * grace-sensitive admission pin).
 *
 * Falsification (R-test-7): stated per test; fixture-side invariants are
 * separately pinned by `testing/hostile.test.ts`, so a red here with a
 * green self-test means the TIME MODEL or SCHEMA changed, not the data.
 */
import { describe, expect, it } from "vitest";
import { minorUnitDigits, parseMoneyToCents } from "../config/money.js";
import { CentsSchema } from "../scalars.js";
import {
  BOUNDARY_STRINGS,
  DATE_LINE_EASTBOUND,
  DATE_LINE_WESTBOUND,
  DST_FALL_BACK_STAY,
  EMPTY_STATES,
  HOSTILE_MONEY,
  MULTI_ZONE_TRIP,
  MULTI_ZONE_TRIP_CREATES,
  instantMs,
  zStamp,
  zStampDetails,
} from "../testing/hostile.js";
import { BOOKING_CATEGORIES } from "../enums.js";
import { paginatedSchema } from "../api/envelope.js";
import {
  ActivityDetailsSchema,
  BookingCreateSchema,
  BookingDetailsSchema,
  BookingSchema,
  FlightDetailsSchema,
  deriveAutoItems,
  deriveBookingInstants,
} from "./booking.js";

const HOUR = 3_600_000;

describe("date-line eastbound (the B-8 trap) through the §3.3 time model", () => {
  it("the CORRECT composition is wire-legal and derives ordered instants (9h) — the post-B-9 client shape needs no schema change", () => {
    // Falsification: constrain `*_at`/`*_tz` in a way that rejects real
    // offsets/zones and this reds — the wire already supports the fix.
    const parsed = FlightDetailsSchema.safeParse(DATE_LINE_EASTBOUND.details);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(DATE_LINE_EASTBOUND.details);

    const derived = deriveBookingInstants(DATE_LINE_EASTBOUND.details);
    expect(derived.starts_at).toBe("2027-04-24T08:00:00.000Z");
    expect(derived.ends_at).toBe("2027-04-24T17:00:00.000Z");
  });

  it("physics-faithful derivation: the same-wall-date item carries end wall-TIME before start wall-time (documented deriveAutoItems contract)", () => {
    // Falsification: "normalizing" the derivation (swapping or clamping the
    // inverted wall pair) reds this — the calendar must show the real wall
    // clocks (depart 17:00, land 10:00, same date), because they are true.
    const items = deriveAutoItems(DATE_LINE_EASTBOUND.details);
    expect(items).toEqual([
      { day: "2027-04-24", end_day: null, start_time: "17:00", end_time: "10:00" },
    ]);
  });

  it("B-8 signature: the Z-stamped payload derives an INVERTED interval (ends_at 7h before starts_at) — as-derived, no rejection at this layer", () => {
    // The pure layer emits what the details say (its documented contract);
    // accept/reject is the server mirror's call (`derivedInstantsOf`,
    // bookings/service.ts — currently admitting ≤12h under the temporary
    // grace). Falsification: teach the time model to reorder/reject and
    // this reds — that would be a LAYERING change, escalate before doing it.
    const derived = deriveBookingInstants(DATE_LINE_EASTBOUND.zStamped);
    expect(derived.starts_at).toBe("2027-04-24T17:00:00.000Z");
    expect(derived.ends_at).toBe("2027-04-24T10:00:00.000Z");
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(-7 * HOUR);
  });
});

describe("date-line westbound — the silent-corruption arm", () => {
  it("BOTH compositions derive ordered instants (nothing errors), but every Z-stamped instant is hours wrong: depart −7h, arrive +9h, duration 11h50m → 27h50m", () => {
    // This is why ordering-only assertions are vacuous on westbound legs —
    // a discriminating suite must pin instants. Falsification: any change
    // to `toUtcInstant`'s offset handling reds the exact deltas.
    const real = deriveBookingInstants(DATE_LINE_WESTBOUND.details);
    const stamped = deriveBookingInstants(DATE_LINE_WESTBOUND.zStamped);

    for (const derived of [real, stamped]) {
      expect(instantMs(derived.ends_at ?? "")).toBeGreaterThan(instantMs(derived.starts_at ?? ""));
    }
    expect(instantMs(stamped.starts_at ?? "") - instantMs(real.starts_at ?? "")).toBe(-7 * HOUR);
    expect(instantMs(stamped.ends_at ?? "") - instantMs(real.ends_at ?? "")).toBe(9 * HOUR);
    expect(instantMs(stamped.ends_at ?? "") - instantMs(stamped.starts_at ?? "")).toBe(
      27 * HOUR + 50 * 60_000,
    );
  });

  it("westbound crosses the wall date: the derived item spans Apr 20 → Apr 21 (end_day set)", () => {
    // Falsification: breaking the §3.3 cross-midnight end_day rule reds.
    const items = deriveAutoItems(DATE_LINE_WESTBOUND.details);
    expect(items).toEqual([
      { day: "2027-04-20", end_day: "2027-04-21", start_time: "11:35", end_time: "15:25" },
    ]);
  });
});

describe("multi-zone trip — cross-booking ordering", () => {
  it("every booking in the trip is wire-legal, including the offset-twin Seoul hop (offset equality ≠ zone equality)", () => {
    const all = [
      MULTI_ZONE_TRIP.outbound.details,
      MULTI_ZONE_TRIP.tokyoStayA,
      MULTI_ZONE_TRIP.seoulHop.details,
      MULTI_ZONE_TRIP.seoulStay,
      MULTI_ZONE_TRIP.returnHop.details,
      MULTI_ZONE_TRIP.tokyoStayB,
      MULTI_ZONE_TRIP.returnFlight.details,
    ];
    for (const details of all) {
      expect(BookingDetailsSchema.safeParse(details).success).toBe(true);
    }
    const hop = MULTI_ZONE_TRIP.seoulHop.details;
    expect(hop.departs_tz).toBe("Asia/Tokyo");
    expect(hop.arrives_tz).toBe("Asia/Seoul");
  });

  it("travel-day scramble: correct starts_at ordering is chronological; Z-stamped derivation sorts the LAX arrival before the Tokyo checkout", () => {
    // The cross-booking corruption B-8 causes even where nothing is
    // rejected: itinerary sort by starts_at puts you in LA before you left
    // the hotel. Falsification: fixture drift reds the self-test; a
    // `toUtcInstant` change reds here.
    const { checkout, departure, arrival } = MULTI_ZONE_TRIP.travelDayScramble;
    const order = (values: readonly string[]) =>
      [...values].sort((a, b) => instantMs(a) - instantMs(b));

    expect(order([checkout, departure, arrival])).toEqual([checkout, departure, arrival]);
    expect(order([checkout, departure, arrival].map(zStamp))).toEqual([
      zStamp(arrival),
      zStamp(checkout),
      zStamp(departure),
    ]);
  });
});

describe("DST fall-back stay", () => {
  it("mixed offsets are wire-legal and derive the REAL 21h duration; the uniform-offset shortcut is 1h wrong", () => {
    // Falsification: any "one offset per booking" normalization sneaking
    // into the schema or time model reds the 21h pin to 20h.
    expect(BookingDetailsSchema.safeParse(DST_FALL_BACK_STAY.details).success).toBe(true);
    const derived = deriveBookingInstants(DST_FALL_BACK_STAY.details);
    expect(instantMs(derived.ends_at ?? "") - instantMs(derived.starts_at ?? "")).toBe(
      DST_FALL_BACK_STAY.realDurationMs,
    );
    const naive =
      instantMs(zStamp(DST_FALL_BACK_STAY.naiveUniformOffsetCheckOut)) -
      instantMs(zStamp(DST_FALL_BACK_STAY.details.check_in ?? ""));
    // Same-shaped arithmetic, wrong by the transition hour.
    expect(naive).toBe(DST_FALL_BACK_STAY.naiveUniformOffsetDurationMs);
  });
});

describe("zero-decimal money on the booking wire", () => {
  it("JPY/KRW-priced creates parse whole (price_cents ARE the display units)", () => {
    // Falsification: any currency-aware "normalization" of price_cents on
    // the wire (×100 / ÷100) reds the exact-value pins.
    for (const create of MULTI_ZONE_TRIP_CREATES) {
      const parsed = BookingCreateSchema.safeParse(create);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.price_cents).toBe(create.price_cents);
    }
  });

  it("Law #2 at the boundary: a fractional 'cents' value is rejected, not rounded", () => {
    expect(CentsSchema.safeParse(HOSTILE_MONEY.jpyStay.minorUnits).success).toBe(true);
    expect(CentsSchema.safeParse(250.5).success).toBe(false);
    const create = { ...MULTI_ZONE_TRIP_CREATES[0], price_cents: 250.5 };
    expect(BookingCreateSchema.safeParse(create).success).toBe(false);
  });

  it("the shared money path discriminates on the hostile amounts: currency-aware parse ≠ ×100, correct text ≠ naive 2dp text", () => {
    // parse: "25000" JPY is ¥25,000 — 25000 minor units, not 2,500,000.
    for (const fixture of [HOSTILE_MONEY.jpyStay, HOSTILE_MONEY.krwStay, HOSTILE_MONEY.krwOdd]) {
      expect(parseMoneyToCents(fixture.text, fixture.currency)).toEqual({
        ok: true,
        cents: fixture.minorUnits,
      });
      expect(fixture.text).not.toBe(fixture.naiveText);
    }
    // A fractional yen is unrepresentable: reject, never scale or truncate.
    const rejected = parseMoneyToCents(
      HOSTILE_MONEY.jpyRejectedDecimalText.text,
      HOSTILE_MONEY.jpyRejectedDecimalText.currency,
    );
    expect(rejected.ok).toBe(false);
    expect(minorUnitDigits("JPY")).toBe(0);
  });
});

describe("empty states", () => {
  it("minimal {category} is wire-legal for all 8 categories and derives the timeless booking: null instants, zero auto-items", () => {
    // Falsification: making any detail field required, or deriving items
    // for a start-less booking, reds here (R-ib-4's absent-⇒-NULL posture).
    for (const category of BOOKING_CATEGORIES) {
      const details = EMPTY_STATES.minimalDetails(category);
      expect(BookingDetailsSchema.safeParse(details).success).toBe(true);
      expect(deriveBookingInstants(details)).toEqual({ starts_at: null, ends_at: null });
      expect(deriveAutoItems(details)).toEqual([]);
    }
  });

  it("empty STRING fields are schema-valid and survive parse — present-but-empty is distinct from absent", () => {
    // Consumers that render `details.airline` must handle "" as well as
    // undefined; the wire will hand them both. Falsification: a .min(1)
    // added to optionalString flips this (and is a wire-contract change).
    const parsed = FlightDetailsSchema.safeParse(EMPTY_STATES.flightWithEmptyStrings);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.airline).toBe("");
  });

  it("a whitespace-only title is rejected at create (trim → min(1))", () => {
    const create = { category: "flight", title: EMPTY_STATES.whitespaceTitle };
    expect(BookingCreateSchema.safeParse(create).success).toBe(false);
  });

  it("the empty page parses under paginatedSchema — zero items, no cursor", () => {
    const parsed = paginatedSchema(BookingSchema).safeParse(EMPTY_STATES.emptyPage);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.items).toEqual([]);
  });
});

describe("boundary-length strings against the T-6.1 caps", () => {
  it("name tier (200): at-cap parses, one over fails — the cap is <=, not <", () => {
    // Falsification: an off-by-one in the cap (199/201) reds one arm.
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", airline: BOUNDARY_STRINGS.nameAtCap })
        .success,
    ).toBe(true);
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", airline: BOUNDARY_STRINGS.nameOverCap })
        .success,
    ).toBe(false);
  });

  it("notes tier (2000) and URL tier (2048): both boundaries exact", () => {
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", notes: BOUNDARY_STRINGS.notesAtCap })
        .success,
    ).toBe(true);
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", notes: BOUNDARY_STRINGS.notesOverCap })
        .success,
    ).toBe(false);
    expect(
      ActivityDetailsSchema.safeParse({
        category: "activity",
        external_url: BOUNDARY_STRINGS.urlAtCap,
      }).success,
    ).toBe(true);
    expect(
      ActivityDetailsSchema.safeParse({
        category: "activity",
        external_url: BOUNDARY_STRINGS.urlOverCap,
      }).success,
    ).toBe(false);
  });

  it("the caps count UTF-16 CODE UNITS, not characters: 100 suitcases pass, 101 fail at '202 chars'", () => {
    // Pins the wire's counting semantics so client-side counters can't
    // silently disagree. Falsification: swapping zod length semantics (or
    // pre-normalizing strings) flips an arm.
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", airline: BOUNDARY_STRINGS.astralAtCap })
        .success,
    ).toBe(true);
    expect(
      FlightDetailsSchema.safeParse({ category: "flight", airline: BOUNDARY_STRINGS.astralOverCap })
        .success,
    ).toBe(false);
  });

  it("z-stamping boundary-string details leaves the strings untouched (simulators only touch datetimes)", () => {
    const details = { category: "flight" as const, airline: BOUNDARY_STRINGS.nameAtCap };
    expect(zStampDetails(details).airline).toBe(BOUNDARY_STRINGS.nameAtCap);
  });
});
