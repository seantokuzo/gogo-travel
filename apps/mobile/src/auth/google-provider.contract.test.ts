/**
 * CONTRACT SUITE for `expo-auth-session/providers/google` (T-S3.2, R-test-1 —
 * ADR-006 layer 1: mock fidelity). The ONE home for this library's
 * real-behavior pins; jest.setup.js's global stub points here.
 *
 * Why this file exists: B-4 shipped because the suite asserted a request
 * shape (`request.nonce` present on native) that the REAL library never
 * produces on iOS — a fiction the mock invented and every consumer test then
 * validated. This suite imports the REAL provider via `jest.requireActual`
 * (only bottom-layer native primitives are mocked — expo-crypto's random/
 * digest; never provider logic) and pins the exact facts our stub and our
 * B-4 fix rely on, so a library upgrade that changes them reds HERE instead
 * of on a device.
 *
 * The real facts pinned (installed expo-auth-session 57.0.5 build):
 * - `useAuthRequest` resolves `responseType` to `Code` on any installed app
 *   (`providers/Google.js:125-139`), and `useIdTokenAuthRequest` leaves it
 *   undefined on native so that resolution applies (`Google.js:91-103`).
 * - `GoogleAuthRequest.getAuthRequestConfigAsync` mints an instance `nonce`
 *   ONLY under `ResponseType.IdToken` (`Google.js:66-70`) — so on native
 *   `request.nonce` is ALWAYS undefined and our `extraParams.nonce` supply
 *   (google.ts) is load-bearing.
 * - `AuthRequest.makeAuthUrlAsync` copies `extraParams` into the authorize
 *   URL (`AuthRequest.js:195-202`) — the URL Google echoes into the token.
 *
 * Relocated from google.test.ts (PR #37 R1's real-AuthRequest arm) per the
 * one-contract-home rule; upgraded from constructing the base `AuthRequest`
 * to driving the real provider hooks end-to-end (constructor + responseType
 * resolution + async load). Shape parity for the stub lives in
 * src/testing/mock-shape-parity.ts.
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import { ResponseType } from "expo-auth-session";
// The GLOBAL STUB (jest.setup.js) — this import stays mocked on purpose: the
// stub-fidelity arm below pins the stub's claims against the real facts.
import * as GoogleStub from "expo-auth-session/providers/google";

import { googlePromptDismissResult, googleProviderStubExports } from "../testing/mock-shape-parity";

/**
 * Bottom-layer native primitives ONLY (the quality bar: never re-mock the
 * thing under contract). The real provider's PKCE module reaches for
 * `getRandomValues` (state + code verifier + nonce entropy) and
 * `digestStringAsync` (code challenge under BASE64, nonce mint under HEX) —
 * deterministic stand-ins keep the real pipeline's output stable.
 */
jest.mock("expo-crypto", () => ({
  __esModule: true,
  getRandomValues: (array: Uint8Array) => array.fill(0xcd),
  digestStringAsync: async () => "bW9ja2RpZ2VzdA==",
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64", HEX: "hex" },
}));

// The REAL library — requireActual bypasses the global stub for this file's
// real arms while the plain import above keeps observing the stub.
const RealGoogle = jest.requireActual<typeof import("expo-auth-session/providers/google")>(
  "expo-auth-session/providers/google",
);

/** What the mocked digest yields after the library's url-safe strip of `=`. */
const MOCK_DIGEST_URLSAFE = "bW9ja2RpZ2VzdA";

const IOS_CLIENT_ID = "test-ios-client-id";
const REDIRECT_URI = "com.gogo.travel:/oauthredirect";

type LoadedRequest = NonNullable<ReturnType<typeof RealGoogle.useIdTokenAuthRequest>[0]>;

async function loadRealRequest(
  hook: () => ReturnType<typeof RealGoogle.useIdTokenAuthRequest>,
): Promise<LoadedRequest> {
  // RNTL v14: renderHook/waitFor are async — await every one (mobile.md).
  const { result } = await renderHook(hook);
  await waitFor(() => expect(result.current[0]).not.toBeNull());
  const request = result.current[0];
  if (request === null) throw new Error("unreachable: waitFor guaranteed a loaded request");
  return request;
}

describe("REAL provider, native default flow (the B-4 facts)", () => {
  it("useIdTokenAuthRequest resolves to the Code flow and mints NO nonce — instance field and URL both empty", async () => {
    // Falsification: a library version that defaults native to IdToken reds
    // the responseType pin; one that starts minting a nonce on the Code flow
    // reds the nonce/URL pins (the negative arms' control is the IdToken
    // test below, which shows the same reads detecting a present nonce).
    const request = await loadRealRequest(() =>
      RealGoogle.useIdTokenAuthRequest({
        iosClientId: IOS_CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    );

    expect(request.responseType).toBe(ResponseType.Code); // Google.js:125-139
    expect(request.nonce).toBeUndefined(); // Google.js:66-70 gate not taken
    expect(request.url).toEqual(expect.any(String));
    expect(request.url).not.toContain("nonce=");
    // Control that the URL came from the real full pipeline (PKCE ran):
    expect(request.url).toContain("code_challenge=");
    expect(request.url).toContain("response_type=code");
  });

  it("OUR extraParams.nonce survives the native Code flow into the authorize URL (the fix's premise), while the instance field stays empty", async () => {
    // Falsification: a library version that sanitizes reserved OIDC params
    // out of extraParams (or adopts them into the instance field) reds this
    // — exactly the upgrade that would silently break google.ts's supply.
    // Arbitrary 64-char hex — the shape google.ts's randomNonceHex() supplies
    // via extraParams (its value here is caller-chosen, not derived from this
    // file's 0xcd-filled crypto mock: extraParams bypass the entropy path).
    const ourNonce = "ab".repeat(32);
    const request = await loadRealRequest(() =>
      RealGoogle.useIdTokenAuthRequest({
        iosClientId: IOS_CLIENT_ID,
        redirectUri: REDIRECT_URI,
        extraParams: { nonce: ourNonce },
      }),
    );

    expect(request.nonce).toBeUndefined(); // library still mints nothing on Code
    expect(request.extraParams.nonce).toBe(ourNonce);
    expect(request.url).toContain(`nonce=${ourNonce}`); // AuthRequest.js:195-202
  });
});

describe("REAL provider, IdToken flow (control arm)", () => {
  it("explicit ResponseType.IdToken DOES mint an instance nonce and carries it into the URL", async () => {
    // The control proving the native-flow negatives above are live reads:
    // the same `.nonce` / URL detectors flip positive under the one flow the
    // library mints for (Google.js:66-70). Falsification: the library
    // dropping IdToken minting reds this — flagging that our web-path read
    // of `request.nonce` (google.ts builder, instance-first) lost its source.
    const request = await loadRealRequest(() =>
      RealGoogle.useAuthRequest({
        iosClientId: IOS_CLIENT_ID,
        redirectUri: REDIRECT_URI,
        responseType: ResponseType.IdToken,
      }),
    );

    expect(request.responseType).toBe(ResponseType.IdToken);
    expect(request.nonce).toBe(MOCK_DIGEST_URLSAFE); // minted via the mocked HEX digest
    expect(request.url).toContain(`nonce=${MOCK_DIGEST_URLSAFE}`);
  });
});

describe("jest.setup.js stub fidelity (the mock-fiction alarm)", () => {
  it("the stub claims ONLY the unloaded state — flipping it to fabricate a loaded request (the pre-B-4 fiction) reds this", async () => {
    // Mutation-verified: jest.setup.js returning `[{ nonce: "x" }, null, fn]`
    // fails the null pin below. `null` is the only universally-true native
    // request state (the real hook loads async); a richer stub must come
    // through THIS file, where the arms above define the only legal shape
    // (nonce-free Code flow).
    const [request, response, promptAsync] = GoogleStub.useIdTokenAuthRequest({
      iosClientId: IOS_CLIENT_ID,
    });

    expect(request).toBeNull();
    expect(response).toBeNull();
    // The stub's canned prompt result must be a result type the real library
    // can produce (type-pinned to AuthSessionResult in mock-shape-parity.ts).
    await expect(promptAsync()).resolves.toEqual(googlePromptDismissResult);
  });

  it("the stub exports exactly the surface the parity contract lists (which typecheck pins to the real module)", () => {
    // Falsification: adding an export to the stub (or dropping one) without
    // updating googleProviderStubExports reds this; listing a name the real
    // library doesn't export reds typecheck.
    const stubKeys = Object.keys(GoogleStub)
      .filter((k) => k !== "__esModule")
      .sort();
    expect(stubKeys).toEqual([...googleProviderStubExports].sort());
  });
});
