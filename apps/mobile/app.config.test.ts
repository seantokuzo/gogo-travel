/**
 * Dynamic Expo config — the bundle-identity guard (S-4 T4;
 * .specs/testing/session-door.spec.md §5.2 "Bundle-identity guard", review
 * round 1 B5 scenario B). Invokes the exported config function directly with
 * a synthetic `ConfigContext`, exactly as the spec's "Verification" note
 * prescribes — no native build needed for this pin.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigContext, ExpoConfig } from "expo/config";

import { isDoorBuild, withDoorVariant } from "./app.config";

const BASE_CONFIG: Partial<ExpoConfig> = {
  name: "gogo-travel",
  slug: "gogo-travel",
  ios: { bundleIdentifier: "app.gogotravel" },
};

function ctx(config: Partial<ExpoConfig> = BASE_CONFIG): ConfigContext {
  return {
    projectRoot: "/repo/apps/mobile",
    staticConfigPath: null,
    packageJsonPath: null,
    config,
  };
}

describe("isDoorBuild (mirrors the client gate's G3 threshold, kept in lockstep by inspection)", () => {
  it("boundary: exactly 32 chars is a door build; 31 is not", () => {
    expect(isDoorBuild({ EXPO_PUBLIC_E2E_DOOR_SECRET: "a".repeat(32) })).toBe(true);
    expect(isDoorBuild({ EXPO_PUBLIC_E2E_DOOR_SECRET: "a".repeat(31) })).toBe(false);
  });

  it("absent env -> not a door build", () => {
    expect(isDoorBuild({})).toBe(false);
  });
});

describe("withDoorVariant — the two variants can never collide (§5.2 bundle-identity guard)", () => {
  it("door-free: passes the static config through byte-for-byte", () => {
    const result = withDoorVariant(ctx(), {});
    expect(result.name).toBe("gogo-travel");
    expect(result.ios?.bundleIdentifier).toBe("app.gogotravel");
  });

  it("door build: appends the distinct suffix to BOTH name and bundleIdentifier", () => {
    // Falsification: make `withDoorVariant` return `base` unconditionally
    // (drop the `isDoorBuild` branch) -> `bundleIdentifier` stays
    // "app.gogotravel" and this assertion goes RED.
    const result = withDoorVariant(ctx(), { EXPO_PUBLIC_E2E_DOOR_SECRET: "s".repeat(32) });
    expect(result.ios?.bundleIdentifier).toBe("app.gogotravel.e2edoor");
    expect(result.name).toBe("gogo-travel (E2E)");
  });

  it("the two variants' bundle identifiers are NEVER equal — a door build can never land on the shipping App Store Connect record", () => {
    const doorFree = withDoorVariant(ctx(), {});
    const door = withDoorVariant(ctx(), { EXPO_PUBLIC_E2E_DOOR_SECRET: "s".repeat(32) });
    expect(door.ios?.bundleIdentifier).not.toBe(doorFree.ios?.bundleIdentifier);
    expect(door.name).not.toBe(doorFree.name);
  });

  it("a too-short secret (31 chars) does NOT trigger the door variant", () => {
    const result = withDoorVariant(ctx(), { EXPO_PUBLIC_E2E_DOOR_SECRET: "s".repeat(31) });
    expect(result.ios?.bundleIdentifier).toBe("app.gogotravel");
  });

  it("preserves every other static config field untouched (spreads the base config)", () => {
    const withExtra = ctx({ ...BASE_CONFIG, scheme: "gogo", version: "0.0.1" });
    const result = withDoorVariant(withExtra, { EXPO_PUBLIC_E2E_DOOR_SECRET: "s".repeat(32) });
    expect(result.scheme).toBe("gogo");
    expect(result.version).toBe("0.0.1");
  });
});

describe("DOOR_BUNDLE_ID_SUFFIX lockstep (S-4 review round 2 item 3)", () => {
  it("app.config.ts's suffix literal matches door.ts's — this file's own doc comment says they must stay in lockstep BY INSPECTION (deliberately not shared code: one runs at Node/prebuild time, the other at Metro/bundle time), so pin the inspection itself", () => {
    // Falsification: change either file's `DOOR_BUNDLE_ID_SUFFIX` literal
    // (e.g. ".e2edoor" -> ".e2edoor2") without updating the other -> RED.
    const appConfigSrc = readFileSync(join(__dirname, "app.config.ts"), "utf8");
    const doorSrc = readFileSync(join(__dirname, "src/features/dev/e2e-door/door.ts"), "utf8");
    const literalPattern = /DOOR_BUNDLE_ID_SUFFIX\s*=\s*"([^"]+)"/;
    const appConfigMatch = appConfigSrc.match(literalPattern);
    const doorMatch = doorSrc.match(literalPattern);

    expect(appConfigMatch).not.toBeNull();
    expect(doorMatch).not.toBeNull();
    expect(doorMatch?.[1]).toBe(appConfigMatch?.[1]);
    // Anchor the shared value itself, not just their equality to each other —
    // two files silently drifting to a DIFFERENT (but still equal to each
    // other) suffix would still pass an equality-only check.
    expect(appConfigMatch?.[1]).toBe(".e2edoor");
  });
});
