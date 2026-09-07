/**
 * Deep-link / universal-link configuration (navigation spec §1 + §2.3,
 * resolved Gate 2, 2026-07-09).
 *
 * `LINK_DOMAIN` is THE single shared constant every link format consumes —
 * the universal-link domain is Sean's pre-launch pick (P-14), so the
 * placeholder ships now and the real domain swaps in as a one-config change
 * with zero spec/code churn. The custom `gogo://` scheme mirrors the same
 * paths as the fallback either way (nav §2.3).
 *
 * Platform-agnostic (R-shared-9): pure string constants + formatters, no I/O.
 */

/**
 * Universal-link host — PLACEHOLDER until the domain purchase (nav spec §1;
 * STATE P-6 scope note). Both mobile (AASA/assetlinks, link parsing) and the
 * server (invite `url` fields) read this one constant.
 */
export const LINK_DOMAIN = "links.gogotravel.example";

/** Custom URL scheme — the deep-link fallback that mirrors every path. */
export const APP_SCHEME = "gogo";

/**
 * Invite link for a token — `https://<LINK_DOMAIN>/invite/<token>` per the
 * nav §2.3 deep-link registry; the `POST /trips/:tripId/invites` response's
 * `url` field (trips spec §3.3).
 */
export function inviteUrl(token: string): string {
  return `https://${LINK_DOMAIN}/invite/${token}`;
}

/** The `gogo://` mirror of the invite link (nav §2.3: scheme mirrors paths). */
export function inviteDeepLink(token: string): string {
  return `${APP_SCHEME}://invite/${token}`;
}

/**
 * THE settle-request path template (T-9.7 hoist rider; R-money-16 + nav §2.3
 * registry row `/t/[tripId]/request/[requestId]`) — one home on purpose: the
 * server's wire `link` (settlements/requests-serialize.ts) and the client's
 * share composition (send-the-bill, gogo:// primary per the W2 ruling) BOTH
 * derive from this template, so the two forms can never drift into a
 * dead-end share link. The link carries the two UUIDs and NOTHING else
 * (PR #32 security posture — no params).
 */
function settleRequestPath(tripId: string, requestId: string): string {
  return `t/${tripId}/request/${requestId}`;
}

/**
 * Universal settle-request link — the Q1/Q2 wire `link` field
 * (`https://<LINK_DOMAIN>/t/<tripId>/request/<requestId>`, money spec §3.2).
 */
export function settleRequestUrl(tripId: string, requestId: string): string {
  return `https://${LINK_DOMAIN}/${settleRequestPath(tripId, requestId)}`;
}

/**
 * The `gogo://` mirror of the settle-request link (nav §2.3: scheme mirrors
 * paths) — the client-composed "primary" half of the P-9 send-the-bill
 * ruling (gogo:// primary + placeholder https until the P-14 domain buy).
 */
export function settleRequestDeepLink(tripId: string, requestId: string): string {
  return `${APP_SCHEME}://${settleRequestPath(tripId, requestId)}`;
}
