/**
 * Transport reference domain (B-9) — airports + airlines.
 *
 * The airport table is THE real fix's foundation for B-8: the client can only
 * compose a correct `departs_tz`/`arrives_tz` (booking.ts flight/train
 * shapes) once it can resolve "NRT" → `Asia/Tokyo`. Airlines exist for
 * flight-number → airline inference ("NH204" → All Nippon Airways).
 *
 * Reference data is GLOBAL and read-only at runtime: seeded by the server's
 * 0002 migration from the committed open-data snapshot
 * (`apps/server/reference-data/` — licence + provenance there). The read
 * schemas below are still capped (caps cover every schema class — the T-7.1
 * landmine); the generation script enforces the same bounds, so a cap can
 * never reject a legitimate seeded row.
 */
import { z } from "zod";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { paginatedSchema } from "../api/envelope.js";
import { LatSchema, LngSchema } from "../scalars.js";

/** IATA airport location code — exactly 3 uppercase letters ("NRT"). */
export const IATA_AIRPORT_CODE_RE = /^[A-Z]{3}$/;
export const IataAirportCodeSchema = z.string().regex(IATA_AIRPORT_CODE_RE);
export type IataAirportCode = z.infer<typeof IataAirportCodeSchema>;

/**
 * IATA airline designator — 2 chars, alphanumeric with at least one letter
 * ("NH", "B6", "3K"). All-digit designators are excluded from the dataset
 * AND this schema: inside a flight-number string they are indistinguishable
 * from the flight number itself.
 */
export const IATA_AIRLINE_CODE_RE = /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])$/;
export const IataAirlineCodeSchema = z.string().regex(IATA_AIRLINE_CODE_RE);
export type IataAirlineCode = z.infer<typeof IataAirlineCodeSchema>;

/**
 * IANA zone id (`Asia/Tokyo`, `America/Argentina/Ushuaia`). Shape-bounded,
 * not enum-bound: the zone catalog evolves with tzdb releases and the seed
 * dataset, and membership is the dataset's guarantee, not the wire's.
 */
export const IanaTimeZoneSchema = z.string().min(1).max(64);

export const AirportSchema = z.object({
  iata: IataAirportCodeSchema,
  icao: z.string().regex(/^[A-Z0-9]{4}$/).nullable(),
  name: z.string().max(200),
  /** Municipality served — the typeahead's second search axis. */
  city: z.string().max(200).nullable(),
  /** ISO 3166-1 alpha-2, display disambiguation only. */
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  lat: LatSchema,
  lng: LngSchema,
  /** The point of the table (B-8): the zone that turns wall times into instants. */
  tz: IanaTimeZoneSchema,
});
export type Airport = z.infer<typeof AirportSchema>;

export const AirlineSchema = z.object({
  iata: IataAirlineCodeSchema,
  name: z.string().max(200),
});
export type Airline = z.infer<typeof AirlineSchema>;

// ---------------------------------------------------------------------------
// Search queries — bounded typeahead (caps class)
// ---------------------------------------------------------------------------

/**
 * Typeahead text: 1..100 chars, NFC-normalized (the places `SearchTextSchema`
 * precedent — a decomposed "Malmö" must match NFC-stored names). Min 1, NOT
 * the places text-only floor: that floor bounds trgm scans over a
 * 10^5–10^6-row spine; these tables are seeded and bounded (~4k rows), so
 * the table itself bounds the scan and first-keystroke search is safe.
 */
const ReferenceSearchTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .transform((val) => val.normalize("NFC"));

/**
 * `limit` max 20: a picker consumes a handful of ranked rows; the default
 * (10) is a server config constant. Deliberately NO `cursor` param — the
 * bounded typeahead never pages; responses still use the `Paginated<T>`
 * envelope (list convention) with `nextCursor` always `null`.
 */
const ReferenceSearchLimitSchema = z.coerce.number().int().min(1).max(20).optional();

export const AirportSearchQuerySchema = z.object({
  /** Matched against IATA (exact/prefix), name, and city. */
  q: ReferenceSearchTextSchema,
  limit: ReferenceSearchLimitSchema,
});
export type AirportSearchQuery = z.infer<typeof AirportSearchQuerySchema>;
export type AirportSearchQueryInput = z.input<typeof AirportSearchQuerySchema>;

export const AirlineSearchQuerySchema = z.object({
  /** Matched against the IATA designator (exact) and name. */
  q: ReferenceSearchTextSchema,
  limit: ReferenceSearchLimitSchema,
});
export type AirlineSearchQuery = z.infer<typeof AirlineSearchQuerySchema>;
export type AirlineSearchQueryInput = z.input<typeof AirlineSearchQuerySchema>;

// ---------------------------------------------------------------------------
// Flight-number → airline lookup (the inference shape)
// ---------------------------------------------------------------------------

/**
 * Raw user input ("NH204", "nh 204", "BA-2276A"). 12 chars is generous for
 * the maximal real shape (2-char designator + 4 digits + operational suffix
 * + separators); the bound is the caps-class DoS floor.
 */
export const FlightNumberInputSchema = z.string().trim().min(1).max(12);

export const ParsedFlightNumberSchema = z.object({
  airline_iata: IataAirlineCodeSchema,
  /** Digits with leading zeros stripped ("005" → "5"); 1..4 digits. */
  number: z.string().regex(/^[1-9][0-9]{0,3}$|^0$/),
});
export type ParsedFlightNumber = z.infer<typeof ParsedFlightNumberSchema>;

/**
 * `GET /airlines/flight-lookup` response — soft by design so the client's
 * inference never turns a keystroke into an error state: unparseable input
 * is `{ flight: null, airline: null }` (200), a parsed-but-unknown
 * designator is `{ flight, airline: null }`.
 */
export const FlightAirlineLookupResponseSchema = z.object({
  flight: ParsedFlightNumberSchema.nullable(),
  airline: AirlineSchema.nullable(),
});
export type FlightAirlineLookupResponse = z.infer<typeof FlightAirlineLookupResponseSchema>;

export const FlightAirlineLookupQuerySchema = z.object({
  flight_number: FlightNumberInputSchema,
});
export type FlightAirlineLookupQuery = z.infer<typeof FlightAirlineLookupQuerySchema>;
export type FlightAirlineLookupQueryInput = z.input<typeof FlightAirlineLookupQuerySchema>;

/**
 * THE canonical flight-number parser — both sides of the wire use this one
 * (server: `/airlines/flight-lookup`; client: local prefill/inference), so
 * "what counts as a flight number" can never fork.
 *
 * Accepts: `<designator><separators?><digits><suffix?>` case-insensitively,
 * where designator is 2 alphanumerics with ≥1 letter, separators are
 * spaces/hyphens, digits are 1–4, and an optional single trailing letter
 * (operational suffix, "BA2276A") is accepted and DROPPED. Leading zeros in
 * the number are normalized away ("NH005" → "5").
 *
 * Rejects (→ null, never throws): empty/oversized input, 3-letter prefixes
 * (ICAO-style "ANA204" is NOT supported in v1 — the dataset keys on IATA),
 * all-digit prefixes ("12345" is not airline "12" flight "345"), and
 * anything with residual junk. Note "N204" DOES parse (designator "N2",
 * flight 4) — a letter+digit prefix is a valid IATA shape; whether it
 * resolves is the dataset's call, not the parser's.
 */
export function parseFlightNumber(input: string): ParsedFlightNumber | null {
  const compact = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (compact.length === 0 || compact.length > 12) return null;
  const match = /^([A-Z][A-Z0-9]|[0-9][A-Z])([0-9]{1,4})[A-Z]?$/.exec(compact);
  if (!match) return null;
  const airlineIata = match[1] as string;
  const digits = match[2] as string;
  const number = digits.replace(/^0+(?=[0-9])/, "");
  return { airline_iata: airlineIata, number };
}

// ---------------------------------------------------------------------------
// Endpoint descriptors (contracts spec §3.6 pattern)
// ---------------------------------------------------------------------------

/**
 * All three run behind the app-wide `requireAuth` (uniform API surface —
 * reference rows aren't user data, but no route escapes the guard) and share
 * one per-user rate-limit bucket (server config `RATE_LIMITS.referenceSearch`,
 * the places-search posture).
 */
export const airportEndpoints = {
  /**
   * Airport typeahead: ranked IATA-exact → IATA-prefix → name-prefix →
   * city-prefix → name/city-substring; deterministic tiebreak. Bounded
   * (limit ≤ 20), never pages (`nextCursor` always `null`).
   */
  searchAirports: {
    method: "GET",
    path: "/airports/search",
    query: AirportSearchQuerySchema,
    response: paginatedSchema(AirportSchema),
  },
  /** Airline typeahead: IATA-exact → name-prefix → name-substring. */
  searchAirlines: {
    method: "GET",
    path: "/airlines/search",
    query: AirlineSearchQuerySchema,
    response: paginatedSchema(AirlineSchema),
  },
  /** Flight-number → airline inference (`parseFlightNumber` server-side). */
  lookupFlightAirline: {
    method: "GET",
    path: "/airlines/flight-lookup",
    query: FlightAirlineLookupQuerySchema,
    response: FlightAirlineLookupResponseSchema,
  },
} as const satisfies Record<string, EndpointDescriptor>;
