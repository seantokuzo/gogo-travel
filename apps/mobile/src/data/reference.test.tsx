/**
 * Transport reference hooks (B-9 client half) — the GATES, mostly.
 *
 * The ApiClient validates RESPONSES against the descriptor, never inputs
 * (the `usePlaceSearch` lesson), so the `enabled` gate is the ONLY thing
 * between a keystroke and a live 400 that also burns the per-user reference
 * limiter. The PR #50 rider is pinned literally: NO request fires on input
 * the SHARED `FlightNumberInputSchema` rejects — and none fires on input the
 * SHARED `parseFlightNumber` can't read either, since the server runs the
 * same parser and would only ever answer `{ flight: null, airline: null }`.
 */
import { airportEndpoints } from "@gogo/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { apiClient } from "@/auth";
import {
  flightLookupKeyOf,
  isSearchableReferenceQuery,
  normalizeReferenceQuery,
  queryKeys,
  useAirlineSearch,
  useAirportSearch,
  useFlightAirlineLookup,
} from "@/data";
import { makeTestQueryClient } from "@/test-utils/render";
import {
  DEFAULT_AIRLINES,
  flightLookupFixture,
  searchAirlineFixtures,
  searchAirportFixtures,
} from "@/test-utils/reference-fixtures";

/** Cast away the descriptor generics so mockResolvedValue accepts any payload. */
function spyRequest(): jest.Mock {
  return jest.spyOn(apiClient, "request") as unknown as jest.Mock;
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Route by descriptor, exactly as the screen mocks do. */
function mockReference(): jest.Mock {
  const request = spyRequest();
  request.mockImplementation(
    (descriptor: { method: string; path: string }, input?: { query?: Record<string, string> }) => {
      const query = input?.query ?? {};
      switch (`${descriptor.method} ${descriptor.path}`) {
        case "GET /airports/search":
          return Promise.resolve(searchAirportFixtures(query["q"] ?? ""));
        case "GET /airlines/search":
          return Promise.resolve(searchAirlineFixtures(query["q"] ?? ""));
        case "GET /airlines/flight-lookup":
          return Promise.resolve(flightLookupFixture(query["flight_number"] ?? ""));
        default:
          return Promise.reject(new Error("unexpected descriptor"));
      }
    },
  );
  return request;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("query normalization + the search gate (the SHARED schema, mirrored)", () => {
  it("normalizes to trimmed NFC — a decomposed 'Malmö' must key like the composed one", () => {
    expect(normalizeReferenceQuery("  Tokyo  ")).toBe("Tokyo");
    expect(normalizeReferenceQuery("Malmö")).toBe("Malmö");
  });

  it("gates on the shared 1..100 bound — empty/whitespace out, 100 in, 101 out", () => {
    expect(isSearchableReferenceQuery("")).toBe(false);
    expect(isSearchableReferenceQuery("   ")).toBe(false);
    expect(isSearchableReferenceQuery("N")).toBe(true);
    expect(isSearchableReferenceQuery("x".repeat(100))).toBe(true);
    expect(isSearchableReferenceQuery("x".repeat(101))).toBe(false);
  });
});

describe("useAirportSearch", () => {
  it("fires ONE request with the normalized query and returns the ranked page", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, unmount } = await renderHook(() => useAirportSearch("  NRT  "), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.iata).toBe("NRT");
    expect(result.current.data?.items[0]?.tz).toBe("Asia/Tokyo");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      airportEndpoints.searchAirports,
      { query: { q: "NRT" } },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });

  it("fires NOTHING for a sub-floor or over-cap query — the 400 never leaves the device", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    for (const query of ["", "   ", "x".repeat(101)]) {
      const { result, unmount } = await renderHook(() => useAirportSearch(query), {
        wrapper: makeWrapper(client),
      });
      expect(result.current.fetchStatus).toBe("idle");
      await unmount();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("every spelling of one query shares ONE request — the normalized cache key", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, rerender, unmount } = await renderHook(
      (query: string) => useAirportSearch(query),
      { wrapper: makeWrapper(client), initialProps: "NRT" },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await rerender("  NRT");
    await rerender("NRT  ");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe("useAirlineSearch", () => {
  it("returns the ranked page and stays idle below the shared floor", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, unmount } = await renderHook(() => useAirlineSearch("All Nippon"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.iata).toBe("NH");

    const idle = await renderHook(() => useAirlineSearch("  "), { wrapper: makeWrapper(client) });
    expect(idle.result.current.fetchStatus).toBe("idle");
    expect(request).toHaveBeenCalledTimes(1);
    await idle.unmount();
    await unmount();
  });
});

describe("flightLookupKeyOf — the PR #50 rider's gate, as a pure function", () => {
  it("canonicalizes every spelling of one flight onto one key", () => {
    for (const spelling of ["NH204", "nh 204", "NH-204", "nh0204", "  NH204  "]) {
      expect(flightLookupKeyOf(spelling)).toBe("NH204");
    }
    // The shared parser drops an operational suffix and normalizes zeros.
    expect(flightLookupKeyOf("BA2276A")).toBe("BA2276");
    expect(flightLookupKeyOf("NH005")).toBe("NH5");
  });

  it("returns null for everything the SHARED schema or parser rejects", () => {
    for (const rejected of [
      "", // schema min(1)
      "   ", // trims to empty
      "NH2041234567", // schema max(12)
      "N", // parser: no digits
      "12345", // parser: all-digit prefix is not airline "12" flight "345"
      "ANA204", // parser: 3-letter ICAO prefix is not supported in v1
      "NH20411", // parser: 5 digits
      "NH204!!", // parser: residual junk
    ]) {
      expect(flightLookupKeyOf(rejected)).toBeNull();
    }
  });
});

describe("useFlightAirlineLookup", () => {
  it("NO REQUEST FIRES on input the shared schema or parser rejects (the PR #50 rider)", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    for (const rejected of ["", "  ", "N", "12345", "ANA204", "NH2041234567", "NH204!!"]) {
      const { result, unmount } = await renderHook(() => useFlightAirlineLookup(rejected), {
        wrapper: makeWrapper(client),
      });
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
      await unmount();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves the airline for a parseable number, sending the CANONICAL key", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, unmount } = await renderHook(() => useFlightAirlineLookup("nh 204"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.airline?.name).toBe("All Nippon Airways");
    expect(result.current.data?.flight).toEqual({ airline_iata: "NH", number: "204" });
    expect(request).toHaveBeenCalledWith(
      airportEndpoints.lookupFlightAirline,
      { query: { flight_number: "NH204" } },
      { signal: expect.any(AbortSignal) },
    );
    await unmount();
  });

  it("a parseable-but-UNKNOWN designator is a soft null, never an error state", async () => {
    // The route is soft by design so a keystroke can't turn the field red.
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, unmount } = await renderHook(() => useFlightAirlineLookup("ZZ999"), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.data?.airline).toBeNull();
    expect(result.current.data?.flight).toEqual({ airline_iata: "ZZ", number: "999" });
    expect(request).toHaveBeenCalledTimes(1);
    // Falsification for the gate pins above: this DOES reach the network, so
    // "nothing ever fires" is not what makes them green.
    expect(DEFAULT_AIRLINES.some((airline) => airline.iata === "ZZ")).toBe(false);
    await unmount();
  });

  it("three spellings of one flight number share ONE request", async () => {
    const request = mockReference();
    const client = makeTestQueryClient();
    const { result, rerender, unmount } = await renderHook(
      (value: string) => useFlightAirlineLookup(value),
      { wrapper: makeWrapper(client), initialProps: "nh 204" },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await rerender("NH-204");
    await rerender("nh0204");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe("cache keys", () => {
  it("live under their OWN root — a trip subtree eviction can never reach them", () => {
    // Reference rows are global, migration-seeded and behind auth alone: no
    // trip is in the path, so losing access to a trip must not evict them
    // (the `placeSearch`/`fxRate` rationale).
    expect(queryKeys.referenceAirportSearch("NRT")).toEqual([
      "reference",
      "airports",
      "search",
      "NRT",
    ]);
    expect(queryKeys.referenceAirlineSearch("NH")).toEqual([
      "reference",
      "airlines",
      "search",
      "NH",
    ]);
    expect(queryKeys.referenceFlightLookup("NH204")).toEqual([
      "reference",
      "airlines",
      "flight-lookup",
      "NH204",
    ]);
    for (const key of [
      queryKeys.referenceAirportSearch("NRT"),
      queryKeys.referenceAirlineSearch("NH"),
      queryKeys.referenceFlightLookup("NH204"),
    ]) {
      expect(key[0]).not.toBe("trips");
    }
  });
});
