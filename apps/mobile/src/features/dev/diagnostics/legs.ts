/**
 * Device-smoke diagnostic legs (T-S3.5, R-test-2; ADR-006 layer 2).
 *
 * Each leg is a PURE async function over injected deps — the panel wires the
 * real device runtime, jest wires fixtures (no real network, no real
 * keychain). Every leg resolves to a LegResult; a leg NEVER rejects by
 * design (the runner catches anyway) — this panel exists precisely for the
 * states where things are broken, so a broken leg must render its cause, not
 * take the screen down.
 *
 * Evidence discipline (the B-6 lesson): failures carry the EXACT cause —
 * error name, message, and the cause chain — never a generic banner. And the
 * B-5 lesson: every fact here is measured ON the device runtime that renders
 * it, never assumed from the Mac side.
 */
import type { ApiBaseUrlResolution } from "@/auth";

import type { ConsoleTapSnapshot } from "./console-tap";

export interface LegResult {
  status: "pass" | "fail";
  /** One-line outcome beside the PASS/FAIL badge. */
  summary: string;
  /** Copyable raw evidence (rendered selectable + monospace). */
  evidence: string;
}

/**
 * Error → display string with the full cause chain (depth-capped). This is
 * the anti-"network request failed" device: the generic message identical
 * across server-down / wrong-URL / cancelled is what cost B-5 two rounds.
 */
export function describeError(err: unknown, depth = 0): string {
  if (depth > 4) return "…(cause chain truncated)";
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const cause = (err as { cause?: unknown }).cause;
    return cause === undefined ? head : `${head}\n  cause → ${describeError(cause, depth + 1)}`;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Leg 1 — resolved API base URL + tier provenance (B-5)
// ---------------------------------------------------------------------------

export interface BaseUrlLegDeps {
  /** `explainApiBaseUrl` — the real resolver's own provenance. */
  explain: () => ApiBaseUrlResolution;
  /** `expo-device` `Device.isDevice` — physical hardware vs simulator. */
  isDevice: () => boolean;
}

/**
 * PASS: a URL resolved, and it is plausible for this runtime. FAIL: physical
 * hardware landed on the tier-4 localhost fallback — the exact B-5 symptom
 * (the phone dialing itself) — or resolution itself threw.
 */
export async function runBaseUrlLeg(deps: BaseUrlLegDeps): Promise<LegResult> {
  let resolution: ApiBaseUrlResolution;
  try {
    resolution = deps.explain();
  } catch (err) {
    return {
      status: "fail",
      summary: "base URL resolution threw",
      evidence: describeError(err),
    };
  }
  const device = deps.isDevice();
  // Set-but-blank rendered distinctly (PR #43 R1): legs 1 and 3 must agree
  // about the exact EXPO_PUBLIC_API_URL="" quoting mistake in one screenshot.
  const explicitEnv = resolution.inputs.explicitEnv;
  const explicitEnvLine =
    explicitEnv === null ? "(unset)" : explicitEnv.trim() === "" ? "(set but blank)" : explicitEnv;
  const evidence = [
    `url: ${resolution.url}`,
    `tier: ${resolution.tier} (${resolution.source})`,
    `EXPO_PUBLIC_API_URL: ${explicitEnvLine}`,
    `expoConfig.hostUri: ${resolution.inputs.hostUri ?? "(empty)"}`,
    `SourceCode.scriptURL: ${resolution.inputs.scriptURL ?? "(none)"}`,
    `runtime: ${device ? "physical device" : "simulator"}`,
  ].join("\n");

  if (device && resolution.tier === 4) {
    return {
      status: "fail",
      summary: "physical device resolved localhost — the B-5 symptom (phone dialing itself)",
      evidence,
    };
  }
  return {
    status: "pass",
    summary: `${resolution.url} via tier ${resolution.tier} (${resolution.source})`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Leg 2 — server /health round-trip FROM THIS RUNTIME (B-5 wrong-side lesson)
// ---------------------------------------------------------------------------

export interface HealthLegDeps {
  /** `resolveApiBaseUrl` — the URL the app's real client would dial. */
  baseUrl: () => string;
  /** Transport seam — global fetch on device, a fixture in jest. */
  fetchFn: (input: string, init?: { signal?: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
  now: () => number;
  timeoutMs?: number;
}

export const HEALTH_TIMEOUT_MS = 8000;

/**
 * GET `<base>/api-relative /health` with latency. PASS: HTTP 200 with
 * `{ ok: true }`. FAIL: anything else — with status/body, or the EXACT
 * transport failure cause (never the sanitized generic — this leg exists
 * because "network request failed" reads identically for server-down,
 * wrong-URL, and cancelled).
 */
export async function runHealthLeg(deps: HealthLegDeps): Promise<LegResult> {
  let url: string;
  try {
    url = `${deps.baseUrl()}/health`;
  } catch (err) {
    return {
      status: "fail",
      summary: "no base URL to probe (resolution threw)",
      evidence: describeError(err),
    };
  }

  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const abort = new AbortController();
  // Cleared in `finally` — a live timer is an open handle under jest
  // (mobile.md landmine) and a stray abort on device. No abort reason: RN's
  // real fetch ignores it (the catch derives the timeout from signal.aborted).
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const started = deps.now();
  try {
    const res = await deps.fetchFn(url, { signal: abort.signal });
    const latency = deps.now() - started;
    let body: unknown;
    let bodyText: string;
    try {
      body = await res.json();
      bodyText = JSON.stringify(body)?.slice(0, 300) ?? "(empty)";
    } catch (err) {
      body = undefined;
      bodyText = `(unparseable: ${describeError(err)})`;
    }
    const ok =
      res.ok && typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    const evidence = [
      `GET ${url}`,
      `status: ${res.status}`,
      `latency: ${latency}ms`,
      `body: ${bodyText}`,
    ].join("\n");
    return ok
      ? { status: "pass", summary: `${res.status} in ${latency}ms`, evidence }
      : { status: "fail", summary: `unhealthy response (status ${res.status})`, evidence };
  } catch (err) {
    const latency = deps.now() - started;
    // Timeout is detected from OUR signal, not the rejection's shape (PR #43
    // R1 correctness): RN's real fetch (vendored whatwg-fetch) rejects aborts
    // with its own DOMException("Aborted","AbortError") and IGNORES
    // AbortSignal.reason — a pin reading the reason back would be fixture
    // fiction (the B-4 mock-fidelity class). The only aborter here is our
    // timer, so signal.aborted ⇔ timeout, deterministically on device.
    const timedOut = abort.signal.aborted;
    return {
      status: "fail",
      summary: timedOut
        ? `no response within ${timeoutMs}ms — request aborted`
        : "round-trip failed — exact cause below",
      evidence: [
        `GET ${url}`,
        `after: ${latency}ms`,
        ...(timedOut ? [`timeout after ${timeoutMs}ms`] : []),
        describeError(err),
      ].join("\n"),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Leg 3 — EXPO_PUBLIC_* inlining (names only, never values)
// ---------------------------------------------------------------------------

export interface ExpoPublicEnvEntry {
  name: string;
  present: boolean;
  /** Present but empty/whitespace — the classic quoting mistake in .env. */
  blank: boolean;
}

/**
 * Snapshot every EXPO_PUBLIC_* var the app reads. STATIC member reads only:
 * Metro inlines `process.env.EXPO_PUBLIC_X` per literal expression at build
 * time — a dynamic `process.env[name]` loop would read undefined in a real
 * bundle even for vars that were set, and this leg would lie.
 */
export function readExpoPublicEnv(): ExpoPublicEnvEntry[] {
  const raw: [string, string | undefined][] = [
    ["EXPO_PUBLIC_API_URL", process.env.EXPO_PUBLIC_API_URL],
    ["EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID", process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID],
    ["EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID", process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID],
    ["EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN", process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN],
    ["EXPO_PUBLIC_MAPBOX_STYLE_URL_LIGHT", process.env.EXPO_PUBLIC_MAPBOX_STYLE_URL_LIGHT],
    ["EXPO_PUBLIC_MAPBOX_STYLE_URL_DARK", process.env.EXPO_PUBLIC_MAPBOX_STYLE_URL_DARK],
  ];
  return raw.map(([name, value]) => ({
    name,
    present: value !== undefined,
    blank: value !== undefined && value.trim() === "",
  }));
}

export interface EnvLegDeps {
  read: () => ExpoPublicEnvEntry[];
}

/**
 * PASS: every var is either cleanly set or cleanly unset (unset is a
 * legitimate state — google is unprovisioned this phase). FAIL: any var
 * present-but-blank, which no runtime read can distinguish from "configured".
 * Names only — a value never reaches the evidence (the Mapbox token is not
 * for screens).
 */
export async function runEnvLeg(deps: EnvLegDeps): Promise<LegResult> {
  const entries = deps.read();
  const blanks = entries.filter((e) => e.blank);
  const evidence = entries
    .map((e) => `${e.name}: ${e.blank ? "SET BUT BLANK" : e.present ? "set" : "unset"}`)
    .join("\n");
  if (blanks.length > 0) {
    return {
      status: "fail",
      summary: `blank env var(s) inlined: ${blanks.map((e) => e.name).join(", ")}`,
      evidence,
    };
  }
  const setCount = entries.filter((e) => e.present).length;
  return {
    status: "pass",
    summary: `${setCount}/${entries.length} vars inlined into this bundle`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Leg 4 — Google auth-request shape (B-4)
// ---------------------------------------------------------------------------

/** Structural view of the loaded auth request (matches `@/auth/google`). */
export interface GoogleRequestView {
  url?: string | null;
  nonce?: string;
  extraParams?: Record<string, string>;
}

export interface GoogleLegInput {
  configured: boolean;
  request: GoogleRequestView | null;
  /** The hook never produced a request within the panel's patience window. */
  timedOut: boolean;
}

/**
 * Evaluate the loaded request. Returns null while legitimately still
 * loading (the caller keeps the leg in "running"). PASS: request loaded AND
 * our nonce is in `extraParams` AND the authorize URL carries a `nonce`
 * param (the B-4 fact: on native the provider mints none — ours must be
 * there or sign-in dies client-side). Nonce VALUES never reach evidence.
 */
export function evaluateGoogleRequestLeg(input: GoogleLegInput): LegResult | null {
  if (!input.configured) {
    return {
      status: "fail",
      summary: "no Google client id inlined (EXPO_PUBLIC_GOOGLE_*) — sign-in cannot run",
      evidence: [
        "isGoogleConfigured(): false",
        "expected once Sean provisions the OAuth client (T-5.7 phase-close dependency)",
      ].join("\n"),
    };
  }
  if (input.request === null) {
    if (!input.timedOut) return null;
    return {
      status: "fail",
      summary: "auth request never finished loading",
      evidence: "useGoogleSignIn().request stayed null past the patience window",
    };
  }
  const nonceInExtraParams = Boolean(input.request.extraParams?.nonce);
  const providerNonce = Boolean(input.request.nonce);
  const url = input.request.url ?? null;
  let urlHost: string | null = null;
  let nonceInUrl = false;
  if (typeof url === "string" && url.length > 0) {
    urlHost = /^https?:\/\/([^:/?#]+)/.exec(url)?.[1] ?? null;
    nonceInUrl = /[?&]nonce=/.test(url);
  }
  const evidence = [
    `request: loaded`,
    `our nonce in extraParams: ${nonceInExtraParams}`,
    `provider-minted instance nonce: ${providerNonce} (expected false on native — B-4)`,
    `authorize URL host: ${urlHost ?? "(no url)"}`,
    `nonce param in authorize URL: ${nonceInUrl}`,
    "(nonce values redacted by design)",
  ].join("\n");
  if (nonceInExtraParams && nonceInUrl) {
    return { status: "pass", summary: "request loaded; nonce present in authorize URL", evidence };
  }
  return {
    status: "fail",
    summary: nonceInExtraParams
      ? "nonce missing from the authorize URL (B-4 regression shape)"
      : "no nonce supplied on the request (B-4 regression shape)",
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Leg 5 — secure-store round-trip (session persistence substrate)
// ---------------------------------------------------------------------------

/** Narrow view of expo-secure-store — only what the probe needs. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * Dedicated probe key. NEVER the refresh-token key: this panel must not
 * read, write, or evict `gogo.refreshToken` (the 30-day bearer credential —
 * secure-storage.ts is its ONLY reader, and that invariant stays intact).
 */
export const DIAGNOSTICS_PROBE_KEY = "gogo.diagnostics.probe";

export interface SecureStoreLegDeps {
  store: SecureStoreLike;
  probeValue?: () => string;
}

/**
 * write → read-back → delete → verify-gone under a diagnostics-only key.
 * PASS: the keychain round-trips faithfully. FAIL: any step diverges or
 * throws (with the step named and the exact cause).
 */
export async function runSecureStoreLeg(deps: SecureStoreLegDeps): Promise<LegResult> {
  const value =
    deps.probeValue?.() ?? `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const steps: string[] = [`key: ${DIAGNOSTICS_PROBE_KEY}`];
  let step = "write";
  try {
    await deps.store.setItemAsync(DIAGNOSTICS_PROBE_KEY, value);
    steps.push("write: ok");

    step = "read-back";
    const readBack = await deps.store.getItemAsync(DIAGNOSTICS_PROBE_KEY);
    if (readBack !== value) {
      steps.push(`read-back: MISMATCH (got ${readBack === null ? "null" : "a different value"})`);
      return {
        status: "fail",
        summary: "keychain read-back did not match what was written",
        evidence: steps.join("\n"),
      };
    }
    steps.push("read-back: ok (value matches)");

    step = "delete";
    await deps.store.deleteItemAsync(DIAGNOSTICS_PROBE_KEY);
    steps.push("delete: ok");

    step = "verify-gone";
    const afterDelete = await deps.store.getItemAsync(DIAGNOSTICS_PROBE_KEY);
    if (afterDelete !== null) {
      steps.push("verify-gone: STALE — value survived deletion");
      return {
        status: "fail",
        summary: "deleted probe still readable — keychain deletes are not landing",
        evidence: steps.join("\n"),
      };
    }
    steps.push("verify-gone: ok");
    return {
      status: "pass",
      summary: "keychain write/read/delete round-trip ok",
      evidence: steps.join("\n"),
    };
  } catch (err) {
    steps.push(`${step}: THREW`, describeError(err));
    return {
      status: "fail",
      summary: `secure-store ${step} failed — exact cause below`,
      evidence: steps.join("\n"),
    };
  } finally {
    // Best-effort cleanup so a failed run never leaves probe residue.
    try {
      await deps.store.deleteItemAsync(DIAGNOSTICS_PROBE_KEY);
    } catch {
      // The probe key holds nothing sensitive; residue is cosmetic.
    }
  }
}

// ---------------------------------------------------------------------------
// Leg 6 — last surfaced dev-error cause (B-6, read back)
// ---------------------------------------------------------------------------

export interface LastErrorLegDeps {
  readTap: () => ConsoleTapSnapshot;
}

/**
 * PASS: the tap is live (evidence = the last captured `[auth]`/`[api]` warn,
 * or "none captured" — a clean session is a pass). FAIL: the tap is not
 * installed, i.e. this leg cannot observe anything and must say so rather
 * than imply a clean session.
 */
export async function runLastErrorLeg(deps: LastErrorLegDeps): Promise<LegResult> {
  const snap = deps.readTap();
  if (!snap.installed) {
    return {
      status: "fail",
      summary: "console tap not installed — dev-error capture is blind",
      evidence: "installConsoleTap() has not run; leg cannot observe B-6's dev surface",
    };
  }
  const since = snap.installedAt === null ? "(unknown)" : new Date(snap.installedAt).toISOString();
  if (snap.last === null) {
    return {
      status: "pass",
      summary: "no dev-surfaced errors captured this session",
      evidence: [`capturing since: ${since}`, "captured: 0", "last: (none)"].join("\n"),
    };
  }
  return {
    status: "pass",
    summary: `last dev error at ${new Date(snap.last.at).toISOString()}`,
    evidence: [
      `capturing since: ${since}`,
      `captured: ${snap.count}`,
      `last: ${snap.last.text}`,
    ].join("\n"),
  };
}
