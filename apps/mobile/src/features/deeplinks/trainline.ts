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
 * Lookup abort cap — same rationale as the ApiClient's `REQUEST_TIMEOUT_MS`
 * (RN's Android OkHttp ships with timeouts DISABLED; a black-holed request
 * would pin the button on "Finding stations…" forever). A capped failure
 * settles the query to error → the §2.7 plain-link degrade.
 */
export const TRAINLINE_LOOKUP_TIMEOUT_MS = 12_000;

/**
 * Bail-out cap on the response body BEFORE parsing (UTF-16 code units ≈
 * bytes for this ASCII-ish payload). This is a third-party endpoint with no
 * contract: `extractFirstUrn`'s breadth-first scan is O(payload), so a
 * pathological/hijacked response must fail fast into the degrade path, not
 * churn the JS thread. Real station lookups are a few KB.
 */
export const TRAINLINE_MAX_RESPONSE_CHARS = 512 * 1024;

/**
 * Compose the caller's signal with the timeout cap — the ApiClient's
 * hand-rolled pattern (Hermes/RN has no reliable `AbortSignal.timeout`/
 * `AbortSignal.any` statics). `cleanup()` runs when the request settles;
 * an EXTERNAL abort also clears the timer inline because a non-settling
 * `fetchFn` (tests; a stack that swallows aborts) would otherwise leak the
 * pending timer past the request's lifetime.
 */
function composeAbort(external: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRAINLINE_LOOKUP_TIMEOUT_MS);
  const onExternalAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (external !== undefined) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

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
 * responses, the `TRAINLINE_LOOKUP_TIMEOUT_MS` abort cap, and an oversize
 * body all throw (TanStack settles the query to error; the panel folds
 * error and null into the same plain-link degrade). `fetch` is injectable
 * for tests; RN provides the global.
 */
export async function searchTrainlineUrn(
  searchTerm: string,
  opts?: { signal?: AbortSignal; fetchFn?: typeof fetch },
): Promise<string | null> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const abort = composeAbort(opts?.signal);
  try {
    const response = await fetchFn(trainlineLocationSearchUrl(searchTerm), {
      signal: abort.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`trainline locations-search responded ${response.status}`);
    }
    // Length-check the text BEFORE parsing — module cap doc.
    const text = await response.text();
    if (text.length > TRAINLINE_MAX_RESPONSE_CHARS) {
      throw new Error("trainline locations-search response too large");
    }
    const payload: unknown = JSON.parse(text);
    return extractFirstUrn(payload);
  } finally {
    abort.cleanup();
  }
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
