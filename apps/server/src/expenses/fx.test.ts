/**
 * R-money-6 FX-pair consistency units (T-9.2): the recorded interpretation
 * — `base_amount_cents` must be the floor or ceiling of the exact rational
 * `amount × rate × 10^(minorDigits(base) − minorDigits(currency))`; when
 * exact IS an integer only that integer passes. All-BigInt arithmetic
 * (Law #2 — no float intermediates), including the minor-unit exponent
 * cross-currency lanes (JPY↔USD both directions) and non-terminating
 * rationals.
 */
import { describe, expect, it } from "vitest";
import { isFxPairConsistent } from "./fx.js";

describe("isFxPairConsistent (R-money-6 — T-9.2)", () => {
  it("same-exponent pair (EUR→USD): exact integer product admits ONLY itself", () => {
    const args = { amountCents: 1000, fxRate: "1.08", currency: "EUR", baseCurrency: "USD" };
    // 1000 × 1.08 = 1080.00 exactly.
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1080 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1079 })).toBe(false);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1081 })).toBe(false);
  });

  it("zero-decimal → two-decimal (JPY→USD): exponent diff +2 rides the numerator", () => {
    const args = { amountCents: 1500, fxRate: "0.0067", currency: "JPY", baseCurrency: "USD" };
    // 1500 yen × 0.0067 = $10.05 → 1005 US cents exactly.
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1005 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1004 })).toBe(false);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1006 })).toBe(false);
  });

  it("two-decimal → zero-decimal (USD→JPY): exponent diff −2 rides the denominator; fractional exact admits floor AND ceil", () => {
    const args = { amountCents: 2550, fxRate: "149.5", currency: "USD", baseCurrency: "JPY" };
    // $25.50 × 149.5 = ¥3812.25 → floor 3812 or ceil 3813 (any sane client rounding).
    expect(isFxPairConsistent({ ...args, baseAmountCents: 3812 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 3813 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 3811 })).toBe(false);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 3814 })).toBe(false);
  });

  it("zero-decimal → zero-decimal (JPY→KRW): exponent diff 0", () => {
    const args = { amountCents: 1000, fxRate: "9.6", currency: "JPY", baseCurrency: "KRW" };
    expect(isFxPairConsistent({ ...args, baseAmountCents: 9600 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 9601 })).toBe(false);
  });

  it("non-terminating rational (rate 0.33333333): floor/ceil window, nothing wider", () => {
    const args = {
      amountCents: 1000,
      fxRate: "0.33333333",
      currency: "GBP",
      baseCurrency: "USD",
    };
    // 1000 × 0.33333333 = 333.33333 → 333 or 334.
    expect(isFxPairConsistent({ ...args, baseAmountCents: 333 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 334 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 332 })).toBe(false);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 335 })).toBe(false);
  });

  it("large amounts stay exact — BigInt, no float precision cliff", () => {
    // The intermediate product 12345678901 × 100000001 ≈ 1.23e18 is far past
    // 2^53 — float math would silently corrupt it; BigInt must not.
    const args = {
      amountCents: 12_345_678_901,
      fxRate: "1.00000001",
      currency: "EUR",
      baseCurrency: "USD",
    };
    // exact = 12345678901 + 123.45678901 = 12345679024.45678901 → floor/ceil.
    expect(isFxPairConsistent({ ...args, baseAmountCents: 12_345_679_024 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 12_345_679_025 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 12_345_679_023 })).toBe(false);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 12_345_679_026 })).toBe(false);

    // And an exactly-integer large product admits ONLY itself.
    const exact = {
      amountCents: 90_000_000_000,
      fxRate: "1.00000001",
      currency: "EUR",
      baseCurrency: "USD",
    };
    // 90e9 × 1.00000001 = 90000000900 exactly.
    expect(isFxPairConsistent({ ...exact, baseAmountCents: 90_000_000_900 })).toBe(true);
    expect(isFxPairConsistent({ ...exact, baseAmountCents: 90_000_000_899 })).toBe(false);
    expect(isFxPairConsistent({ ...exact, baseAmountCents: 90_000_000_901 })).toBe(false);
  });

  it("tiny products: exact < 1 admits ceil 1 (PositiveCents floors the wire at 1)", () => {
    const args = { amountCents: 1, fxRate: "0.0067", currency: "JPY", baseCurrency: "USD" };
    // 1 yen → $0.000067 → 0.67 US cents: floor 0, ceil 1.
    expect(isFxPairConsistent({ ...args, baseAmountCents: 1 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 2 })).toBe(false);
  });

  it("integer rate string (no decimal point) parses", () => {
    const args = { amountCents: 100, fxRate: "3", currency: "EUR", baseCurrency: "USD" };
    expect(isFxPairConsistent({ ...args, baseAmountCents: 300 })).toBe(true);
    expect(isFxPairConsistent({ ...args, baseAmountCents: 301 })).toBe(false);
  });

  it("defensive: a rate string the shared schema would never pass throws RangeError (never a silent pass)", () => {
    expect(() =>
      isFxPairConsistent({
        amountCents: 100,
        fxRate: "1.2.3",
        baseAmountCents: 120,
        currency: "EUR",
        baseCurrency: "USD",
      }),
    ).toThrow(RangeError);
  });
});
