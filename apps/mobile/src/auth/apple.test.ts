/**
 * Apple sign-in flow (T-5.7) — the nonce contract is the load-bearing detail:
 * the RAW nonce goes to the server; Apple receives SHA-256(raw_nonce). Native
 * modules are mocked; a cancel is a null, not an error.
 */
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";

import { signInWithApple } from "./apple";

jest.mock("expo-apple-authentication", () => ({
  __esModule: true,
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: jest.fn(async () => true),
  signInAsync: jest.fn(),
}));

jest.mock("expo-crypto", () => ({
  __esModule: true,
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: jest.fn(),
  getRandomBytesAsync: jest.fn(),
}));

jest.mock("expo-device", () => ({ __esModule: true, deviceName: "Test iPhone" }));

const signInAsync = AppleAuthentication.signInAsync as jest.Mock;
const digest = Crypto.digestStringAsync as jest.Mock;
const randomBytes = Crypto.getRandomBytesAsync as jest.Mock;

// Fixed bytes → deterministic raw nonce hex "000fff".
const RAW_NONCE_HEX = "000fff";

describe("signInWithApple", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    randomBytes.mockResolvedValue(Uint8Array.from([0x00, 0x0f, 0xff]));
    digest.mockResolvedValue("hashed-nonce");
  });

  it("hands Apple the SHA-256 and posts the RAW nonce, forwarding first-auth names", async () => {
    signInAsync.mockResolvedValue({
      identityToken: "id-token",
      authorizationCode: "auth-code",
      fullName: { givenName: "Ada", familyName: "Lovelace" },
      email: "ada@example.com",
    });

    const payload = await signInWithApple();

    expect(digest).toHaveBeenCalledWith("SHA-256", RAW_NONCE_HEX);
    expect(signInAsync).toHaveBeenCalledWith(expect.objectContaining({ nonce: "hashed-nonce" }));
    expect(payload).toEqual({
      identity_token: "id-token",
      authorization_code: "auth-code",
      raw_nonce: RAW_NONCE_HEX,
      device: { platform: "ios", device_name: "Test iPhone" },
      given_name: "Ada",
      family_name: "Lovelace",
    });
  });

  it("returns null when the user cancels the native sheet", async () => {
    signInAsync.mockRejectedValue({ code: "ERR_REQUEST_CANCELED" });
    await expect(signInWithApple()).resolves.toBeNull();
  });

  it("throws when Apple returns no identity token", async () => {
    signInAsync.mockResolvedValue({ identityToken: null, authorizationCode: null, fullName: null });
    await expect(signInWithApple()).rejects.toThrow();
  });

  it("rethrows a non-cancel native error", async () => {
    signInAsync.mockRejectedValue(new Error("boom"));
    await expect(signInWithApple()).rejects.toThrow("boom");
  });
});
