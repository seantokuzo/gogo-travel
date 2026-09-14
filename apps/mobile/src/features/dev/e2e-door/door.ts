/**
 * E2E session door — client half (S-4 T4; .specs/testing/session-door.spec.md
 * §4.5). One of exactly two importers of `@gogo/shared/domains/e2e` (the
 * other is `apps/server/src/auth/e2e-door.ts` — the descriptor's own doc
 * comment names both, a greppable property).
 *
 * `openSessionDoor` is a PURE function over injected deps — no store import,
 * no module singleton — so every branch (disabled, rejected, network throw,
 * success) is unit-testable without a router or a query client. The route
 * file (`app/(auth)/e2e-session.tsx`) does the wiring.
 *
 * Triple gate (R-door-7, R-door-16), all checked here so the function is
 * self-contained and safe to call from anywhere: (1) the secret was
 * build-inlined at >=32 chars (G3 — see `isDoorSecretConfigured`), (2)
 * the caller's resolved API base is loopback/private (`isLocalOrPrivateHost`,
 * the SAME predicate `apps/mobile/src/auth/config.ts` already exports and
 * the rest of the client already trusts), AND (3) the REAL installed bundle
 * id carries the `.e2edoor` suffix (`isDoorBundleId`, review round 1 B1 —
 * `expo run:ios` on an already-prebuilt `ios/` dir never re-consults
 * `app.config.ts`, so (1)+(2) alone can pass in a mis-built binary that
 * still wears the SHIPPING `CFBundleIdentifier`). Failing ANY of the three
 * means: no network call, ever, and the presented secret is simply not read
 * past the length check — a door-free build never had a real value to read
 * in the first place (Metro folds the unset env member expression to the
 * literal `undefined` at compile time; nothing here can un-fold that at
 * runtime).
 */
import * as Application from "expo-application";
import * as Device from "expo-device";
import { type ApiClient, type SignInResponse } from "@gogo/shared";
import { e2eEndpoints, E2eSessionRequestSchema } from "@gogo/shared/domains/e2e";

import { hostOf, isLocalOrPrivateHost } from "@/auth/config";
import { ApiRequestError } from "@/auth/api-client";

/** G3 threshold — mirrors the server's `E2E_SESSION_DOOR_SECRET` >=32-char gate. */
const MIN_SECRET_LENGTH = 32;

/**
 * R-door-16 third gate. Mirrors `app.config.ts`'s `DOOR_BUNDLE_ID_SUFFIX` —
 * deliberately NOT shared code (that module runs as a plain Node script at
 * prebuild time and has no import path into the RN bundle; see its own
 * doc-comment), so the literal is duplicated here and must stay in lockstep
 * by inspection. `expo-application`'s `applicationId` reads the REAL
 * installed `CFBundleIdentifier` at native init — NOT
 * `Constants.expoConfig?.ios?.bundleIdentifier`, which reflects the resolved
 * app CONFIG, not what actually got prebuilt/archived, and would report the
 * suffixed id even for a mis-built binary that skipped prebuild.
 */
const DOOR_BUNDLE_ID_SUFFIX = ".e2edoor";

/**
 * The client gate's third condition (R-door-16). Injectable so a unit test
 * can drive both arms without a native module. Defaults to the real
 * `expo-application` value.
 */
export function isDoorBundleId(
  bundleId: string | null | undefined = Application.applicationId,
): boolean {
  return typeof bundleId === "string" && bundleId.endsWith(DOOR_BUNDLE_ID_SUFFIX);
}

/**
 * Client build gate (G3). Reads the Metro-inlined env var as a FUNCTION call
 * (never a frozen module-level constant) — the same convention
 * `resolveApiBaseUrl`/`EXPO_PUBLIC_API_URL` already uses (`auth/config.ts`),
 * so a jest test can drive both arms by setting `process.env` directly, with
 * no module-registry reset required. `secret` is also injectable so a test
 * can drive both arms without touching `process.env` at all.
 */
export function isDoorSecretConfigured(
  secret: string | undefined = process.env.EXPO_PUBLIC_E2E_DOOR_SECRET,
): boolean {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

export interface OpenDoorParams {
  userKey: string;
  firstRun: boolean;
}

export interface OpenDoorDeps {
  api: ApiClient;
  /** The API base URL actually in use, checked with `isLocalOrPrivateHost`
   *  before ANY of the rest of this function runs (R-door-7): a build can
   *  carry the secret and still be pointed at a hosted base after the fact. */
  apiBase: string;
  /**
   * Client-local reset ONLY (session store, secure-store refresh token,
   * query cache, tab/trip memory, money-segment memory, deeplink-return and
   * settle-return records, last-zone map — R-door-8). NEVER calls the
   * server: wire `useSessionStore.getState().resetLocalSession`, never
   * `signOut` — unlike `signOut()`, this never fires the best-effort
   * `/auth/logout` POST, so a door run's reset never depends on network
   * reachability. Called and awaited BEFORE the mint request is issued.
   */
  resetLocalSession: () => Promise<void>;
  /** `useSessionStore.getState().applySignIn` — the exact session-apply path
   *  a real sign-in uses; the door introduces no new client state handling. */
  applySignIn: (response: SignInResponse) => Promise<void>;
  /** The build-inlined secret; injected so a unit test can drive both arms
   *  without touching `process.env`. Defaults to the real Metro-inlined var. */
  secret?: string | undefined;
  /** The REAL installed bundle id (R-door-16 third gate); injected so a unit
   *  test can drive both arms without a native module. Defaults to the real
   *  `expo-application` value. */
  bundleId?: string | null | undefined;
  /**
   * S-4 T4 review round 2 (A4 residual): true once a LATER invocation has
   * superseded this one (the route wires this to the same per-invocation
   * `cancelled` flag that already guards `applySignIn`). Checked right after
   * `resetLocalSession()` resolves, BEFORE the mint POST fires — `reset`
   * itself cannot be skipped for a run that was still current when it
   * started (R-door-8 needs every invocation to clear stale state before it
   * knows whether it will win), but nothing past that point should run for
   * a run that lost the race while its reset was still in flight: no wasted
   * mint request, and no chance of a stray `applySignIn` landing after a
   * later invocation already applied the real session. Defaults to
   * `() => false` so existing single-invocation callers are unaffected.
   */
  isSuperseded?: () => boolean;
}

export type OpenDoorResult =
  { ok: true } | { ok: false; reason: "disabled" | "rejected" | "network" | "superseded" };

/**
 * `first_run` param parsing (adversarial guard — type-confusion). ONLY the
 * literal string `"true"` means true; a missing param, `"1"`, `"TRUE"`, or an
 * array (a repeated query key) all mean false. Never throws: a malformed
 * `first_run` degrades to false, never a crash.
 */
export function parseFirstRun(raw: string | string[] | undefined): boolean {
  return raw === "true";
}

/** `user_key` fallback — a missing param mints/reuses the `"default"` fixture. */
export function resolveUserKey(raw: string | string[] | undefined): string {
  return typeof raw === "string" && raw.length > 0 ? raw : "default";
}

/**
 * Run the full door sequence: gate check → client-local reset → mint POST →
 * apply the response through the real sign-in session path. Every branch
 * returns rather than throws, so the route never needs a try/catch of its
 * own around this call.
 */
export async function openSessionDoor(p: OpenDoorParams, d: OpenDoorDeps): Promise<OpenDoorResult> {
  const secret = d.secret ?? process.env.EXPO_PUBLIC_E2E_DOOR_SECRET;
  const bundleId = d.bundleId ?? Application.applicationId;
  if (
    !isDoorSecretConfigured(secret) ||
    !isLocalOrPrivateHost(hostOf(d.apiBase)) ||
    !isDoorBundleId(bundleId)
  ) {
    return { ok: false, reason: "disabled" };
  }

  // Adversarial: a malformed user_key (or any other shape violation) is
  // rejected client-side, before any network call — never sent to the
  // server just to find out it's invalid there too.
  const parsed = E2eSessionRequestSchema.safeParse({
    secret,
    user_key: p.userKey,
    device: { platform: "ios", device_name: Device.deviceName ?? undefined },
    first_run: p.firstRun,
  });
  if (!parsed.success) {
    return { ok: false, reason: "rejected" };
  }

  await d.resetLocalSession();

  // S-4 T4 review round 2 (A4 residual): a later invocation may have already
  // won the race while this one's reset was in flight. Bail before the mint
  // POST — never fire a request whose response this invocation is not
  // allowed to apply anyway (`applySignIn` below is guarded independently by
  // the SAME token, but skipping the request outright avoids the wasted
  // network call and the window it opens).
  if (d.isSuperseded?.()) {
    return { ok: false, reason: "superseded" };
  }

  let response: SignInResponse;
  try {
    response = await d.api.request(e2eEndpoints.mintSession, { body: parsed.data });
  } catch (err) {
    // R-door-6: never let a transport/rejection error surface the secret —
    // `ApiRequestError` already strips it (api-client.ts); this branch adds
    // nothing of its own to any log or message, and never re-throws.
    const rejected = err instanceof ApiRequestError && err.status === 401;
    return { ok: false, reason: rejected ? "rejected" : "network" };
  }

  await d.applySignIn(response);
  return { ok: true };
}
