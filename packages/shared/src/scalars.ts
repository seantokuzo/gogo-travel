/**
 * Scalar conventions (contracts spec §3.3).
 *
 * Money is integer cents (Law #2) paired with `CurrencyCode`; dates on the
 * wire are ISO-8601 strings, never epoch numbers or `Date` (R-shared-11).
 */
import { z } from "zod";

/**
 * Integer cents, ≥ 0 (Law #2). Sign conventions (who owes whom) are modeled
 * structurally (`from`/`to`), never as negative amounts — except computed
 * `Balance.net_cents`, which is explicitly signed and documented there.
 * Floats fail validation (R-shared-6).
 */
export const CentsSchema = z.int().nonnegative();
export type Cents = z.infer<typeof CentsSchema>;

/** `Cents` strictly > 0 — expenses/settlements. */
export const PositiveCentsSchema = z.int().positive();
export type PositiveCents = z.infer<typeof PositiveCentsSchema>;

/** ISO-4217 uppercase, e.g. `"USD"`. Lowercase fails (R-shared-6 test). */
export const CurrencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/** Calendar date `YYYY-MM-DD` (e.g. `itinerary_items.day`, `expenses.spent_at`). */
export const ISODateSchema = z.iso.date();
export type ISODate = z.infer<typeof ISODateSchema>;

/** Instant with UTC offset; serialized UTC by the server. */
export const ISODateTimeSchema = z.iso.datetime({ offset: true });
export type ISODateTime = z.infer<typeof ISODateTimeSchema>;

/**
 * Wall-clock time of day, `HH:MM` 24-hour (itinerary `start_time`/`end_time`
 * cross the wire as strings — itinerary-bookings spec §3.7; Gate 2 sync).
 */
export const ISOTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type ISOTime = z.infer<typeof ISOTimeSchema>;

/** All ids. */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/**
 * Latitude/longitude with range refinement (±90 / ±180). Range refinements
 * are deliberately expressed as numeric checks so the AI-constraint walker
 * catches accidental reuse inside AI output schemas (§3.7 — those use plain
 * numbers + server-side refiners instead).
 */
export const LatSchema = z.number().min(-90).max(90);
export type Lat = z.infer<typeof LatSchema>;

export const LngSchema = z.number().min(-180).max(180);
export type Lng = z.infer<typeof LngSchema>;
