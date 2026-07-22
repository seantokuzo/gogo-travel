import { describe, expect, it } from "vitest";
import { descriptorKey } from "../api/descriptor.js";
import {
  AVATAR_MAX_BYTES,
  AvatarUploadRequestSchema,
  AvatarUploadTicketSchema,
  canonicalizeTravelStyles,
  DisplayNameSchema,
  PaymentHandlesUpdateSchema,
  PushTokenCreateSchema,
  PushTokenSchema,
  userEndpoints,
  UserPrefsSchema,
  UserProfileSchema,
  UserSchema,
  UserUpdateSchema,
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
    expect(DisplayNameSchema.safeParse("Sean\u0007").success).toBe(false);
  });
});

describe("UserUpdate (PATCH /users/me — R-user-2/3)", () => {
  it("accepts display_name + whole-object prefs; avatar_key null clears", () => {
    const parsed = UserUpdateSchema.parse({
      display_name: "  Sean  ",
      prefs: { units: "metric" },
      avatar_key: null,
    });
    expect(parsed.display_name).toBe("Sean");
    expect(parsed.avatar_key).toBeNull();
  });

  it("strips non-writable fields — email/subs/slug can never reach the handler", () => {
    const parsed = UserUpdateSchema.parse({
      display_name: "Sean",
      email: "evil@example.com",
      apple_sub: "sub",
      google_sub: "sub",
      forward_email_slug: "hijack",
    });
    expect(parsed).not.toHaveProperty("email");
    expect(parsed).not.toHaveProperty("apple_sub");
    expect(parsed).not.toHaveProperty("google_sub");
    expect(parsed).not.toHaveProperty("forward_email_slug");
  });

  it("rejects empty avatar_key (empty string is not a clear — null is)", () => {
    expect(UserUpdateSchema.safeParse({ avatar_key: "" }).success).toBe(false);
  });

  it("rejects control-character display names", () => {
    expect(UserUpdateSchema.safeParse({ display_name: "a\u0000b" }).success).toBe(false);
  });
});

describe("Avatar upload contract (R-user-3)", () => {
  it("accepts the three allowed content types", () => {
    for (const content_type of ["image/jpeg", "image/png", "image/webp"] as const) {
      expect(AvatarUploadRequestSchema.parse({ content_type, byte_size: 1024 }).content_type).toBe(
        content_type,
      );
    }
  });
  it("rejects gif/svg/anything else, and non-positive or float byte_size", () => {
    for (const content_type of ["image/gif", "image/svg+xml", "application/pdf", ""]) {
      expect(AvatarUploadRequestSchema.safeParse({ content_type, byte_size: 1 }).success).toBe(
        false,
      );
    }
    for (const byte_size of [0, -1, 1.5, "1024"]) {
      expect(
        AvatarUploadRequestSchema.safeParse({ content_type: "image/png", byte_size }).success,
      ).toBe(false);
    }
  });
  it("pins AVATAR_MAX_BYTES at 5 MB (413 threshold is the server's to enforce)", () => {
    expect(AVATAR_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
  it("ticket round-trips; method is literally PUT and upload_url must be a URL", () => {
    const ticket = {
      upload_url: "https://storage.example.com/presigned",
      method: "PUT",
      headers: { "content-type": "image/png" },
      storage_key: "avatars/6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c/abc",
      expires_at: "2026-07-22T00:10:00Z",
    };
    expect(AvatarUploadTicketSchema.parse(ticket).method).toBe("PUT");
    expect(AvatarUploadTicketSchema.safeParse({ ...ticket, method: "POST" }).success).toBe(false);
    expect(AvatarUploadTicketSchema.safeParse({ ...ticket, upload_url: "not-a-url" }).success).toBe(
      false,
    );
  });
});

describe("Push token schemas (R-user-8)", () => {
  it("create requires a nonempty token and a known platform", () => {
    expect(
      PushTokenCreateSchema.parse({ token: "ExponentPushToken[abc]", platform: "android" }).token,
    ).toBe("ExponentPushToken[abc]");
    expect(PushTokenCreateSchema.safeParse({ token: "", platform: "ios" }).success).toBe(false);
    expect(PushTokenCreateSchema.safeParse({ token: "t", platform: "web" }).success).toBe(false);
  });
  it("row shape round-trips with ISO last_seen_at", () => {
    const parsed = PushTokenSchema.parse({
      id: "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c",
      token: "ExponentPushToken[abc]",
      platform: "ios",
      last_seen_at: "2026-07-22T00:00:00Z",
    });
    expect(parsed.platform).toBe("ios");
    expect(PushTokenSchema.safeParse({ ...parsed, last_seen_at: 1786000000000 }).success).toBe(
      false,
    );
  });
});

describe("userEndpoints descriptors (§3.4.2 route table)", () => {
  it("mirror the spec routes exactly", () => {
    expect(
      Object.fromEntries(
        Object.entries(userEndpoints).map(([name, d]) => [name, descriptorKey(d)]),
      ),
    ).toEqual({
      getMe: "GET /users/me",
      updateMe: "PATCH /users/me",
      requestAvatarUpload: "POST /users/me/avatar-upload",
      updatePaymentHandles: "PATCH /users/me/payment-handles",
      getUserProfile: "GET /users/:userId",
      registerPushToken: "POST /users/me/push-tokens",
      deletePushToken: "DELETE /users/me/push-tokens/:pushTokenId",
      deleteMe: "DELETE /users/me",
    });
  });

  it("bind the shared write/read schemas", () => {
    expect(userEndpoints.updateMe.body).toBe(UserUpdateSchema);
    expect(userEndpoints.updateMe.response).toBe(UserSchema);
    expect(userEndpoints.updatePaymentHandles.body).toBe(PaymentHandlesUpdateSchema);
    expect(userEndpoints.requestAvatarUpload.body).toBe(AvatarUploadRequestSchema);
    expect(userEndpoints.getUserProfile.response).toBe(UserProfileSchema);
    expect(userEndpoints.registerPushToken.body).toBe(PushTokenCreateSchema);
  });

  it("path params require uuids; 204 endpoints have no body schema", () => {
    expect(userEndpoints.getUserProfile.params.safeParse({ userId: "1" }).success).toBe(false);
    expect(userEndpoints.deletePushToken.params.safeParse({ pushTokenId: "abc" }).success).toBe(
      false,
    );
    expect(userEndpoints.deleteMe.response.parse(undefined)).toBeUndefined();
    expect(userEndpoints.deleteMe).not.toHaveProperty("body");
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
