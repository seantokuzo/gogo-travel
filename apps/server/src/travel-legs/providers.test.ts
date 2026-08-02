/**
 * T-7.3 provider-adapter unit suite (spec §3.5 step 3, R-ib-21) — FIXTURE
 * DRIVEN, zero live network (Law #5 / the T-6.4 precedent): every test
 * injects a stub fetch returning recorded response shapes (verified against
 * the Mapbox Directions v5 docs and a captured Transitous /api/v6/plan
 * response, 2026-07-31).
 *
 * Headline security pins (Law #1, T-6.3 redaction precedent): no error
 * thrown from an adapter ever contains the access token or the request URL —
 * including transport errors whose underlying cause embeds the full URL.
 */
import { describe, expect, it } from "vitest";
import {
  createMapboxDirectionsPort,
  createTransitousPort,
  MAX_PROVIDER_BODY_BYTES,
  MAX_ROUTE_DISTANCE_METERS,
  MAX_ROUTE_DURATION_SECONDS,
  ProviderRequestError,
  TRANSITOUS_USER_AGENT,
  type FetchLike,
} from "./providers.js";

const TOKEN = "pk.super-secret-mapbox-token-000";

/**
 * Stub fetch capturing calls (incl. the requested `redirect` posture) and
 * returning a canned response. `rawBody` overrides the JSON-serialized
 * `body` for byte-cap tests.
 */
function stubFetch(
  responder: (url: string) => { status?: number; body?: unknown; rawBody?: string } | Error,
): {
  fetchImpl: FetchLike;
  calls: { url: string; headers?: Record<string, string>; redirect?: "error" }[];
} {
  const calls: { url: string; headers?: Record<string, string>; redirect?: "error" }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    const out = responder(url);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve({
      ok: (out.status ?? 200) >= 200 && (out.status ?? 200) < 300,
      status: out.status ?? 200,
      text: () => Promise.resolve(out.rawBody ?? JSON.stringify(out.body)),
    });
  };
  return { fetchImpl, calls };
}

/** Docs-shaped Directions v5 success body (duration s / distance m, floats). */
const mapboxOk = {
  code: "Ok",
  uuid: "fixture",
  waypoints: [],
  routes: [{ duration: 1371.657958984375, distance: 4575.367, legs: [] }],
};

/** Captured-shape MOTIS v6 plan body (transit legs carry no distance). */
const transitousOk = {
  requestParameters: {},
  debugOutput: {},
  from: {},
  to: {},
  direct: [{ duration: 2460, legs: [{ mode: "WALK", distance: 3200.5 }] }],
  itineraries: [
    {
      duration: 1320,
      startTime: "2026-09-01T09:00:00Z",
      endTime: "2026-09-01T09:22:00Z",
      transfers: 1,
      id: "fixture",
      legs: [
        { mode: "WALK", duration: 180, distance: 174.0 },
        { mode: "SUBWAY", duration: 60 },
        { mode: "WALK", duration: 180, distance: 279.0 },
        { mode: "BUS", duration: 540 },
        { mode: "WALK", duration: 240, distance: 298.0 },
      ],
    },
  ],
  previousPageCursor: "",
  nextPageCursor: "",
};

const QUERY = {
  from: { lat: 35.6895, lng: 139.6917 },
  to: { lat: 35.6595, lng: 139.7005 },
};

describe("Mapbox Directions adapter", () => {
  it("requests the documented URL shape — lng,lat order, profile per mode", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: mapboxOk }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });

    const result = await port.route(QUERY, "driving");
    expect(result).toEqual({ durationSeconds: 1372, distanceMeters: 4575 });

    const url = calls[0]?.url ?? "";
    expect(url).toContain("/directions/v5/mapbox/driving/");
    // lng,lat coordinate order (the v5 trap), pairs ;-separated.
    expect(url).toContain("/139.6917,35.6895;139.7005,35.6595");
    // No geometry payloads, no alternatives — duration/distance only (§3.5).
    expect(url).toContain("alternatives=false");
    expect(url).toContain("overview=false");
    expect(url).toContain(`access_token=${encodeURIComponent(TOKEN)}`);
  });

  it("maps walking/cycling to their profiles; rejects modes it does not serve", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: mapboxOk }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    await port.route(QUERY, "walking");
    await port.route(QUERY, "cycling");
    expect(calls[0]?.url).toContain("/mapbox/walking/");
    expect(calls[1]?.url).toContain("/mapbox/cycling/");
    expect(port.modes).toEqual(["driving", "walking", "cycling"]);
    await expect(port.route(QUERY, "transit")).rejects.toThrow(ProviderRequestError);
  });

  it("NoRoute / NoSegment are DEFINITIVE null — absent row, never an error (R-ib-21)", async () => {
    for (const code of ["NoRoute", "NoSegment"]) {
      const { fetchImpl } = stubFetch(() => ({ body: { code, routes: [] } }));
      const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
      await expect(port.route(QUERY, "driving")).resolves.toBeNull();
    }
  });

  it("code Ok with no usable route is null, not a throw", async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { code: "Ok", routes: [] } }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    await expect(port.route(QUERY, "driving")).resolves.toBeNull();
  });

  it("HTTP failure throws WITHOUT the token or URL (Law #1 pin)", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: { message: "unauthorized" } }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    const err = await port.route(QUERY, "driving").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err?.message).toContain("HTTP 401");
    expect(err?.message).not.toContain(TOKEN);
    expect(err?.message).not.toContain("api.mapbox.com");
  });

  it("transport errors are redacted to the error NAME (undici embeds URLs in messages)", async () => {
    const poisoned = new Error(
      `fetch failed: https://api.mapbox.com/directions/v5/...access_token=${TOKEN}`,
    );
    poisoned.name = "TypeError";
    const { fetchImpl } = stubFetch(() => poisoned);
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    const err = await port.route(QUERY, "driving").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err?.message).toContain("TypeError");
    expect(err?.message).not.toContain(TOKEN);
    expect(err?.message).not.toContain("access_token");
  });

  it("unexpected code and invalid JSON throw sanitized errors", async () => {
    const bad = stubFetch(() => ({ body: { code: "InvalidInput", message: "boom" } }));
    const badPort = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: bad.fetchImpl });
    await expect(badPort.route(QUERY, "driving")).rejects.toThrow(/code InvalidInput/);

    const broken = stubFetch(() => ({ rawBody: "<html>not json</html>" }));
    const brokenPort = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: broken.fetchImpl });
    await expect(brokenPort.route(QUERY, "driving")).rejects.toThrow(/invalid JSON/);

    const unreadable: FetchLike = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.reject(new Error("nope")) });
    const unreadablePort = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: unreadable });
    await expect(unreadablePort.route(QUERY, "driving")).rejects.toThrow(/unreadable body/);
  });

  it("provider-controlled `code` is truncated + control-stripped before embedding (A1a)", async () => {
    // 500 chars of hostile code with embedded control chars (\u0007 BEL,
    // \u001b ESC — written as escapes per the server rules landmine).
    const hostile = `EVIL\u0007\u001b${"x".repeat(500)}`;
    const { fetchImpl } = stubFetch(() => ({ body: { code: hostile, routes: [] } }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    const err = await port.route(QUERY, "driving").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err?.message).not.toContain("\u0007");
    expect(err?.message).not.toContain("\u001b");
    // 64-char cap: the fixed prefix + EVIL + 60 x's, and nothing more.
    expect(err?.message).toContain(`code EVIL${"x".repeat(60)}`);
    expect(err?.message).not.toContain("x".repeat(61));
  });

  it("body reads are byte-capped BEFORE JSON parse: cap passes, cap+1 throws (A1b)", async () => {
    // A valid mapbox body padded to EXACTLY the cap → parses fine.
    const skeleton = (pad: string) =>
      `{"code":"Ok","routes":[{"duration":600,"distance":1000}],"pad":"${pad}"}`;
    const overhead = Buffer.byteLength(skeleton(""), "utf8");
    const atCap = skeleton("y".repeat(MAX_PROVIDER_BODY_BYTES - overhead));
    expect(Buffer.byteLength(atCap, "utf8")).toBe(MAX_PROVIDER_BODY_BYTES);
    const ok = stubFetch(() => ({ rawBody: atCap }));
    const okPort = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: ok.fetchImpl });
    await expect(okPort.route(QUERY, "driving")).resolves.toEqual({
      durationSeconds: 600,
      distanceMeters: 1000,
    });

    // One byte over → sanitized throw, no parse attempt on the payload.
    const over = stubFetch(() => ({ rawBody: `${atCap}z` }));
    const overPort = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: over.fetchImpl });
    const err = await overPort.route(QUERY, "driving").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err?.message).toContain("response body too large");
    expect(err?.message).not.toContain(TOKEN);
  });

  it("both adapters request redirect: 'error' (A1b — token URL must never follow a bounce)", async () => {
    // The REJECTION itself is native-fetch behavior (not reachable through
    // the injected seam) — the pin locks the requested posture instead.
    const mapbox = stubFetch(() => ({ body: mapboxOk }));
    await createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl: mapbox.fetchImpl }).route(
      QUERY,
      "driving",
    );
    expect(mapbox.calls[0]?.redirect).toBe("error");

    const transitous = stubFetch(() => ({ body: transitousOk }));
    await createTransitousPort({
      baseUrl: "https://api.transitous.org",
      fetchImpl: transitous.fetchImpl,
    }).route(QUERY, "transit");
    expect(transitous.calls[0]?.redirect).toBe("error");
  });

  it("absurd provider values are clamped to the documented domain maxima (A1c)", async () => {
    const absurd = {
      code: "Ok",
      routes: [{ duration: 9e12, distance: 9e12 }], // would overflow int4 unclamped
    };
    const { fetchImpl } = stubFetch(() => ({ body: absurd }));
    const port = createMapboxDirectionsPort({ accessToken: TOKEN, fetchImpl });
    await expect(port.route(QUERY, "driving")).resolves.toEqual({
      durationSeconds: MAX_ROUTE_DURATION_SECONDS,
      distanceMeters: MAX_ROUTE_DISTANCE_METERS,
    });
    // The caps themselves stay below int4 (the reason they exist).
    expect(MAX_ROUTE_DURATION_SECONDS).toBeLessThan(2_147_483_647);
    expect(MAX_ROUTE_DISTANCE_METERS).toBeLessThan(2_147_483_647);

    const transitAbsurd = {
      itineraries: [{ duration: 9e12, legs: [{ mode: "WALK", distance: 9e12 }] }],
    };
    const transitStub = stubFetch(() => ({ body: transitAbsurd }));
    const transitPort = createTransitousPort({
      baseUrl: "https://api.transitous.org",
      fetchImpl: transitStub.fetchImpl,
    });
    await expect(transitPort.route(QUERY, "transit")).resolves.toEqual({
      durationSeconds: MAX_ROUTE_DURATION_SECONDS,
      distanceMeters: MAX_ROUTE_DISTANCE_METERS,
    });
  });
});

describe("Transitous (MOTIS) adapter", () => {
  it("requests /api/v6/plan with lat,lng places and the policy User-Agent", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: transitousOk }));
    const port = createTransitousPort({ baseUrl: "https://api.transitous.org", fetchImpl });

    const result = await port.route(QUERY, "transit");
    // duration = itinerary seconds; distance = Σ leg distances that exist
    // (transit segments report none — documented lower bound): 174+279+298.
    expect(result).toEqual({ durationSeconds: 1320, distanceMeters: 751 });

    const url = calls[0]?.url ?? "";
    expect(url).toContain("/api/v6/plan");
    expect(url).toContain("fromPlace=35.6895,139.6917");
    expect(url).toContain("toPlace=35.6595,139.7005");
    expect(calls[0]?.headers?.["User-Agent"]).toBe(TRANSITOUS_USER_AGENT);
    expect(port.provider).toBe("transitous");
    expect(port.modes).toEqual(["transit"]);
  });

  it("no transit itineraries ⇒ null — direct (walk/bike) results are IGNORED", async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { ...transitousOk, itineraries: [] } }));
    const port = createTransitousPort({ baseUrl: "https://api.transitous.org", fetchImpl });
    await expect(port.route(QUERY, "transit")).resolves.toBeNull();
  });

  it("HTTP failure throws sanitized; only serves transit", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 503, body: {} }));
    const port = createTransitousPort({ baseUrl: "https://api.transitous.org", fetchImpl });
    const err = await port.route(QUERY, "transit").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err?.message).toContain("HTTP 503");
    expect(err?.message).not.toContain("transitous.org");
    await expect(port.route(QUERY, "driving")).rejects.toThrow(/unsupported mode/);
  });

  it("trailing-slash base URL is normalized (no //api double-slash)", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ body: transitousOk }));
    const port = createTransitousPort({ baseUrl: "https://api.transitous.org/", fetchImpl });
    await port.route(QUERY, "transit");
    expect(calls[0]?.url).toContain("https://api.transitous.org/api/v6/plan");
  });
});
