import { describe, expect, it } from "vitest";
import { HealthResponseSchema, MigrationStateSchema } from "./health.js";

const CHECKED_AT = "2026-01-01T00:00:00.000Z";

describe("MigrationStateSchema (B-28)", () => {
  it("happy: an up-to-date snapshot round-trips", () => {
    const value = {
      onDisk: 4,
      applied: 4,
      pending: [],
      pendingCount: 0,
      modified: [],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("happy: a behind snapshot names the pending tags in order", () => {
    const value = {
      onDisk: 4,
      applied: 2,
      pending: ["0002_lowly_venom", "0003_outstanding_doctor_spectrum"],
      pendingCount: 2,
      modified: [],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("happy: pending redacted (count-only, outside development/test) — empty `pending`, non-zero `pendingCount`", () => {
    // The shape `/health` produces in prod when migrations ARE pending
    // (architecture review round-1 #3): pending tag NAMES are dev/test-only,
    // but `pendingCount` stays truthful in every env.
    const value = {
      onDisk: 4,
      applied: 2,
      pending: [],
      pendingCount: 2,
      modified: [],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("happy: modified-after-apply tags round-trip (round-2 fix: a distinct state from `pending`)", () => {
    // `modified` names migrations whose on-disk hash no longer matches the
    // hash recorded when the migrator applied it — an edited-after-apply
    // file, never conflated with a never-applied one.
    const value = {
      onDisk: 4,
      applied: 4,
      pending: [],
      pendingCount: 0,
      modified: ["0001_edited_after_apply"],
      modifiedCount: 1,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("happy: modified redacted (count-only, outside development/test) — same posture as `pending`", () => {
    const value = {
      onDisk: 4,
      applied: 4,
      pending: [],
      pendingCount: 0,
      modified: [],
      modifiedCount: 1,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("boundary: zero on both sides (a brand-new, unmigrated journal) is valid", () => {
    const value = {
      onDisk: 0,
      applied: 0,
      pending: [],
      pendingCount: 0,
      modified: [],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.parse(value)).toEqual(value);
  });

  it("adversarial: negative counts are rejected", () => {
    const base = {
      pending: [] as string[],
      pendingCount: 0,
      modified: [] as string[],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.safeParse({ ...base, onDisk: -1, applied: 0 }).success).toBe(false);
    expect(MigrationStateSchema.safeParse({ ...base, onDisk: 1, applied: -1 }).success).toBe(false);
    expect(
      MigrationStateSchema.safeParse({ ...base, onDisk: 1, applied: 0, pendingCount: -1 }).success,
    ).toBe(false);
    expect(
      MigrationStateSchema.safeParse({ ...base, onDisk: 1, applied: 0, modifiedCount: -1 }).success,
    ).toBe(false);
  });

  it("adversarial: non-integer counts are rejected — money-style precision, never a float", () => {
    const base = {
      applied: 0,
      pending: [] as string[],
      pendingCount: 0,
      modified: [] as string[],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.safeParse({ ...base, onDisk: 1.5 }).success).toBe(false);
    expect(MigrationStateSchema.safeParse({ ...base, onDisk: 1, modifiedCount: 0.5 }).success).toBe(
      false,
    );
  });

  it("adversarial: `pending`/`modified` must be arrays of strings, never a bare count or number list", () => {
    const base = {
      onDisk: 1,
      applied: 0,
      pendingCount: 0,
      modified: [] as string[],
      modifiedCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(MigrationStateSchema.safeParse({ ...base, pending: 1 }).success).toBe(false);
    expect(MigrationStateSchema.safeParse({ ...base, pending: [1] }).success).toBe(false);
    const base2 = {
      onDisk: 1,
      applied: 0,
      pending: [] as string[],
      pendingCount: 0,
      checkedAt: CHECKED_AT,
    };
    expect(
      MigrationStateSchema.safeParse({ ...base2, modified: 1, modifiedCount: 0 }).success,
    ).toBe(false);
    expect(
      MigrationStateSchema.safeParse({ ...base2, modified: [1], modifiedCount: 0 }).success,
    ).toBe(false);
  });

  it("adversarial: `checkedAt` must be a real ISO-8601 datetime string, never epoch millis or a bare date", () => {
    const base = {
      onDisk: 1,
      applied: 1,
      pending: [] as string[],
      pendingCount: 0,
      modified: [] as string[],
      modifiedCount: 0,
    };
    expect(MigrationStateSchema.safeParse({ ...base, checkedAt: 1700000000000 }).success).toBe(
      false,
    );
    expect(MigrationStateSchema.safeParse({ ...base, checkedAt: "2026-01-01" }).success).toBe(
      false,
    );
    expect(MigrationStateSchema.safeParse({ ...base, checkedAt: CHECKED_AT }).success).toBe(true);
  });

  it("error: missing fields are rejected, not defaulted", () => {
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: 1 }).success).toBe(false);
    expect(MigrationStateSchema.safeParse({ onDisk: 1, applied: 1, pending: [] }).success).toBe(
      false,
    );
    expect(
      MigrationStateSchema.safeParse({ onDisk: 1, applied: 1, pending: [], pendingCount: 0 })
        .success,
    ).toBe(false);
    // Falsification: making `modified`/`modifiedCount` optional would make
    // this resolve `true` — the round-2 addition must be required, matching
    // `pending`/`pendingCount`'s own posture (never defaulted).
    expect(
      MigrationStateSchema.safeParse({
        onDisk: 1,
        applied: 1,
        pending: [],
        pendingCount: 0,
        modified: [],
      }).success,
    ).toBe(false);
  });
});

describe("HealthResponseSchema (B-28: migrations is the optional leg)", () => {
  it("happy: a full response with a current migration state parses", () => {
    const value = {
      ok: true,
      version: "0.0.1",
      migrations: {
        onDisk: 4,
        applied: 4,
        pending: [],
        pendingCount: 0,
        modified: [],
        modifiedCount: 0,
        checkedAt: CHECKED_AT,
      },
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
