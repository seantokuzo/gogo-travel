/**
 * Cashtag HEAD checker unit suite (T-5.5, R-user-6/7). All transport is an
 * injected fake — this suite makes ZERO network calls. The headline
 * assertions: the ONE permitted request shape (`HEAD https://cash.app/$…`,
 * never any other host — R-user-7's Venmo red line), and fail-OPEN on
 * everything except a definitive 404.
 */
import { describe, expect, it, vi } from "vitest";
import { cashtagUrl, createHttpCashtagChecker } from "./cashtag.js";

function fakeFetch(status: number) {
  return vi.fn(() => Promise.resolve(new Response(null, { status })));
}

describe("createHttpCashtagChecker (R-user-6)", () => {
  it("HEADs exactly https://cash.app/$<cashtag> — no other host, ever (R-user-7)", async () => {
    const fetchFn = fakeFetch(200);
    const checker = createHttpCashtagChecker({ fetchFn });
    await checker.check("seant");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cash.app/$seant");
    expect(new URL(url).host).toBe("cash.app");
    expect(url).not.toContain("venmo");
    expect(init.method).toBe("HEAD");
    // 3xx is a verdict, not an invitation — never follow to another host.
    expect(init.redirect).toBe("manual");
  });

  it("404 → not_found (the save-rejecting verdict)", async () => {
    const checker = createHttpCashtagChecker({ fetchFn: fakeFetch(404) });
    await expect(checker.check("ghost")).resolves.toBe("not_found");
  });

  it("2xx and 3xx → ok", async () => {
    for (const status of [200, 204, 301, 302]) {
      const checker = createHttpCashtagChecker({ fetchFn: fakeFetch(status) });
      await expect(checker.check("seant")).resolves.toBe("ok");
    }
  });

  it("5xx and non-404 4xx → ok (fail-open — bot-blocking must not break saves)", async () => {
    for (const status of [500, 502, 503, 403, 429]) {
      const checker = createHttpCashtagChecker({ fetchFn: fakeFetch(status) });
      await expect(checker.check("seant")).resolves.toBe("ok");
    }
  });

  it("network error / timeout → ok (fail-open, R-user-6)", async () => {
    const throwing = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const checker = createHttpCashtagChecker({ fetchFn: throwing as unknown as typeof fetch });
    await expect(checker.check("seant")).resolves.toBe("ok");
  });

  it("cashtagUrl interpolates the already-normalized tag after the literal $", () => {
    expect(cashtagUrl("seant")).toBe("https://cash.app/$seant");
  });
});
