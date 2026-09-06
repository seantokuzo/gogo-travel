/**
 * Transport reference data (B-9) — `airports` + `airlines`.
 *
 * GLOBAL, not user-scoped; READ-ONLY at runtime. Rows are seeded by the
 * migration that creates the tables (0002 — the processed open-data snapshot
 * committed under `reference-data/`, provenance + licence documented there).
 * Refreshing the dataset is a NEW migration regenerated from updated JSON
 * (Law #6 — no ad-hoc drift), never a runtime write; no route mutates these
 * tables.
 *
 * `airports.tz` is the point of the whole table (B-8/B-9): the IANA zone the
 * client uses to compose real UTC offsets for flight/train wall times
 * (`departs_tz`/`arrives_tz`, booking.ts). `airlines` powers flight-number →
 * airline inference ("NH204" → NH → All Nippon Airways).
 *
 * Immutable reference rows carry `created_at` only (schema conventions,
 * `_shared.ts`): there is no runtime update path, so `updated_at` would be
 * dead weight that never moves off its default.
 */
import { sql } from "drizzle-orm";
import { check, numeric, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt } from "./_shared.js";

export const airports = pgTable(
  "airports",
  {
    /** IATA location code — the natural key; the dataset is filtered to rows that have one. */
    iata: text("iata").primaryKey(),
    /** ICAO code where the dataset has one (a few small fields don't). */
    icao: text("icao"),
    name: text("name").notNull(),
    /** Municipality served (OurAirports) — disambiguates typeahead hits. */
    city: text("city"),
    /** ISO 3166-1 alpha-2 — same purpose ("San Jose, CR" vs "San Jose, US"). */
    country: text("country"),
    lat: numeric("lat", { precision: 9, scale: 6 }).notNull(),
    lng: numeric("lng", { precision: 9, scale: 6 }).notNull(),
    /** IANA zone id (`Asia/Tokyo`) — derived from lat/lng at generation time. */
    tz: text("tz").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("airports_iata_ck", sql`${t.iata} ~ '^[A-Z]{3}$'`),
    check("airports_icao_ck", sql`${t.icao} IS NULL OR ${t.icao} ~ '^[A-Z0-9]{4}$'`),
    // tz is a path-shaped IANA id, never an offset literal; bound (caps class).
    check("airports_tz_ck", sql`length(${t.tz}) BETWEEN 1 AND 64`),
    // Generation dedupes ICAO collisions (nulling the loser), so this holds.
    uniqueIndex("airports_icao_uq").on(t.icao).where(sql`${t.icao} IS NOT NULL`),
    // NO trgm/GIN search indexes on purpose: the table is bounded (~4k rows,
    // seeded — not user-growable), so ILIKE typeahead is a sub-ms scan. The
    // places spine needed GIN because it grows to 10^5–10^6 rows.
  ],
);

export const airlines = pgTable(
  "airlines",
  {
    /**
     * IATA airline designator — 2 chars, alphanumeric ("NH", "B6", "3K").
     * All-digit codes are excluded at generation (ambiguous inside a flight
     * number string), so the flight-number parser can rely on it.
     */
    iata: text("iata").primaryKey(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("airlines_iata_ck", sql`${t.iata} ~ '^[A-Z0-9]{2}$' AND ${t.iata} !~ '^[0-9]{2}$'`),
  ],
);
