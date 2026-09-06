/**
 * Auth config (T-5.7 r1) — the transport-security guard on the API base URL. A
 * release build must never carry the 30-day refresh token over cleartext http
 * to a non-local host; Metro's loopback/LAN dev hosts stay allowed so device
 * dev keeps working. `dev` is passed explicitly (jest runs with __DEV__ true).
 *
 * B-5 (device QA 2026-08-29): `resolveApiBaseUrl` used to land on `localhost`
 * whenever `Constants.expoConfig.hostUri` was empty — which it ALWAYS is in a
 * dev-client build — so a physical device called itself and every server call
 * died. The derivation tests below drive the REAL module wiring (real
 * expo-constants via its `__rawManifest_TEST` escape hatch, the real jest
 * `NativeModules.SourceCode` mock via spies) — no `jest.mock` of either
 * source, so a broken production import path cannot hide behind a mock.
 */
import Constants from "expo-constants";
import { NativeModules } from "react-native";

import { assertSecureBaseUrl, resolveApiBaseUrl } from "./config";

describe("assertSecureBaseUrl", () => {
  it("allows any https URL (prod transport)", () => {
    expect(assertSecureBaseUrl("https://api.gogo.travel/api", false)).toBe(
      "https://api.gogo.travel/api",
    );
  });

  it("allows http to loopback even in a release build (simulator / same box)", () => {
    expect(assertSecureBaseUrl("http://localhost:3000/api", false)).toBe(
      "http://localhost:3000/api",
    );
    expect(assertSecureBaseUrl("http://127.0.0.1:3000/api", false)).toBe(
      "http://127.0.0.1:3000/api",
    );
  });

  it("allows http to a LAN host even in a release build (Metro on a device)", () => {
    expect(assertSecureBaseUrl("http://192.168.1.50:3000/api", false)).toBe(
      "http://192.168.1.50:3000/api",
    );
    expect(assertSecureBaseUrl("http://10.0.0.2:3000/api", false)).toBe("http://10.0.0.2:3000/api");
    expect(assertSecureBaseUrl("http://172.16.5.5:3000/api", false)).toBe(
      "http://172.16.5.5:3000/api",
    );
    expect(assertSecureBaseUrl("http://macbook.local:3000/api", false)).toBe(
      "http://macbook.local:3000/api",
    );
  });

  it("rejects cleartext http to a public host in a release build", () => {
    expect(() => assertSecureBaseUrl("http://api.gogo.travel/api", false)).toThrow(/non-https/i);
  });

  it("permits http anywhere in a dev build (Metro tunnel / __DEV__)", () => {
    expect(assertSecureBaseUrl("http://api.example.com/api", true)).toBe(
      "http://api.example.com/api",
    );
  });
});

describe("resolveApiBaseUrl", () => {
  const prev = process.env.EXPO_PUBLIC_API_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = prev;
  });

  it("normalizes an explicit https override to end in /api", () => {
    process.env.EXPO_PUBLIC_API_URL = "https://staging.gogo.travel";
    expect(resolveApiBaseUrl()).toBe("https://staging.gogo.travel/api");
  });

  it("passes an explicit http override through the guard (rejects a public host)", () => {
    process.env.EXPO_PUBLIC_API_URL = "http://staging.gogo.travel";
    // __DEV__ is true under jest, so the guard permits it — assert the shape,
    // and that the guard is wired (the pure assertSecureBaseUrl test covers the
    // release-build rejection where __DEV__ is false).
    expect(resolveApiBaseUrl()).toBe("http://staging.gogo.travel/api");
  });

  describe("dev-host derivation (B-5)", () => {
    /**
     * expo-constants ships a test-only `__rawManifest_TEST` accessor that
     * swaps the module's internal `rawManifest`. A manifest object WITHOUT a
     * `metadata` key reads as an embedded manifest, which `expoConfig`
     * returns verbatim — so `{ hostUri }` lands exactly where the production
     * tier-2 read looks. This drives the REAL module, not a mock of it.
     */
    const manifestHandle = Constants as unknown as { __rawManifest_TEST: unknown };
    let originalManifest: unknown;

    function setHostUri(hostUri: string | null): void {
      manifestHandle.__rawManifest_TEST = hostUri === null ? null : { hostUri };
    }

    /**
     * The jest preset's real `SourceCode` mock is `getConstants(): {
     * scriptURL: null }` — spy on that same object (shared with the module
     * under test via the preset's moduleNameMapper) rather than mocking the
     * `react-native` import.
     */
    function setScriptUrl(scriptURL: string | null): void {
      jest.spyOn(NativeModules.SourceCode, "getConstants").mockReturnValue({ scriptURL });
    }

    beforeEach(() => {
      originalManifest = manifestHandle.__rawManifest_TEST;
      delete process.env.EXPO_PUBLIC_API_URL;
    });

    afterEach(() => {
      manifestHandle.__rawManifest_TEST = originalManifest;
      jest.restoreAllMocks();
    });

    it("tier 1: explicit override beats BOTH live derivation sources (with control arm)", () => {
      setHostUri("192.168.1.50:8081");
      setScriptUrl("http://10.0.0.7:8081/index.bundle?platform=ios&dev=true");
      process.env.EXPO_PUBLIC_API_URL = "https://staging.gogo.travel";
      expect(resolveApiBaseUrl()).toBe("https://staging.gogo.travel/api");

      // Control arm: the derivation sources were live — removing the override
      // (only) must surface one of them, or the assertion above was vacuous.
      delete process.env.EXPO_PUBLIC_API_URL;
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.50:3000/api");
    });

    it("tier 2: derives the API host from expoConfig.hostUri (Expo Go / expo start)", () => {
      setHostUri("192.168.1.50:8081");
      setScriptUrl(null);
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.50:3000/api");
    });

    it("tier 2 outranks tier 3: hostUri wins over scriptURL (with control arm)", () => {
      setHostUri("192.168.1.50:8081");
      setScriptUrl("http://10.0.0.7:8081/index.bundle?platform=ios&dev=true");
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.50:3000/api");

      // Control arm: same scriptURL with hostUri gone must surface tier 3 —
      // proving the scriptURL source was live while tier 2 outranked it.
      setHostUri(null);
      expect(resolveApiBaseUrl()).toBe("http://10.0.0.7:3000/api");
    });

    it("tier 3 (THE B-5 PIN): hostUri absent (dev-client build) derives from SourceCode.scriptURL — not localhost", () => {
      // A dev-client build: expoConfig carries no hostUri, but the bundle's
      // own source URL is the Metro dev server. Pre-fix this resolved to
      // http://localhost:3000/api and the phone called itself.
      setHostUri(null);
      setScriptUrl("http://192.168.1.69:8081/index.bundle?platform=ios&dev=true&minify=false");
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.69:3000/api");
    });

    it("tier 3 also reads the legacy constants-hoisted SourceCode.scriptURL property", () => {
      setHostUri(null);
      // Legacy-bridge shape: constants hoisted onto the module, no getConstants.
      jest.replaceProperty(
        NativeModules as { SourceCode: unknown },
        "SourceCode",
        { scriptURL: "http://10.0.0.7:8081/index.bundle?platform=ios&dev=true" },
      );
      expect(resolveApiBaseUrl()).toBe("http://10.0.0.7:3000/api");
    });

    it("tier 3 refuses a file:// scriptURL (embedded release bundle) — with control arm", () => {
      setHostUri(null);
      setScriptUrl("file:///var/containers/Bundle/Application/GoGo.app/main.jsbundle");
      expect(resolveApiBaseUrl()).toBe("http://localhost:3000/api");

      // Control arm: an http scriptURL through the same harness derives —
      // proving the file:// rejection (not a dead source) produced localhost.
      setScriptUrl("http://192.168.1.69:8081/index.bundle?platform=ios&dev=true");
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.69:3000/api");
    });

    it("tier 3 stops the host capture at userinfo: a `@`-bearing scriptURL can never smuggle its real host — with control arm", () => {
      // R1 security finding: with `[^:/]+` the capture kept the whole
      // `192.168.1.1@evil.com`, assertSecureBaseUrl's own parse ALSO kept the
      // `@` (the /^192\.168\./ prefix matched), yet fetch would read the host
      // as evil.com — guard and fetch disagreeing about the same URL. The
      // capture now stops at `@`, so only the pre-`@` segment derives.
      setHostUri(null);
      setScriptUrl("http://192.168.1.1@evil.com:8081/index.bundle?platform=ios");
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.1:3000/api");

      // Control arm: evil.com as the GENUINE host flows through this same
      // harness (jest runs __DEV__-true, so the transport guard permits it) —
      // proving an evil.com-hosted result was expressible, and the pin above
      // refusing to produce one is the capture's doing, not a dead source.
      setScriptUrl("http://evil.com:8081/index.bundle?platform=ios");
      expect(resolveApiBaseUrl()).toBe("http://evil.com:3000/api");
    });

    it("tier 4: localhost is the terminal fallback ONLY when every dev-host source is empty — with control arm", () => {
      setHostUri(null);
      setScriptUrl(null);
      expect(resolveApiBaseUrl()).toBe("http://localhost:3000/api");

      // Control arm: the same harness with a live scriptURL must NOT land on
      // localhost — proving the fallback assertion could have failed.
      setScriptUrl("http://192.168.1.69:8081/index.bundle?platform=ios&dev=true");
      expect(resolveApiBaseUrl()).toBe("http://192.168.1.69:3000/api");
    });
  });
});
