/**
 * Transport-reference fixtures (B-9) — the airport/airline rows the
 * flight/train form's typeaheads read, plus responders shaped like the REAL
 * server routes (`apps/server/src/reference/routes.ts`).
 *
 * Faithfulness matters here more than convenience: the flight-lookup
 * responder runs the SHARED `parseFlightNumber` exactly as the server does,
 * so a client gate that lets junk through can't be papered over by a mock
 * that answers anyway. Search ranks IATA-exact first, like the server's
 * ranked ILIKE.
 *
 * Zones are the REAL IANA zones for these airports — the hostile fixtures'
 * date-line endpoints (`@gogo/shared/testing`) resolve through this table.
 */
import { parseFlightNumber, type Airline, type Airport } from "@gogo/shared";
import type { Paginated } from "@gogo/shared/api/envelope";

export function makeAirport(overrides: Partial<Airport> & Pick<Airport, "iata" | "tz">): Airport {
  return {
    icao: null,
    name: `${overrides.iata} Airport`,
    city: null,
    country: null,
    lat: 0,
    lng: 0,
    ...overrides,
  };
}

export function makeAirline(overrides: Partial<Airline> & Pick<Airline, "iata">): Airline {
  return { name: `${overrides.iata} Airways`, ...overrides };
}

/** The B-8/B-9 cast: every endpoint the hostile flight fixtures name. */
export const DEFAULT_AIRPORTS: readonly Airport[] = [
  makeAirport({
    iata: "NRT",
    icao: "RJAA",
    name: "Narita International Airport",
    city: "Tokyo",
    country: "JP",
    lat: 35.7647,
    lng: 140.386,
    tz: "Asia/Tokyo",
  }),
  makeAirport({
    iata: "HND",
    icao: "RJTT",
    name: "Tokyo Haneda International Airport",
    city: "Tokyo",
    country: "JP",
    lat: 35.5523,
    lng: 139.78,
    tz: "Asia/Tokyo",
  }),
  makeAirport({
    iata: "LAX",
    icao: "KLAX",
    name: "Los Angeles International Airport",
    city: "Los Angeles",
    country: "US",
    lat: 33.9425,
    lng: -118.408,
    tz: "America/Los_Angeles",
  }),
  makeAirport({
    iata: "SFO",
    icao: "KSFO",
    name: "San Francisco International Airport",
    city: "San Francisco",
    country: "US",
    lat: 37.6189,
    lng: -122.375,
    tz: "America/Los_Angeles",
  }),
  makeAirport({
    iata: "AKL",
    icao: "NZAA",
    name: "Auckland International Airport",
    city: "Auckland",
    country: "NZ",
    lat: -37.008,
    lng: 174.792,
    tz: "Pacific/Auckland",
  }),
  makeAirport({
    iata: "PPT",
    icao: "NTAA",
    name: "Faa'a International Airport",
    city: "Papeete",
    country: "PF",
    lat: -17.5537,
    lng: -149.607,
    tz: "Pacific/Tahiti",
  }),
  // A half-hour-offset endpoint — naive offset math breaks on these.
  makeAirport({
    iata: "KTM",
    icao: "VNKT",
    name: "Tribhuvan International Airport",
    city: "Kathmandu",
    country: "NP",
    lat: 27.6966,
    lng: 85.3591,
    tz: "Asia/Kathmandu",
  }),
];

export const DEFAULT_AIRLINES: readonly Airline[] = [
  makeAirline({ iata: "NH", name: "All Nippon Airways" }),
  makeAirline({ iata: "UA", name: "United Airlines" }),
  makeAirline({ iata: "B6", name: "JetBlue Airways" }),
];

function matches(haystacks: readonly (string | null)[], needle: string): boolean {
  return haystacks.some(
    (value) => value !== null && value.toLowerCase().includes(needle.toLowerCase()),
  );
}

/** IATA-exact first, then name/city substring — the server's ranking posture. */
export function searchAirportFixtures(
  q: string,
  rows: readonly Airport[] = DEFAULT_AIRPORTS,
): Paginated<Airport> {
  const needle = q.trim();
  const exact = rows.filter((row) => row.iata.toLowerCase() === needle.toLowerCase());
  const rest = rows.filter(
    (row) => !exact.includes(row) && matches([row.iata, row.name, row.city], needle),
  );
  return { items: [...exact, ...rest], nextCursor: null };
}

export function searchAirlineFixtures(
  q: string,
  rows: readonly Airline[] = DEFAULT_AIRLINES,
): Paginated<Airline> {
  const needle = q.trim();
  const exact = rows.filter((row) => row.iata.toLowerCase() === needle.toLowerCase());
  const rest = rows.filter((row) => !exact.includes(row) && matches([row.name], needle));
  return { items: [...exact, ...rest], nextCursor: null };
}

/**
 * `GET /airlines/flight-lookup`, server-faithful: the SHARED parser decides
 * what a flight number IS, and an unresolvable designator comes back as a
 * soft `{ flight, airline: null }` — never an error.
 */
export function flightLookupFixture(
  flightNumber: string,
  rows: readonly Airline[] = DEFAULT_AIRLINES,
): { flight: ReturnType<typeof parseFlightNumber>; airline: Airline | null } {
  const flight = parseFlightNumber(flightNumber);
  if (flight === null) return { flight: null, airline: null };
  return { flight, airline: rows.find((row) => row.iata === flight.airline_iata) ?? null };
}
