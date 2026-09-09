/**
 * Zoned composition × hostile fixtures (B-9 client half / B-8's real fix).
 *
 * The four shapes naive offset math gets wrong, each pinned against the
 * shared fixture pack (`@gogo/shared/testing`) where one exists:
 *
 *  1. the EASTBOUND DATE-LINE flight (NRT→LAX — Sean's real booking),
 *  2. both DST edges — the fall-back replay and the spring-forward gap,
 *  3. a ZERO-offset zone (where "+00:00" and a dropped offset look alike),
 *  4. SUB-HOUR offsets — Kathmandu (+05:45) and Chatham (+12:45/+13:45),
 *     which break every "offset = whole hours" shortcut.
 *
 * Discrimination (mobile.md's vacuous-pin taxonomy): each arm carries a
 * NAIVE twin — the same assertion under uniform-offset or Z-stamped
 * composition — and asserts the two DIFFER. An arm where naive and correct
 * agree proves nothing, and this file says so out loud rather than
 * accumulating green.
 */
import {
  DATE_LINE_EASTBOUND,
  DATE_LINE_EASTBOUND_EXTREME,
  DATE_LINE_WESTBOUND,
  DST_FALL_BACK_AMBIGUOUS,
  DST_FALL_BACK_STAY,
  DST_SPRING_FORWARD_GAP,
  NAIVE_CONTROL_FLIGHT,
  instantMs,
  type HostileFlight,
} from "@gogo/shared/testing";
import { wallDate, wallTime } from "@gogo/shared";

import { composeZonedDateTime, resolveWallTime, zoneOffsetMinutesAt } from "./zoned-time";

const HOUR = 3_600_000;

/** Compose an endpoint the way the form does: its wall values, in its zone. */
function composeEndpoint(endpoint: HostileFlight["origin"]): string | null {
  return composeZonedDateTime(endpoint.date, endpoint.time, endpoint.tz);
}

// ---------------------------------------------------------------------------
// 1. The date-line arm — the B-8 trap itself
// ---------------------------------------------------------------------------

describe("[1] eastbound date-line: the real NRT→LAX flight", () => {
  it("both endpoints compose to the fixture's own correct strings, offsets and all", () => {
    expect(composeEndpoint(DATE_LINE_EASTBOUND.origin)).toBe(
      DATE_LINE_EASTBOUND.details.departs_at,
    );
    expect(composeEndpoint(DATE_LINE_EASTBOUND.destination)).toBe(
      DATE_LINE_EASTBOUND.details.arrives_at,
    );
  });

  it("the composed instants span the REAL 9h — an arrival wall clock 7h 'before' departure", () => {
    const depart = instantMs(composeEndpoint(DATE_LINE_EASTBOUND.origin) ?? "");
    const arrive = instantMs(composeEndpoint(DATE_LINE_EASTBOUND.destination) ?? "");
    expect(arrive - depart).toBe(9 * HOUR);
    expect(arrive - depart).toBe(DATE_LINE_EASTBOUND.durationMs);
    // Discrimination: the wall clocks alone invert. Any implementation that
    // ignored the zones would land on the fixture's Z-stamped interval.
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).toBe(-7 * HOUR);
    expect(DATE_LINE_EASTBOUND.zStampedIntervalMs).not.toBe(9 * HOUR);
  });

  it("westbound and the extreme AKL→PPT hop compose correctly too", () => {
    for (const fixture of [DATE_LINE_WESTBOUND, DATE_LINE_EASTBOUND_EXTREME]) {
      const depart = instantMs(composeEndpoint(fixture.origin) ?? "");
      const arrive = instantMs(composeEndpoint(fixture.destination) ?? "");
      expect(arrive - depart).toBe(fixture.durationMs);
      expect(fixture.zStampedIntervalMs).not.toBe(fixture.durationMs);
    }
  });

  it("CONTROL: the same-zone flight composes identically under both — so it can never see this bug", () => {
    const depart = instantMs(composeEndpoint(NAIVE_CONTROL_FLIGHT.origin) ?? "");
    const arrive = instantMs(composeEndpoint(NAIVE_CONTROL_FLIGHT.destination) ?? "");
    expect(arrive - depart).toBe(NAIVE_CONTROL_FLIGHT.durationMs);
    expect(NAIVE_CONTROL_FLIGHT.zStampedIntervalMs).toBe(NAIVE_CONTROL_FLIGHT.durationMs);
  });
});

// ---------------------------------------------------------------------------
// 2. DST edges — the offset that changes UNDER a single booking
// ---------------------------------------------------------------------------

describe("[2] DST boundaries", () => {
  it("the fall-back STAY resolves its two endpoints to DIFFERENT offsets (21h, not the naive 20h)", () => {
    // The uniform-offset corruption class: resolving the offset ONCE per
    // booking (from check-in) instead of once per endpoint loses the
    // transition hour. This is the arm that survives a "we have zones now"
    // half-fix, so it is pinned on the composition, not just on the form.
    const ci = DST_FALL_BACK_STAY.details.check_in ?? "";
    const co = DST_FALL_BACK_STAY.details.check_out ?? "";
    const checkIn = composeZonedDateTime(wallDate(ci), wallTime(ci), DST_FALL_BACK_STAY.tz);
    const checkOut = composeZonedDateTime(wallDate(co), wallTime(co), DST_FALL_BACK_STAY.tz);
    expect(checkIn).toBe(ci);
    expect(checkOut).toBe(co);
    expect(instantMs(checkOut ?? "") - instantMs(checkIn ?? "")).toBe(
      DST_FALL_BACK_STAY.realDurationMs,
    );

    // Discrimination: the naive per-BOOKING offset (check-in's −07:00
    // applied to check-out) is the fixture's precomputed wrong string, and
    // it is an hour short.
    expect(checkOut).not.toBe(DST_FALL_BACK_STAY.naiveUniformOffsetCheckOut);
    expect(
      instantMs(DST_FALL_BACK_STAY.naiveUniformOffsetCheckOut) - instantMs(checkIn ?? ""),
    ).toBe(DST_FALL_BACK_STAY.naiveUniformOffsetDurationMs);
    expect(DST_FALL_BACK_STAY.naiveUniformOffsetDurationMs).not.toBe(
      DST_FALL_BACK_STAY.realDurationMs,
    );
  });

  it("AMBIGUOUS wall time (clocks repeat 01:30) takes the EARLIER instant — Temporal's `compatible` rule", () => {
    // 2027-11-07 01:30 exists TWICE in America/Los_Angeles. BOTH fixture
    // candidates are legal strings; the disambiguation must be a decision,
    // not an accident of iteration order.
    const { tz, date, time } = DST_FALL_BACK_AMBIGUOUS;
    const resolved = resolveWallTime(tz, date, time);
    expect(resolved?.kind).toBe("ambiguous");
    const composed = composeZonedDateTime(date, time, tz);
    expect(composed).toBe(DST_FALL_BACK_AMBIGUOUS.candidates.daylight);
    expect(composed).not.toBe(DST_FALL_BACK_AMBIGUOUS.candidates.standard);
    // Earlier of the two instants, by one hour.
    expect(instantMs(DST_FALL_BACK_AMBIGUOUS.candidates.standard) - instantMs(composed ?? "")).toBe(
      HOUR,
    );
  });

  it("GAP wall time (02:30 never happens) takes the PRE-transition offset — the wall values the user typed survive", () => {
    // 2027-03-14 02:30 does not exist in America/Los_Angeles. The composed
    // string keeps 02:30 (the server slices wall components for display,
    // §3.3) while the instant lands an hour later — the same resolution
    // java.time and Luxon reach.
    const { tz, date, time } = DST_SPRING_FORWARD_GAP;
    const resolved = resolveWallTime(tz, date, time);
    expect(resolved?.kind).toBe("gap");
    const composed = composeZonedDateTime(date, time, tz);
    expect(composed).toBe(DST_SPRING_FORWARD_GAP.candidates.standard);
    expect(composed).not.toBe(DST_SPRING_FORWARD_GAP.candidates.daylight);
    expect(wallTime(composed ?? "")).toBe(time);
    // The instant it denotes is 03:30 local — the zone's own answer.
    expect(zoneOffsetMinutesAt(DST_SPRING_FORWARD_GAP.tz, instantMs(composed ?? ""))).toBe(-420);
  });

  it("a wall time either side of a transition is UNIQUE — the edges are edges, not a blanket", () => {
    // Falsification for the two pins above: if `resolveWallTime` reported
    // every time as ambiguous/gap they would still pass. It must not.
    expect(resolveWallTime("America/Los_Angeles", "2027-11-07", "04:00")?.kind).toBe("unique");
    expect(resolveWallTime("America/Los_Angeles", "2027-03-14", "05:00")?.kind).toBe("unique");
    expect(resolveWallTime("America/Los_Angeles", "2027-06-14", "02:30")?.kind).toBe("unique");
  });
});

// ---------------------------------------------------------------------------
// 3. Zero offset — where a dropped offset is invisible
// ---------------------------------------------------------------------------

describe("[3] zero-offset zones", () => {
  it("UTC composes an EXPLICIT +00:00, and Europe/London's zero is seasonal (not a constant)", () => {
    expect(composeZonedDateTime("2027-04-24", "17:00", "UTC")).toBe("2027-04-24T17:00:00+00:00");
    // The trap: London is +00:00 in January and +01:00 in July, so a zone
    // whose offset is zero SOMETIMES is exactly where "it's basically UTC"
    // goes wrong. This is also the shape that makes a Z-stamped value look
    // correct half the year.
    expect(composeZonedDateTime("2027-01-24", "17:00", "Europe/London")).toBe(
      "2027-01-24T17:00:00+00:00",
    );
    expect(composeZonedDateTime("2027-07-24", "17:00", "Europe/London")).toBe(
      "2027-07-24T17:00:00+01:00",
    );
  });

  it("a zero-offset composition denotes the same instant as the `Z` shape — the reason this arm needs its own pin", () => {
    // Discrimination stated plainly: on this arm correct and Z-stamped
    // AGREE, so no ordering/instant assertion here can ever catch B-8. The
    // arm exists to pin the +00:00 SHAPE and the seasonal London case.
    expect(instantMs("2027-01-24T17:00:00+00:00")).toBe(instantMs("2027-01-24T17:00:00Z"));
    expect(instantMs("2027-07-24T17:00:00+01:00")).not.toBe(instantMs("2027-07-24T17:00:00Z"));
  });
});

// ---------------------------------------------------------------------------
// 4. Sub-hour offsets — where whole-hour math silently truncates
// ---------------------------------------------------------------------------

describe("[4] sub-hour offsets", () => {
  it("Kathmandu is +05:45 — a 45-minute offset survives composition intact", () => {
    const composed = composeZonedDateTime("2027-04-24", "17:00", "Asia/Kathmandu");
    expect(composed).toBe("2027-04-24T17:00:00+05:45");
    // Whole-hour truncation (+05:00) would be 45 minutes off — the class of
    // error a `Math.round(offset / 60)` shortcut produces.
    expect(instantMs(composed ?? "")).toBe(instantMs("2027-04-24T11:15:00Z"));
    expect(instantMs(composed ?? "")).not.toBe(instantMs("2027-04-24T12:00:00Z"));
  });

  it("India (+05:30) and the Marquesas (-09:30) both keep their half hour, in both signs", () => {
    expect(composeZonedDateTime("2027-04-24", "09:00", "Asia/Kolkata")).toBe(
      "2027-04-24T09:00:00+05:30",
    );
    // A NEGATIVE sub-hour offset: sign handling on the minutes half is a
    // separate bug from sign handling on the hours half.
    expect(composeZonedDateTime("2027-04-24", "09:00", "Pacific/Marquesas")).toBe(
      "2027-04-24T09:00:00-09:30",
    );
  });

  it("Chatham combines a 45-minute offset WITH DST — +12:45 in winter, +13:45 in summer", () => {
    // The compound case: sub-hour AND seasonal. Southern hemisphere, so
    // July is standard time and January is daylight.
    expect(composeZonedDateTime("2027-07-24", "09:00", "Pacific/Chatham")).toBe(
      "2027-07-24T09:00:00+12:45",
    );
    expect(composeZonedDateTime("2027-01-24", "09:00", "Pacific/Chatham")).toBe(
      "2027-01-24T09:00:00+13:45",
    );
    // And its DST edges are still edges — the transition is 45 minutes past
    // the hour, which a whole-hour transition model would place wrongly.
    expect(zoneOffsetMinutesAt("Pacific/Chatham", Date.UTC(2027, 6, 1, 0, 0, 0))).toBe(765);
    expect(zoneOffsetMinutesAt("Pacific/Chatham", Date.UTC(2027, 0, 1, 0, 0, 0))).toBe(825);
  });

  it("a Kathmandu→Tokyo leg's duration is a whole-hour value PLUS 15 minutes — the arithmetic, not just the string", () => {
    // KTM 17:00 (+05:45) → NRT 06:30 next day (+09:00): 10h 15m real. A
    // whole-hour offset table would report 11h.
    const depart = instantMs(composeZonedDateTime("2027-04-24", "17:00", "Asia/Kathmandu") ?? "");
    const arrive = instantMs(composeZonedDateTime("2027-04-25", "06:30", "Asia/Tokyo") ?? "");
    expect(arrive - depart).toBe(10 * HOUR + 15 * 60_000);
    expect(arrive - depart).not.toBe(11 * HOUR);
  });
});
