/**
 * T-9.3 settlements-cursor codec pins: round-trip (positive AND negative
 * micros — `settled_at` is client-suppliable, pre-1970 is representable; the
 * bookings round-1 A2 lesson), and every malformed shape decoding to `null`
 * (page-1 fallback; crafted values never reach the `::bigint`/`::uuid`
 * casts).
 */
import { describe, expect, it } from "vitest";
import { decodeSettlementCursor, encodeSettlementCursor } from "./cursor.js";

const ID = "f2f8b0e2-6c0e-4a3e-9a51-3a54c5f0a111";

describe("settlement keyset cursor codec", () => {
  it("round-trips a positive-micros cursor", () => {
    const encoded = encodeSettlementCursor({ settledMicros: "1786000000123456", id: ID });
    expect(decodeSettlementCursor(encoded)).toEqual({
      settledMicros: "1786000000123456",
      id: ID,
    });
  });

  it("round-trips a NEGATIVE-micros cursor (pre-1970 settled_at)", () => {
    const encoded = encodeSettlementCursor({ settledMicros: "-14182980000000", id: ID });
    expect(decodeSettlementCursor(encoded)).toEqual({
      settledMicros: "-14182980000000",
      id: ID,
    });
  });

  it("rejects malformed cursors to null (page-1 fallback)", () => {
    // Not base64 of a two-part token at all.
    expect(decodeSettlementCursor("%not-a-cursor%")).toBeNull();
    // No separator.
    expect(decodeSettlementCursor(Buffer.from("garbage", "utf8").toString("base64url"))).toBeNull();
    // Non-numeric micros.
    expect(
      decodeSettlementCursor(Buffer.from(`12a34|${ID}`, "utf8").toString("base64url")),
    ).toBeNull();
    // Bare sign carries no digits.
    expect(decodeSettlementCursor(Buffer.from(`-|${ID}`, "utf8").toString("base64url"))).toBeNull();
    // 19 digits could overflow int64.
    expect(
      decodeSettlementCursor(Buffer.from(`${"9".repeat(19)}|${ID}`, "utf8").toString("base64url")),
    ).toBeNull();
    // Non-UUID id part.
    expect(
      decodeSettlementCursor(Buffer.from("123|not-a-uuid", "utf8").toString("base64url")),
    ).toBeNull();
  });
});
