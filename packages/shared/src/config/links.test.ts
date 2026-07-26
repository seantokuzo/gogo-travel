import { describe, expect, it } from "vitest";
import { APP_SCHEME, inviteDeepLink, inviteUrl, LINK_DOMAIN } from "./links.js";

describe("link config (nav spec §1/§2.3)", () => {
  it("LINK_DOMAIN is the Gate-2 placeholder host (swaps at P-14, one-config change)", () => {
    expect(LINK_DOMAIN).toBe("links.gogotravel.example");
  });

  it("invite universal link matches the §2.3 registry format", () => {
    expect(inviteUrl("tok_abc-123")).toBe("https://links.gogotravel.example/invite/tok_abc-123");
  });

  it("gogo:// scheme mirrors the same invite path", () => {
    expect(APP_SCHEME).toBe("gogo");
    expect(inviteDeepLink("tok_abc-123")).toBe("gogo://invite/tok_abc-123");
  });
});
