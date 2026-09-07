/**
 * Transport reference reads (B-9 client half): `GET /airports/search`,
 * `GET /airlines/search`, `GET /airlines/flight-lookup` via the shared
 * `airportEndpoints` descriptors (PR #50's wire surface).
 *
 * Posture mirrored from the server (reference/routes.ts): all three sit
 * behind `requireAuth` and ONE per-user limiter bucket, so the client gates
 * every call on the SHARED query schema before it fires — the ApiClient
 * validates responses, never inputs (the usePlaceSearch lesson), and a
 * sub-floor/over-cap query would be a live 400 that also burns limiter
 * budget. The flight-lookup gate is the PR #50 rider verbatim: no call
 * fires on input `FlightNumberInputSchema` rejects — and, because the
 * server's parse is the same `parseFlightNumber`, nothing is sent that
 * would only ever come back `{ flight: null, airline: null }` either.
 *
 * Reference rows are migration-seeded and immutable at runtime, so results
 * stay fresh for the session (`REFERENCE_STALE_TIME`); keys live under
 * their own `["reference", …]` root (the `placeSearch` rationale: global
 * reads with no trip in the path — trip eviction must not reach them).
 *
 * B-9 R1 (performance lane): every hook carries `placeholderData:
 * keepPreviousData`. The shared query floor is ONE character (short codes
 * must be searchable from the first letter), so a per-keystroke query key
 * would otherwise flip `isPending` on every character and strobe the result
 * list skeleton↔results while the user types a name they mean to pick from
 * that list. The cross-cutting shared-debounce sweep (QUEUE) still stands;
 * this is the local half that costs nothing.
 */
import {
  AirlineSearchQuerySchema,
  AirportSearchQuerySchema,
  airportEndpoints,
  FlightNumberInputSchema,
  parseFlightNumber,
  type Airline,
  type Airport,
  type FlightAirlineLookupResponse,
} from "@gogo/shared";
import type { Paginated } from "@gogo/shared/api/envelope";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/auth";

import { queryKeys } from "./query-client";

/** Seeded reference data never changes within a session — 24h. */
export const REFERENCE_STALE_TIME = 24 * 60 * 60 * 1000;

/** Trimmed + NFC-normalized, the shared `ReferenceSearchTextSchema` transform. */
export function normalizeReferenceQuery(raw: string): string {
  return raw.trim().normalize("NFC");
}

/** The client gate = the shared query schema itself (1..100 chars after trim). */
export function isSearchableReferenceQuery(raw: string): boolean {
  return AirportSearchQuerySchema.safeParse({ q: raw }).success;
}

export function useAirportSearch(rawQuery: string): UseQueryResult<Paginated<Airport>, Error> {
  const q = normalizeReferenceQuery(rawQuery);
  return useQuery({
    queryKey: queryKeys.referenceAirportSearch(q),
    queryFn: ({ signal }) =>
      apiClient.request(airportEndpoints.searchAirports, { query: { q } }, { signal }),
    enabled: isSearchableReferenceQuery(rawQuery),
    staleTime: REFERENCE_STALE_TIME,
    placeholderData: keepPreviousData,
  });
}

export function useAirlineSearch(rawQuery: string): UseQueryResult<Paginated<Airline>, Error> {
  const q = normalizeReferenceQuery(rawQuery);
  return useQuery({
    queryKey: queryKeys.referenceAirlineSearch(q),
    queryFn: ({ signal }) =>
      apiClient.request(airportEndpoints.searchAirlines, { query: { q } }, { signal }),
    enabled: AirlineSearchQuerySchema.safeParse({ q: rawQuery }).success,
    staleTime: REFERENCE_STALE_TIME,
    placeholderData: keepPreviousData,
  });
}

/**
 * The lookup's canonical request value for a raw flight-number field:
 * `"nh 204"` / `"NH-204"` / `"nh0204"` → `"NH204"`, so every spelling of one
 * flight shares a cache entry and a request. `null` when the shared input
 * schema rejects the text OR the shared parser can't read it — the gate.
 */
export function flightLookupKeyOf(raw: string): string | null {
  const input = FlightNumberInputSchema.safeParse(raw);
  if (!input.success) return null;
  const parsed = parseFlightNumber(input.data);
  if (parsed === null) return null;
  return `${parsed.airline_iata}${parsed.number}`;
}

export function useFlightAirlineLookup(
  rawFlightNumber: string,
): UseQueryResult<FlightAirlineLookupResponse, Error> {
  const key = flightLookupKeyOf(rawFlightNumber);
  return useQuery({
    queryKey: queryKeys.referenceFlightLookup(key ?? ""),
    queryFn: ({ signal }) =>
      apiClient.request(
        airportEndpoints.lookupFlightAirline,
        { query: { flight_number: key ?? "" } },
        { signal },
      ),
    enabled: key !== null,
    staleTime: REFERENCE_STALE_TIME,
    placeholderData: keepPreviousData,
  });
}
