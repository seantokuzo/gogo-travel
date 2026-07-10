import { describe, expect, it } from "vitest";
import { NotificationPayloadSchema } from "./notification.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";
const common = {
  title: "Itinerary updated",
  body: "Sean moved dinner to 19:30",
  route: "/t/abc/itinerary",
  trip_id: UUID,
};

describe("NotificationPayload discriminated union (notifications spec §3.3)", () => {
  it("itinerary_change carries invalidate scopes + actor", () => {
    const parsed = NotificationPayloadSchema.parse({
      category: "itinerary_change",
      ...common,
      invalidate: ["itinerary", "legs"],
      actor_id: UUID,
    });
    expect(parsed.category === "itinerary_change" && parsed.invalidate).toEqual([
      "itinerary",
      "legs",
    ]);
  });

  it("rejects unknown invalidate scopes", () => {
    expect(
      NotificationPayloadSchema.safeParse({
        category: "itinerary_change",
        ...common,
        invalidate: ["everything"],
        actor_id: UUID,
      }).success,
    ).toBe(false);
  });

  it("daily_digest carries the day", () => {
    const parsed = NotificationPayloadSchema.parse({
      category: "daily_digest",
      ...common,
      day: "2026-09-02",
    });
    expect(parsed.category === "daily_digest" && parsed.day).toBe("2026-09-02");
  });

  it("leave_by carries item + leave_at instant", () => {
    expect(
      NotificationPayloadSchema.parse({
        category: "leave_by",
        ...common,
        item_id: UUID,
        leave_at: "2026-09-02T09:15:00+09:00",
      }).category,
    ).toBe("leave_by");
  });

  it("document_expiry / settle_up carry their entity ids; missing extras rejected", () => {
    expect(
      NotificationPayloadSchema.parse({
        category: "document_expiry",
        ...common,
        document_id: UUID,
      }).category,
    ).toBe("document_expiry");
    expect(NotificationPayloadSchema.safeParse({ category: "settle_up", ...common }).success).toBe(
      false,
    );
  });

  it("flight_status is reserved: common fields only", () => {
    expect(NotificationPayloadSchema.parse({ category: "flight_status", ...common }).category).toBe(
      "flight_status",
    );
  });

  it("trip_id is optional (category-level pushes)", () => {
    const { trip_id: _t, ...noTrip } = common;
    expect(
      NotificationPayloadSchema.parse({
        category: "document_expiry",
        ...noTrip,
        document_id: UUID,
      }).trip_id,
    ).toBeUndefined();
  });
});
