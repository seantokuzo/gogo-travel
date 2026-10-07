/**
 * `todayInZone` / `isValidTimeZone` (B-30). Every case injects an EXPLICIT
 * instant — nothing here reads the process zone or the real clock, so the
 * suite is identical under any `TZ=` (the PR runs it under three).
 *
 * Falsification (what makes each group red) is stated beside it; every one
 * was exercised, not just written (PR body "mutation reds").
 */
import { afterEach, describe, expect, it } from "vitest";
import { isValidTimeZone, todayInZone } from "./time.js";

const at = (iso: string): Date => new Date(iso);

describe("todayInZone — west of UTC (the evening-flip class B-30 is about)", () => {
  it("2026-08-02T03:00Z is still Aug 1 in Los Angeles (PDT, UTC-7)", () => {
    expect(todayInZone(at("2026-08-02T03:00:00Z"), "America/Los_Angeles")).toBe("2026-08-01");
    // …while the UTC day (the old server rule) is already Aug 2.
    expect(todayInZone(at("2026-08-02T03:00:00Z"), "UTC")).toBe("2026-08-02");
  });

  it("flips exactly at local midnight (07:00Z in PDT), not a millisecond before", () => {
    expect(todayInZone(at("2026-08-02T06:59:59.999Z"), "America/Los_Angeles")).toBe("2026-08-01");
    expect(todayInZone(at("2026-08-02T07:00:00.000Z"), "America/Los_Angeles")).toBe("2026-08-02");
  });

  it("UTC-12 (Etc/GMT+12) lags UTC by half a day: flips at 12:00Z", () => {
    expect(todayInZone(at("2026-08-02T11:59:59.999Z"), "Etc/GMT+12")).toBe("2026-08-01");
    expect(todayInZone(at("2026-08-02T12:00:00.000Z"), "Etc/GMT+12")).toBe("2026-08-02");
  });
});

describe("todayInZone — east of UTC", () => {
  it("2026-08-01T20:00Z is already Aug 2 in Tokyo (JST, UTC+9)", () => {
    expect(todayInZone(at("2026-08-01T20:00:00Z"), "Asia/Tokyo")).toBe("2026-08-02");
    expect(todayInZone(at("2026-08-01T20:00:00Z"), "UTC")).toBe("2026-08-01");
  });

  it("flips exactly at local midnight (15:00Z in JST)", () => {
    expect(todayInZone(at("2026-08-01T14:59:59.999Z"), "Asia/Tokyo")).toBe("2026-08-01");
    expect(todayInZone(at("2026-08-01T15:00:00.000Z"), "Asia/Tokyo")).toBe("2026-08-02");
  });

  it("UTC+14 (Pacific/Kiritimati) leads UTC by 14h: flips at 10:00Z", () => {
    expect(todayInZone(at("2026-08-01T09:59:59.999Z"), "Pacific/Kiritimati")).toBe("2026-08-01");
    expect(todayInZone(at("2026-08-01T10:00:00.000Z"), "Pacific/Kiritimati")).toBe("2026-08-02");
  });

  it("crosses a year boundary and a leap day in the destination zone first", () => {
    expect(todayInZone(at("2026-12-31T20:00:00Z"), "Asia/Tokyo")).toBe("2027-01-01");
    expect(todayInZone(at("2028-02-28T20:00:00Z"), "Asia/Tokyo")).toBe("2028-02-29");
    expect(todayInZone(at("2027-01-01T03:00:00Z"), "America/Los_Angeles")).toBe("2026-12-31");
  });

  it("half-hour offsets: Asia/Calcutta (a tzdb BACKWARD link of Asia/Kolkata) resolves", () => {
    // UTC+5:30 — 18:30Z is exactly local midnight.
    expect(todayInZone(at("2026-08-01T18:29:59.999Z"), "Asia/Calcutta")).toBe("2026-08-01");
    expect(todayInZone(at("2026-08-01T18:30:00.000Z"), "Asia/Calcutta")).toBe("2026-08-02");
    // Backlink and canonical id agree (the iOS-Hermes NSTimeZone-fallback class).
    expect(todayInZone(at("2026-08-01T18:30:00.000Z"), "Asia/Kolkata")).toBe("2026-08-02");
  });
});

describe("todayInZone — DST edges (New York, 2026)", () => {
  it("spring forward 2026-03-08 (a 23h day): Mar 8 runs 05:00Z → 04:00Z next day", () => {
    expect(todayInZone(at("2026-03-08T04:59:59.999Z"), "America/New_York")).toBe("2026-03-07");
    expect(todayInZone(at("2026-03-08T05:00:00.000Z"), "America/New_York")).toBe("2026-03-08");
    // After the 07:00Z jump the offset is -4: the day ends at 04:00Z, not 05:00Z.
    expect(todayInZone(at("2026-03-09T03:59:59.999Z"), "America/New_York")).toBe("2026-03-08");
    expect(todayInZone(at("2026-03-09T04:00:00.000Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("fall back 2026-11-01 (a 25h day): Nov 1 runs 04:00Z → 05:00Z next day", () => {
    expect(todayInZone(at("2026-11-01T03:59:59.999Z"), "America/New_York")).toBe("2026-10-31");
    expect(todayInZone(at("2026-11-01T04:00:00.000Z"), "America/New_York")).toBe("2026-11-01");
    // 06:00Z is the replayed 01:00 — still Nov 1; the day ends at 05:00Z next day (EST, -5).
    expect(todayInZone(at("2026-11-01T06:30:00.000Z"), "America/New_York")).toBe("2026-11-01");
    expect(todayInZone(at("2026-11-02T04:59:59.999Z"), "America/New_York")).toBe("2026-11-01");
    expect(todayInZone(at("2026-11-02T05:00:00.000Z"), "America/New_York")).toBe("2026-11-02");
  });
});

describe("todayInZone — never throws; unknown zone degrades to the UTC date", () => {
  const instant = at("2026-08-01T20:00:00Z"); // Tokyo is Aug 2 here; UTC is Aug 1.

  it("null / undefined / empty → UTC", () => {
    expect(todayInZone(instant, null)).toBe("2026-08-01");
    expect(todayInZone(instant, undefined)).toBe("2026-08-01");
    expect(todayInZone(instant, "")).toBe("2026-08-01");
  });

  it("an id the engine rejects → UTC (not Tokyo, not a throw)", () => {
    expect(todayInZone(instant, "Mars/Olympus_Mons")).toBe("2026-08-01");
    expect(todayInZone(instant, "Not A Zone")).toBe("2026-08-01");
  });

  it("an over-long id (> 64 chars) → UTC without reaching the engine", () => {
    expect(todayInZone(instant, `Asia/${"T".repeat(60)}`)).toBe("2026-08-01");
  });

  it("an offset-style id is NOT an IANA zone → UTC on every engine (modern V8 would accept '+09:00'; Hermes would not)", () => {
    expect(todayInZone(instant, "+09:00")).toBe("2026-08-01");
    expect(todayInZone(instant, "UTC+9")).toBe("2026-08-01");
  });

  it("an invalid Date has no calendar day: fixed sentinel, no throw", () => {
    expect(todayInZone(new Date(Number.NaN), "Asia/Tokyo")).toBe("1970-01-01");
    expect(todayInZone(new Date(Number.NaN), null)).toBe("1970-01-01");
  });

  it("zero-pads month and day, 4-digit year (ISODate shape)", () => {
    expect(todayInZone(at("2026-01-05T12:00:00Z"), "UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayInZone(at("2026-01-05T12:00:00Z"), "Asia/Tokyo")).toBe("2026-01-05");
  });
});

describe("todayInZone — a misbehaving engine degrades to UTC, never to a believable wrong day", () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  afterEach(() => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
  });

  /** Replace Intl.DateTimeFormat with a stub whose formatToParts returns `parts`. */
  function stubIntl(parts: () => Intl.DateTimeFormatPart[]): void {
    class FakeDateTimeFormat {
      formatToParts(): Intl.DateTimeFormatPart[] {
        return parts();
      }
    }
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = FakeDateTimeFormat;
  }
  const part = (type: Intl.DateTimeFormatPartTypes, value: string): Intl.DateTimeFormatPart => ({
    type,
    value,
  });
  const instant = at("2026-08-01T12:00:00Z");

  it("an answer more than a day from the UTC day (impossible for any real zone) → UTC", () => {
    stubIntl(() => [
      part("month", "08"),
      part("literal", "/"),
      part("day", "07"),
      part("year", "2026"),
    ]);
    expect(todayInZone(instant, "Fake/Far_Day")).toBe("2026-08-01");
    // Falsification: delete the `Math.abs(zoneDayMs - utcDayMs) > DAY_MS` gate in time.ts → returns 2026-08-07.
  });

  it("a plausible one-day-off answer is honored (the gate is ±1, not 0)", () => {
    stubIntl(() => [part("month", "08"), part("day", "02"), part("year", "2026")]);
    expect(todayInZone(instant, "Fake/Plus_One")).toBe("2026-08-02");
  });

  it("missing / non-numeric / out-of-range parts → UTC", () => {
    stubIntl(() => [part("month", "08"), part("year", "2026")]); // no day
    expect(todayInZone(instant, "Fake/No_Day")).toBe("2026-08-01");
    stubIntl(() => [part("month", "Aug"), part("day", "01"), part("year", "2026")]);
    expect(todayInZone(instant, "Fake/Word_Month")).toBe("2026-08-01");
    stubIntl(() => [part("month", "13"), part("day", "01"), part("year", "2026")]);
    expect(todayInZone(instant, "Fake/Month_13")).toBe("2026-08-01");
  });

  it("formatToParts throwing → UTC", () => {
    stubIntl(() => {
      throw new RangeError("engine blew up");
    });
    expect(todayInZone(instant, "Fake/Throws")).toBe("2026-08-01");
  });

  it("caches one formatter per zone (construct once, reuse) and never caches a rejected id", () => {
    let constructed = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        constructed += 1; // before super(): a rejected id throws inside super()
        super(...args);
      }
    }
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = CountingDateTimeFormat;
    for (let i = 0; i < 5; i += 1) todayInZone(instant, "Europe/Lisbon");
    expect(constructed).toBe(1);
    // A bad id re-attempts each call but does not poison/grow the cache.
    for (let i = 0; i < 3; i += 1) todayInZone(instant, "Nowhere/Land");
    expect(constructed).toBe(1 + 3);
  });
});

describe("isValidTimeZone", () => {
  it("accepts canonical ids, backlinks and fixed Etc zones", () => {
    for (const tz of [
      "UTC",
      "Asia/Tokyo",
      "Asia/Calcutta",
      "Asia/Kolkata",
      "America/Argentina/Buenos_Aires",
      "Etc/GMT+12",
      "Pacific/Kiritimati",
    ]) {
      expect(isValidTimeZone(tz), tz).toBe(true);
    }
  });

  it("rejects empty, unknown, offset-style, over-long and shell-ish ids", () => {
    for (const tz of [
      "",
      "Nowhere/Land",
      "+05:00",
      "Asia/Tokyo; DROP TABLE trips",
      `Asia/${"T".repeat(60)}`,
      "Asia//Tokyo",
      "/Asia/Tokyo",
    ]) {
      expect(isValidTimeZone(tz), tz).toBe(false);
    }
  });

  it("the 64-char cap: a 65-char id is rejected BEFORE the engine, a 64-char one reaches it", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let constructed = 0;
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        constructed += 1; // before super(): a rejected id throws inside super()
        super(...args);
      }
    }
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = CountingDateTimeFormat;
    try {
      expect(isValidTimeZone(`A${"b".repeat(64)}`)).toBe(false); // 65 chars
      expect(constructed).toBe(0);
      expect(isValidTimeZone(`A${"b".repeat(63)}`)).toBe(false); // 64 chars, unknown to the engine
      expect(constructed).toBe(1);
    } finally {
      (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealDateTimeFormat;
    }
  });
});
