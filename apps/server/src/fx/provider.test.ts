/**
 * Frankfurter v2 adapter unit tests (T-9.4; ruling ③) — fixture-driven, ZERO
 * live network (Law #5 / the $0-no-flake rule): every arm runs against a
 * stub `FetchLike` with recorded fixture bodies (shape live-probed once at
 * implementation, 2026-08-26 — see provider.ts module doc; the live probe is
 * optional-manual, never part of the suite).
 */
import { describe, expect, it } from "vitest";
import {
  createFrankfurterPort,
  FRANKFURTER_BASE_URL,
  MAX_FX_BODY_BYTES,
  rateNumberToDecimalString,
  type FetchLike,
} from "./provider.js";

/** Recorded 2026-08-26 from the live v2 endpoint (see module doc). */
const FIXTURE_EUR_USD = '{"date":"2026-08-26","base":"EUR","quote":"USD","rate":1.1675}';
const FIXTURE_USD_JPY = '{"date":"2026-08-26","base":"USD","quote":"JPY","rate":159.2}';
const FIXTURE_IDENTITY = '{"date":"2026-08-26","base":"EUR","quote":"EUR","rate":1.0}';
const FIXTURE_INVALID_CURRENCY = '{"status":422,"message":"invalid currency: XXX"}';

interface RecordedCall {
  url: string;
  init: Parameters<FetchLike>[1];
}

function stubFetch(
  respond: (url: string) => { status: number; body: string } | Error,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const result = respond(url);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: () => Promise.resolve(result.body),
    });
  };
  return { fetchImpl, calls };
}

describe("rateNumberToDecimalString (Law #2 rendering)", () => {
  it("renders provider numbers as plain decimal strings, trailing zeros trimmed", () => {
    expect(rateNumberToDecimalString(1.1675)).toBe("1.1675");
    expect(rateNumberToDecimalString(159.2)).toBe("159.2");
    expect(rateNumberToDecimalString(1)).toBe("1");
    expect(rateNumberToDecimalString(3.0)).toBe("3");
    expect(rateNumberToDecimalString(0.00000041)).toBe("0.00000041");
    expect(rateNumberToDecimalString(0.12345678)).toBe("0.12345678");
  });

  it("rejects non-positive, non-finite, and schema-overflowing values", () => {
    expect(rateNumberToDecimalString(0)).toBeNull();
    expect(rateNumberToDecimalString(-1.5)).toBeNull();
    expect(rateNumberToDecimalString(Number.NaN)).toBeNull();
    expect(rateNumberToDecimalString(Number.POSITIVE_INFINITY)).toBeNull();
    // Below the 8-fraction-digit floor: renders to zero → schema rejects.
    expect(rateNumberToDecimalString(1e-9)).toBeNull();
    // 11 integer digits — outside FxRateSchema's 10-digit envelope.
    expect(rateNumberToDecimalString(12_345_678_901)).toBeNull();
    // Beyond toFixed's non-exponent range.
    expect(rateNumberToDecimalString(1e22)).toBeNull();
  });
});

describe("createFrankfurterPort", () => {
  it("fetches the v2 pair path with timeout + redirect:'error' and parses the confirmed rate", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: FIXTURE_EUR_USD }));
    const port = createFrankfurterPort({ fetchImpl });

    const result = await port.rate("EUR", "USD");
    expect(result).toEqual({
      kind: "rate",
      read: { base: "EUR", quote: "USD", rate: "1.1675", as_of: "2026-08-26" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${FRANKFURTER_BASE_URL}/v2/rate/EUR/USD`);
    // Posture pins: bounded timeout requested; provider redirects rejected.
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init?.redirect).toBe("error");
  });

  it("parses whole-number-ish rates without float artifacts (USD/JPY 159.2; identity 1.0 → '1')", async () => {
    const jpy = createFrankfurterPort({
      fetchImpl: stubFetch(() => ({ status: 200, body: FIXTURE_USD_JPY })).fetchImpl,
    });
    const jpyResult = await jpy.rate("USD", "JPY");
    expect(jpyResult.kind).toBe("rate");
    if (jpyResult.kind === "rate") expect(jpyResult.read.rate).toBe("159.2");

    const identity = createFrankfurterPort({
      fetchImpl: stubFetch(() => ({ status: 200, body: FIXTURE_IDENTITY })).fetchImpl,
    });
    const identityResult = await identity.rate("EUR", "EUR");
    expect(identityResult.kind).toBe("rate");
    if (identityResult.kind === "rate") expect(identityResult.read.rate).toBe("1");
  });

  it("maps provider 422/404 (the pair) to 'unsupported'; other statuses to 'unavailable'", async () => {
    const status = (code: number) =>
      createFrankfurterPort({
        fetchImpl: stubFetch(() => ({ status: code, body: FIXTURE_INVALID_CURRENCY })).fetchImpl,
      });
    expect((await status(422).rate("EUR", "XXX")).kind).toBe("unsupported");
    expect((await status(404).rate("EUR", "ZZZ")).kind).toBe("unsupported");
    expect((await status(400).rate("EUR", "USD")).kind).toBe("unavailable");
    expect((await status(500).rate("EUR", "USD")).kind).toBe("unavailable");
    expect((await status(503).rate("EUR", "USD")).kind).toBe("unavailable");
  });

  it("maps transport failures to 'unavailable' carrying ONLY the error name (redaction posture)", async () => {
    const err = new Error("connect ECONNREFUSED https://api.frankfurter.dev/v2/rate/EUR/USD");
    err.name = "AbortError";
    const port = createFrankfurterPort({ fetchImpl: stubFetch(() => err).fetchImpl });

    const result = await port.rate("EUR", "USD");
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.detail).toBe("transport error (AbortError)");
      expect(result.detail).not.toContain("frankfurter");
    }
  });

  it("rejects invalid provider bodies: bad JSON, wrong echo, bad date, missing/zero/string rate", async () => {
    const bodies: Array<[string, string]> = [
      ["malformed JSON", "{nope"],
      ["non-object body", "42"],
      // Echo mismatch: a body quoting another pair must never be cached
      // under this request's key.
      ["wrong pair echo", '{"date":"2026-08-26","base":"EUR","quote":"GBP","rate":1.1}'],
      ["bad date", '{"date":"today","base":"EUR","quote":"USD","rate":1.1}'],
      ["missing rate", '{"date":"2026-08-26","base":"EUR","quote":"USD"}'],
      ["string rate", '{"date":"2026-08-26","base":"EUR","quote":"USD","rate":"1.1675"}'],
      ["zero rate", '{"date":"2026-08-26","base":"EUR","quote":"USD","rate":0}'],
      ["negative rate", '{"date":"2026-08-26","base":"EUR","quote":"USD","rate":-2}'],
    ];
    for (const [label, body] of bodies) {
      const port = createFrankfurterPort({
        fetchImpl: stubFetch(() => ({ status: 200, body })).fetchImpl,
      });
      const result = await port.rate("EUR", "USD");
      expect(result.kind, label).toBe("unavailable");
    }
  });

  it("byte-caps the body before parsing (a hostile giant body is 'unavailable', not a parse)", async () => {
    const huge = `{"date":"2026-08-26","base":"EUR","quote":"USD","rate":1.1,"pad":"${"x".repeat(
      MAX_FX_BODY_BYTES,
    )}"}`;
    const port = createFrankfurterPort({
      fetchImpl: stubFetch(() => ({ status: 200, body: huge })).fetchImpl,
    });
    const result = await port.rate("EUR", "USD");
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.detail).toBe("response body too large");
  });

  it("normalizes a trailing-slash baseUrl", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: FIXTURE_EUR_USD }));
    const port = createFrankfurterPort({ fetchImpl, baseUrl: "https://fx.example.test/" });
    await port.rate("EUR", "USD");
    expect(calls[0]!.url).toBe("https://fx.example.test/v2/rate/EUR/USD");
  });
});
