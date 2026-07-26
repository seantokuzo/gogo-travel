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
