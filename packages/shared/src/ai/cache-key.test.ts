import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.js";
import {
  canonicalizeDestination,
  deriveAiCacheKey,
  deriveSeason,
  type AiCacheKeyInput,
} from "./cache-key.js";

describe("sha256Hex (NIST FIPS 180-4 vectors)", () => {
  it("empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("two-block message", () => {
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
  it("multi-byte UTF-8 ('日本語' — matches `shasum -a 256`)", () => {
    expect(sha256Hex("日本語")).toBe(
      "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
    );
  });
  it("padding boundaries around the 64-byte block (55/56/64/65 chars — pinned digests)", () => {
    // Digests computed with node:crypto `createHash('sha256')` — real
    // cross-implementation vectors pinning the padding edge cases.
    expect(sha256Hex("a".repeat(55))).toBe(
      "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
    );
    expect(sha256Hex("a".repeat(56))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
    expect(sha256Hex("a".repeat(64))).toBe(
      "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
    );
    expect(sha256Hex("a".repeat(65))).toBe(
      "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0",
    );
  });

  it("2-byte UTF-8 branch ('Zürich' — accented destinations; node:crypto digest)", () => {
    expect(sha256Hex("Zürich")).toBe(
      "4251685e06cab635578c72b1f5f221e9840a05ac4d8f2404be4177aa87f9907d",
    );
  });

  it("4-byte UTF-8 branch (non-BMP emoji; node:crypto digest)", () => {
    expect(sha256Hex("Tokyo 🗼🧳")).toBe(
      "dfb623357e26aeb2f8de54290a992ae541e5e7abd4b480871b5cf453438eb0e2",
    );
  });
});

describe("canonicalizeDestination (ai spec §3.6.1)", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(canonicalizeDestination("  Tokyo,   Japan ")).toBe("tokyo, japan");
    expect(canonicalizeDestination("Tokyo, Japan")).toBe(canonicalizeDestination("TOKYO, JAPAN"));
  });

  it("strips non-whitespace control characters (the separator-safety invariant)", () => {
    expect(canonicalizeDestination("Tok\u001Fyo")).toBe("tokyo");
    expect(canonicalizeDestination("Tokyo\u0000, Japan\u007F")).toBe("tokyo, japan");
    // whitespace controls still collapse to a single space, not to nothing
    expect(canonicalizeDestination("Tokyo,\tJapan")).toBe("tokyo, japan");
  });
});

describe("deriveSeason (ai spec §3.6.2 — deterministic)", () => {
  it("meteorological seasons, northern hemisphere", () => {
    expect(deriveSeason(35.68, "2026-07-01", "2026-07-10")).toBe("summer");
    expect(deriveSeason(35.68, "2026-12-20", "2026-12-30")).toBe("winter");
    expect(deriveSeason(35.68, "2026-04-01", "2026-04-10")).toBe("spring");
    expect(deriveSeason(35.68, "2026-10-01", "2026-10-10")).toBe("autumn");
  });
  it("hemisphere-flips when destination_lat < 0", () => {
    expect(deriveSeason(-33.87, "2026-07-01", "2026-07-10")).toBe("winter");
    expect(deriveSeason(-33.87, "2026-12-20", "2026-12-30")).toBe("summer");
    expect(deriveSeason(-33.87, "2026-04-01", "2026-04-10")).toBe("autumn");
  });
  it("uses the trip MIDPOINT month", () => {
    // 2026-02-25 → 2026-03-15 midpoint = 2026-03-06 → spring (N)
    expect(deriveSeason(35.68, "2026-02-25", "2026-03-15")).toBe("spring");
  });
  it("'unknown' when dates are absent; null lat → northern assumed", () => {
    expect(deriveSeason(35.68, null, "2026-07-10")).toBe("unknown");
    expect(deriveSeason(35.68, "2026-07-01", undefined)).toBe("unknown");
    expect(deriveSeason(null, "2026-07-01", "2026-07-10")).toBe("summer");
  });
});

describe("deriveAiCacheKey (R-db-10 / R-shared-8)", () => {
  const input: AiCacheKeyInput = {
    feature: "recommendations",
    destination: "Tokyo, Japan",
    travelStyle: ["budget", "foodie"],
    season: "summer",
    schemaVersion: 1,
  };

  it("matches the pinned preimage format (sha256 of \\x1f-joined segments)", () => {
    // printf 'recommendations\x1ftokyo, japan\x1fbudget+foodie\x1fsummer\x1f1' | shasum -a 256
    expect(deriveAiCacheKey(input)).toBe(
      "8ad8ef26e38f1254354a69f51203ec7ad9f700da030dd161629e4a6b93cf93ec",
    );
  });

  it("is stable across calls and travel-style orderings", () => {
    expect(deriveAiCacheKey(input)).toBe(deriveAiCacheKey({ ...input }));
    expect(deriveAiCacheKey({ ...input, travelStyle: ["foodie", "budget"] })).toBe(
      deriveAiCacheKey(input),
    );
    expect(deriveAiCacheKey({ ...input, destination: "  TOKYO,   Japan " })).toBe(
      deriveAiCacheKey(input),
    );
  });

  it("changes when ANY input changes — including SCHEMA_VERSION", () => {
    const baseline = deriveAiCacheKey(input);
    expect(deriveAiCacheKey({ ...input, feature: "expense_estimate" })).not.toBe(baseline);
    expect(deriveAiCacheKey({ ...input, destination: "Kyoto, Japan" })).not.toBe(baseline);
    expect(deriveAiCacheKey({ ...input, travelStyle: ["budget"] })).not.toBe(baseline);
    expect(deriveAiCacheKey({ ...input, season: "winter" })).not.toBe(baseline);
    expect(deriveAiCacheKey({ ...input, schemaVersion: 2 })).not.toBe(baseline);
  });

  it("unset travel style keys as 'any'", () => {
    expect(deriveAiCacheKey({ ...input, travelStyle: undefined })).toBe(
      deriveAiCacheKey({ ...input, travelStyle: [] }),
    );
  });

  it("a control char in the destination cannot fork the key (stripped pre-preimage)", () => {
    expect(deriveAiCacheKey({ ...input, destination: "Tokyo\u001F, Japan" })).toBe(
      deriveAiCacheKey(input),
    );
  });

  it("produces a 64-char hex key (the ai_cache PK)", () => {
    expect(deriveAiCacheKey(input)).toMatch(/^[0-9a-f]{64}$/);
  });
});
