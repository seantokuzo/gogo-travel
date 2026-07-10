import { describe, expect, it } from "vitest";
import {
  canonicalizeTravelStyles,
  DisplayNameSchema,
  PaymentHandlesUpdateSchema,
  UserPrefsSchema,
  UserProfileSchema,
  UserSchema,
} from "./user.js";

describe("UserPrefs", () => {
  it("parses a full prefs object", () => {
    const parsed = UserPrefsSchema.parse({
      travel_style: ["foodie", "budget"],
      home_currency: "JPY",
      units: "metric",
      notifications: { daily_digest: false },
    });
    expect(parsed.travel_style).toEqual(["foodie", "budget"]);
    expect(parsed.notifications).toEqual({ daily_digest: false });
  });

  it("strips unknown keys (R-shared-10 / R-db-17)", () => {
    const parsed = UserPrefsSchema.parse({ units: "imperial", favorite_color: "teal" });
    expect(parsed).toEqual({ units: "imperial" });
  });

  it("rejects travel styles outside the fixed taxonomy", () => {
    expect(UserPrefsSchema.safeParse({ travel_style: ["yolo"] }).success).toBe(false);
  });

  it("rejects unknown notification categories as prefs keys", () => {
    expect(UserPrefsSchema.safeParse({ notifications: { spam: true } }).success).toBe(false);
  });
});

describe("canonicalizeTravelStyles (AI cache-key input)", () => {
  it("sorts unique tags and joins with '+'", () => {
    expect(canonicalizeTravelStyles(["foodie", "budget", "culture"])).toBe("budget+culture+foodie");
  });
  it("is order-insensitive (tag order can never fork the cache)", () => {
    expect(canonicalizeTravelStyles(["culture", "budget", "foodie"])).toBe(
      canonicalizeTravelStyles(["foodie", "culture", "budget"]),
    );
  });
  it("dedupes", () => {
    expect(canonicalizeTravelStyles(["budget", "budget"])).toBe("budget");
  });
  it("empty or unset → 'any'", () => {
    expect(canonicalizeTravelStyles([])).toBe("any");
    expect(canonicalizeTravelStyles(undefined)).toBe("any");
  });
});

describe("PaymentHandlesUpdate normalization (R-user-5)", () => {
  it("strips leading @ from venmo and $ from cashtag", () => {
    const parsed = PaymentHandlesUpdateSchema.parse({
      venmo_username: "@sean-t",
      cashtag: "$seant",
    });
    expect(parsed.venmo_username).toBe("sean-t");
    expect(parsed.cashtag).toBe("seant");
  });

  it("normalizes THEN validates: a lone prefix strips to empty and rejects", () => {
    expect(PaymentHandlesUpdateSchema.safeParse({ venmo_username: "@" }).success).toBe(false);
    expect(PaymentHandlesUpdateSchema.safeParse({ venmo_username: "@@@" }).success).toBe(false);
    expect(PaymentHandlesUpdateSchema.safeParse({ cashtag: "$" }).success).toBe(false);
    expect(PaymentHandlesUpdateSchema.parse({ venmo_username: "@validname" }).venmo_username).toBe(
      "validname",
    );
  });

  it("rejects deeplink parameter-injection payloads (charset chokepoint)", () => {
    for (const field of ["venmo_username", "cashtag", "paypalme_username"] as const) {
      expect(PaymentHandlesUpdateSchema.safeParse({ [field]: "evil&amount=5000" }).success).toBe(
        false,
      );
      expect(PaymentHandlesUpdateSchema.safeParse({ [field]: "a?note=paid#x" }).success).toBe(
        false,
      );
    }
  });

  it("rejects internal whitespace and full URLs", () => {
    expect(PaymentHandlesUpdateSchema.safeParse({ venmo_username: "sean t" }).success).toBe(false);
    expect(
      PaymentHandlesUpdateSchema.safeParse({ paypalme_username: "https://paypal.me/sean" }).success,
    ).toBe(false);
    expect(PaymentHandlesUpdateSchema.safeParse({ cashtag: "$evil/transfer" }).success).toBe(false);
  });

  it("caps handles at 30 chars post-normalization", () => {
    expect(
      PaymentHandlesUpdateSchema.parse({ venmo_username: "@" + "a".repeat(30) }).venmo_username,
    ).toBe("a".repeat(30));
    expect(PaymentHandlesUpdateSchema.safeParse({ venmo_username: "a".repeat(31) }).success).toBe(
      false,
    );
  });

  it("null clears; absent leaves untouched", () => {
    const parsed = PaymentHandlesUpdateSchema.parse({ venmo_username: null });
    expect(parsed.venmo_username).toBeNull();
    expect("cashtag" in parsed).toBe(false);
  });

  it("accepts zelle as email or E.164, with display name", () => {
    expect(
      PaymentHandlesUpdateSchema.parse({
        zelle_handle: "sean@example.com",
        zelle_display_name: "Sean T",
      }).zelle_handle,
    ).toBe("sean@example.com");
    expect(
      PaymentHandlesUpdateSchema.parse({
        zelle_handle: "+14155550123",
        zelle_display_name: "Sean T",
      }).zelle_handle,
    ).toBe("+14155550123");
  });

  it("rejects zelle handles that are neither email nor E.164", () => {
    expect(
      PaymentHandlesUpdateSchema.safeParse({
        zelle_handle: "415-555-0123",
        zelle_display_name: "Sean T",
      }).success,
    ).toBe(false);
  });

  it("rejects zelle_handle set without zelle_display_name in the same payload", () => {
    expect(PaymentHandlesUpdateSchema.safeParse({ zelle_handle: "sean@example.com" }).success).toBe(
      false,
    );
  });
});

describe("DisplayName", () => {
  it("trims and bounds 1–50", () => {
    expect(DisplayNameSchema.parse("  Sean  ")).toBe("Sean");
    expect(DisplayNameSchema.safeParse("").success).toBe(false);
    expect(DisplayNameSchema.safeParse("x".repeat(51)).success).toBe(false);
  });
  it("rejects control characters", () => {
    expect(DisplayNameSchema.safeParse("Sean").success).toBe(false);
  });
});

describe("User vs UserProfile exposure", () => {
  const base = {
    id: "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c",
    display_name: "Sean",
    avatar_key: null,
    venmo_username: "sean-t",
    cashtag: null,
    paypalme_username: null,
    zelle_handle: null,
    zelle_display_name: null,
  };

  it("User carries email/prefs/slug; UserProfile strips them", () => {
    const user = UserSchema.parse({
      ...base,
      email: "sean@example.com",
      prefs: {},
      forward_email_slug: "sean-abc123",
      created_at: "2026-07-10T00:00:00Z",
    });
    expect(user.forward_email_slug).toBe("sean-abc123");

    const profile = UserProfileSchema.parse({
      ...base,
      email: "leak@example.com",
      prefs: { units: "metric" },
      forward_email_slug: "leak",
    });
    expect(profile).not.toHaveProperty("email");
    expect(profile).not.toHaveProperty("prefs");
    expect(profile).not.toHaveProperty("forward_email_slug");
  });
});
