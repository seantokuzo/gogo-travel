/**
 * Money-tab display labels (T-9.5 — Law #2). The load-bearing pins are the
 * ISO-4217 arms: JPY renders WHOLE units (the formatIdeaPrice 100×-off
 * precedent — a local `/100` would print "JPY 25.50" for ¥2550), and the
 * sign never touches the digits (shared formatter only).
 */
import { moneyLabel, signedMoneyLabel } from "./money-format";

describe("moneyLabel", () => {
  it("two-decimal currencies render minor digits (USD 2550 → 'USD 25.50')", () => {
    expect(moneyLabel(2550, "USD")).toBe("USD 25.50");
    expect(moneyLabel(0, "USD")).toBe("USD 0.00");
    expect(moneyLabel(5, "EUR")).toBe("EUR 0.05");
  });

  it("zero-decimal currencies render WHOLE units (JPY 2550 → 'JPY 2550')", () => {
    expect(moneyLabel(2550, "JPY")).toBe("JPY 2550");
    expect(moneyLabel(0, "JPY")).toBe("JPY 0");
  });
});

describe("signedMoneyLabel (signed nets — contracts §3.3 exception)", () => {
  it("positive → '+', negative → '-', zero unsigned", () => {
    expect(signedMoneyLabel(2550, "USD")).toBe("+USD 25.50");
    expect(signedMoneyLabel(-2550, "USD")).toBe("-USD 25.50");
    expect(signedMoneyLabel(0, "USD")).toBe("USD 0.00");
  });

  it("negative zero-decimal keeps whole units", () => {
    expect(signedMoneyLabel(-500, "JPY")).toBe("-JPY 500");
  });
});
