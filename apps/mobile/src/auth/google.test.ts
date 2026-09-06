/**
 * Google sign-in nonce contract + request builder (T-5.7; B-4 fix).
 *
 * Google echoes the request nonce VERBATIM into the id-token `nonce` claim →
 * server raw match (R-auth-3). The load-bearing detail these tests pin is
 * WHERE that nonce comes from: on native the provider does NOT mint one (it
 * only does so under `responseType === ResponseType.IdToken`, and installed
 * apps resolve to `Code`), so we pass it ourselves via `extraParams`. The
 * previous version of this file asserted `{ nonce }` — a request shape the
 * library never produces on iOS — which is exactly why the outage shipped.
 */
import { renderHook } from "@testing-library/react-native";

import { buildGoogleSignInRequest, useGoogleSignIn } from "./google";

jest.mock("expo-device", () => ({ __esModule: true, deviceName: "Test Device" }));

jest.mock("expo-crypto", () => ({
  __esModule: true,
  getRandomBytes: (n: number) => new Uint8Array(n).fill(0xab),
  // The primitives the REAL AuthRequest's PKCE module reaches for
  // (PKCE.js: generateRandom → getRandomValues; deriveChallengeAsync →
  // digestStringAsync + the two enums). Only expo-crypto is mocked — the
  // AuthRequest/PKCE code under contract test runs for real.
  getRandomValues: (array: Uint8Array) => array.fill(0xcd),
  digestStringAsync: async () => "bW9ja2RpZ2VzdA==",
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64", HEX: "hex" },
}));

/** Only the slice of the provider config this test asserts on. */
type GoogleAuthConfig = { extraParams?: Record<string, string> };

// Per-file override of the global stub (jest.setup) so the config the hook
// hands the provider is observable. The param is typed so `mock.calls[0][0]`
// carries it — an untyped `jest.fn()` records `[]` and typecheck rejects the
// index access even though jest is happy at runtime.
const mockUseIdTokenAuthRequest = jest.fn((_config: GoogleAuthConfig) => [null, null, jest.fn()]);
jest.mock("expo-auth-session/providers/google", () => ({
  __esModule: true,
  useIdTokenAuthRequest: (config: GoogleAuthConfig) => mockUseIdTokenAuthRequest(config),
}));

describe("useGoogleSignIn nonce supply", () => {
  beforeEach(() => mockUseIdTokenAuthRequest.mockClear());

  it("passes a nonce to the provider via extraParams", async () => {
    // RNTL v14 made `renderHook` async — await it (see .claude/rules/mobile.md).
    await renderHook(() => useGoogleSignIn());

    expect(mockUseIdTokenAuthRequest).toHaveBeenCalled();
    const config = mockUseIdTokenAuthRequest.mock.calls[0]?.[0];
    // The discriminating assertion: without our supply this is `undefined`,
    // because the provider only mints a nonce on the IdToken/web path.
    expect(config?.extraParams?.nonce).toEqual(expect.any(String));
    expect(config?.extraParams?.nonce).toHaveLength(64); // 32 bytes, hex
  });

  it("hands the provider the SAME extraParams object across rerenders (stable nonce identity)", async () => {
    // IDENTITY (toBe), not value equality: the 0xab-filled getRandomBytes
    // mock makes every generated nonce byte-identical, so a value pin would
    // stay green even if the hook minted a fresh object (and nonce) per
    // render — the exact useMemo regression this pin exists to catch. A
    // re-render rebuilding the request mid-flow races promptAsync on device.
    const { rerender } = await renderHook(() => useGoogleSignIn());
    await rerender(undefined);

    const calls = mockUseIdTokenAuthRequest.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0]?.[0]?.extraParams;
    const second = calls[calls.length - 1]?.[0]?.extraParams;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

// The REAL-library contract arms (PR #37 R1's real-AuthRequest test) moved to
// src/auth/google-provider.contract.test.ts (T-S3.2 — one contract home per
// library). That suite drives the real provider HOOKS end-to-end and pins the
// same facts, strictly stronger: no-instance-nonce + extraParams-nonce-in-URL
// on the native Code flow, plus the responseType resolution itself.

describe("buildGoogleSignInRequest", () => {
  const success = { type: "success", params: { id_token: "google-id-token" } };
  const payload = {
    id_token: "google-id-token",
    raw_nonce: "raw-nonce-123",
    device: { platform: "ios", device_name: "Test Device" },
  };

  it("reads the nonce from extraParams — the ONLY shape native produces", () => {
    expect(buildGoogleSignInRequest(success, { extraParams: { nonce: "raw-nonce-123" } })).toEqual(
      payload,
    );
  });

  it("still reads the instance nonce (the web implicit path)", () => {
    expect(buildGoogleSignInRequest(success, { nonce: "raw-nonce-123" })).toEqual(payload);
  });

  it("prefers the instance nonce when both are present", () => {
    // If a future provider version mints its own on native, that is the value
    // actually sent in the authorize URL, so it must win.
    expect(
      buildGoogleSignInRequest(success, {
        nonce: "raw-nonce-123",
        extraParams: { nonce: "stale-ours" },
      }),
    ).toEqual(payload);
  });

  it("returns null for a non-success response (cancel / error / loading)", () => {
    const req = { extraParams: { nonce: "n" } };
    expect(buildGoogleSignInRequest({ type: "dismiss" }, req)).toBeNull();
    expect(buildGoogleSignInRequest({ type: "error" }, req)).toBeNull();
    expect(buildGoogleSignInRequest(null, req)).toBeNull();
  });

  it("returns null when the id token or nonce is missing", () => {
    expect(
      buildGoogleSignInRequest({ type: "success", params: {} }, { extraParams: { nonce: "n" } }),
    ).toBeNull();
    expect(buildGoogleSignInRequest(success, {})).toBeNull();
    // The exact runtime state that caused the outage: a loaded native request
    // carrying PKCE params but no nonce anywhere.
    expect(buildGoogleSignInRequest(success, { extraParams: {} })).toBeNull();
  });
});
