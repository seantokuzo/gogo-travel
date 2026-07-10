import { describe, expect, it } from "vitest";
import { OfflineMutationSchema } from "./offline.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

describe("OfflineMutation queue entry (contracts spec §3.4)", () => {
  const valid = {
    id: UUID,
    trip_id: UUID,
    descriptor_key: "POST /trips/:tripId/expenses",
    params: { tripId: UUID },
    payload: { description: "Dinner", amount_cents: 1000 },
    queued_at: "2026-09-02T10:00:00Z",
    attempts: 0,
    status: "pending",
  };

  it("parses a queued mutation", () => {
    expect(OfflineMutationSchema.parse(valid).status).toBe("pending");
  });
  it("status is pending|failed only", () => {
    expect(OfflineMutationSchema.parse({ ...valid, status: "failed" }).status).toBe("failed");
    expect(OfflineMutationSchema.safeParse({ ...valid, status: "done" }).success).toBe(false);
  });
  it("attempts must be a non-negative int", () => {
    expect(OfflineMutationSchema.safeParse({ ...valid, attempts: -1 }).success).toBe(false);
    expect(OfflineMutationSchema.safeParse({ ...valid, attempts: 1.5 }).success).toBe(false);
  });
  it("queued_at must be an ISO instant, never epoch (R-shared-11)", () => {
    expect(OfflineMutationSchema.safeParse({ ...valid, queued_at: 1760000000 }).success).toBe(
      false,
    );
  });
});
