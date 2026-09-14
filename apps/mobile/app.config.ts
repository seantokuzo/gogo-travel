/**
 * Dynamic Expo config (S-4 T4; .specs/testing/session-door.spec.md §5.2 —
 * "Bundle-identity guard", review round 1 B5 scenario B). `app.json` stays
 * the static base (Expo merges it in as `config` below); this file's only
 * job is the door build-variant switch.
 *
 * A door build and a door-free build are otherwise byte-identical at the
 * point of upload — the only difference is the `EXPO_PUBLIC_E2E_DOOR_SECRET`
 * string literal folded into the Hermes bundle by babel-preset-expo's
 * `inline-env-vars` plugin, which no human inspecting an `.ipa`/`.app` can
 * tell apart (spec §3.4 forbids trying to prove this with `strings | grep`).
 * Distinguishing the two at the BUNDLE-ID level instead means a door build
 * can never be archived or uploaded under the shipping App Store Connect
 * record: Apple's upload pipeline keys off `CFBundleIdentifier`, and
 * `app.gogotravel.e2edoor` has no matching record to receive it.
 *
 * This file runs as a plain Node script during `expo prebuild`/`expo run`/
 * `expo export` — NOT inside the JS bundle — so it reads the shell env
 * directly and needs no babel inlining. `isDoorBuild` mirrors the same
 * >=32-char threshold the client gate (`features/dev/e2e-door/door.ts`,
 * `isDoorSecretConfigured`) applies to the SAME env var name, so "this is a
 * door build" means the identical thing on both sides — deliberately NOT
 * shared code (one runs at Node/build time, the other at Metro/bundle time,
 * and they read the var through entirely different mechanisms), but the
 * threshold and the var name must stay in lockstep by inspection.
 *
 * 🔴 SWITCHING VARIANTS REQUIRES A PREBUILD (review round 1 B1). This module
 * is consulted ONLY by `expo prebuild` (and anything that runs it, like a
 * fresh `expo run:ios`) — a bare `expo run:ios` against an ALREADY-PREBUILT
 * `ios/` dir skips prebuild entirely and reuses whatever `PRODUCT_BUNDLE_
 * IDENTIFIER` the last prebuild wrote, silently ignoring this file. Use the
 * `pnpm ios:door` / `pnpm ios:doorfree` scripts (`package.json`), which
 * always run `expo prebuild --platform ios` first — never call `expo
 * run:ios` directly for a door/door-free build. Belt-and-suspenders: the
 * client gate's third condition (R-door-16,
 * `features/dev/e2e-door/door.ts`'s `isDoorBundleId`) additionally checks
 * the REAL installed bundle id at runtime, so even a mis-built binary that
 * skipped prebuild and still wears the shipping identity cannot open the
 * door — the identity and the capability are inseparable regardless of how
 * the binary was produced.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

const MIN_SECRET_LENGTH = 32;
const DOOR_BUNDLE_ID_SUFFIX = ".e2edoor";
const DOOR_NAME_SUFFIX = " (E2E)";

/** A plain string-map view of `process.env` — injectable so a test can drive
 *  both arms without touching the real `process.env`. */
export type EnvLike = Record<string, string | undefined>;

export function isDoorBuild(env: EnvLike = process.env): boolean {
  const secret = env.EXPO_PUBLIC_E2E_DOOR_SECRET;
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * The exported config function itself (not just the default export) so a
 * test can invoke it directly with a synthetic `ConfigContext` and assert
 * the two resulting `bundleIdentifier`/`name` values differ — no native
 * build needed for the pin (spec §5.2 "Verification").
 */
export function withDoorVariant({ config }: ConfigContext, env: EnvLike = process.env): ExpoConfig {
  const base = config as ExpoConfig;
  if (!isDoorBuild(env)) return base;

  const ios = base.ios ?? {};
  return {
    ...base,
    name: `${base.name}${DOOR_NAME_SUFFIX}`,
    ios: {
      ...ios,
      bundleIdentifier: `${ios.bundleIdentifier}${DOOR_BUNDLE_ID_SUFFIX}`,
    },
  };
}

export default withDoorVariant;
