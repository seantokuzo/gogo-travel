/**
 * T-5.2 display-name seeding (R-auth-5) — pure-function edge cases; the
 * resolution flows are covered end-to-end in `signin-routes.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { seedDisplayName } from "./sign-in.js";

describe("seedDisplayName", () => {
  it("joins given + family name", () => {
    expect(seedDisplayName({ givenName: "Sean", familyName: "Tokuzo" }, "s@example.com")).toBe(
      "Sean Tokuzo",
    );
  });

  it("prefers the provider's full name when present", () => {
    expect(
      seedDisplayName(
        { fullName: "Sean T.", givenName: "Sean", familyName: "Tokuzo" },
        "s@example.com",
      ),
    ).toBe("Sean T.");
  });

  it("uses a lone given name without trailing whitespace", () => {
    expect(seedDisplayName({ givenName: " Sean " }, "s@example.com")).toBe("Sean");
  });

  it("falls back to the email local part when no name fields arrive", () => {
    expect(seedDisplayName({}, "wanderer42@example.com")).toBe("wanderer42");
  });

  it("whitespace-only name fields fall through to the email local part", () => {
    expect(seedDisplayName({ fullName: "  ", givenName: " " }, "trip.lord@example.com")).toBe(
      "trip.lord",
    );
  });

  it("clamps to 50 chars (DisplayNameSchema cap)", () => {
    const seeded = seedDisplayName({ fullName: "x".repeat(80) }, "s@example.com");
    expect(seeded).toHaveLength(50);
  });

  it("degenerate email local part still yields a non-empty name", () => {
    expect(seedDisplayName({}, "@example.com")).toBe("Traveler");
  });
});
