/**
 * Rate-limit store + middleware unit suite (AU-5, §3.6.3 / R-auth-14). No DB:
 * the store is pure and the middleware is exercised on a tiny Hono app with an
 * injected clock and header-driven keys. The through-the-router wiring for the
 * actual §3.6.3 surfaces (apple/google IP, refresh IP + session) lives in
 * `rate-limit.db.test.ts`.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestIdMiddleware } from "./app-middleware.js";
import type { RequestVars } from "./errors.js";
import {
  InMemoryRateLimitStore,
  isLoopbackOrPrivatePeer,
  rateLimit,
  type RateLimitRule,
} from "./rate-limit.js";

const HOUR_MS = 3_600_000;

describe("InMemoryRateLimitStore", () => {
  it("allows up to `limit` per window, then blocks with a whole-second Retry-After", () => {
    const store = new InMemoryRateLimitStore();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(store.hit("k", 3, HOUR_MS, t0).allowed).toBe(true);
    }
    const blocked = store.hit("k", 3, HOUR_MS, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    // ~1 hour minus 1s remains → ceil to whole seconds, never 0.
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((HOUR_MS - 1000) / 1000));
  });

  it("resets after the window elapses", () => {
    const store = new InMemoryRateLimitStore();
    const t0 = 5_000_000;
    expect(store.hit("k", 1, HOUR_MS, t0).allowed).toBe(true);
    expect(store.hit("k", 1, HOUR_MS, t0 + 1).allowed).toBe(false);
    // One tick past the reset boundary → fresh window.
    expect(store.hit("k", 1, HOUR_MS, t0 + HOUR_MS).allowed).toBe(true);
  });

  it("keys are isolated — one key's flood never touches another", () => {
    const store = new InMemoryRateLimitStore();
    const t = 9_000_000;
    expect(store.hit("a", 1, HOUR_MS, t).allowed).toBe(true);
    expect(store.hit("a", 1, HOUR_MS, t).allowed).toBe(false);
    expect(store.hit("b", 1, HOUR_MS, t).allowed).toBe(true); // b unaffected
  });

  it("a blocked attempt reports at least 1 second (never 0 → a client would hot-loop)", () => {
    const store = new InMemoryRateLimitStore();
    const t = 3_000_000;
    store.hit("k", 1, 500, t); // window is sub-second
    const blocked = store.hit("k", 1, 500, t + 499);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("isLoopbackOrPrivatePeer (S-4/T3, R-door-11)", () => {
  // The spec's own pinned vector table, verbatim — every allowed and
  // disallowed address it names.
  it.each([
    "127.0.0.1",
    "::1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "fc00::1",
    "::ffff:10.0.0.5",
    "[::1]",
  ])("%s → true", (addr) => {
    expect(isLoopbackOrPrivatePeer(addr)).toBe(true);
  });

  it.each(["8.8.8.8", "0.0.0.0", "169.254.0.1", "fe80::1", "unknown", ""])("%s → false", (addr) => {
    expect(isLoopbackOrPrivatePeer(addr)).toBe(false);
  });

  it("null → false", () => {
    expect(isLoopbackOrPrivatePeer(null)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isLoopbackOrPrivatePeer(undefined)).toBe(false);
  });

  // Boundary of the 172.16.0.0/12 range — 172.15.x and 172.32.x are PUBLIC,
  // only 172.16.x through 172.31.x are private.
  it("172.16.0.0/12 boundary: 172.15.255.255 and 172.32.0.0 are public; 172.31.255.255 is private", () => {
    expect(isLoopbackOrPrivatePeer("172.15.255.255")).toBe(false);
    expect(isLoopbackOrPrivatePeer("172.31.255.255")).toBe(true);
    expect(isLoopbackOrPrivatePeer("172.32.0.0")).toBe(false);
  });

  it("a hostname (including .local) is NEVER accepted — IP-literal-only predicate", () => {
    // Falsification: revert `isLoopbackOrPrivatePeer` to the pre-round-1-fix
    // `lower.startsWith("fc") || lower.startsWith("fd")` prefix check (no
    // `net.isIP` gate) and THIS test goes RED on the fc*/fd* cases below —
    // the prior falsification note ("swap for a substring/DNS-ish match")
    // was wrong: the regressed code IS a prefix/substring match already, and
    // stayed green because nothing here fed it an fc*/fd*-prefixed hostname
    // (review round 1 adversarial-verifier finding 22).
    expect(isLoopbackOrPrivatePeer("localhost")).toBe(false);
    expect(isLoopbackOrPrivatePeer("my-mac.local")).toBe(false);
    expect(isLoopbackOrPrivatePeer("evil.com")).toBe(false);
  });

  it("a hostname beginning fc or fd is NEVER accepted (review round 1 F1/A1) — the prefix-only predicate's exact hole", () => {
    // Falsification: this is the pin that reds on the regression above.
    expect(isLoopbackOrPrivatePeer("fcell.example.com")).toBe(false);
    expect(isLoopbackOrPrivatePeer("fdsomething.evil.com")).toBe(false);
    expect(isLoopbackOrPrivatePeer("10.metrics.example")).toBe(false);
    expect(isLoopbackOrPrivatePeer("fd-rig.internal")).toBe(false);
  });

  // The adversarial-verifier's round-1 38-input table, verbatim (round-1
  // adversarial-verifier.md row 20) — every case it hand-checked against the
  // real exported function, both directions.
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "::1",
    "[::1]",
    "[10.0.0.1]",
    "fc00::1",
    "fd12:3456::1",
    "FC00::1",
    "FD00::1",
    "::ffff:10.0.0.1",
    "::FFFF:10.0.0.1",
    "::ffff:127.0.0.1",
    "  127.0.0.1  ",
  ])("38-entry table: %s → true", (addr) => {
    expect(isLoopbackOrPrivatePeer(addr)).toBe(true);
  });

  it.each([
    "172.32.0.1",
    "172.15.0.1",
    "192.169.0.1",
    "100.64.0.1",
    "8.8.8.8",
    "::ffff:8.8.8.8",
    "::ffff:0.0.0.0",
    "0.0.0.0",
    "169.254.1.1",
    "fe80::1",
    "fe80::1%en0",
    "fe00::1",
    "2001:db8::1",
    "999.999.999.999",
    "10.0.0.1@evil",
    "127.0.0.1.evil.com",
    "localhost",
    "my-mac.local",
    "unknown",
    "",
  ])("38-entry table: %s → false", (addr) => {
    expect(isLoopbackOrPrivatePeer(addr)).toBe(false);
  });

  it("a spoofed Host-style value embedded in the string is not enough — must be the literal address", () => {
    expect(isLoopbackOrPrivatePeer("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackOrPrivatePeer("evil.com/127.0.0.1")).toBe(false);
  });
});

/** Build a tiny app: requestId → rate limiter → 200 handler. Clock is mutable. */
function makeApp(rules: readonly RateLimitRule[], clock: { ms: number }) {
  const store = new InMemoryRateLimitStore();
  const app = new Hono<RequestVars>();
  app.use("*", requestIdMiddleware);
  app.use("*", rateLimit(rules, { store, now: () => clock.ms }));
  app.get("/x", (c) => c.json({ ok: true }));
  return app;
}

const ipKey: RateLimitRule["keyOf"] = (c) => c.req.header("x-test-ip") ?? "unknown";

describe("rateLimit middleware", () => {
  it("429 + Retry-After at threshold, envelope is RATE_LIMITED with a requestId", async () => {
    const clock = { ms: 1_000_000 };
    const app = makeApp([{ name: "ip", limit: 2, windowMs: HOUR_MS, keyOf: ipKey }], clock);
    const req = () => app.request("/x", { headers: { "x-test-ip": "1.1.1.1" } });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);

    const limited = await req();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.requestId).toBeTruthy();
  });

  it("resets after the window (injected clock advance)", async () => {
    const clock = { ms: 2_000_000 };
    const app = makeApp([{ name: "ip", limit: 1, windowMs: HOUR_MS, keyOf: ipKey }], clock);
    const req = () => app.request("/x", { headers: { "x-test-ip": "2.2.2.2" } });

    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429);
    clock.ms += HOUR_MS; // window elapses
    expect((await req()).status).toBe(200);
  });

  it("distinct keys don't share a budget", async () => {
    const clock = { ms: 3_000_000 };
    const app = makeApp([{ name: "ip", limit: 1, windowMs: HOUR_MS, keyOf: ipKey }], clock);

    expect((await app.request("/x", { headers: { "x-test-ip": "a" } })).status).toBe(200);
    expect((await app.request("/x", { headers: { "x-test-ip": "a" } })).status).toBe(429);
    expect((await app.request("/x", { headers: { "x-test-ip": "b" } })).status).toBe(200);
  });

  it("multi-window: the TIGHTER window blocks first; both advance per attempt", async () => {
    const clock = { ms: 4_000_000 };
    // 3/min AND 5/hour — the per-minute window trips at the 4th request.
    const app = makeApp(
      [
        { name: "min", limit: 3, windowMs: 60_000, keyOf: ipKey },
        { name: "hr", limit: 5, windowMs: HOUR_MS, keyOf: ipKey },
      ],
      clock,
    );
    const req = () => app.request("/x", { headers: { "x-test-ip": "9.9.9.9" } });

    for (let i = 0; i < 3; i++) expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429); // minute window exhausted
  });

  it("a null key skips that window entirely", async () => {
    const clock = { ms: 5_000_000 };
    const app = makeApp([{ name: "opt", limit: 1, windowMs: HOUR_MS, keyOf: () => null }], clock);
    const req = () => app.request("/x");
    // Never limited — the rule is skipped every request.
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
  });
});
