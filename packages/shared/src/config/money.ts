/**
 * Money-facing shared config (T-9.1 / MON-1): the hand-rolled ISO-4217
 * zero-decimal currency list (P-9 ruling ② 2026-08-25 — deliberately NO
 * currency-data npm dependency), the currency-aware minor-unit parse/format
 * helpers (client money spec R-cmoney-8 + §2.5 shared formatting rules; api
 * money spec §1: "Cents" = ISO-4217 minor units — JPY's minor unit is 1 yen),
 * and the fixed booking→expense category prefill mapping (client money spec
 * §2.3, R-cmoney-11 — "defined once in `@gogo/shared` config").
 *
 * Law #2: money is integer minor units end to end — parsing is integer
 * string math and formatting is string slicing; no float ever holds an
 * amount, including intermediates.
 */
import type { BookingCategory, ExpenseCategory } from "../enums.js";

// ---------------------------------------------------------------------------
// ISO-4217 minor units (ruling ②: hand-rolled zero-decimal list)
// ---------------------------------------------------------------------------

/**
 * ISO-4217 currencies with NO minor unit (exponent 0), hand-rolled from the
 * current ISO 4217 list. Anything not listed is treated as two-minor-digit
 * (the ISO default). v1 interpretations (flagged in the T-9.1 PR): the
 * three-digit currencies (BHD/IQD/JOD/KWD/LYD/OMR/TND) and the non-decimal
 * fifths (MGA/MRU) fall back to 2 digits; ISO fund codes (XDR/XSU/XUA) are
 * omitted — they are not payment currencies.
 */
export const ZERO_DECIMAL_CURRENCIES = [
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
] as const;

const ZERO_DECIMAL = new Set<string>(ZERO_DECIMAL_CURRENCIES);

/**
 * Minor-unit digits for a currency code. Case-insensitive (form inputs may
 * carry unnormalized text mid-edit); unknown codes default to 2 — the safe
 * majority posture, and `CurrencyCode` validation rejects junk on the wire
 * regardless.
 */
export function minorUnitDigits(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

// ---------------------------------------------------------------------------
// Parse: text → integer minor units (R-cmoney-8)
// ---------------------------------------------------------------------------

export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string };

/** Comma OR dot decimal separator, 1–2 fraction digits (2-decimal currencies). */
const TWO_DECIMAL_RE = /^\s*(\d{1,10})(?:[.,](\d{1,2}))?\s*$/;
/** Whole amounts only (zero-decimal currencies — no fraction is representable). */
const ZERO_DECIMAL_RE = /^\s*(\d{1,10})\s*$/;

/**
 * Amount text → integer minor units, ISO-4217 aware (R-cmoney-8; spec pins:
 * `"25.50"` USD → 2550, `"1500"` JPY → 1500, `"25.505"` rejected). Integer
 * and fraction parts are parsed separately as integers — STRING math, no
 * float ever holds the amount (Law #2). Zero-decimal currencies reject any
 * decimal separator: a fractional yen is not representable, and silently
 * dropping or scaling it would corrupt the amount.
 */
export function parseMoneyToCents(text: string, currency: string): MoneyParse {
  if (minorUnitDigits(currency) === 0) {
    const match = ZERO_DECIMAL_RE.exec(text);
    if (match === null) {
      return { ok: false, error: "Use a whole amount like 1500 — this currency has no decimals." };
    }
    return { ok: true, cents: Number(match[1]) };
  }
  const match = TWO_DECIMAL_RE.exec(text);
  if (match === null) {
    return { ok: false, error: "Use a plain amount like 120 or 89.99." };
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  return { ok: true, cents: whole * 100 + fraction };
}

// ---------------------------------------------------------------------------
// Format: integer minor units → text (client money spec §2.5)
// ---------------------------------------------------------------------------

/**
 * Integer minor units → dot-decimal text with the currency's ISO-4217
 * minor-unit digits (§2.5 pins: USD 2550 → `"25.50"`, JPY 2550 → `"2550"`).
 * Pure string slicing — never float division (Law #2). The default keeps
 * FIXED minor digits (the §2.5 rail-link shape); `omitZeroMinor` drops an
 * all-zero minor part (`"120"` not `"120.00"`) — the form-prefill posture.
 *
 * Throws `RangeError` on non-integer or negative input: sign is modeled
 * structurally everywhere (contracts spec §3.3), so a negative here is a
 * caller bug, not a formattable value.
 */
export function centsToMoneyText(
  cents: number,
  currency: string,
  options?: { omitZeroMinor?: boolean },
): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`cents must be a non-negative safe integer (got ${cents})`);
  }
  if (minorUnitDigits(currency) === 0) return String(cents);
  const padded = String(cents).padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  if (options?.omitZeroMinor === true && minor === "00") return major;
  return `${major}.${minor}`;
}

// ---------------------------------------------------------------------------
// Booking → expense category prefill mapping (client money spec §2.3)
// ---------------------------------------------------------------------------

/**
 * The fixed, deterministic `booking_category → expense_category` prefill
 * mapping (R-cmoney-11; §2.3 table verbatim). Prefill only — the user edits
 * freely; the booking link persists as `expenses.booking_id`. The
 * `Record<BookingCategory, …>` shape makes a missing booking category a
 * compile error when the enum grows.
 */
export const BOOKING_TO_EXPENSE_CATEGORY: Readonly<Record<BookingCategory, ExpenseCategory>> = {
  lodging: "lodging",
  flight: "transport",
  train: "transport",
  car_rental: "transport",
  moped_rental: "transport",
  activity: "activities",
  restaurant: "food",
  other: "other",
};
