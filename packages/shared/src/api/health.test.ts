import { describe, expect, it } from "vitest";
import { HealthResponseSchema, MigrationStateSchema } from "./health.js";

describe("MigrationStateSchema (B-28)", () => {
  it("happy: an up-to-date snapshot round-trips", () => {
    const value = { onDisk: 4, applied: 4, pending: [] };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("happy: a behind snapshot names the pending tags in order", () => {
    const value = {
      onDisk: 4,
      applied: 2,
      pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("boundary: zero on both sides (a brand-new, unmigrated journal) is valid", () => {
    expect(MigrationStateSchema.parse({ onDisk: 0, applied: 0, pending: [] })).toEqual({
      onDisk: 0,
      applied: 0,
      pending: [],
    });
  });

  it("adversarial: negative counts are rejected", () => {
    expect(MigrationStateSchema.safeParse({ onDisk: -1, applied: 0, pending: [] }).success).toBe(
      false,
    );
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: -1, pending: [] }).success).toBe(
      false,
    );
  });

  it("adversarial: non-integer counts are rejected — money-style precision, never a float", () => {
    expect(MigrationStateSchema.safeParse({ onDisk: 1.5, applied: 0, pending: [] }).success).toBe(
      false,
    );
  });

  it("adversarial: `pending` must be an array of strings, never a bare count or number list", () => {
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: 0, pending: 1 }).success).toBe(
      false,
    );
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: 0, pending: [1] }).success).toBe(
      false,
    );
  });

  it("error: missing fields are rejected, not defaulted", () => {
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: 1 }).success).toBe(false);
  });
});

describe("HealthResponseSchema (B-28: migrations is the optional leg)", () => {
  it("happy: a full response with a current migration state parses", () => {
    const value = {
      ok: true,
      version: "0.0.1",
      migrations: { onDisk: 4, applied: 4, pending: [] },
    };
    expect(HealthResponseSchema.parse(value)).toEqual(value);
  });

  it("empty/absent: an older server's response — no `migrations` key at all — still parses", () => {
    const value = { ok: true, version: "0.0.1" };
    const parsed = HealthResponseSchema.parse(value);
    expect(parsed.migrations).toBeUndefined();
    // Falsification: making `migrations` required would red this pin.
    expect("migrations" in parsed).toBe(false);
  });

  it("adversarial: a malformed embedded `migrations` object fails the WHOLE response, not silently", () => {
    const value = { ok: true, version: "0.0.1", migrations: { onDisk: 4, applied: 4 } };
    expect(HealthResponseSchema.safeParse(value).success).toBe(false);
  });
});
