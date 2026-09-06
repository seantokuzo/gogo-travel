/**
 * Typed API client (T-5.7 / NAV-2) — the `apps/mobile` adapter for the shared
 * `ApiClient` port (contracts spec §3.6). It drives every call from the
 * `@gogo/shared` endpoint descriptors: URL from `path` (+ `:params`/query),
 * JSON body, bearer access token, and BOTH-direction runtime validation
 * (`descriptor.response.parse`).
 *
 * Refresh-on-401 rotation (auth-users spec §3.6.1): an authed request that
 * 401s triggers a SINGLE-FLIGHT `/auth/refresh` (concurrent 401s share one
 * in-flight refresh — rotation makes parallel refreshes self-defeating,
 * R-auth-11), then retries once with the rotated access token. A failed
 * refresh (or a still-401 retry) surfaces `onAuthLost` → local sign-out.
 *
 * Token hygiene (R-auth-9 / Quality gate #5): no token, header, or body is
 * ever logged or embedded in an error message; the refresh token travels only
 * in the `/auth/refresh` POST body.
 */
import {
  ApiErrorSchema,
  authEndpoints,
  type ApiClient,
  type AuthTokens,
  type EndpointDescriptor,
  type ErrorCode,
  type InferInput,
  type InferResponse,
} from "@gogo/shared";

/**
 * Per-request abort cap (round-1 review, T-6.6): RN's Android OkHttp stack
 * ships with timeouts DISABLED — a captive-portal/black-hole stall would
 * otherwise hang a request forever (iOS worst case ≈ 3 min), pinning boot
 * surfaces like the entry redirect on their splash with no escape. 12s is
 * generous for a mobile API round-trip; a capped failure converts into the
 * built error surfaces (entry → trip list, guard → retry).
 */
export const REQUEST_TIMEOUT_MS = 12_000;

/** Per-call options (TanStack queryFn cancellation rides through here). */
export interface RequestOptions {
  /** External cancellation, composed with the `REQUEST_TIMEOUT_MS` cap. */
  signal?: AbortSignal;
}

/**
 * Compose the external signal with the timeout cap. Hand-rolled on plain
 * AbortController + setTimeout: Hermes/RN's AbortSignal has no reliable
 * `AbortSignal.timeout`/`AbortSignal.any` statics — don't reach for them.
 * `cleanup()` MUST run when the request settles or the timer leaks (open
 * handle under jest; wasted wakeup on device).
 */
function composeAbort(external: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
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

/** Non-2xx (or transport failure) surfaced from a request. */
export class ApiRequestError extends Error {
  constructor(
    /** HTTP status; `0` for a transport/network failure. */
    readonly status: number,
    /** Shared `ErrorCode` when the server returned an `ApiError`, else a marker. */
    readonly code: ErrorCode | "NETWORK" | "UNKNOWN",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** The seam into the session store (kept as callbacks to break the cycle). */
export interface ApiClientBridge {
  /** Current in-memory access token (session store), or null when signed out. */
  getAccessToken(): string | null;
  /** Refresh token from secure storage (the ONLY reader outside the store). */
  getRefreshToken(): Promise<string | null>;
  /** Persist a rotated token pair + swap the in-memory access token. */
  onTokensRefreshed(tokens: AuthTokens): void | Promise<void>;
  /** Refresh failed → the session is dead; sign out locally. */
  onAuthLost(): void | Promise<void>;
}

export interface ApiClientConfig extends ApiClientBridge {
  baseUrl: string;
  /** Injected for tests; defaults to global `fetch` at the wiring site. */
  fetchImpl: typeof fetch;
}

interface RequestInput {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

function buildPath(path: string, params: RequestInput["params"]): string {
  if (!params) return path;
  let out = path;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  return out;
}

function buildQuery(query: RequestInput["query"]): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The mobile adapter's client — the shared `ApiClient` port plus the
 * per-call `RequestOptions` third argument (external cancellation). Callers
 * typed against the shared port keep working; the query layer forwards its
 * TanStack signal through the wider signature.
 */
export interface MobileApiClient extends ApiClient {
  request<D extends EndpointDescriptor>(
    descriptor: D,
    input: InferInput<D>,
    options?: RequestOptions,
  ): Promise<InferResponse<D>>;
}

export function createApiClient(config: ApiClientConfig): MobileApiClient {
  const REFRESH_PATH = authEndpoints.refresh.path;
  let refreshInFlight: Promise<AuthTokens> | null = null;

  /** One network round-trip; no auto-refresh. `withAuth` attaches the bearer. */
  async function send<D extends EndpointDescriptor>(
    descriptor: D,
    input: InferInput<D>,
    withAuth: boolean,
    externalSignal?: AbortSignal,
  ): Promise<InferResponse<D>> {
    const parts = input as RequestInput;
    const url = `${config.baseUrl}${buildPath(descriptor.path, parts.params)}${buildQuery(parts.query)}`;

    const headers: Record<string, string> = { Accept: "application/json" };
    let bodyInit: string | undefined;
    if (parts.body !== undefined && descriptor.method !== "GET") {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(parts.body);
    }
    if (withAuth) {
      const token = config.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const abort = composeAbort(externalSignal);
    let res: Response;
    try {
      res = await config.fetchImpl(url, {
        method: descriptor.method,
        headers,
        body: bodyInit,
        signal: abort.signal,
      });
    } catch (err) {
      // Never surface the transport error verbatim — it can echo the URL.
      // Aborts (timeout cap or external cancel) land here too: a transient
      // transport failure either way (TanStack ignores rejections from its
      // own cancelled signal).
      //
      // B-6 (device QA 2026-08-29): sanitizing is right for the UI and for
      // production, but it also erased the ONE clue that mattered — the host
      // the phone actually dialed. `network request failed` is identical
      // whether the server is down, the URL is wrong, or the request was
      // cancelled, and that ambiguity cost two debugging rounds while the app
      // was quietly calling `localhost` (B-5). Dev keeps the cause; the thrown
      // error is unchanged, so production behaviour and every caller's
      // handling stay exactly as before.
      //
      // Base URL + path TEMPLATE, never the interpolated URL (PR #43 R1
      // security): path params carry capabilities (`/invites/:token` — the
      // invite token IS the join credential), and this warn feeds the
      // diagnostics panel's copyable evidence via the dev console tap. The
      // template keeps 100% of the B-5 diagnostic value (host + route shape);
      // query strings are dropped with the same reasoning.
      if (__DEV__) {
        console.warn(
          `[api] transport failure: ${descriptor.method} ${config.baseUrl} · ${descriptor.path}`,
          err,
        );
      }
      throw new ApiRequestError(0, "NETWORK", "network request failed");
    } finally {
      abort.cleanup();
    }

    if (res.status === 204 || res.status === 205) {
      return descriptor.response.parse(undefined) as InferResponse<D>;
    }

    const text = await res.text();
    const json = text.length > 0 ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiRequestError(res.status, code, message, details);
      }
      throw new ApiRequestError(res.status, "UNKNOWN", `request failed (${res.status})`);
    }

    return descriptor.response.parse(json) as InferResponse<D>;
  }

  /** Single-flight `/auth/refresh` rotation (R-auth-11). */
  function refreshTokens(): Promise<AuthTokens> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const refreshToken = await config.getRefreshToken();
      if (!refreshToken) {
        throw new ApiRequestError(401, "UNAUTHENTICATED", "no refresh token");
      }
      const tokens = await send(
        authEndpoints.refresh,
        { body: { refresh_token: refreshToken } },
        false,
      );
      await config.onTokensRefreshed(tokens);
      return tokens;
    })();
    return refreshInFlight.finally(() => {
      refreshInFlight = null;
    });
  }

  return {
    async request(descriptor, input, options?: RequestOptions) {
      const hadToken = config.getAccessToken() !== null;
      try {
        return await send(descriptor, input, true, options?.signal);
      } catch (err) {
        const is401 = err instanceof ApiRequestError && err.status === 401;
        // Only authed requests refresh-retry; never the refresh call itself,
        // and never a public request that never carried a token.
        if (!is401 || !hadToken || descriptor.path === REFRESH_PATH) throw err;

        try {
          await refreshTokens();
        } catch {
          await config.onAuthLost();
          throw err;
        }

        try {
          return await send(descriptor, input, true, options?.signal);
        } catch (retryErr) {
          if (retryErr instanceof ApiRequestError && retryErr.status === 401) {
            await config.onAuthLost();
          }
          throw retryErr;
        }
      }
    },
  };
}
