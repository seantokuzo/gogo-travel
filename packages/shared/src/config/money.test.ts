import { describe, expect, it } from "vitest";
import { BOOKING_CATEGORIES, ExpenseCategorySchema } from "../enums.js";
import {
  BOOKING_TO_EXPENSE_CATEGORY,
  centsToMoneyText,
  minorUnitDigits,
  parseMoneyToCents,
  ZERO_DECIMAL_CURRENCIES,
} from "./money.js";

describe("minorUnitDigits (ruling ② — hand-rolled zero-decimal list)", () => {
  it("zero-decimal currencies report 0; everything else 2", () => {
    for (const code of ZERO_DECIMAL_CURRENCIES) expect(minorUnitDigits(code)).toBe(0);
    for (const code of ["USD", "EUR", "GBP", "AUD", "MXN", "THB"]) {
      expect(minorUnitDigits(code)).toBe(2);
    }
  });

  it("is case-insensitive and defaults unknown codes to 2", () => {
    expect(minorUnitDigits("jpy")).toBe(0);
    expect(minorUnitDigits("Krw")).toBe(0);
    expect(minorUnitDigits("usd")).toBe(2);
    expect(minorUnitDigits("ZZZ")).toBe(2);
    expect(minorUnitDigits("")).toBe(2);
  });
});

describe("parseMoneyToCents (R-cmoney-8 — ISO-4217-aware, string math)", () => {
  it("2-decimal currencies: spec pins parse exactly", () => {
    expect(parseMoneyToCents("25.50", "USD")).toEqual({ ok: true, cents: 2550 });
    expect(parseMoneyToCents("25.5", "USD")).toEqual({ ok: true, cents: 2550 });
    expect(parseMoneyToCents("120", "USD")).toEqual({ ok: true, cents: 12000 });
    expect(parseMoneyToCents("89,9", "EUR")).toEqual({ ok: true, cents: 8990 });
    expect(parseMoneyToCents("0.05", "USD")).toEqual({ ok: true, cents: 5 });
    // The classic float trap: 0.1 + 0.2 territory stays exact via strings.
    expect(parseMoneyToCents("0.29", "USD")).toEqual({ ok: true, cents: 29 });
  });

  it("zero-decimal currencies: whole text IS the minor units (JPY '1500' → 1500)", () => {
    expect(parseMoneyToCents("1500", "JPY")).toEqual({ ok: true, cents: 1500 });
    expect(parseMoneyToCents("2550", "JPY")).toEqual({ ok: true, cents: 2550 });
    expect(parseMoneyToCents(" 300 ", "KRW")).toEqual({ ok: true, cents: 300 });
    // Control arm: the SAME text under a 2-decimal currency scales ×100.
    expect(parseMoneyToCents("1500", "USD")).toEqual({ ok: true, cents: 150000 });
  });

  it("zero-decimal currencies reject any decimal separator (control: same text parses under USD)", () => {
    for (const bad of ["1500.5", "1500.00", "1500,5"]) {
      expect(parseMoneyToCents(bad, "JPY").ok).toBe(false);
      // Ungated control arm: the rejection is the CURRENCY's, not the parser
      // rejecting everything — identical text is valid for a 2dp currency.
      expect(parseMoneyToCents(bad, "USD").ok).toBe(true);
    }
  });

  it("rejects junk for every currency (negatives, letters, 3 decimals, thousands separators)", () => {
    for (const bad of ["-5", "abc", "25.505", "1.234", "1,234.56", "12.", ""]) {
      expect(parseMoneyToCents(bad, "USD").ok).toBe(false);
      expect(parseMoneyToCents(bad, "JPY").ok).toBe(false);
    }
  });
});

describe("centsToMoneyText (§2.5 shared formatting rules)", () => {
  it("spec pins: USD 2550 → '25.50'; JPY 2550 → '2550'", () => {
    expect(centsToMoneyText(2550, "USD")).toBe("25.50");
    expect(centsToMoneyText(2550, "JPY")).toBe("2550");
  });

  it("default keeps FIXED minor digits (rail-link shape); omitZeroMinor drops an all-zero minor part", () => {
    expect(centsToMoneyText(12000, "USD")).toBe("120.00");
    expect(centsToMoneyText(12000, "USD", { omitZeroMinor: true })).toBe("120");
    expect(centsToMoneyText(8999, "USD", { omitZeroMinor: true })).toBe("89.99");
    expect(centsToMoneyText(5, "USD")).toBe("0.05");
    expect(centsToMoneyText(5, "USD", { omitZeroMinor: true })).toBe("0.05");
    expect(centsToMoneyText(0, "USD")).toBe("0.00");
    expect(centsToMoneyText(0, "USD", { omitZeroMinor: true })).toBe("0");
    expect(centsToMoneyText(0, "JPY")).toBe("0");
    expect(centsToMoneyText(1500, "JPY", { omitZeroMinor: true })).toBe("1500");
  });

  it("round-trips through parseMoneyToCents for both minor-unit shapes", () => {
    for (const cents of [1, 5, 99, 100, 101, 2550, 8999, 12000, 9999999]) {
      expect(parseMoneyToCents(centsToMoneyText(cents, "USD"), "USD")).toEqual({
        ok: true,
        cents,
      });
      expect(parseMoneyToCents(centsToMoneyText(cents, "JPY"), "JPY")).toEqual({
        ok: true,
        cents,
      });
    }
  });

  it("throws on floats and negatives (Law #2 — sign is structural, never formatted)", () => {
    expect(() => centsToMoneyText(25.5, "USD")).toThrow(RangeError);
    expect(() => centsToMoneyText(-1, "USD")).toThrow(RangeError);
    expect(() => centsToMoneyText(Number.NaN, "JPY")).toThrow(RangeError);
  });
});

describe("BOOKING_TO_EXPENSE_CATEGORY (client money spec §2.3 verbatim)", () => {
  it("matches the §2.3 table exactly", () => {
    expect(BOOKING_TO_EXPENSE_CATEGORY).toEqual({
      lodging: "lodging",
      flight: "transport",
      train: "transport",
      car_rental: "transport",
      moped_rental: "transport",
      activity: "activities",
      restaurant: "food",
      other: "other",
    });
  });

  it("covers every booking category and lands on valid expense categories", () => {
    expect(Object.keys(BOOKING_TO_EXPENSE_CATEGORY).sort()).toEqual([...BOOKING_CATEGORIES].sort());
    for (const value of Object.values(BOOKING_TO_EXPENSE_CATEGORY)) {
      expect(ExpenseCategorySchema.safeParse(value).success).toBe(true);
    }
  });
});
