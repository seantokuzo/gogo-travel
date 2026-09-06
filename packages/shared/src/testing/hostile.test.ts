/**
 * Hostile-pack self-test (T-S3.4) — pins every numeric invariant the
 * fixtures' doc-comments claim, so a fixture edit that silently defuses a
 * trap goes RED here on the exact invariant it broke.
 *
 * Falsification (R-test-7), per group:
 *  - change any wall time/offset in `DATE_LINE_*` → the exact-duration /
 *    exact-inversion pins red;
 *  - "fix" the eastbound fixture into an ordered-wall-clock shape (the
 *    classic well-meaning cleanup) → the wall-clock-inversion pin reds:
 *    that inversion IS the B-8 trap, not a typo;
 *  - point `zStamp`/`zStampDetails` at anything but the form-model
 *    composition (`${date}T${time}:00Z`, tz dropped) → coherence pins red;
 *  - drop a zone from the multi-zone trip, or make Seoul/Tokyo offsets
 *    differ → the offset≠zone and scramble pins red;
 *  - swap a zero-decimal amount for one where naive 2dp agrees → the
 *    discrimination pin (`text !== naiveText`) reds;
 *  - resize any boundary string → the exact-length pins red.
 *
 * The DISCRIMINATION meta-pins are the point of the pack: they assert the
 * hostile shapes and the naive controls BEHAVE DIFFERENTLY under the bug
 * simulators, i.e. that the pack cannot quietly regress into "a fixture
 * where two behaviors yield the same value" (mobile.md vacuous-pin
 * taxonomy).
 */
import { describe, expect, it } from "vitest";
import { minorUnitDigits } from "../config/money.js";
import { BOOKING_CATEGORIES } from "../enums.js";
import {
  BOUNDARY_STRINGS,
  DATE_LINE_EASTBOUND,
  DATE_LINE_EASTBOUND_EXTREME,
  DATE_LINE_WESTBOUND,
  DST_FALL_BACK_AMBIGUOUS,
  DST_FALL_BACK_STAY,
  DST_SPRING_FORWARD_GAP,
  EMPTY_STATES,
  HOSTILE_MONEY,
  MULTI_ZONE_TRIP,
  MULTI_ZONE_TRIP_CREATES,
  NAIVE_CONTROL_FLIGHT,
  instantMs,
  localISO,
  naiveTwoDecimalText,
  zStamp,
  zStampDetails,
} from "./hostile.js";

const HOUR = 3_600_000;

describe("date-line fixtures — the B-8 trap invariants", () => {
  it("eastbound: arrival WALL clock precedes departure wall clock on the SAME wall date, while instants are correctly ordered (+9h)", () => {
    const { origin, destination, durationMs } = DATE_LINE_EASTBOUND;
    // The wall-clock inversion IS the fixture. "Fixing" it defuses the trap.
    expect(origin.date).toBe(destination.date);
    expect(destination.time < origin.time).toBe(true);
    expect(durationMs).toBe(9 * HOUR);
    expect(instantMs(destination.local)).toBeGreaterThan(instantMs(origin.local));
  });

  it("eastbound: the B-8 composition INVERTS the interval by exactly 7h — inside the temporary 12h transport grace", () => {
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).toBe(-7 * HOUR);
    expect(-DATE_LINE_EASTBOUND.zStampedIntervalMs).toBeLessThan(12 * HOUR);
  });

  it("extreme eastbound (AKL→PPT): z-inversion 16h10m EXCEEDS the 12h grace — the grace is a partial unblock, not a fix", () => {
    expect(DATE_LINE_EASTBOUND_EXTREME.durationMs).toBe(5 * HOUR + 50 * 60_000);
    expect(DATE_LINE_EASTBOUND_EXTREME.zStampedIntervalMs).toBe(-(16 * HOUR + 10 * 60_000));
    expect(-DATE_LINE_EASTBOUND_EXTREME.zStampedIntervalMs).toBeGreaterThan(12 * HOUR);
  });

  it("westbound: ordering SURVIVES the B-8 composition (why it never errored) but the duration corrupts 11h50m → 27h50m", () => {
    expect(DATE_LINE_WESTBOUND.durationMs).toBe(11 * HOUR + 50 * 60_000);
    // Still positive — no validation error to catch you…
    expect(DATE_LINE_WESTBOUND.zStampedIntervalMs).toBeGreaterThan(0);
    // …but 16h of silent corruption.
    expect(DATE_LINE_WESTBOUND.zStampedIntervalMs).toBe(27 * HOUR + 50 * 60_000);
  });

  it("DISCRIMINATION: the naive same-zone control cannot see the bug — ordering, duration and wall values all survive z-stamping", () => {
    const { details, zStamped, durationMs, zStampedIntervalMs } = NAIVE_CONTROL_FLIGHT;
    // Uniform offset ⇒ uniform shift: the interval is untouched…
    expect(zStampedIntervalMs).toBe(durationMs);
    // …and the wall components are byte-identical, so wall-based assertions
    // (calendar day, displayed time) can't red either.
    expect(zStamped.departs_at?.slice(0, 16)).toBe(details.departs_at?.slice(0, 16));
    expect(zStamped.arrives_at?.slice(0, 16)).toBe(details.arrives_at?.slice(0, 16));
    // The hostile eastbound shape is the opposite on the same assertions:
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).not.toBe(DATE_LINE_EASTBOUND.durationMs);
    expect(Math.sign(DATE_LINE_EASTBOUND.zStampedIntervalMs)).toBe(-1);
  });
});

describe("bug simulators — coherence with the real client composition", () => {
  it("zStamp reproduces form-model composeLocalDateTime's shape from the wall components", () => {
    // form-model.ts:205 — `${date}T${time}:00Z`.
    expect(zStamp(localISO("2027-04-24", "17:00", "+09:00"))).toBe("2027-04-24T17:00:00Z");
    expect(zStamp("2027-04-24T10:00:00-07:00")).toBe("2027-04-24T10:00:00Z");
  });

  it("zStampDetails z-stamps every datetime field and DROPS the *_tz fields (the edit-round-trip transform)", () => {
    const stamped = zStampDetails(DATE_LINE_EASTBOUND.details);
    expect(stamped).toEqual(DATE_LINE_EASTBOUND.zStamped);
    expect(stamped.departs_at).toBe(zStamp(DATE_LINE_EASTBOUND.details.departs_at ?? ""));
    expect(stamped.arrives_at).toBe(zStamp(DATE_LINE_EASTBOUND.details.arrives_at ?? ""));
    expect("departs_tz" in stamped).toBe(false);
    expect("arrives_tz" in stamped).toBe(false);
    // Non-datetime fields ride through untouched.
    expect(stamped.airline).toBe(DATE_LINE_EASTBOUND.details.airline);
  });
});

describe("multi-zone trip", () => {
  it("touches three DISTINCT IANA zones, two of which share an offset (offset ≠ zone)", () => {
    expect(new Set(MULTI_ZONE_TRIP.zones).size).toBe(3);
    const hop = MULTI_ZONE_TRIP.seoulHop;
    expect(hop.origin.offset).toBe(hop.destination.offset);
    expect(hop.origin.tz).not.toBe(hop.destination.tz);
  });

  it("travel-day scramble: real chronology checkout → departure → arrival; z-stamped sort puts the ARRIVAL FIRST", () => {
    const { checkout, departure, arrival } = MULTI_ZONE_TRIP.travelDayScramble;
    const byInstant = (values: string[]) => [...values].sort((a, b) => instantMs(a) - instantMs(b));

    expect(byInstant([checkout, departure, arrival])).toEqual([checkout, departure, arrival]);
    // Under the B-8 composition you land in LA before leaving your hotel.
    expect(byInstant([checkout, departure, arrival].map(zStamp))).toEqual(
      [arrival, checkout, departure].map(zStamp),
    );
  });

  it("the scramble triple is the trip's own Apr-24 data, not free-floating values", () => {
    expect(MULTI_ZONE_TRIP.travelDayScramble.checkout).toBe(MULTI_ZONE_TRIP.tokyoStayB.check_out);
    expect(MULTI_ZONE_TRIP.travelDayScramble.departure).toBe(
      MULTI_ZONE_TRIP.returnFlight.details.departs_at,
    );
    expect(MULTI_ZONE_TRIP.travelDayScramble.arrival).toBe(
      MULTI_ZONE_TRIP.returnFlight.details.arrives_at,
    );
  });

  it("the priced stays carry the trip's own lodging details and zero-decimal currencies", () => {
    expect(MULTI_ZONE_TRIP_CREATES[0]?.details).toBe(MULTI_ZONE_TRIP.tokyoStayB);
    expect(MULTI_ZONE_TRIP_CREATES[1]?.details).toBe(MULTI_ZONE_TRIP.seoulStay);
    expect(MULTI_ZONE_TRIP_CREATES.map((c) => c.currency)).toEqual(["JPY", "KRW"]);
  });
});

describe("DST boundary fixtures", () => {
  it("fall-back stay: endpoints carry DIFFERENT offsets; real duration 21h, uniform-offset composition says 20h", () => {
    const stay = DST_FALL_BACK_STAY;
    expect(stay.details.check_in?.slice(-6)).toBe("-07:00");
    expect(stay.details.check_out?.slice(-6)).toBe("-08:00");
    const real = instantMs(stay.details.check_out ?? "") - instantMs(stay.details.check_in ?? "");
    expect(real).toBe(stay.realDurationMs);
    expect(stay.realDurationMs).toBe(21 * HOUR);
    const naive = instantMs(stay.naiveUniformOffsetCheckOut) - instantMs(stay.details.check_in ?? "");
    expect(naive).toBe(stay.naiveUniformOffsetDurationMs);
    expect(naive).not.toBe(real); // the discriminating hour
  });

  it("the stay actually spans the transition instant", () => {
    const stay = DST_FALL_BACK_STAY;
    expect(instantMs(stay.details.check_in ?? "")).toBeLessThan(instantMs(stay.transitionUtc));
    expect(instantMs(stay.details.check_out ?? "")).toBeGreaterThan(instantMs(stay.transitionUtc));
  });

  it("spring-forward gap and fall-back ambiguity: the candidate resolutions differ by exactly 1h", () => {
    const gap = DST_SPRING_FORWARD_GAP;
    expect(instantMs(gap.candidates.standard) - instantMs(gap.candidates.daylight)).toBe(HOUR);
    const twice = DST_FALL_BACK_AMBIGUOUS;
    expect(instantMs(twice.candidates.standard) - instantMs(twice.candidates.daylight)).toBe(HOUR);
  });
});

describe("zero-decimal money fixtures", () => {
  it("every hostile amount is zero-decimal and DISCRIMINATES: correct text ≠ naive 2dp text (100× wrong)", () => {
    for (const fixture of [HOSTILE_MONEY.jpyStay, HOSTILE_MONEY.krwStay, HOSTILE_MONEY.krwOdd]) {
      expect(minorUnitDigits(fixture.currency)).toBe(0);
      expect(fixture.text).toBe(String(fixture.minorUnits));
      expect(fixture.naiveText).toBe(naiveTwoDecimalText(fixture.minorUnits));
      expect(fixture.text).not.toBe(fixture.naiveText);
    }
  });

  it("DISCRIMINATION: the USD control is the vacuous shape — correct and naive renderings coincide", () => {
    const usd = HOSTILE_MONEY.usdControl;
    expect(minorUnitDigits(usd.currency)).toBe(2);
    expect(usd.text).toBe(usd.naiveText);
    expect(usd.naiveText).toBe(naiveTwoDecimalText(usd.minorUnits));
  });

  it("krwOdd is not divisible by 100 — a /100→×100 'round-trip' cannot reproduce it", () => {
    expect(HOSTILE_MONEY.krwOdd.minorUnits % 100).not.toBe(0);
  });
});

describe("empty states and boundary strings", () => {
  it("minimalDetails is a valid member for all 8 categories (category is the only key)", () => {
    for (const category of BOOKING_CATEGORIES) {
      expect(EMPTY_STATES.minimalDetails(category)).toEqual({ category });
    }
  });

  it("empty-string flight fields are PRESENT and empty — distinct from absent", () => {
    expect(EMPTY_STATES.flightWithEmptyStrings.airline).toBe("");
    expect("airline" in EMPTY_STATES.flightWithEmptyStrings).toBe(true);
    expect(EMPTY_STATES.whitespaceTitle.trim()).toBe("");
  });

  it("boundary strings sit at EXACTLY the booking caps and one unit over (200/2000/2048 tiers)", () => {
    expect(BOUNDARY_STRINGS.nameAtCap.length).toBe(200);
    expect(BOUNDARY_STRINGS.nameOverCap.length).toBe(201);
    expect(BOUNDARY_STRINGS.notesAtCap.length).toBe(2000);
    expect(BOUNDARY_STRINGS.notesOverCap.length).toBe(2001);
    expect(BOUNDARY_STRINGS.urlAtCap.length).toBe(2048);
    expect(BOUNDARY_STRINGS.urlOverCap.length).toBe(2049);
  });

  it("astral strings split code units from characters: 101 suitcases = 202 UTF-16 units", () => {
    expect([...BOUNDARY_STRINGS.astralAtCap].length).toBe(100);
    expect(BOUNDARY_STRINGS.astralAtCap.length).toBe(200);
    expect([...BOUNDARY_STRINGS.astralOverCap].length).toBe(101);
    expect(BOUNDARY_STRINGS.astralOverCap.length).toBe(202);
  });
});
