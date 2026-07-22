/**
 * T-5.2 crypto primitives (offline — no network, no DB).
 */
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  mintRefreshToken,
  parseAesKey,
  safeEqual,
  sha256Hex,
} from "./crypto.js";

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 'abc' test vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is lowercase hex, 64 chars", () => {
    expect(sha256Hex("raw-nonce-value")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("safeEqual", () => {
  it("true for equal strings, false otherwise (including length mismatches)", () => {
    expect(safeEqual("nonce-abc", "nonce-abc")).toBe(true);
    expect(safeEqual("nonce-abc", "nonce-abd")).toBe(false);
    expect(safeEqual("short", "much-longer-value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("mintRefreshToken", () => {
  it("is 256-bit base64url — 43 chars, URL-safe alphabet (spec §3.2)", () => {
    const token = mintRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats (CSPRNG)", () => {
    const tokens = new Set(Array.from({ length: 256 }, () => mintRefreshToken()));
    expect(tokens.size).toBe(256);
  });
});

describe("parseAesKey", () => {
  it("accepts exactly 32 decoded bytes", () => {
    const key = parseAesKey(Buffer.alloc(32, 7).toString("base64"));
    expect(key.length).toBe(32);
  });

  it("rejects wrong lengths, reporting length only (no key material in the message)", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(() => parseAesKey(short)).toThrowError(/32 bytes \(got 16\)/);
    expect(() => parseAesKey(short)).not.toThrowError(new RegExp(short));
  });
});

describe("encryptSecret / decryptSecret (AES-256-GCM, §3.3.3)", () => {
  const key = parseAesKey(Buffer.alloc(32, 42).toString("base64"));

  it("round-trips, and ciphertext never contains the plaintext", () => {
    const plaintext = "apple-refresh-token-material";
    const sealed = encryptSecret(key, plaintext);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(plaintext);
    expect(decryptSecret(key, sealed)).toBe(plaintext);
  });

  it("uses a fresh IV per call — same plaintext, different ciphertext", () => {
    expect(encryptSecret(key, "same")).not.toBe(encryptSecret(key, "same"));
  });

  it("rejects tampering (GCM auth)", () => {
    const sealed = encryptSecret(key, "secret");
    const raw = Buffer.from(sealed.slice(3), "base64url");
    raw[raw.length - 20]! ^= 0xff; // flip a ciphertext bit
    const tampered = `v1.${raw.toString("base64url")}`;
    expect(() => decryptSecret(key, tampered)).toThrow();
  });

  it("rejects the wrong key", () => {
    const otherKey = parseAesKey(Buffer.alloc(32, 43).toString("base64"));
    const sealed = encryptSecret(key, "secret");
    expect(() => decryptSecret(otherKey, sealed)).toThrow();
  });

  it("rejects truncation and unknown format versions", () => {
    expect(() => decryptSecret(key, "v1.AAAA")).toThrowError(/too short/);
    const sealed = encryptSecret(key, "secret");
    expect(() => decryptSecret(key, `v2.${sealed.slice(3)}`)).toThrowError(/unrecognized/);
    expect(() => decryptSecret(key, "garbage")).toThrowError(/unrecognized/);
  });
});
