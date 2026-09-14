/**
 * Dynamic Expo config — the bundle-identity guard (S-4 T4;
 * .specs/testing/session-door.spec.md §5.2 "Bundle-identity guard", review
 * round 1 B5 scenario B). Invokes the exported config function directly with
 * a synthetic `ConfigContext`, exactly as the spec's "Verification" note
 * prescribes — no native build needed for this pin.
 */
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
