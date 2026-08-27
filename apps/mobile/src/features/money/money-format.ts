/**
 * Money-tab display labels (T-9.5) — thin composition over the SHARED
 * ISO-4217 minor-unit formatter and nothing else (Law #2 + the
 * `formatIdeaPrice` 100×-off precedent: every money render goes through
 * `centsToMoneyText`; no local digit math, no float division ever). The
 * `"USD 25.50"` shape mirrors formatIdeaPrice (ideas-model.ts) so money
 * copy reads the same across surfaces; JPY renders whole units by
 * construction (`"JPY 2550"`).
 */
import { centsToMoneyText } from "@gogo/shared";

/** Non-negative cents → `"USD 25.50"` / `"JPY 2550"`. */
export function moneyLabel(cents: number, currency: string): string {
  return `${currency} ${centsToMoneyText(cents, currency)}`;
}

/**
 * SIGNED net (the one documented signed-cents exception, contracts §3.3) →
 * `"+USD 25.50"` / `"-USD 25.50"` / `"USD 0.00"`. Sign handling is integer
 * negation only — the digits still come from the shared formatter.
 */
export function signedMoneyLabel(netCents: number, currency: string): string {
  if (netCents > 0) return `+${moneyLabel(netCents, currency)}`;
  if (netCents < 0) return `-${moneyLabel(-netCents, currency)}`;
  return moneyLabel(0, currency);
}
