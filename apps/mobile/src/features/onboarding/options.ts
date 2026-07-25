/**
 * Onboarding option lists (T-5.8). Display-only UI content — NOT wire types.
 *
 * `home_currency` is a free `CurrencyCode` on the wire (any ISO-4217 code); the
 * spec doesn't fix a picker set, so onboarding offers a curated short list of
 * common currencies (skippable — the field stays optional). Travel-style labels
 * humanize the shared `TRAVEL_STYLES` enum (the enum is the source of truth).
 */
import { TRAVEL_STYLES, type CurrencyCode, type TravelStyle } from "@gogo/shared";

/** Curated common-currency shortlist for the onboarding picker. */
export const COMMON_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
  "INR",
  "MXN",
] as const satisfies readonly CurrencyCode[];

/** Title-case label for a travel style tag (source of truth stays the enum). */
export function travelStyleLabel(style: TravelStyle): string {
  return style.charAt(0).toUpperCase() + style.slice(1);
}

/** Re-export the ordered tag list so the screen renders every style once. */
export const TRAVEL_STYLE_OPTIONS: readonly TravelStyle[] = TRAVEL_STYLES;
