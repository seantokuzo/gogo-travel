import { describe, expect, it } from "vitest";
import {
  CentsSchema,
  CurrencyCodeSchema,
  ISODateSchema,
  ISODateTimeSchema,
  ISOTimeSchema,
  LatSchema,
  LngSchema,
  PositiveCentsSchema,
  UuidSchema,
} from "./scalars.js";

describe("Cents (Law #2)", () => {
  it("accepts non-negative integers", () => {
    expect(CentsSchema.parse(0)).toBe(0);
    expect(CentsSchema.parse(123456)).toBe(123456);
  });
  it("rejects floats", () => {
    expect(CentsSchema.safeParse(10.5).success).toBe(false);
    expect(CentsSchema.safeParse(0.1).success).toBe(false);
  });
  it("rejects negatives", () => {
    expect(CentsSchema.safeParse(-1).success).toBe(false);
  });
  it("rejects string amounts", () => {
    expect(CentsSchema.safeParse("100").success).toBe(false);
  });
});

describe("PositiveCents", () => {
  it("rejects 0", () => {
    expect(PositiveCentsSchema.safeParse(0).success).toBe(false);
  });
  it("accepts 1", () => {
    expect(PositiveCentsSchema.parse(1)).toBe(1);
  });
  it("rejects floats and negatives", () => {
    expect(PositiveCentsSchema.safeParse(1.5).success).toBe(false);
    expect(PositiveCentsSchema.safeParse(-5).success).toBe(false);
  });
});

describe("CurrencyCode (ISO-4217)", () => {
  it("accepts uppercase 3-letter codes", () => {
    expect(CurrencyCodeSchema.parse("USD")).toBe("USD");
    expect(CurrencyCodeSchema.parse("JPY")).toBe("JPY");
  });
  it("rejects lowercase", () => {
    expect(CurrencyCodeSchema.safeParse("usd").success).toBe(false);
  });
  it("rejects wrong lengths and symbols", () => {
    expect(CurrencyCodeSchema.safeParse("US").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("USDT").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("U$D").success).toBe(false);
  });
});

describe("ISO date/time scalars (R-shared-11)", () => {
  it("ISODate accepts YYYY-MM-DD only", () => {
    expect(ISODateSchema.parse("2026-07-10")).toBe("2026-07-10");
    expect(ISODateSchema.safeParse("07/10/2026").success).toBe(false);
    expect(ISODateSchema.safeParse("2026-7-1").success).toBe(false);
  });
  it("ISODateTime accepts instants with offset or Z", () => {
    expect(ISODateTimeSchema.parse("2026-07-10T12:00:00Z")).toBe("2026-07-10T12:00:00Z");
    expect(ISODateTimeSchema.parse("2026-07-10T12:00:00+09:00")).toBe("2026-07-10T12:00:00+09:00");
    expect(ISODateTimeSchema.safeParse("2026-07-10 12:00:00").success).toBe(false);
  });
  it("ISODateTime rejects epoch numbers", () => {
    expect(ISODateTimeSchema.safeParse(1760000000000).success).toBe(false);
  });
  it("ISOTime accepts HH:MM 24-hour wall times", () => {
    expect(ISOTimeSchema.parse("00:00")).toBe("00:00");
    expect(ISOTimeSchema.parse("23:59")).toBe("23:59");
    expect(ISOTimeSchema.safeParse("24:00").success).toBe(false);
    expect(ISOTimeSchema.safeParse("9:30").success).toBe(false);
    expect(ISOTimeSchema.safeParse("09:30:00").success).toBe(false);
  });
});

describe("Uuid", () => {
  it("accepts uuids, rejects junk", () => {
    expect(UuidSchema.parse("6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c")).toBeTruthy();
    expect(UuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("Lat/Lng range refinements", () => {
  it("bounds latitude to ±90", () => {
    expect(LatSchema.parse(90)).toBe(90);
    expect(LatSchema.parse(-90)).toBe(-90);
    expect(LatSchema.safeParse(90.01).success).toBe(false);
  });
  it("bounds longitude to ±180", () => {
    expect(LngSchema.parse(-180)).toBe(-180);
    expect(LngSchema.safeParse(180.5).success).toBe(false);
  });
});
