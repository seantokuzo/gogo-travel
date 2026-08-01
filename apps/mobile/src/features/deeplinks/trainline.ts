/**
 * Trainline URN lookup — step 1 of the §2.7 two-step train flow (T-7.8 /
 * IT-8): station text → debounced client-direct call to the OPEN
 * `thetrainline.com/api/locations-search/v2/search?searchTerm={q}` endpoint
 * (research: verified live) → pick a URN → step 2 builds
 * `/book/results?origin={urn}&destination={urn}&outwardDate={ISO}`
 * (`buildTrainlineUrl`, url-builders.ts). On lookup failure the button
 * degrades to plain `thetrainline.com` (§2.7) — never an error surface.
 *
 * The lookup response SHAPE is not pinned by research (only the endpoint +
 * "pick URN" are), so extraction is deliberately tolerant: breadth-first
 * scan of the payload for the first object carrying a string `urn` (Trainline
 * URNs are `urn:trainline:…`). Live-shape verification is a phase-QA item
 * (flagged in the T-7.8 PR alongside the Airbnb/Turo device-verify pass).
 *
 * Query-key note (KEY-CACHE LAW): `["trainline", …]` is its OWN disjoint
 * root — this is third-party lookup data, not server state; it must NOT join
 * `["trips", …]` (the guard's 404-scrub owns that subtree) and never touches
 * `["trip-list"]`.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export const TRAINLINE_LOCATION_SEARCH_BASE =
  "https://www.thetrainline.com/api/locations-search/v2/search";

/** §2.7 lookup URL: `…/locations-search/v2/search?searchTerm={q}`. */
export function trainlineLocationSearchUrl(searchTerm: string): string {
  return `${TRAINLINE_LOCATION_SEARCH_BASE}?searchTerm=${encodeURIComponent(searchTerm)}`;
}

const TRAINLINE_URN_PREFIX = "urn:trainline:";

/**
 * Breadth-first scan for the first string `urn` property (shape-tolerant —
 * module doc). Null = no URN anywhere in the payload ("no match" folds into
 * the same degrade path as a transport failure).
 */
export function extractFirstUrn(payload: unknown): string | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const urn = record["urn"];
    if (typeof urn === "string" && urn.startsWith(TRAINLINE_URN_PREFIX)) return urn;
    queue.push(...Object.values(record));
  }
  return null;
}

/**
 * One lookup round-trip: term → first URN, or null on no-match. Non-OK
 * responses throw (TanStack settles the query to error; the panel folds
 * error and null into the same plain-link degrade). `fetch` is injectable
 * for tests; RN provides the global.
 */
export async function searchTrainlineUrn(
  searchTerm: string,
  opts?: { signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<string | null> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const response = await fetchFn(trainlineLocationSearchUrl(searchTerm), {
    ...(opts?.signal !== undefined ? { signal: opts.signal } : null),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`trainline locations-search responded ${response.status}`);
  }
  const payload: unknown = await response.json();
  return extractFirstUrn(payload);
}

/** §2.7 "debounced" — one settle window for station typing. */
export const TRAINLINE_DEBOUNCE_MS = 300;

/** Debounced mirror of a changing value (station text → settled lookup term). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Station text → URN, debounced (§2.7 "station fields drive debounced
 * client-direct URN lookup"). Disabled on empty text. `data === null` means
 * the lookup ran but found no URN; `isError` a failed transport — the panel
 * treats both as the plain-link degrade.
 */
export function useTrainlineStationUrn(
  stationText: string | undefined,
): UseQueryResult<string | null, Error> {
  const term = useDebouncedValue((stationText ?? "").trim(), TRAINLINE_DEBOUNCE_MS);
  return useQuery({
    // Disjoint root by law — see module doc.
    queryKey: ["trainline", "locations", term],
    enabled: term.length > 0,
    // Station→URN pairs are stable; don't re-fetch per keystroke revisit.
    staleTime: Infinity,
    queryFn: ({ signal }) => searchTrainlineUrn(term, { signal }),
  });
}
