/**
 * Routing-provider ports + adapters (T-7.3 / IB-3; itinerary-bookings spec
 * §3.5 step 3, R-ib-21): Mapbox Directions for `driving`/`walking`/`cycling`,
 * Transitous (MOTIS) for `transit`. Server-side ONLY — keys never reach the
 * client (spec §4 IB-3 "keys server-only").
 *
 * FIXTURE-DRIVEN POSTURE (T-6.4 $0 precedent, Law #5): adapters are thin
 * `fetch` wrappers behind the `RoutingPort` seam; tests inject a stub fetch
 * with recorded fixture bodies — ZERO live network in CI or tests. API
 * shapes verified against current docs at implementation (2026-07-31):
 *  - Mapbox Directions v5 (docs.mapbox.com/api/navigation/directions):
 *    `GET {base}/directions/v5/mapbox/{profile}/{lng},{lat};{lng},{lat}` —
 *    NOTE lng-first coordinate order; 200 body `{ code, routes: [{ duration
 *    (s, float), distance (m, float) }] }`; `code` "Ok" | "NoRoute" |
 *    "NoSegment" | error codes.
 *  - Transitous = MOTIS (api.transitous.org, openapi v6):
 *    `GET {base}/api/v6/plan?fromPlace={lat},{lng}&toPlace={lat},{lng}` —
 *    lat-first; 200 body `{ itineraries: [{ duration (s, int), legs: [{
 *    distance? (m — non-transit legs only) }] }], direct: [...] }`.
 *    Transitous usage policy requires an identifying User-Agent.
 *
 * ERROR CONTRACT (worker-facing):
 *  - resolve `RouteResult` — a routable pair;
 *  - resolve `null` — a DEFINITIVE no-route (provider answered; the mode row
 *    is omitted per R-ib-21 "absent, never an error");
 *  - throw — transport/HTTP/parse failure (outage). The worker treats a
 *    throw as "can't know": existing rows are KEPT (offline ETAs come from
 *    the last precomputed rows, §3.5 step 5), missing rows stay absent and
 *    retry next cycle.
 *
 * 🔴 SECRET HYGIENE (Law #1; T-6.3 push-token-redaction precedent): the
 * Mapbox token rides the request URL (`access_token=`), so NO error thrown
 * from these adapters may embed a URL — errors carry status/code text only.
 * Never log from here; the worker owns (redaction-safe) logging.
 */
import type { TravelMode } from "@gogo/shared/enums";
import { TRAVEL_LEGS_PROVIDER_TIMEOUT_MS } from "../config.js";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteQuery {
  from: LatLng;
  to: LatLng;
}

export interface RouteResult {
  /** Whole seconds (schema `duration_seconds`, int ≥ 0). */
  durationSeconds: number;
  /** Whole meters (schema `distance_meters`, int ≥ 0). */
  distanceMeters: number;
}

/**
 * The provider seam the leg job computes through. One port instance serves
 * one provider; `modes` declares which travel modes it answers for.
 */
export interface RoutingPort {
  /** `travel_legs.provider` value for rows this port computes. */
  readonly provider: string;
  readonly modes: readonly TravelMode[];
  /** See the module error contract: result | null (no route) | throw (outage). */
  route(query: RouteQuery, mode: TravelMode): Promise<RouteResult | null>;
}

/**
 * Injectable fetch seam — tests supply fixture-backed stubs (never live).
 * `redirect: "error"` is always requested: a provider (or an interposed box)
 * answering with a redirect could bounce the token-bearing request to an
 * attacker-chosen host — native fetch rejects the redirect outright (the
 * rejection rides the transport-error redaction path; the rejection itself
 * is native-fetch behavior, so tests pin the requested posture).
 * The response is consumed via `text()` so the body can be BYTE-CAPPED
 * before any JSON parse (`MAX_PROVIDER_BODY_BYTES`) — global `fetch`
 * satisfies this shape structurally.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Provider failure with NO url/token — safe to log verbatim. */
export class ProviderRequestError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} routing request failed: ${detail}`);
    this.name = "ProviderRequestError";
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Domain caps at ingestion (defense in depth, far below int4's 2 147 483 647
 * — one absurd provider value must never poison a batch insert):
 *  - duration: 14 days of travel (1 209 600 s) exceeds any real leg;
 *  - distance: 50 000 km (50 000 000 m) exceeds any surface route on Earth.
 */
export const MAX_ROUTE_DURATION_SECONDS = 14 * 24 * 60 * 60;
export const MAX_ROUTE_DISTANCE_METERS = 50_000_000;

/**
 * Response bodies are byte-capped AFTER `text()` buffers them and BEFORE any
 * JSON parse — the cap bounds what the worker will PARSE, not what fetch
 * buffers (an oversized body is still read into memory once, then rejected).
 * 2 MB is ~three orders of magnitude above a real Directions/MOTIS answer
 * for a single pair.
 */
export const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Clamp into `[0, max]` (negative can't exist; the ceiling is the domain
 * cap above) and round to the schema's whole units.
 */
const toBoundedInt = (value: number, max: number): number =>
  Math.min(max, Math.max(0, Math.round(value)));

/**
 * Provider-controlled text embedded in an error detail: control chars
 * stripped (log-injection hygiene), hard-capped so a hostile body cannot
 * balloon error messages/logs.
 */
const MAX_ERROR_DETAIL_CHARS = 64;
const sanitizeDetail = (value: string): string =>
  value.replace(/\p{Cc}/gu, "").slice(0, MAX_ERROR_DETAIL_CHARS);

/** Shared capped body read (see MAX_PROVIDER_BODY_BYTES) → parsed JSON. */
async function readBodyCapped(
  response: Awaited<ReturnType<FetchLike>>,
  provider: string,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ProviderRequestError(provider, "unreadable body");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PROVIDER_BODY_BYTES) {
    throw new ProviderRequestError(provider, "response body too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(provider, "invalid JSON body");
  }
}

// ---------------------------------------------------------------------------
// Mapbox Directions (driving / walking / cycling)
// ---------------------------------------------------------------------------

export const MAPBOX_PROVIDER = "mapbox";
export const MAPBOX_DIRECTIONS_BASE_URL = "https://api.mapbox.com";

/** Mode → Directions profile (docs: mapbox/driving|walking|cycling). */
const MAPBOX_PROFILES: Partial<Record<TravelMode, string>> = {
  driving: "driving",
  walking: "walking",
  cycling: "cycling",
};

/** Definitive "provider answered, no route exists" codes → `null` row-absent. */
const MAPBOX_NO_ROUTE_CODES = new Set(["NoRoute", "NoSegment"]);

export interface MapboxDirectionsPortDeps {
  /** From env ONLY (`MAPBOX_ACCESS_TOKEN`) — never a literal, never logged. */
  accessToken: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  baseUrl?: string;
}

export function createMapboxDirectionsPort(deps: MapboxDirectionsPortDeps): RoutingPort {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TRAVEL_LEGS_PROVIDER_TIMEOUT_MS;
  const baseUrl = (deps.baseUrl ?? MAPBOX_DIRECTIONS_BASE_URL).replace(/\/$/, "");

  return {
    provider: MAPBOX_PROVIDER,
    modes: Object.keys(MAPBOX_PROFILES) as TravelMode[],

    async route(query, mode) {
      const profile = MAPBOX_PROFILES[mode];
      if (!profile) {
        throw new ProviderRequestError(MAPBOX_PROVIDER, `unsupported mode '${mode}'`);
      }
      // lng,lat order (Directions v5 coordinates are {longitude},{latitude}).
      const coords = `${query.from.lng},${query.from.lat};` + `${query.to.lng},${query.to.lat}`;
      const url =
        `${baseUrl}/directions/v5/mapbox/${profile}/${coords}` +
        `?alternatives=false&overview=false&access_token=${encodeURIComponent(deps.accessToken)}`;

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          // A redirect could bounce the token-bearing URL elsewhere — reject.
          redirect: "error",
        });
      } catch (err) {
        // Redact: the thrown cause may embed the URL (undici does) — keep
        // only the error NAME (AbortError/TypeError), never the message.
        const name = err instanceof Error ? err.name : "unknown";
        throw new ProviderRequestError(MAPBOX_PROVIDER, `transport error (${name})`);
      }
      if (!response.ok) {
        throw new ProviderRequestError(MAPBOX_PROVIDER, `HTTP ${response.status}`);
      }

      const body = asRecord(await readBodyCapped(response, MAPBOX_PROVIDER));
      const code = typeof body?.code === "string" ? body.code : null;
      if (code !== null && MAPBOX_NO_ROUTE_CODES.has(code)) return null;
      if (code !== "Ok") {
        // `code` is provider-controlled text — sanitized before embedding.
        throw new ProviderRequestError(
          MAPBOX_PROVIDER,
          `code ${code === null ? "missing" : sanitizeDetail(code)}`,
        );
      }

      const routes = Array.isArray(body?.routes) ? body.routes : [];
      const first = asRecord(routes[0]);
      const duration = finiteNumber(first?.duration);
      const distance = finiteNumber(first?.distance);
      // `code: "Ok"` with no usable route — treat as no-route, not an outage.
      if (first === null || duration === null || distance === null) return null;

      return {
        durationSeconds: toBoundedInt(duration, MAX_ROUTE_DURATION_SECONDS),
        distanceMeters: toBoundedInt(distance, MAX_ROUTE_DISTANCE_METERS),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Transitous (MOTIS) — transit
// ---------------------------------------------------------------------------

export const TRANSITOUS_PROVIDER = "transitous";

/**
 * Transitous usage policy: requests must identify the app + a contact.
 * Website contact (no personal email in code — Law #1/PII posture).
 */
export const TRANSITOUS_USER_AGENT =
  "gogo-travel/0.0.1 (+https://github.com/seantokuzo/gogo-travel)";

export interface TransitousPortDeps {
  /** From env (`TRANSITOUS_BASE_URL`, public default — keyless instance). */
  baseUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createTransitousPort(deps: TransitousPortDeps): RoutingPort {
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? TRAVEL_LEGS_PROVIDER_TIMEOUT_MS;
  const baseUrl = deps.baseUrl.replace(/\/$/, "");

  return {
    provider: TRANSITOUS_PROVIDER,
    modes: ["transit"],

    async route(query, mode) {
      if (mode !== "transit") {
        throw new ProviderRequestError(TRANSITOUS_PROVIDER, `unsupported mode '${mode}'`);
      }
      // lat,lng order (MOTIS `fromPlace`/`toPlace` are latitude,longitude).
      const url =
        `${baseUrl}/api/v6/plan` +
        `?fromPlace=${query.from.lat},${query.from.lng}` +
        `&toPlace=${query.to.lat},${query.to.lng}` +
        `&numItineraries=1`;

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, {
          headers: { "User-Agent": TRANSITOUS_USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
          // Same posture as Mapbox: never follow a provider redirect.
          redirect: "error",
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "unknown";
        throw new ProviderRequestError(TRANSITOUS_PROVIDER, `transport error (${name})`);
      }
      if (!response.ok) {
        throw new ProviderRequestError(TRANSITOUS_PROVIDER, `HTTP ${response.status}`);
      }

      const body = asRecord(await readBodyCapped(response, TRANSITOUS_PROVIDER));
      // `itineraries` are the transit connections; `direct` are non-transit
      // (walk/bike) fallbacks — deliberately ignored: walking already has its
      // own mode/provider, and a transit chip must mean transit (R-ib-21).
      const itineraries = Array.isArray(body?.itineraries) ? body.itineraries : [];
      const best = asRecord(itineraries[0]);
      if (best === null) return null; // no transit route — absent, never an error
      const duration = finiteNumber(best.duration);
      if (duration === null) return null;

      // MOTIS reports `distance` (meters) on non-transit legs only — the sum
      // is a LOWER BOUND (transit segments contribute 0). Honest given the
      // schema's NOT NULL distance; chips lead with duration anyway.
      const legs = Array.isArray(best.legs) ? best.legs : [];
      let distance = 0;
      for (const leg of legs) {
        const d = finiteNumber(asRecord(leg)?.distance);
        if (d !== null) distance += d;
      }

      return {
        durationSeconds: toBoundedInt(duration, MAX_ROUTE_DURATION_SECONDS),
        distanceMeters: toBoundedInt(distance, MAX_ROUTE_DISTANCE_METERS),
      };
    },
  };
}
