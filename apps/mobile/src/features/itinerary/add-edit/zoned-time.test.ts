/**
 * Zoned composition core (B-9 client half) — the mechanics.
 *
 * The hostile-fixture arms (date-line, DST edges, zero-offset, sub-hour
 * offsets) live in `zoned-time.hostile.test.ts`; this file pins the pieces
 * those arms are built from: offset resolution, ICU zone recognition,
 * formatting, and the display helpers.
 *
 * No fake timers anywhere: every function here is a pure function of
 * (zone, wall values) except `deviceTimeZone`/`referenceInstantFor`, whose
 * clock is injected.
 */
import {
  composeZonedDateTime,
  describeTimeZone,
  deviceTimeZone,
  formatUtcOffset,
  gmtLabelOf,
  isKnownTimeZone,
  referenceInstantFor,
  resolveWallTime,
  zoneCityLabel,
  zoneOffsetMinutesAt,
  zoneRegionLabel,
} from "./zoned-time";

describe("isKnownTimeZone", () => {
  it("accepts canonical ids AND tzdb backward links; rejects junk and empty", () => {
    expect(isKnownTimeZone("Asia/Tokyo")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    // A backward link — the seed dataset and older devices both emit these.
    expect(isKnownTimeZone("Asia/Calcutta")).toBe(true);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
    // Cached both ways — a second call must agree with the first.
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("Asia/Tokyo")).toBe(true);
  });
});

describe("zoneOffsetMinutesAt", () => {
  it("reads the offset in force AT the instant, not a fixed per-zone constant", () => {
    // The same zone, six months apart — a fixed-offset table gets one wrong.
    const july = Date.UTC(2027, 6, 1, 12, 0, 0);
    const january = Date.UTC(2027, 0, 1, 12, 0, 0);
    expect(zoneOffsetMinutesAt("America/Los_Angeles", july)).toBe(-420);
    expect(zoneOffsetMinutesAt("America/Los_Angeles", january)).toBe(-480);
    // A no-DST zone stays put across the same pair.
    expect(zoneOffsetMinutesAt("Asia/Tokyo", july)).toBe(540);
    expect(zoneOffsetMinutesAt("Asia/Tokyo", january)).toBe(540);
    expect(zoneOffsetMinutesAt("UTC", july)).toBe(0);
  });

  it("sub-second input can't round the offset to the wrong minute", () => {
    // The formatter reads whole seconds; a 999ms residue must be dropped,
    // not rounded up into the next minute.
    const base = Date.UTC(2027, 3, 24, 8, 0, 0);
    expect(zoneOffsetMinutesAt("Asia/Kathmandu", base + 999)).toBe(345);
    expect(zoneOffsetMinutesAt("Asia/Kathmandu", base - 1)).toBe(345);
  });

  it("midnight reads as hour 00, never 24 (the h23 hourCycle)", () => {
    // 15:00Z on Apr 24 is exactly 00:00 Apr 25 in Tokyo — an engine that
    // renders "24" would compute a 24h offset error here.
    expect(zoneOffsetMinutesAt("Asia/Tokyo", Date.UTC(2027, 3, 24, 15, 0, 0))).toBe(540);
  });
});

describe("resolveWallTime", () => {
  it("a normal wall time resolves uniquely", () => {
    expect(resolveWallTime("Asia/Tokyo", "2027-04-24", "17:00")).toEqual({
      offsetMinutes: 540,
      kind: "unique",
    });
  });

  it("rejects an unknown zone and malformed wall values instead of throwing", () => {
    expect(resolveWallTime("Not/AZone", "2027-04-24", "17:00")).toBeNull();
    expect(resolveWallTime("Asia/Tokyo", "2027-4-24", "17:00")).toBeNull();
    expect(resolveWallTime("Asia/Tokyo", "2027-04-24", "5:00")).toBeNull();
    expect(resolveWallTime("Asia/Tokyo", "", "")).toBeNull();
  });
});

describe("formatUtcOffset", () => {
  it("renders the wire's ±HH:MM for whole, sub-hour and zero offsets", () => {
    expect(formatUtcOffset(540)).toBe("+09:00");
    expect(formatUtcOffset(-420)).toBe("-07:00");
    expect(formatUtcOffset(345)).toBe("+05:45");
    expect(formatUtcOffset(-570)).toBe("-09:30");
    // Zero is POSITIVE-signed: "+00:00", the shape the fixtures pin.
    expect(formatUtcOffset(0)).toBe("+00:00");
    expect(formatUtcOffset(840)).toBe("+14:00");
  });
});

describe("composeZonedDateTime", () => {
  it("produces the wire shape with the zone's offset AT that wall time", () => {
    expect(composeZonedDateTime("2027-04-24", "17:00", "Asia/Tokyo")).toBe(
      "2027-04-24T17:00:00+09:00",
    );
    expect(composeZonedDateTime("2027-04-24", "10:00", "America/Los_Angeles")).toBe(
      "2027-04-24T10:00:00-07:00",
    );
    // Same zone, winter — the offset moves, the wall values do not.
    expect(composeZonedDateTime("2027-01-24", "10:00", "America/Los_Angeles")).toBe(
      "2027-01-24T10:00:00-08:00",
    );
  });

  it("null (never a throw) for an unknown zone or malformed wall values", () => {
    expect(composeZonedDateTime("2027-04-24", "17:00", "Not/AZone")).toBeNull();
    expect(composeZonedDateTime("2027-04-24", "17:00", "")).toBeNull();
    expect(composeZonedDateTime("", "17:00", "Asia/Tokyo")).toBeNull();
  });
});

describe("deviceTimeZone", () => {
  it("returns an ICU-resolvable zone id", () => {
    const tz = deviceTimeZone();
    expect(typeof tz).toBe("string");
    expect(isKnownTimeZone(tz)).toBe(true);
  });
});

describe("display helpers", () => {
  it("city/region labels split the id, spacing underscores", () => {
    expect(zoneCityLabel("Asia/Tokyo")).toBe("Tokyo");
    expect(zoneCityLabel("America/Los_Angeles")).toBe("Los Angeles");
    expect(zoneCityLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(zoneCityLabel("UTC")).toBe("UTC");
    expect(zoneRegionLabel("Asia/Tokyo")).toBe("Asia");
    expect(zoneRegionLabel("America/Argentina/Buenos_Aires")).toBe("America");
    expect(zoneRegionLabel("UTC")).toBe("");
  });

  it("GMT labels are human, never a bare ±HH:MM", () => {
    expect(gmtLabelOf(540)).toBe("GMT+9");
    expect(gmtLabelOf(-420)).toBe("GMT-7");
    expect(gmtLabelOf(345)).toBe("GMT+5:45");
    expect(gmtLabelOf(0)).toBe("GMT");
  });

  it("describeTimeZone is null for an unknown id rather than throwing", () => {
    expect(describeTimeZone("Not/AZone", Date.now())).toBeNull();
    expect(describeTimeZone("Asia/Tokyo", Date.UTC(2027, 3, 24, 0, 0, 0))).toEqual({
      id: "Asia/Tokyo",
      city: "Tokyo",
      region: "Asia",
      gmt: "GMT+9",
    });
  });

  it("referenceInstantFor anchors on noon of the wall date, else the injected clock", () => {
    expect(referenceInstantFor("2027-04-24")).toBe(Date.UTC(2027, 3, 24, 12, 0, 0));
    expect(referenceInstantFor(undefined, () => 1234)).toBe(1234);
    // A malformed date falls back to the clock, never NaN.
    expect(referenceInstantFor("nope", () => 1234)).toBe(1234);
  });

  it("the seasonal display: the SAME zone reads GMT-7 in April and GMT-8 in January", () => {
    // Why `referenceDate` is threaded through the pickers at all — a picker
    // labelled from `Date.now()` would lie about a trip six months out.
    expect(describeTimeZone("America/Los_Angeles", referenceInstantFor("2027-04-24"))?.gmt).toBe(
      "GMT-7",
    );
    expect(describeTimeZone("America/Los_Angeles", referenceInstantFor("2027-01-24"))?.gmt).toBe(
      "GMT-8",
    );
  });
});
