/**
 * Payment-rail link builders (T-9.7 / CMON-5 — R-cmoney-15..19, §2.5).
 * Pure over a counterparty's member-visible payment handles (R-cmoney-31:
 * `UserProfile` is the ONLY handle source) — so every URL is testable
 * byte-for-byte against the live-probed §2.5 formats table without a
 * component.
 *
 * Contract:
 *  - one rail per handle the counterparty HAS — absent handles produce
 *    nothing, never a disabled stub (R-cmoney-15);
 *  - Venmo/Cash App/Zelle are USD-only rails: hidden when the settle
 *    currency isn't USD; PayPal (multi-currency) survives (R-cmoney-18);
 *  - amounts render through the SHARED minor-unit formatter — dot-decimal
 *    with the currency's ISO-4217 digits, never float division (Law #2);
 *  - handles interpolate RAW: the shared write schemas are the charset
 *    chokepoint (1–30 chars of `[A-Za-z0-9_.-]`, `@`/`$` stripped at save),
 *    so no URL metacharacter can reach a rail link. The defensive re-strip
 *    below only covers pre-chokepoint dev rows; only the Venmo NOTE is
 *    URL-encoded (§2.5);
 *  - Zelle is copy-only — no link, no API, no scheme (research; R-cmoney-19).
 *
 * ToS red line (research): every deeplink is best-effort UX sugar, killable
 * without notice — nothing here may ever gate "Mark as settled".
 */
import type { UserProfile } from "@gogo/shared";
import { centsToMoneyText } from "@gogo/shared";

/**
 * R-cmoney-28 GATE — Venmo `txn=charge` ("Request via Venmo") ships OFF and
 * stays off until device test D1 (client money spec §3 checklist) passes on
 * real hardware at P-14. A REAL gate (R1): `buildRails` derives the venmo
 * `txn` param from this flag — `charge` iff true — so flipping it at P-14
 * actually enables the request rail. While false, the GoGo link is the ONLY
 * request transport and no built URL carries `txn=charge` (pinned).
 */
export const VENMO_TXN_CHARGE_ENABLED = false;

/** Feature flags `buildRails` derives behavior from — injectable so both
 * states are pinnable while the shipped default stays the module const. */
export interface RailFlags {
  /** R-cmoney-28: venmo `txn=charge` iff true (`txn=pay` otherwise). */
  venmoTxnCharge: boolean;
}

/** The five §3.4 member-visible handle fields — structural, so the settle
 * screen's roster profile and the request screen's `requester` both fit. */
export type RailHandles = Pick<
  UserProfile,
  "venmo_username" | "cashtag" | "paypalme_username" | "zelle_handle" | "zelle_display_name"
>;

export interface RailContext {
  /** Settle currency — the trip base by construction (R-money-13). */
  currency: string;
  /** Integer minor units (Law #2). */
  amountCents: number;
  /** Venmo note source — `GoGo: <trip name>`, URL-encoded (§2.5). */
  tripName: string;
}

export type Rail =
  /** App scheme first; `webUrl` when `canOpenURL` says no (R-cmoney-16). */
  | { kind: "venmo"; appUrl: string; webUrl: string }
  | { kind: "cashapp"; url: string }
  | { kind: "paypal"; url: string }
  /** Copy-only (R-cmoney-19): clipboard + adjacent display name + amount. */
  | { kind: "zelle"; handle: string; displayName: string };

/**
 * §2.5 shared formatting rule: cents → dot-decimal with the currency's
 * minor-unit digits, FIXED (2550 → `"25.50"`; JPY 2550 → `"2550"`).
 */
export function railAmountText(amountCents: number, currency: string): string {
  return centsToMoneyText(amountCents, currency);
}

/** Defensive prefix strip — the write schema already stores bare handles. */
const bare = (handle: string, prefix: "@" | "$"): string =>
  handle.startsWith(prefix) ? handle.replace(new RegExp(`^\\${prefix}+`), "") : handle;

/**
 * Build the rail list for one counterparty, §2.8 inventory order (venmo ·
 * cashapp · paypal · zelle). Every URL matches the §2.5 live-probed formats
 * verbatim; the venmo `txn` param derives from the R-cmoney-28 gate —
 * `pay` while `VENMO_TXN_CHARGE_ENABLED` is false (the shipped default).
 */
export function buildRails(
  handles: RailHandles,
  ctx: RailContext,
  flags: RailFlags = { venmoTxnCharge: VENMO_TXN_CHARGE_ENABLED },
): Rail[] {
  const usd = ctx.currency === "USD";
  const amount = railAmountText(ctx.amountCents, ctx.currency);
  const rails: Rail[] = [];

  if (usd && handles.venmo_username !== null) {
    const user = bare(handles.venmo_username, "@");
    const note = encodeURIComponent(`GoGo: ${ctx.tripName}`);
    const txn = flags.venmoTxnCharge ? "charge" : "pay";
    const params = `txn=${txn}&recipients=${user}&amount=${amount}&note=${note}`;
    rails.push({
      kind: "venmo",
      appUrl: `venmo://paycharge?${params}`,
      webUrl: `https://account.venmo.com/pay?${params}`,
    });
  }
  if (usd && handles.cashtag !== null) {
    // Cashtag stored bare, `$` prefixed at render; NO note support (§2.5).
    rails.push({
      kind: "cashapp",
      url: `https://cash.app/$${bare(handles.cashtag, "$")}/${amount}`,
    });
  }
  if (handles.paypalme_username !== null) {
    // ALWAYS pin the currency code or the recipient's default applies (§2.5).
    rails.push({
      kind: "paypal",
      url: `https://paypal.me/${handles.paypalme_username}/${amount}${ctx.currency}`,
    });
  }
  if (usd && handles.zelle_handle !== null) {
    rails.push({
      kind: "zelle",
      handle: handles.zelle_handle,
      // The write schema pairs the display name with the handle; a legacy
      // row missing one degrades to the handle itself, never a blank label.
      displayName: handles.zelle_display_name ?? handles.zelle_handle,
    });
  }
  return rails;
}
