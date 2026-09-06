/**
 * FX-rate provider port + Frankfurter adapter (T-9.4; P-9 ruling ③,
 * 2026-08-25): keyless Frankfurter v2 behind the thin `GET /fx/rate` proxy —
 * $0, no account, no key (escalation #3 satisfied at the ruling). The port
 * is the provider-swappable seam (P-10 §3.7 reuses it).
 *
 * FIXTURE-DRIVEN POSTURE (travel-legs providers.ts precedent, Law #5): the
 * adapter is a thin `fetch` wrapper behind the `FxProviderPort` seam; tests
 * inject a stub fetch with recorded fixture bodies — ZERO live network in CI
 * or tests. API shape verified against https://frankfurter.dev/docs/ + a
 * live probe at implementation (2026-08-26):
 *  - `GET https://api.frankfurter.dev/v2/rate/{FROM}/{TO}` → 200
 *    `{"date":"2026-08-26","base":"EUR","quote":"USD","rate":1.1675}`
 *    (`rate` is a JSON number; identity pairs answer 200 rate 1.0);
 *  - unsupported currency → 422 `{"status":422,"message":"invalid
 *    currency: XXX"}`; docs also list 404 "currency … not found" and 400
 *    malformed-request.
 *
 * RESULT CONTRACT (route-facing) — three arms, no throws:
 *  - `rate` — provider-confirmed pair; the ONLY arm the day cache may store
 *    (the shared `getFxRate` descriptor pin: an attacker-fillable cache was
 *    the R1 security finding that JSDoc guards against);
 *  - `unsupported` — the provider REJECTED the pair (422/404): the caller's
 *    input, not an outage → 400 at the route;
 *  - `unavailable` — outage/timeout/transport/parse: the manual-fallback arm
 *    (client money spec R-cmoney: "offline/FX-failure → manual rate
 *    required") → 503 at the route.
 *
 * LAW #2 (rate handling): the provider wire carries `rate` as a JSON number.
 * It is never used in arithmetic here — `toFixed(8)` renders it to a plain
 * decimal string (≤ 8 fraction digits, no exponent; exact for every value
 * round-trippable in ≤ 15 significant digits, which covers any real
 * currency pair by orders of magnitude), trailing zeros trimmed, then
 * validated against the shared `FxRateSchema` before it may leave this
 * module. The client captures that string verbatim into `expenses.fx_rate`
 * (R-money-6); all downstream money math is the shared BigInt path.
 */
import { FxRateSchema, type FxRateRead } from "@gogo/shared/domains/money";
import { ISODateSchema } from "@gogo/shared/scalars";
import { FX_PROVIDER_TIMEOUT_MS } from "../config.js";

export const FRANKFURTER_PROVIDER = "frankfurter";
export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev";

/**
 * Injectable fetch seam — tests supply fixture-backed stubs (never live).
 * Structurally identical to the travel-legs `FetchLike` on purpose (same
 * posture: `redirect: "error"` always requested, body consumed via `text()`
 * so it can be byte-capped before any parse) but owned locally — the FX
 * seam must not depend on the travel-legs domain module.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type FxProviderResult =
  | { kind: "rate"; read: FxRateRead }
  | { kind: "unsupported"; detail: string }
  | { kind: "unavailable"; detail: string };

/** The provider seam the FX route fetches through (P-10 §3.7 reuse point). */
export interface FxProviderPort {
  readonly provider: string;
  /** `base`/`quote` are boundary-validated `CurrencyCode`s ([A-Z]{3}). */
  rate(base: string, quote: string): Promise<FxProviderResult>;
}

/**
 * Response bodies are byte-capped AFTER `text()` buffers them and BEFORE any
 * JSON parse (travel-legs posture). A real v2 rate body is ~60 bytes; 64 KiB
 * is three orders of magnitude of slack while starving a hostile body.
 */
export const MAX_FX_BODY_BYTES = 64 * 1024;

/** Provider statuses that mean "this pair", not "this provider" (docs + probe). */
const UNSUPPORTED_PAIR_STATUSES = new Set([404, 422]);

/**
 * Render a provider rate number to the shared decimal-string shape (module
 * doc Law #2 note). `null` = not representable (non-finite, ≤ 0, or outside
 * `FxRateSchema`'s 10.8 digit envelope) — the caller treats it as an invalid
 * provider body.
 */
export function rateNumberToDecimalString(rate: number): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // toFixed never uses exponent notation below 1e21, far above the schema's
  // 10-integer-digit ceiling — anything that large fails validation below.
  if (rate >= 1e21) return null;
  const fixed = rate.toFixed(8);
  // Trim trailing fraction zeros ("1.16750000" → "1.1675", "159.20000000" →
  // "159.2", "3.00000000" → "3") — string surgery only, never re-parsed.
  const trimmed = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  const parsed = FxRateSchema.safeParse(trimmed);
  return parsed.success ? parsed.data : null;
}

export interface FrankfurterPortDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

export function createFrankfurterPort(deps: FrankfurterPortDeps = {}): FxProviderPort {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FX_PROVIDER_TIMEOUT_MS;
  const baseUrl = (deps.baseUrl ?? FRANKFURTER_BASE_URL).replace(/\/$/, "");

  return {
    provider: FRANKFURTER_PROVIDER,

    async rate(base, quote) {
      // Path segments are boundary-validated [A-Z]{3} (shared FxRateQuery) —
      // no user-controlled bytes beyond the two codes reach the URL.
      const url = `${baseUrl}/v2/rate/${base}/${quote}`;

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          // Keyless, but same posture as every provider adapter: never
          // follow a provider redirect.
          redirect: "error",
        });
      } catch (err) {
        // Keep only the error NAME (AbortError/TypeError) — transport causes
        // can embed URLs (travel-legs redaction posture; harmless here but
        // one rule is one rule).
        const name = err instanceof Error ? err.name : "unknown";
        return { kind: "unavailable", detail: `transport error (${name})` };
      }

      if (!response.ok) {
        return UNSUPPORTED_PAIR_STATUSES.has(response.status)
          ? { kind: "unsupported", detail: `HTTP ${response.status}` }
          : { kind: "unavailable", detail: `HTTP ${response.status}` };
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        return { kind: "unavailable", detail: "unreadable body" };
      }
      if (Buffer.byteLength(text, "utf8") > MAX_FX_BODY_BYTES) {
        return { kind: "unavailable", detail: "response body too large" };
      }

      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return { kind: "unavailable", detail: "invalid JSON body" };
      }
      const record =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
      if (record === null) return { kind: "unavailable", detail: "invalid body shape" };

      // Echo check: a body quoting a DIFFERENT pair must never be cached
      // under this key (cache poisoning via provider confusion).
      if (record.base !== base || record.quote !== quote) {
        return { kind: "unavailable", detail: "provider echoed a different pair" };
      }
      const date = ISODateSchema.safeParse(record.date);
      if (!date.success) return { kind: "unavailable", detail: "invalid provider date" };

      const rate =
        typeof record.rate === "number" ? rateNumberToDecimalString(record.rate) : null;
      if (rate === null) return { kind: "unavailable", detail: "invalid provider rate" };

      return {
        kind: "rate",
        read: { base, quote, rate, as_of: date.data },
      };
    },
  };
}
