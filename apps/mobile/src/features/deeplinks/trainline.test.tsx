/**
 * Trainline URN lookup pins (T-7.8 / IT-8; §2.7 two-step train flow) — the
 * lookup URL, the shape-tolerant URN extraction (response shape is NOT
 * research-pinned — module doc), the round-trip's ok / non-ok / no-match /
 * timeout / oversize arms (R1: abort cap + body cap), and the 300ms
 * debounce's CHANGE arm (R1 falsifiability: below the window no new lookup
 * fires; past it exactly one does). The full panel ladder is exercised in
 * the DeeplinkPanel suite.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";

import { makeTestQueryClient } from "@/test-utils/render";

import {
  extractFirstUrn,
  searchTrainlineUrn,
  TRAINLINE_DEBOUNCE_MS,
  TRAINLINE_LOOKUP_TIMEOUT_MS,
  TRAINLINE_MAX_RESPONSE_CHARS,
  trainlineLocationSearchUrl,
  useTrainlineStationUrn,
} from "./trainline";

describe("trainlineLocationSearchUrl", () => {
  it("builds the §2.7 lookup URL with the term encoded", () => {
    expect(trainlineLocationSearchUrl("London Euston")).toBe(
      "https://www.thetrainline.com/api/locations-search/v2/search?searchTerm=London%20Euston",
    );
  });
});

describe("extractFirstUrn (shape-tolerant)", () => {
  it("finds a top-level searchLocations-style shape", () => {
    expect(
      extractFirstUrn({
        searchLocations: [
          { name: "London Euston", urn: "urn:trainline:generic:loc:182gb" },
          { name: "London Bridge", urn: "urn:trainline:generic:loc:1745gb" },
        ],
      }),
    ).toBe("urn:trainline:generic:loc:182gb");
  });

  it("finds a nested/renamed collection too (breadth-first)", () => {
    expect(
      extractFirstUrn({
        data: { results: { items: [{ location: { urn: "urn:trainline:generic:loc:9gb" } }] } },
      }),
    ).toBe("urn:trainline:generic:loc:9gb");
  });

  it("ignores non-trainline urn strings and returns null when nothing matches", () => {
    expect(extractFirstUrn({ urn: "urn:other:thing" })).toBeNull();
    expect(extractFirstUrn({ locations: [] })).toBeNull();
    expect(extractFirstUrn(null)).toBeNull();
    expect(extractFirstUrn("urn:trainline:generic:loc:182gb")).toBeNull();
  });
});

/** Minimal fetch-response stub — only the fields searchTrainlineUrn reads. */
function fakeResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** A fetch that never settles but respects its abort signal (stall stand-in). */
function stalledFetch(rejectMessage: string): typeof fetch {
  return jest.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(rejectMessage)));
      }),
  ) as unknown as typeof fetch;
}

describe("searchTrainlineUrn", () => {
  it("resolves the first URN from an ok response", async () => {
    const fetchFn = jest.fn(async () =>
      fakeResponse(200, { searchLocations: [{ urn: "urn:trainline:generic:loc:182gb" }] }),
    ) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("London", { fetchFn })).resolves.toBe(
      "urn:trainline:generic:loc:182gb",
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.thetrainline.com/api/locations-search/v2/search?searchTerm=London",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("resolves null on a no-match payload (degrade arm, not an error)", async () => {
    const fetchFn = jest.fn(async () =>
      fakeResponse(200, { searchLocations: [] }),
    ) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("Nowhere", { fetchFn })).resolves.toBeNull();
  });

  it("throws on a non-ok response (TanStack settles the query to error → degrade)", async () => {
    const fetchFn = jest.fn(async () => fakeResponse(503, "teapot")) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("London", { fetchFn })).rejects.toThrow("503");
  });

  it("aborts a black-holed lookup at the timeout cap (R1 compose-abort)", async () => {
    jest.useFakeTimers();
    try {
      const pending = searchTrainlineUrn("London", { fetchFn: stalledFetch("aborted by cap") });
      const settled = expect(pending).rejects.toThrow("aborted by cap");
      jest.advanceTimersByTime(TRAINLINE_LOOKUP_TIMEOUT_MS);
      await settled;
    } finally {
      jest.useRealTimers();
    }
  });

  it("an external abort (query cancel) reaches the composed signal", async () => {
    const external = new AbortController();
    const pending = searchTrainlineUrn("London", {
      fetchFn: stalledFetch("externally aborted"),
      signal: external.signal,
    });
    const settled = expect(pending).rejects.toThrow("externally aborted");
    external.abort();
    await settled;
  });

  it("bails on an oversize body BEFORE parsing (R1 cap → degrade, not JS-thread churn)", async () => {
    const oversized = "x".repeat(TRAINLINE_MAX_RESPONSE_CHARS + 1);
    const fetchFn = jest.fn(
      async () => ({ ok: true, status: 200, text: async () => oversized }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(searchTrainlineUrn("London", { fetchFn })).rejects.toThrow("too large");
  });
});

describe("useTrainlineStationUrn — the §2.7 debounce is real (R1 falsifiability)", () => {
  it("a changed term triggers NO new lookup below 300ms and exactly one past it", async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    const client = makeTestQueryClient();
    try {
      globalThis.fetch = jest.fn(async () =>
        fakeResponse(200, { searchLocations: [{ urn: "urn:trainline:generic:loc:182gb" }] }),
      ) as unknown as typeof fetch;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );

      const { rerender, unmount } = await renderHook(
        ({ text }: { text: string }) => useTrainlineStationUrn(text),
        { initialProps: { text: "London" }, wrapper },
      );
      // Mount fires the initial lookup (the debounce seeds with the first value).
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      await rerender({ text: "London Euston" });
      // Below the window: the changed term must NOT have fired a lookup yet.
      await act(async () => {
        jest.advanceTimersByTime(TRAINLINE_DEBOUNCE_MS - 1);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      // Crossing the window: exactly one lookup for the settled term.
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenLastCalledWith(
        trainlineLocationSearchUrl("London Euston"),
        expect.anything(),
      );

      // Flush TanStack's scheduled notifies inside act, then tear down
      // (B-2 flake class: nothing may settle outside an act window).
      await act(async () => {
        jest.advanceTimersByTime(0);
      });
      await unmount();
    } finally {
      globalThis.fetch = originalFetch;
      jest.useRealTimers();
      client.clear();
    }
  });
});
