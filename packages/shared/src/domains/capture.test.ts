import { describe, expect, it } from "vitest";
import {
  CAPTURE_CONFIDENCES,
  CAPTURE_PARSERS,
  CaptureItemSchema,
  ProposedBookingSchema,
} from "./capture.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

describe("domain-local enums", () => {
  it("match the schema spec §3.4.2 values", () => {
    expect([...CAPTURE_PARSERS]).toEqual(["jsonld", "llm"]);
    expect([...CAPTURE_CONFIDENCES]).toEqual(["high", "medium", "low"]);
  });
});

describe("ProposedBooking (capture_inbox.parsed)", () => {
  const valid = {
    category: "flight",
    title: "UA 837 SFO→NRT",
    details: { category: "flight", flight_number: "UA 837" },
    price_cents: 128500,
    currency: "USD",
    confirmation_code: "ABC123",
    confidence: "high",
    parser: "jsonld",
  };

  it("parses a valid proposal", () => {
    expect(ProposedBookingSchema.parse(valid).parser).toBe("jsonld");
  });

  it("rejects details whose category mismatches the proposal", () => {
    expect(
      ProposedBookingSchema.safeParse({
        ...valid,
        details: { category: "lodging" },
      }).success,
    ).toBe(false);
  });

  it("trip_guess is optional (an email arrives with no trip context)", () => {
    expect(ProposedBookingSchema.parse({ ...valid, trip_guess: UUID }).trip_guess).toBe(UUID);
    const { price_cents: _p, ...minimal } = valid;
    expect(ProposedBookingSchema.parse(minimal).price_cents).toBeUndefined();
  });
});

describe("CaptureItem row", () => {
  it("parses a failed capture with visible error (R-db-7: never silent)", () => {
    const parsed = CaptureItemSchema.parse({
      id: UUID,
      user_id: UUID,
      trip_id: null,
      source: "email",
      raw_ref: null,
      parse_status: "failed",
      parsed: null,
      error: "unsupported_document",
      parsed_at: null,
      created_at: "2026-07-10T00:00:00Z",
      updated_at: "2026-07-10T00:00:00Z",
    });
    expect(parsed.error).toBe("unsupported_document");
  });
});
