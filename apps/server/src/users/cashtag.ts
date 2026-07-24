/**
 * Cashtag existence check (AU-6, R-user-6/7; auth-users spec §3.4.2).
 *
 * ONE outbound request shape is permitted by the whole payment-handles
 * surface: `HEAD https://cash.app/$<cashtag>`. Venmo gets NO traffic ever —
 * validation, lookup, or otherwise (R-user-7, research ToS red line); Venmo
 * handles are format-validated by the shared schema only.
 *
 * Verdict mapping (R-user-6):
 *   - 404                        → "not_found" (save rejected 400)
 *   - 2xx / 3xx                  → "ok"
 *   - 5xx / other 4xx / network
 *     error / timeout            → "ok" — FAIL OPEN. Deeplinks are
 *     best-effort UX sugar; a save must never depend on a third party's
 *     uptime (or its bot-blocking mood).
 *
 * The checker is a port so route tests inject fakes; the HTTP impl takes an
 * injectable `fetchFn` so its own tests never touch the network (Law #5-
 * adjacent hygiene: unit suites make zero outbound calls).
 */
import { CASHTAG_HEAD_TIMEOUT_MS } from "../config.js";

export type CashtagCheckResult = "ok" | "not_found";

export interface CashtagChecker {
  check(cashtag: string): Promise<CashtagCheckResult>;
}

export interface HttpCashtagCheckerOptions {
  /** Injectable transport (tests). Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** The URL the checker HEADs — exported so tests assert the exact target host. */
export function cashtagUrl(cashtag: string): string {
  return `https://cash.app/$${cashtag}`;
}

export function createHttpCashtagChecker(options: HttpCashtagCheckerOptions = {}): CashtagChecker {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? CASHTAG_HEAD_TIMEOUT_MS;

  return {
    async check(cashtag: string): Promise<CashtagCheckResult> {
      try {
        const response = await fetchFn(cashtagUrl(cashtag), {
          method: "HEAD",
          // 3xx is an accept verdict on its own (R-user-6) — never follow a
          // redirect to some other host on the third party's say-so.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.status === 404 ? "not_found" : "ok";
      } catch {
        // Unreachable / timeout / DNS / TLS — fail open.
        return "ok";
      }
    },
  };
}
