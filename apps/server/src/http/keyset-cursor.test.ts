import { describe, expect, it } from "vitest";
import { decodeKeysetCursor, encodeKeysetCursor } from "./keyset-cursor.js";

const ID = "6f7c2e1a-9d4b-4c3e-8a2f-1b5d7e9f0a3c";

describe("keyset cursor codec (shared helper — T-6.2 extraction)", () => {
  it("round-trips micros + id", () => {
    const encoded = encodeKeysetCursor({ micros: "1786000000123456", id: ID });
    expect(decodeKeysetCursor(encoded)).toEqual({ micros: "1786000000123456", id: ID });
  });

  it("is base64url (URL-safe, no padding drama in query strings)", () => {
    const encoded = encodeKeysetCursor({ micros: "1", id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("malformed cursors decode to null — page-1 fallback, never a 500", () => {
    // No separator.
    expect(decodeKeysetCursor(Buffer.from("garbage", "utf8").toString("base64url"))).toBeNull();
    // Non-integer micros.
    expect(
      decodeKeysetCursor(Buffer.from(`12a34|${ID}`, "utf8").toString("base64url")),
    ).toBeNull();
    // Negative micros (sign char fails the digits-only rule).
    expect(decodeKeysetCursor(Buffer.from(`-5|${ID}`, "utf8").toString("base64url"))).toBeNull();
    // 19-digit micros would overflow-risk the ::bigint cast — rejected.
    expect(
      decodeKeysetCursor(Buffer.from(`${"9".repeat(19)}|${ID}`, "utf8").toString("base64url")),
    ).toBeNull();
    // Non-UUID id.
    expect(
      decodeKeysetCursor(Buffer.from("123|not-a-uuid", "utf8").toString("base64url")),
    ).toBeNull();
    // Raw junk that isn't even base64 of anything useful.
    expect(decodeKeysetCursor("%not-a-cursor%")).toBeNull();
  });

  it("18-digit micros (max) still decode", () => {
    const micros = "9".repeat(18);
    expect(decodeKeysetCursor(encodeKeysetCursor({ micros, id: ID }))).toEqual({
      micros,
      id: ID,
    });
  });
});
