/**
 * Expenses keyset cursor codec units (T-9.2) — mirrors the bookings-cursor
 * suite for the THREE-part codec over `spent_at DESC, created_at DESC,
 * id DESC`: date-part validation (calendar-shaped, `::date`-cast-safe),
 * malformed-part rejection (page-1 fallback, never a 500), the 19-digit
 * bigint-overflow guard, wrong part counts, and the signed negative-micros
 * lane.
 */
import { describe, expect, it } from "vitest";
import { decodeExpenseCursor, encodeExpenseCursor } from "./cursor.js";

const ID = "6f7c2e1a-9d4b-4c3e-8a2f-1b5d7e9f0a3c";
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

describe("expenses keyset cursor codec (three-part, date-led — T-9.2)", () => {
  it("round-trips (spentAt + createdMicros + id)", () => {
    const cursor = { spentAt: "2026-09-05", createdMicros: "1786000000123456", id: ID };
    expect(decodeExpenseCursor(encodeExpenseCursor(cursor))).toEqual(cursor);
  });

  it("round-trips NEGATIVE epoch-micros (pre-1970 created_at — signed lane)", () => {
    const cursor = { spentAt: "1969-12-31", createdMicros: "-315619200000000", id: ID };
    expect(decodeExpenseCursor(encodeExpenseCursor(cursor))).toEqual(cursor);
  });

  it("is base64url (URL-safe in query strings)", () => {
    expect(encodeExpenseCursor({ spentAt: "2026-01-01", createdMicros: "1", id: ID })).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
  });

  it("malformed cursors decode to null — page-1 fallback, never a 500", () => {
    // Wrong part count.
    expect(decodeExpenseCursor(b64(`2026-01-01|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-01-01|1|2|${ID}`))).toBeNull();
    // Non-calendar date parts — kept out of the ::date cast (no 500 vector).
    expect(decodeExpenseCursor(b64(`2026-13-01|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-00-10|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-01-32|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`20260101|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`not-a-date|123|${ID}`))).toBeNull();
    // Non-integer micros.
    expect(decodeExpenseCursor(b64(`2026-01-01|12a34|${ID}`))).toBeNull();
    // 19-digit micros would overflow-risk the ::bigint cast — signed or not.
    expect(decodeExpenseCursor(b64(`2026-01-01|${"9".repeat(19)}|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-01-01|-${"9".repeat(19)}|${ID}`))).toBeNull();
    // Non-UUID id.
    expect(decodeExpenseCursor(b64("2026-01-01|123|not-a-uuid"))).toBeNull();
    // Raw junk that isn't base64 of anything useful.
    expect(decodeExpenseCursor("%not-a-cursor%")).toBeNull();
  });

  it("CALENDAR-exact dates, not just calendar-shaped (round-1 blocking): impossible days fold to null, never the ::date 22008 500", () => {
    // Shape-valid but non-existent: Feb 31 / Feb 30 / Apr 31 pass the RE and
    // would bind `::date` → Postgres 22008 → unhandled 500 (verified live in
    // review). The Date.UTC round-trip folds them to page 1.
    expect(decodeExpenseCursor(b64(`2026-02-31|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-02-30|123|${ID}`))).toBeNull();
    expect(decodeExpenseCursor(b64(`2026-04-31|123|${ID}`))).toBeNull();
    // Leap-year control: Feb 29 is real in 2024, impossible in 2026.
    expect(decodeExpenseCursor(b64(`2024-02-29|123|${ID}`))).toEqual({
      spentAt: "2024-02-29",
      createdMicros: "123",
      id: ID,
    });
    expect(decodeExpenseCursor(b64(`2026-02-29|123|${ID}`))).toBeNull();
  });

  it("18-digit micros (max magnitude) still decode, both signs", () => {
    const max = "9".repeat(18);
    expect(
      decodeExpenseCursor(encodeExpenseCursor({ spentAt: "2026-06-30", createdMicros: max, id: ID })),
    ).toEqual({ spentAt: "2026-06-30", createdMicros: max, id: ID });
    expect(
      decodeExpenseCursor(
        encodeExpenseCursor({ spentAt: "2026-06-30", createdMicros: `-${max}`, id: ID }),
      ),
    ).toEqual({ spentAt: "2026-06-30", createdMicros: `-${max}`, id: ID });
  });
});
