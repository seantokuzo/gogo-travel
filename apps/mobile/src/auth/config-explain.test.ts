/**
 * `explainApiBaseUrl` provenance (T-S3.5, R-test-2) — the tier decision made
 * visible for the device-smoke diagnostics panel. Drives the REAL module
 * wiring exactly like config.test.ts (expo-constants `__rawManifest_TEST`
 * escape hatch + the preset's real `SourceCode` mock — no `jest.mock` of
 * either source).
 *
 * Falsification (R-test-7): each pin goes red if the tier logic reorders, if
 * a tier stops reporting its number/source, or if the raw inputs stop being
 * captured. The identity pin at the bottom goes red the moment
 * `resolveApiBaseUrl` stops delegating to `explainApiBaseUrl` — the exact
 * drift (two copies of the tier truth) this refactor exists to prevent.
 */
import Constants from "expo-constants";
import { NativeModules } from "react-native";

import { explainApiBaseUrl, resolveApiBaseUrl } from "./config";

const manifestHandle = Constants as unknown as { __rawManifest_TEST: unknown };

function setHostUri(hostUri: string | null): void {
  manifestHandle.__rawManifest_TEST = hostUri === null ? null : { hostUri };
}

function setScriptUrl(scriptURL: string | null): void {
  jest.spyOn(NativeModules.SourceCode, "getConstants").mockReturnValue({ scriptURL });
}

describe("explainApiBaseUrl (tier provenance — the B-5 evidence surface)", () => {
  const prevEnv = process.env.EXPO_PUBLIC_API_URL;
  let originalManifest: unknown;

  beforeEach(() => {
    originalManifest = manifestHandle.__rawManifest_TEST;
    delete process.env.EXPO_PUBLIC_API_URL;
  });

  afterEach(() => {
    manifestHandle.__rawManifest_TEST = originalManifest;
    jest.restoreAllMocks();
    if (prevEnv === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = prevEnv;
  });

  it("tier 1: explicit env override — url, tier, source, and ALL raw inputs reported", () => {
    setHostUri("192.168.1.50:8081");
    setScriptUrl("http://10.0.0.7:8081/index.bundle?platform=ios&dev=true");
    process.env.EXPO_PUBLIC_API_URL = "https://staging.gogo.travel";

    expect(explainApiBaseUrl()).toEqual({
      url: "https://staging.gogo.travel/api",
      tier: 1,
      source: "explicit-env",
      // Raw inputs are captured even for the tiers that DIDN'T fire — the
      // panel needs to show what each tier saw, not just the winner.
      inputs: {
        explicitEnv: "https://staging.gogo.travel",
        hostUri: "192.168.1.50:8081",
        scriptURL: "http://10.0.0.7:8081/index.bundle?platform=ios&dev=true",
      },
    });
  });

  it("tier 2: hostUri derivation (Expo Go) reports its provenance", () => {
    setHostUri("192.168.1.50:8081");
    setScriptUrl(null);

    expect(explainApiBaseUrl()).toEqual({
      url: "http://192.168.1.50:3000/api",
      tier: 2,
      source: "expo-config-host-uri",
      inputs: { explicitEnv: null, hostUri: "192.168.1.50:8081", scriptURL: null },
    });
  });

  it("tier 3 (the B-5 shape): dev-client build — empty hostUri, scriptURL derivation", () => {
    setHostUri(null);
    setScriptUrl("http://192.168.1.69:8081/index.bundle?platform=ios&dev=true");

    expect(explainApiBaseUrl()).toEqual({
      url: "http://192.168.1.69:3000/api",
      tier: 3,
      source: "metro-script-url",
      inputs: {
        explicitEnv: null,
        hostUri: null,
        scriptURL: "http://192.168.1.69:8081/index.bundle?platform=ios&dev=true",
      },
    });
  });

  it("tier 4: terminal localhost fallback labels itself — with control arm", () => {
    setHostUri(null);
    setScriptUrl(null);

    expect(explainApiBaseUrl()).toEqual({
      url: "http://localhost:3000/api",
      tier: 4,
      source: "localhost-fallback",
      inputs: { explicitEnv: null, hostUri: null, scriptURL: null },
    });

    // Control arm: the same harness with a live scriptURL must NOT report the
    // fallback — proving tier 4 above was a decision, not a dead default.
    setScriptUrl("http://192.168.1.69:8081/index.bundle?platform=ios&dev=true");
    expect(explainApiBaseUrl()).toMatchObject({ tier: 3, source: "metro-script-url" });
  });

  it("set-but-blank env is captured RAW ('' — not normalized to null) while the tier falls through (PR #43 R1)", () => {
    // Falsification: restore the old `length > 0 ? explicit : null`
    // normalization → the explicitEnv pin below reds. Leg 1 and leg 3 must
    // agree about EXPO_PUBLIC_API_URL="" in the same screenshot.
    setHostUri("192.168.1.50:8081");
    setScriptUrl(null);
    process.env.EXPO_PUBLIC_API_URL = "";

    expect(explainApiBaseUrl()).toEqual({
      url: "http://192.168.1.50:3000/api",
      tier: 2,
      source: "expo-config-host-uri",
      inputs: { explicitEnv: "", hostUri: "192.168.1.50:8081", scriptURL: null },
    });
  });

  it("tier 3 file:// refusal keeps the RAW scriptURL in evidence while tier 4 fires", () => {
    // A release-shaped embedded bundle: the panel must show WHY tier 3
    // declined (the file:// URL is right there) — not just "localhost".
    setHostUri(null);
    setScriptUrl("file:///var/containers/Bundle/Application/GoGo.app/main.jsbundle");

    expect(explainApiBaseUrl()).toEqual({
      url: "http://localhost:3000/api",
      tier: 4,
      source: "localhost-fallback",
      inputs: {
        explicitEnv: null,
        hostUri: null,
        scriptURL: "file:///var/containers/Bundle/Application/GoGo.app/main.jsbundle",
      },
    });
  });

  it("IDENTITY PIN: resolveApiBaseUrl() IS explainApiBaseUrl().url on every tier", () => {
    // Red if the resolver stops delegating (a re-implemented tier ladder can
    // silently disagree with the provenance — the two-truths B-5 class).
    const arms: [string | null, string | null, string | undefined][] = [
      ["192.168.1.50:8081", "http://10.0.0.7:8081/index.bundle", "https://staging.gogo.travel"],
      ["192.168.1.50:8081", null, undefined],
      [null, "http://10.0.0.7:8081/index.bundle?platform=ios", undefined],
      [null, null, undefined],
    ];
    for (const [hostUri, scriptURL, env] of arms) {
      setHostUri(hostUri);
      setScriptUrl(scriptURL);
      if (env === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = env;
      expect(resolveApiBaseUrl()).toBe(explainApiBaseUrl().url);
    }
  });
});
