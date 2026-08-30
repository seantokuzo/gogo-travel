/**
 * Auth runtime config (T-5.7 / NAV-2) — env-driven, no secrets.
 *
 * `EXPO_PUBLIC_*` vars are inlined by Metro at build time and are PUBLIC by
 * design: the API base URL is not a secret, and the Google OAuth *client id*
 * is a public identifier (the id token is verified server-side — the secret
 * is the server's, never shipped here). No refresh/access token or provider
 * secret ever lives in this module.
 */
import Constants from "expo-constants";
import { NativeModules } from "react-native";

/** apps/server dev port (server `env.ts` `PORT` default). */
export const DEV_SERVER_PORT = 3000;

/** Every server route is mounted under `/api` (contracts spec §3.6 / T-5.4). */
const API_BASE_PATH = "/api";

function withApiSuffix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith(API_BASE_PATH) ? trimmed : `${trimmed}${API_BASE_PATH}`;
}

/** Loopback hosts where cleartext http is always fine (simulator / same box). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** True for loopback + RFC-1918 LAN + mDNS hosts — the Metro dev surfaces. */
function isLocalOrPrivateHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".local")) return true; // mDNS / Bonjour dev host
  if (/^10\./.test(host)) return true; // 10.0.0.0/8
  if (/^192\.168\./.test(host)) return true; // 192.168.0.0/16
  return /^172\.(1[6-9]|2\d|3[01])\./.test(host); // 172.16.0.0/12
}

/**
 * Transport guard (T-5.7 r1 security): refuse a cleartext base URL in a release
 * build. A non-https endpoint to a non-local host would carry the 30-day
 * refresh token (and every bearer) in the clear. Metro's loopback/LAN dev hosts
 * stay allowed so `npx expo start` on a device keeps working, and any https URL
 * always passes. Called at ApiClient construction (via `resolveApiBaseUrl`).
 */
export function assertSecureBaseUrl(url: string, dev: boolean = __DEV__): string {
  if (url.startsWith("https://")) return url;
  const host = url.replace(/^https?:\/\//, "").split(/[:/]/)[0] ?? "";
  if (dev || isLocalOrPrivateHost(host)) return url;
  throw new Error(
    "Insecure API base URL: a non-https endpoint is refused in release builds " +
      "(the refresh token would travel in cleartext). Set EXPO_PUBLIC_API_URL to an https URL.",
  );
}

/**
 * Narrow view of the `SourceCode` native module (RN 0.86
 * `Libraries/NativeModules/specs/NativeSourceCode`): new-arch/TurboModule
 * exposes `getConstants().scriptURL`; the legacy bridge hoists constants onto
 * the module object as `.scriptURL`. Both are covered.
 */
type SourceCodeModule = {
  getConstants?: () => { scriptURL?: string | null };
  scriptURL?: string | null;
};

/**
 * The host the bundle itself was served from — i.e. the Metro dev server
 * (B-5). In a dev build `SourceCode.scriptURL` is ALWAYS the Metro URL
 * (`http://<host>:8081/index.bundle?...`), even in a dev-client build where
 * `Constants.expoConfig.hostUri` is empty. In a release build the bundle is
 * embedded, `scriptURL` is `file://...`, the `https?` match fails, and this
 * returns `null` — an embedded bundle has no dev host to offer.
 *
 * Same extraction RN's own `getDevServer()` performs
 * (`Libraries/Core/Devtools/getDevServer.js`); read here via `NativeModules`
 * to spare a deep Flow-file import (and its throw on `scriptURL: null`,
 * which is exactly what the jest preset's `SourceCode` mock returns).
 */
/** Raw `SourceCode.scriptURL` (both native-arch shapes), or null when absent. */
function readScriptURL(): string | null {
  const sourceCode = (NativeModules as { SourceCode?: SourceCodeModule | null }).SourceCode;
  const scriptURL = sourceCode?.getConstants?.().scriptURL ?? sourceCode?.scriptURL;
  return typeof scriptURL === "string" ? scriptURL : null;
}

function resolveMetroHost(): string | null {
  const scriptURL = readScriptURL();
  if (scriptURL === null) return null;
  // `@` is excluded so a userinfo-bearing URL (`http://a@evil.com`) can never
  // smuggle its real host past the capture: the guard's host parse and
  // fetch's host parse would otherwise disagree about which side of the `@`
  // is the host (R1 security finding). The capture stops at the userinfo
  // boundary, so only the pre-`@` segment can ever be derived.
  const match = /^https?:\/\/([^:/@]+)/.exec(scriptURL);
  return match?.[1] ?? null;
}

/** Which resolution tier produced the base URL (T-S3.5 device-smoke leg 1). */
export type ApiBaseUrlSource =
  | "explicit-env"
  | "expo-config-host-uri"
  | "metro-script-url"
  | "localhost-fallback";

/**
 * The resolved base URL plus its provenance — which tier fired, and the raw
 * inputs every tier read. Evidence surface for the `__DEV__` diagnostics
 * panel (R-test-2): B-5 cost two debugging rounds because nobody could SEE
 * which tier a device resolved. None of these values is a secret (module
 * header: the base URL is public by design; hostUri/scriptURL are the Metro
 * dev host the bundle itself came from).
 */
export interface ApiBaseUrlResolution {
  /** Identical to `resolveApiBaseUrl()`'s return — same tiers, same guard. */
  url: string;
  /** 1-based tier number (doc-comment on `resolveApiBaseUrl`). */
  tier: 1 | 2 | 3 | 4;
  source: ApiBaseUrlSource;
  /** Raw inputs as read, before any tier logic touched them. */
  inputs: {
    explicitEnv: string | null;
    hostUri: string | null;
    scriptURL: string | null;
  };
}

/**
 * `resolveApiBaseUrl` with the tier decision made visible. This IS the
 * resolver — `resolveApiBaseUrl` delegates here, so the provenance this
 * reports can never diverge from the URL the app actually uses (a separate
 * "explainer" re-implementing the tiers would be the B-5 class all over
 * again: two copies of the truth, one of them wrong on hardware).
 */
export function explainApiBaseUrl(): ApiBaseUrlResolution {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  const hostUri = Constants.expoConfig?.hostUri ?? null;
  const scriptURL = readScriptURL();
  const inputs = {
    explicitEnv: explicit !== undefined && explicit.length > 0 ? explicit : null,
    hostUri,
    scriptURL,
  };

  if (explicit && explicit.length > 0) {
    return {
      url: assertSecureBaseUrl(withApiSuffix(explicit)),
      tier: 1,
      source: "explicit-env",
      inputs,
    };
  }

  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host) {
      return {
        url: assertSecureBaseUrl(`http://${host}:${DEV_SERVER_PORT}${API_BASE_PATH}`),
        tier: 2,
        source: "expo-config-host-uri",
        inputs,
      };
    }
  }

  const metroHost = resolveMetroHost();
  if (metroHost) {
    return {
      url: assertSecureBaseUrl(`http://${metroHost}:${DEV_SERVER_PORT}${API_BASE_PATH}`),
      tier: 3,
      source: "metro-script-url",
      inputs,
    };
  }

  return {
    url: assertSecureBaseUrl(`http://localhost:${DEV_SERVER_PORT}${API_BASE_PATH}`),
    tier: 4,
    source: "localhost-fallback",
    inputs,
  };
}

/**
 * Resolve the API base URL (always normalized to end in `/api`). Priority:
 * 1. `EXPO_PUBLIC_API_URL` — explicit override (staging/prod/tunnel).
 * 2. Derived from the Metro dev host (`Constants.expoConfig.hostUri` =
 *    `<lan-ip>:8081`) → `http://<lan-ip>:3000/api`, so a physical device on
 *    the same LAN reaches the dev server with zero config (Expo Go path).
 * 3. Derived from the bundle's own source URL (`SourceCode.scriptURL`) —
 *    dev-client builds, where `hostUri` is EMPTY and tier 2 never fires
 *    (B-5: the fall-through to `localhost` made a physical device call
 *    itself; every device→server call died as "network request failed").
 * 4. `http://localhost:3000/api` — the SIMULATOR's fallback (loopback IS the
 *    dev box there). Never correct for a physical device, which is why it is
 *    the terminal tier and nothing device-shaped may land on it.
 */
export function resolveApiBaseUrl(): string {
  return explainApiBaseUrl().url;
}

/**
 * Google OAuth client ids (public identifiers). Empty until Sean provisions a
 * Google OAuth client — device Google sign-in is a phase-close dependency
 * (T-5.7 report). Apple needs no client id here: the app bundle id IS the
 * token audience the server verifies against (`APPLE_CLIENT_ID`, server-side).
 */
export const googleClientIds = {
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
} as const;

/** Google sign-in can only run on-device once a client id is provisioned. */
export function isGoogleConfigured(): boolean {
  return Boolean(googleClientIds.iosClientId ?? googleClientIds.webClientId);
}
