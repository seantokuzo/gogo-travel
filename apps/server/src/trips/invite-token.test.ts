import { describe, expect, it } from "vitest";
import { INVITE_TOKEN_BYTES } from "../config.js";
import { generateInviteToken, INVITE_TOKEN_RE, inviteState } from "./invite-token.js";

describe("generateInviteToken (R-db-9: ≥128-bit, URL-safe, unique)", () => {
  it("entropy source is structurally ≥128 bits (config floor, asserted)", () => {
    // 16 bytes = the 128-bit floor; we mint double.
    expect(INVITE_TOKEN_BYTES).toBeGreaterThanOrEqual(16);
    expect(INVITE_TOKEN_BYTES).toBe(32);
  });

  it("tokens are base64url of the full byte length (43 chars for 32 bytes)", () => {
    const token = generateInviteToken();
    // ceil(32 * 4 / 3) unpadded = 43 — the whole entropy survives encoding.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe charset, no padding
    expect(INVITE_TOKEN_RE.test(token)).toBe(true);
  });

  it("500 consecutive tokens are unique (CSPRNG sanity, not a collision proof)", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateInviteToken()));
    expect(tokens.size).toBe(500);
  });
});

describe("INVITE_TOKEN_RE — the :token param shape gate", () => {
  it("rejects shapes no server-minted token can have (folded to the 404 door)", () => {
    expect(INVITE_TOKEN_RE.test("short")).toBe(false); // < 16 chars
    expect(INVITE_TOKEN_RE.test("a".repeat(129))).toBe(false); // absurd length
    expect(INVITE_TOKEN_RE.test("has/slash-and-plus+chars-1234")).toBe(false); // not base64url
    expect(INVITE_TOKEN_RE.test("white space padded token 123")).toBe(false);
  });
});

describe("inviteState — one derivation for list/preview/accept (R-trips-16)", () => {
  const NOW = new Date("2026-07-25T12:00:00.000Z");
  const base = {
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    revokedAt: null,
    maxUses: null,
    useCount: 0,
  };

  it("active when unexpired, unrevoked, under max", () => {
    expect(inviteState(base, NOW)).toBe("active");
  });

  it("expired at and after the expiry instant — 'expires AT' boundary pinned", () => {
    expect(inviteState({ ...base, expiresAt: NOW }, NOW)).toBe("expired");
    expect(inviteState({ ...base, expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe("expired");
    expect(inviteState({ ...base, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe("active");
  });

  it("max_uses_reached at the cap; unlimited (null) never maxes", () => {
    expect(inviteState({ ...base, maxUses: 2, useCount: 2 }, NOW)).toBe("max_uses_reached");
    expect(inviteState({ ...base, maxUses: 2, useCount: 1 }, NOW)).toBe("active");
    expect(inviteState({ ...base, maxUses: null, useCount: 9_999 }, NOW)).toBe("active");
  });

  it("precedence: revoked > expired > max_uses_reached (revocation never relaxes)", () => {
    const dead = {
      expiresAt: new Date(NOW.getTime() - 1),
      revokedAt: new Date("2026-07-01T00:00:00.000Z"),
      maxUses: 1,
      useCount: 1,
    };
    expect(inviteState(dead, NOW)).toBe("revoked");
    expect(inviteState({ ...dead, revokedAt: null }, NOW)).toBe("expired");
  });
});
