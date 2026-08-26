/**
 * R-money-6 FX-pair consistency (money spec §2, schema spec §3.3.12 R-db-20):
 * when an expense's `currency` differs from the trip's `base_currency`, the
 * wire must carry BOTH `fx_rate` (decimal string, `currency → base` in MAJOR
 * units — the Frankfurter/`GET /fx/rate` shape) and `base_amount_cents`, and
 * the pair must be CONSISTENT with `amount_cents`.
 *
 * "Consistent" is not pinned numerically by the spec — INTERPRETATION
 * (recorded in the T-9.2 PR): `base_amount_cents` must be the floor or the
 * ceiling of the exact rational
 *
 *     amount_minor × rate × 10^(minorDigits(base) − minorDigits(currency))
 *
 * i.e. within strictly less than one minor unit of exact. That admits every
 * sane client rounding mode (floor / ceil / half-up / half-even — the client
 * computes base from the fetched-or-overridden rate) while rejecting any
 * value a full cent off. When the exact value IS an integer, only that
 * integer passes.
 *
 * Law #2 applies to intermediates: all arithmetic is BigInt over exact
 * rationals — the rate string is scaled to an integer numerator/denominator,
 * never parsed as a float.
 */
import { minorUnitDigits } from "@gogo/shared/config/money";

/**
 * `FxRateSchema` already validated shape (`\d{1,10}(\.\d{1,8})?`, non-zero,
 * positive) at the boundary; this parse is defensive only.
 */
const RATE_RE = /^(\d{1,10})(?:\.(\d{1,8}))?$/;

/** Exact rational for a validated `numeric(18,8)` rate string. */
function rateAsRational(rate: string): { num: bigint; den: bigint } {
  const match = RATE_RE.exec(rate);
  if (!match) throw new RangeError(`fx_rate '${rate}' is not a valid decimal string`);
  const whole = match[1] as string;
  const frac = match[2] ?? "";
  return {
    num: BigInt(whole + frac),
    den: 10n ** BigInt(frac.length),
  };
}

/**
 * Is `base_amount_cents` consistent with `amount_cents × fx_rate` under the
 * minor-unit exponents of the two currencies? (Doc block above pins the
 * accepted window: floor ≤ base ≤ ceil of the exact rational.)
 */
export function isFxPairConsistent(args: {
  amountCents: number;
  fxRate: string;
  baseAmountCents: number;
  /** The expense's `currency` (spend-in-local). */
  currency: string;
  /** The trip's `base_currency`. */
  baseCurrency: string;
}): boolean {
  const rate = rateAsRational(args.fxRate);
  const exponentDiff = minorUnitDigits(args.baseCurrency) - minorUnitDigits(args.currency);

  // exact = amount × rateNum/rateDen × 10^exponentDiff, kept rational.
  let num = BigInt(args.amountCents) * rate.num;
  let den = rate.den;
  if (exponentDiff >= 0) {
    num *= 10n ** BigInt(exponentDiff);
  } else {
    den *= 10n ** BigInt(-exponentDiff);
  }

  const floor = num / den;
  const remainder = num % den;
  const base = BigInt(args.baseAmountCents);
  if (remainder === 0n) return base === floor;
  return base === floor || base === floor + 1n;
}
