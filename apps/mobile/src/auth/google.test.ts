/**
 * Google sign-in request builder (T-5.7). Google echoes the request nonce
 * VERBATIM into the id-token `nonce` claim → server raw match (R-auth-3), so
 * `raw_nonce = request.nonce`. The auth-session provider hook is globally
 * stubbed (jest.setup); this covers the pure payload builder.
 */
import { buildGoogleSignInRequest } from "./google";

jest.mock("expo-device", () => ({ __esModule: true, deviceName: "Test Device" }));

describe("buildGoogleSignInRequest", () => {
  it("builds /auth/google with the id token and the raw request nonce", () => {
    const payload = buildGoogleSignInRequest(
      { type: "success", params: { id_token: "google-id-token" } },
      { nonce: "raw-nonce-123" },
    );
    expect(payload).toEqual({
      id_token: "google-id-token",
      raw_nonce: "raw-nonce-123",
      device: { platform: "ios", device_name: "Test Device" },
    });
  });

  it("returns null for a non-success response (cancel / error / loading)", () => {
    expect(buildGoogleSignInRequest({ type: "dismiss" }, { nonce: "n" })).toBeNull();
    expect(buildGoogleSignInRequest({ type: "error" }, { nonce: "n" })).toBeNull();
    expect(buildGoogleSignInRequest(null, { nonce: "n" })).toBeNull();
  });

  it("returns null when the id token or nonce is missing", () => {
    expect(buildGoogleSignInRequest({ type: "success", params: {} }, { nonce: "n" })).toBeNull();
    expect(buildGoogleSignInRequest({ type: "success", params: { id_token: "g" } }, {})).toBeNull();
  });
});
