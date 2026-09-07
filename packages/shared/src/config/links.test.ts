import { describe, expect, it } from "vitest";
import {
  APP_SCHEME,
  inviteDeepLink,
  inviteUrl,
  LINK_DOMAIN,
  settleRequestDeepLink,
  settleRequestUrl,
} from "./links.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const REQUEST = "99999999-9999-4999-8999-999999999999";

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

  // T-9.7 hoist rider (W4 obligations row): ONE home for the settle-request
  // path template — the server's wire `link` (requests-serialize.ts) and the
  // client's share composition both consume these, so a template mutation
  // reds the shared pins AND both consumers' suites together (the drift
  // hazard: independently-composed halves ship dead-end share links).
  it("settle-request universal link matches the §2.3 registry format (R-money-16)", () => {
    expect(settleRequestUrl(TRIP, REQUEST)).toBe(
      `https://links.gogotravel.example/t/${TRIP}/request/${REQUEST}`,
    );
  });

  it("gogo:// scheme mirrors the same settle-request path (R-nav-13 twin)", () => {
    expect(settleRequestDeepLink(TRIP, REQUEST)).toBe(`gogo://t/${TRIP}/request/${REQUEST}`);
  });

  it("the https and gogo:// settle-request forms derive from ONE path template", () => {
    const httpsPath = settleRequestUrl(TRIP, REQUEST).replace(`https://${LINK_DOMAIN}/`, "");
    const schemePath = settleRequestDeepLink(TRIP, REQUEST).replace(`${APP_SCHEME}://`, "");
    expect(schemePath).toBe(httpsPath);
  });
});
