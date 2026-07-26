/**
 * Deep-link registry unit tests (T-6.6 / NAV-5; navigation.spec §2.3).
 * Every §2.3 family × every transport, plus the malformed/unknown edges and
 * the +native-intent contract (cold/warm parity, falsy-cancels, never-throw).
 */
import { APP_SCHEME, LINK_DOMAIN } from "@gogo/shared";

import { redirectSystemPath } from "@/app/+native-intent";

import { parseDeepLink } from "./deep-links";
import { useLinkNoticeStore } from "./link-notice";

const HTTPS = `https://${LINK_DOMAIN}`;

afterEach(() => {
  useLinkNoticeStore.setState({ message: null });
});

describe("parseDeepLink — §2.3 registry families", () => {
  it.each([
    [`${HTTPS}/invite/tok-abc123`, "/join/tok-abc123"],
    [`${APP_SCHEME}://invite/tok-abc123`, "/join/tok-abc123"],
    ["/invite/tok-abc123", "/join/tok-abc123"],
  ])("invite link %s → %s (R-nav-11)", (url, path) => {
    expect(parseDeepLink(url)).toEqual({ kind: "target", path });
  });

  it.each([
    [`${HTTPS}/t/trip-uuid-1`, "/trip-uuid-1"],
    [`${APP_SCHEME}://t/trip-uuid-1`, "/trip-uuid-1"],
    ["/t/trip-uuid-1", "/trip-uuid-1"],
  ])("trip link %s → %s (default tab via the [tripId] layout)", (url, path) => {
    expect(parseDeepLink(url)).toEqual({ kind: "target", path });
  });

  it.each([
    [`${HTTPS}/t/trip-1/request/req-9`, "/trip-1/money/request/req-9"],
    [`${APP_SCHEME}://t/trip-1/request/req-9`, "/trip-1/money/request/req-9"],
    ["/t/trip-1/request/req-9", "/trip-1/money/request/req-9"],
  ])("settle-request link %s → %s (R-nav-13)", (url, path) => {
    expect(parseDeepLink(url)).toEqual({ kind: "target", path });
  });

  it("strips query/hash before matching (share-sheet URLs carry trackers)", () => {
    expect(parseDeepLink(`${HTTPS}/invite/tok-1?utm_source=x#frag`)).toEqual({
      kind: "target",
      path: "/join/tok-1",
    });
  });

  it("matches the universal-link host case-insensitively", () => {
    expect(parseDeepLink(`https://${LINK_DOMAIN.toUpperCase()}/invite/tok-1`)).toEqual({
      kind: "target",
      path: "/join/tok-1",
    });
  });
});

describe("parseDeepLink — malformed ours → fallback (R-nav-17)", () => {
  it.each([
    [`${HTTPS}/invite`, "invite with no token"],
    [`${HTTPS}/invite/a/b`, "invite with extra segments"],
    [`${APP_SCHEME}://invite`, "scheme invite with no token"],
    [`${HTTPS}/t`, "t namespace with no trip id"],
    [`${HTTPS}/t/x/request`, "request with no id"],
    [`${HTTPS}/t/x/y/z`, "unknown shape under /t"],
    [`${HTTPS}/anything-else`, "unknown path on OUR domain"],
    [`${HTTPS}/`, "bare domain root"],
  ])("%s (%s)", (url) => {
    expect(parseDeepLink(url)).toEqual({ kind: "fallback" });
  });
});

describe("parseDeepLink — not ours → passthrough", () => {
  it.each([
    ["https://example.com/invite/tok-1", "someone else's https host"],
    ["exp://127.0.0.1:8081/--/whatever", "dev-client scheme"],
    ["mailto:someone@example.com", "non-URL-shaped scheme string"],
    [`${APP_SCHEME}://some-trip-id/itinerary`, "internal route on the app scheme (dev QA, notifications)"],
    ["/sign-in", "bare internal path"],
    ["/", "root path"],
  ])("%s (%s)", (url) => {
    expect(parseDeepLink(url)).toEqual({ kind: "passthrough" });
  });
});

describe("redirectSystemPath — the +native-intent contract", () => {
  it("cold and warm resolve identically (R-nav-16 parity is structural)", () => {
    for (const url of [
      `${HTTPS}/invite/tok-1`,
      `${APP_SCHEME}://t/trip-1`,
      `${HTTPS}/unknown`,
      "/sign-in",
    ]) {
      expect(redirectSystemPath({ path: url, initial: true })).toBe(
        redirectSystemPath({ path: url, initial: false }),
      );
    }
  });

  it("rewrites targets", () => {
    expect(redirectSystemPath({ path: `${HTTPS}/invite/tok-1`, initial: true })).toBe(
      "/join/tok-1",
    );
  });

  it("fallback → trip list AND sets the non-blocking notice (R-nav-17)", () => {
    expect(redirectSystemPath({ path: `${HTTPS}/nope`, initial: false })).toBe("/(trips)");
    expect(useLinkNoticeStore.getState().message).not.toBeNull();
  });

  it("passthrough returns the ORIGINAL path — a falsy return would CANCEL navigation", () => {
    expect(redirectSystemPath({ path: "/sign-in", initial: true })).toBe("/sign-in");
    expect(useLinkNoticeStore.getState().message).toBeNull();
  });
});
