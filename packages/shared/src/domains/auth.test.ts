/**
 * AU-1 contract suite for the auth domain (auth-users spec §3.4.1/§3.7).
 * Red-team posture: these schemas ARE the public sign-in boundary — every
 * probe that could smuggle a malformed credential payload past validation
 * belongs here.
 */
import { describe, expect, it } from "vitest";
import { descriptorKey } from "../api/descriptor.js";
import {
  AppleSignInRequestSchema,
  AuthSessionInfoSchema,
  AuthTokensSchema,
  authEndpoints,
  DeviceInfoSchema,
  GoogleSignInRequestSchema,
  LogoutRequestSchema,
  RefreshRequestSchema,
  SignInResponseSchema,
} from "./auth.js";

const UUID = "6f9d9d31-6d4a-4b7a-9df6-9b4a3f6d2e1c";

const validDevice = { platform: "ios" } as const;

const validApple = {
  identity_token: "eyJhbGciOiJFUzI1NiJ9.payload.sig",
  authorization_code: "c0de",
  raw_nonce: "n0nce",
  device: { device_name: "Sean's iPhone 17", platform: "ios" },
} as const;

const validGoogle = {
  id_token: "eyJhbGciOiJSUzI1NiJ9.payload.sig",
  raw_nonce: "n0nce",
  device: validDevice,
} as const;

const validUser = {
  id: UUID,
  email: "sean@example.com",
  display_name: "Sean",
  avatar_key: null,
  prefs: {},
  venmo_username: null,
  cashtag: null,
  paypalme_username: null,
  zelle_handle: null,
  zelle_display_name: null,
  forward_email_slug: null,
  created_at: "2026-07-22T00:00:00Z",
} as const;

const validTokens = {
  access_token: "eyJhbGciOiJFUzI1NiJ9.claims.sig",
  refresh_token: "A".repeat(43),
  expires_in: 900,
} as const;

describe("DeviceInfo", () => {
  it("accepts ios/android; device_name optional", () => {
    expect(DeviceInfoSchema.parse({ platform: "android" }).device_name).toBeUndefined();
    expect(DeviceInfoSchema.parse(validApple.device).device_name).toBe("Sean's iPhone 17");
  });
  it("rejects platforms outside the shared push_platform tuple", () => {
    for (const platform of ["web", "ipados", "", "IOS", null, 1]) {
      expect(DeviceInfoSchema.safeParse({ platform }).success).toBe(false);
    }
  });
});

describe("AppleSignInRequest (POST /auth/apple)", () => {
  it("parses the minimal payload", () => {
    const parsed = AppleSignInRequestSchema.parse(validApple);
    expect(parsed.given_name).toBeUndefined();
    expect(parsed.family_name).toBeUndefined();
  });

  it("parses first-authorization name fields (R-auth-5)", () => {
    const parsed = AppleSignInRequestSchema.parse({
      ...validApple,
      given_name: "Sean",
      family_name: "T",
    });
    expect(parsed.given_name).toBe("Sean");
  });

  it("rejects missing or empty credential material", () => {
    for (const field of ["identity_token", "authorization_code", "raw_nonce"] as const) {
      expect(AppleSignInRequestSchema.safeParse({ ...validApple, [field]: "" }).success).toBe(
        false,
      );
      const { [field]: _omitted, ...rest } = validApple;
      expect(AppleSignInRequestSchema.safeParse(rest).success).toBe(false);
    }
  });

  it("rejects non-string credential material (type-juggling probes)", () => {
    for (const evil of [null, 42, true, ["a"], { token: "x" }]) {
      expect(
        AppleSignInRequestSchema.safeParse({ ...validApple, identity_token: evil }).success,
      ).toBe(false);
      expect(AppleSignInRequestSchema.safeParse({ ...validApple, raw_nonce: evil }).success).toBe(
        false,
      );
    }
  });

  it("requires device with a valid platform", () => {
    const { device: _device, ...noDevice } = validApple;
    expect(AppleSignInRequestSchema.safeParse(noDevice).success).toBe(false);
    expect(
      AppleSignInRequestSchema.safeParse({ ...validApple, device: { platform: "web" } }).success,
    ).toBe(false);
  });

  it("strips unknown keys at both levels (R-shared-10)", () => {
    const parsed = AppleSignInRequestSchema.parse({
      ...validApple,
      is_admin: true,
      device: { ...validApple.device, jailbroken: true },
    });
    expect(parsed).not.toHaveProperty("is_admin");
    expect(parsed.device).not.toHaveProperty("jailbroken");
  });
});

describe("GoogleSignInRequest (POST /auth/google)", () => {
  it("parses the valid payload", () => {
    expect(GoogleSignInRequestSchema.parse(validGoogle).id_token).toBe(validGoogle.id_token);
  });

  it("rejects missing/empty id_token and raw_nonce", () => {
    expect(GoogleSignInRequestSchema.safeParse({ ...validGoogle, id_token: "" }).success).toBe(
      false,
    );
    expect(GoogleSignInRequestSchema.safeParse({ ...validGoogle, raw_nonce: "" }).success).toBe(
      false,
    );
    const { id_token: _t, ...rest } = validGoogle;
    expect(GoogleSignInRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("has no Apple-only fields — they are stripped, not accepted", () => {
    const parsed = GoogleSignInRequestSchema.parse({
      ...validGoogle,
      identity_token: "smuggled",
      authorization_code: "smuggled",
    });
    expect(parsed).not.toHaveProperty("identity_token");
    expect(parsed).not.toHaveProperty("authorization_code");
  });
});

describe("RefreshRequest (POST /auth/refresh)", () => {
  it("parses a token", () => {
    expect(RefreshRequestSchema.parse({ refresh_token: "r" }).refresh_token).toBe("r");
  });
  it("rejects empty, missing, and non-string tokens", () => {
    expect(RefreshRequestSchema.safeParse({ refresh_token: "" }).success).toBe(false);
    expect(RefreshRequestSchema.safeParse({}).success).toBe(false);
    for (const evil of [null, 1, ["t"], { hash: "x" }]) {
      expect(RefreshRequestSchema.safeParse({ refresh_token: evil }).success).toBe(false);
    }
  });
});

describe("AuthTokens", () => {
  it("parses; expires_in is positive integer seconds (= ACCESS_TOKEN_TTL)", () => {
    expect(AuthTokensSchema.parse(validTokens).expires_in).toBe(900);
  });
  it("rejects zero, negative, float, and stringified expires_in", () => {
    for (const expires_in of [0, -900, 900.5, "900", null]) {
      expect(AuthTokensSchema.safeParse({ ...validTokens, expires_in }).success).toBe(false);
    }
  });
  it("rejects empty token strings", () => {
    expect(AuthTokensSchema.safeParse({ ...validTokens, access_token: "" }).success).toBe(false);
    expect(AuthTokensSchema.safeParse({ ...validTokens, refresh_token: "" }).success).toBe(false);
  });
});

describe("SignInResponse", () => {
  it("round-trips { user, tokens, is_new_user }", () => {
    const parsed = SignInResponseSchema.parse({
      user: validUser,
      tokens: validTokens,
      is_new_user: true,
    });
    expect(parsed.user.id).toBe(UUID);
    expect(parsed.is_new_user).toBe(true);
  });
  it("requires all three members; is_new_user must be a real boolean", () => {
    expect(SignInResponseSchema.safeParse({ user: validUser, tokens: validTokens }).success).toBe(
      false,
    );
    expect(
      SignInResponseSchema.safeParse({ tokens: validTokens, is_new_user: false }).success,
    ).toBe(false);
    for (const is_new_user of ["true", 1, null]) {
      expect(
        SignInResponseSchema.safeParse({ user: validUser, tokens: validTokens, is_new_user })
          .success,
      ).toBe(false);
    }
  });
});

describe("LogoutRequest (POST /auth/logout)", () => {
  it("accepts an empty body and a uuid push_token_id", () => {
    expect(LogoutRequestSchema.parse({}).push_token_id).toBeUndefined();
    expect(LogoutRequestSchema.parse({ push_token_id: UUID }).push_token_id).toBe(UUID);
  });
  it("rejects non-uuid push_token_id", () => {
    for (const push_token_id of ["ExponentPushToken[x]", "1", 7, {}]) {
      expect(LogoutRequestSchema.safeParse({ push_token_id }).success).toBe(false);
    }
  });
});

describe("AuthSessionInfo (GET /auth/sessions item)", () => {
  const valid = {
    id: UUID,
    device_name: "Sean's iPhone 17",
    platform: "ios",
    created_at: "2026-07-22T00:00:00Z",
    last_used_at: "2026-07-22T01:00:00+00:00",
    current: true,
  };

  it("parses; device_name is nullable", () => {
    expect(AuthSessionInfoSchema.parse(valid).current).toBe(true);
    expect(AuthSessionInfoSchema.parse({ ...valid, device_name: null }).device_name).toBeNull();
  });

  it("timestamps are ISO-8601 strings — epoch numbers and junk fail (R-shared-11)", () => {
    for (const created_at of [1786000000000, "2026-07-22", "not-a-date", null]) {
      expect(AuthSessionInfoSchema.safeParse({ ...valid, created_at }).success).toBe(false);
    }
  });

  it("rejects unknown platforms and non-boolean current", () => {
    expect(AuthSessionInfoSchema.safeParse({ ...valid, platform: "web" }).success).toBe(false);
    expect(AuthSessionInfoSchema.safeParse({ ...valid, current: "yes" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Descriptors (§3.4.1 route table — the machine-readable mirror must match)
// ---------------------------------------------------------------------------

describe("authEndpoints descriptors", () => {
  it("mirror the §3.4.1 route table exactly", () => {
    expect(
      Object.fromEntries(
        Object.entries(authEndpoints).map(([name, d]) => [name, descriptorKey(d)]),
      ),
    ).toEqual({
      appleSignIn: "POST /auth/apple",
      googleSignIn: "POST /auth/google",
      refresh: "POST /auth/refresh",
      logout: "POST /auth/logout",
      listSessions: "GET /auth/sessions",
      revokeSession: "DELETE /auth/sessions/:sessionId",
    });
  });

  it("bind the shared schemas — server and client cannot drift", () => {
    expect(authEndpoints.appleSignIn.body).toBe(AppleSignInRequestSchema);
    expect(authEndpoints.googleSignIn.body).toBe(GoogleSignInRequestSchema);
    expect(authEndpoints.refresh.body).toBe(RefreshRequestSchema);
    expect(authEndpoints.refresh.response).toBe(AuthTokensSchema);
    expect(authEndpoints.logout.body).toBe(LogoutRequestSchema);
  });

  it("listSessions responds Paginated<AuthSessionInfo> and takes ?cursor", () => {
    const page = authEndpoints.listSessions.response.parse({
      items: [
        {
          id: UUID,
          device_name: null,
          platform: "android",
          created_at: "2026-07-22T00:00:00Z",
          last_used_at: "2026-07-22T00:00:00Z",
          current: false,
        },
      ],
      nextCursor: null,
    });
    expect(page.items).toHaveLength(1);
    expect(authEndpoints.listSessions.query.parse({}).cursor).toBeUndefined();
  });

  it("204 endpoints parse no body and reject one", () => {
    expect(authEndpoints.logout.response.parse(undefined)).toBeUndefined();
    expect(authEndpoints.revokeSession.response.safeParse({}).success).toBe(false);
  });

  it("revokeSession requires a uuid sessionId path param", () => {
    expect(authEndpoints.revokeSession.params.safeParse({ sessionId: "1" }).success).toBe(false);
    expect(authEndpoints.revokeSession.params.parse({ sessionId: UUID }).sessionId).toBe(UUID);
  });
});
