/**
 * Bookings keyset cursor codec units (round-1 A5) — mirrors
 * `http/keyset-cursor.test.ts` for the THREE-part codec over
 * `starts_at ASC NULLS LAST, updated_at DESC, id DESC`: NULL-sentinel
 * round-trip, malformed-part rejection (page-1 fallback, never a 500), the
 * 19-digit bigint-overflow guard, wrong part counts, and the signed
 * negative-micros lane (pre-1970 `starts_at` — round-1 A2).
 */
import { describe, expect, it } from "vitest";
import { decodeBookingCursor, encodeBookingCursor } from "./cursor.js";

const ID = "6f7c2e1a-9d4b-4c3e-8a2f-1b5d7e9f0a3c";
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

describe("bookings keyset cursor codec (three-part, NULLS LAST — T-7.1)", () => {
  it("round-trips the timed region (startsMicros + updatedMicros + id)", () => {
    const cursor = { startsMicros: "1786000000123456", updatedMicros: "1786000000654321", id: ID };
    expect(decodeBookingCursor(encodeBookingCursor(cursor))).toEqual(cursor);
  });

  it("round-trips the NULL tail — startsMicros null rides the bare '-' sentinel", () => {
    const cursor = { startsMicros: null, updatedMicros: "1786000000654321", id: ID };
    const encoded = encodeBookingCursor(cursor);
    expect(Buffer.from(encoded, "base64url").toString("utf8").startsWith("-|")).toBe(true);
    expect(decodeBookingCursor(encoded)).toEqual(cursor);
  });

  it("round-trips NEGATIVE epoch-micros — a pre-1970 starts_at must not mint a cursor its own decoder rejects (A2)", () => {
    const cursor = { startsMicros: "-315619200000000", updatedMicros: "1786000000654321", id: ID };
    expect(decodeBookingCursor(encodeBookingCursor(cursor))).toEqual(cursor);
  });

  it("is base64url (URL-safe in query strings)", () => {
    expect(encodeBookingCursor({ startsMicros: null, updatedMicros: "1", id: ID })).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });

  it("malformed cursors decode to null — page-1 fallback, never a 500", () => {
    // Wrong part count: two parts (the old two-part shape) and four parts.
    expect(decodeBookingCursor(b64(`123|${ID}`))).toBeNull();
    expect(decodeBookingCursor(b64(`1|2|3|${ID}`))).toBeNull();
    // Non-integer micros in either timestamp slot.
    expect(decodeBookingCursor(b64(`12a34|123|${ID}`))).toBeNull();
    expect(decodeBookingCursor(b64(`123|12a34|${ID}`))).toBeNull();
    // The bare '-' sentinel is legal ONLY in the starts slot, never updated.
    expect(decodeBookingCursor(b64(`123|-|${ID}`))).toBeNull();
    // A sign followed by non-digits is not a signed integer.
    expect(decodeBookingCursor(b64(`-1x2|123|${ID}`))).toBeNull();
    // 19-digit micros would overflow-risk the ::bigint cast — signed or not.
    expect(decodeBookingCursor(b64(`${"9".repeat(19)}|123|${ID}`))).toBeNull();
    expect(decodeBookingCursor(b64(`-${"9".repeat(19)}|123|${ID}`))).toBeNull();
    expect(decodeBookingCursor(b64(`123|${"9".repeat(19)}|${ID}`))).toBeNull();
    // Non-UUID id.
    expect(decodeBookingCursor(b64("123|456|not-a-uuid"))).toBeNull();
    // Raw junk that isn't base64 of anything useful.
    expect(decodeBookingCursor("%not-a-cursor%")).toBeNull();
  });

  it("18-digit micros (max magnitude) still decode, both signs", () => {
    const max = "9".repeat(18);
    expect(
      decodeBookingCursor(encodeBookingCursor({ startsMicros: max, updatedMicros: max, id: ID })),
    ).toEqual({ startsMicros: max, updatedMicros: max, id: ID });
    expect(
      decodeBookingCursor(
        encodeBookingCursor({ startsMicros: `-${max}`, updatedMicros: max, id: ID }),
      ),
    ).toEqual({ startsMicros: `-${max}`, updatedMicros: max, id: ID });
  });
});
