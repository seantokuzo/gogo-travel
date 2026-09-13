/**
 * S-4 wave 2 (T2) contract suite for the E2E session-door descriptor
 * (`.specs/testing/session-door.spec.md`). `user_key` is concatenated into
 * `apple_sub` server-side, so its shape IS a security boundary — the
 * adversarial block below is not decorative.
 *
 * Falsification (R-test-7): widening `E2eUserKeySchema`'s regex to
 * `/^.*$/` turns the adversarial `describe` block RED. Re-exporting
 * `./e2e.js` from `../index.ts` turns the barrel-exclusion pin RED. Both
 * were executed and reverted — see the PR body's mutation table.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { descriptorKey } from "../api/descriptor.js";
import type { EndpointDescriptor } from "../api/descriptor.js";
import { SignInResponseSchema } from "./auth.js";
import { E2eSessionRequestSchema, E2eUserKeySchema, e2eEndpoints } from "./e2e.js";

// Built via fromCharCode, never as a literal source byte/glyph, so the
// adversarial fixtures below carry a real NUL / em dash at RUNTIME without
// putting a raw control byte or non-ASCII glyph in this source file
// (`.claude/rules/mobile.md` Hermes-UTF-16 landmine; ci.md ASCII posture).
const NUL = String.fromCharCode(0);
const EM_DASH = String.fromCharCode(0x2014);

const validDevice = { platform: "ios" } as const;

const validRequest = {
  secret: "s".repeat(32),
  user_key: "golden-run-1",
  device: validDevice,
} as const;

describe("E2eUserKeySchema", () => {
  it("accepts the minimal and maximal valid shapes", () => {
    expect(E2eUserKeySchema.safeParse("a").success).toBe(true);
    expect(E2eUserKeySchema.safeParse("a".repeat(32)).success).toBe(true);
    expect(E2eUserKeySchema.safeParse("golden-run-1").success).toBe(true);
  });

  it("boundary: 32 chars accepted, 33 rejected", () => {
    expect(E2eUserKeySchema.safeParse("a".repeat(32)).success).toBe(true);
    expect(E2eUserKeySchema.safeParse("a".repeat(33)).success).toBe(false);
  });

  it("empty string rejected", () => {
    expect(E2eUserKeySchema.safeParse("").success).toBe(false);
  });

  it("adversarial: shapes that would corrupt the server-side apple_sub concat are rejected", () => {
    const evil = [
      "a/b", // path-injection into apple_sub
      "..", // traversal-shaped
      "a..b",
      "a%2eb", // percent-encoded dot, in case the server ever decodes before matching
      "-leading-hyphen", // first char must be alnum
      "Uppercase", // charset is [a-z0-9-] only
      `a${NUL}b`, // NUL char, built at runtime (see NUL const above)
      `a${EM_DASH}b`, // em dash, built at runtime (see EM_DASH const above)
      "a".repeat(10_000), // pathological length, independent of the 32-cap check above
    ];
    for (const user_key of evil) {
      expect(E2eUserKeySchema.safeParse(user_key).success).toBe(false);
    }
  });

  it("rejects non-string type confusion", () => {
    for (const evil of [null, undefined, 1, true, ["a"], { user_key: "a" }]) {
      expect(E2eUserKeySchema.safeParse(evil).success).toBe(false);
    }
  });
});

describe("E2eSessionRequestSchema (POST /auth/e2e/session)", () => {
  it("happy: a valid request parses", () => {
    const parsed = E2eSessionRequestSchema.parse(validRequest);
    expect(parsed.user_key).toBe("golden-run-1");
    expect(parsed.first_run).toBeUndefined();
  });

  it("happy: first_run is optional and defaults to undefined, not false", () => {
    expect(E2eSessionRequestSchema.parse({ ...validRequest, first_run: true }).first_run).toBe(
      true,
    );
    expect(E2eSessionRequestSchema.parse(validRequest).first_run).toBeUndefined();
  });

  it("empty body rejected", () => {
    expect(E2eSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  it("empty: secret '' and user_key '' rejected", () => {
    expect(E2eSessionRequestSchema.safeParse({ ...validRequest, secret: "" }).success).toBe(false);
    expect(E2eSessionRequestSchema.safeParse({ ...validRequest, user_key: "" }).success).toBe(
      false,
    );
  });

  it("missing device rejected", () => {
    const { device: _device, ...noDevice } = validRequest;
    expect(E2eSessionRequestSchema.safeParse(noDevice).success).toBe(false);
  });

  it("error: secret one char under the 32-char floor is rejected", () => {
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, secret: "s".repeat(31) }).success,
    ).toBe(false);
  });

  it("error: secret one char over the 512-char DoS-headroom cap is rejected", () => {
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, secret: "s".repeat(513) }).success,
    ).toBe(false);
  });

  it("boundary: secret exactly 32 and exactly 512 chars accepted", () => {
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, secret: "s".repeat(32) }).success,
    ).toBe(true);
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, secret: "s".repeat(512) }).success,
    ).toBe(true);
  });

  it("boundary: user_key exactly 1 and exactly 32 chars accepted", () => {
    expect(E2eSessionRequestSchema.safeParse({ ...validRequest, user_key: "a" }).success).toBe(
      true,
    );
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, user_key: "a".repeat(32) }).success,
    ).toBe(true);
  });

  it("adversarial: user_key that would corrupt apple_sub is rejected at the request level too", () => {
    for (const user_key of ["a/b", "..", "-x", "A", `a${EM_DASH}b`]) {
      expect(E2eSessionRequestSchema.safeParse({ ...validRequest, user_key }).success).toBe(false);
    }
  });

  it("rejects non-string type confusion on secret", () => {
    for (const evil of [null, 42, true, ["s".repeat(40)], {}]) {
      expect(E2eSessionRequestSchema.safeParse({ ...validRequest, secret: evil }).success).toBe(
        false,
      );
    }
  });

  it("rejects a non-boolean first_run (type confusion)", () => {
    for (const evil of ["true", 1, null]) {
      expect(E2eSessionRequestSchema.safeParse({ ...validRequest, first_run: evil }).success).toBe(
        false,
      );
    }
  });

  it("rejects a device with an out-of-enum platform", () => {
    expect(
      E2eSessionRequestSchema.safeParse({ ...validRequest, device: { platform: "web" } }).success,
    ).toBe(false);
  });

  it("strips unknown keys at both levels rather than rejecting (R-shared-10 — not a strictObject)", () => {
    const parsed = E2eSessionRequestSchema.parse({
      ...validRequest,
      admin: true,
      device: { ...validDevice, jailbroken: true },
    });
    expect(parsed).not.toHaveProperty("admin");
    expect(parsed.device).not.toHaveProperty("jailbroken");
  });
});

describe("e2eEndpoints.mintSession", () => {
  it("descriptorKey is 'POST /auth/e2e/session'", () => {
    expect(descriptorKey(e2eEndpoints.mintSession)).toBe("POST /auth/e2e/session");
  });

  it("response schema is SignInResponseSchema, reused verbatim (not a re-derived shape)", () => {
    expect(e2eEndpoints.mintSession.response).toBe(SignInResponseSchema);
  });

  it("has no query or params — the route takes no path/query input", () => {
    const descriptor: EndpointDescriptor = e2eEndpoints.mintSession;
    expect(descriptor.query).toBeUndefined();
    expect(descriptor.params).toBeUndefined();
  });
});

describe("e2eEndpoints registry invariants (scoped — this group is NOT in the shared descriptor registry)", () => {
  const all: EndpointDescriptor[] = Object.values(e2eEndpoints);

  it("every path is absolute and free of trailing slashes", () => {
    for (const descriptor of all) {
      expect(descriptor.path.startsWith("/")).toBe(true);
      expect(descriptor.path.endsWith("/")).toBe(false);
    }
  });

  it("path `:tokens` and params-schema keys match one-to-one (none, here)", () => {
    for (const descriptor of all) {
      const pathTokens = (descriptor.path.match(/:([A-Za-z0-9_]+)/g) ?? []).map((t) => t.slice(1));
      const paramKeys =
        descriptor.params instanceof z.ZodObject ? Object.keys(descriptor.params.shape) : [];
      expect(paramKeys.sort()).toEqual([...pathTokens].sort());
    }
  });

  it("descriptorKeys within the group are unique", () => {
    const keys = all.map(descriptorKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("barrel exclusion (session-door spec §4.1 — the door must have exactly two importers)", () => {
  it("e2eEndpoints, E2eSessionRequestSchema, and E2eUserKeySchema are NOT re-exported from the package barrel", async () => {
    const barrel = (await import("../index.js")) as Record<string, unknown>;
    expect(barrel).not.toHaveProperty("e2eEndpoints");
    expect(barrel).not.toHaveProperty("E2eSessionRequestSchema");
    expect(barrel).not.toHaveProperty("E2eUserKeySchema");
  });
});
