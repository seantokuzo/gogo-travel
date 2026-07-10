# S-2 Research: Expense Splitting + Settle-Up Integrations

> Evidence layer for P-2 splitting/settlement specs. Researched 2026-07-09
> (US-first), 5 search passes + 2 adversarial verifiers, **live HTTP probes
> 2026-07-09** for Cash App / PayPal.me / Venmo web / Zelle QR formats.

## TL;DR

Build our own splitting engine (Splitwise ToS explicitly bans competing apps
from its API). Ship the industry-standard pattern used by Splitwise, Tricount,
Settle Up, and Tab: **record-only ledger + per-user payment handles + deeplink
handoff.** Our app never moves money → no money-transmitter exposure. No rail
has webhooks/callbacks — settlement confirmation is user self-report,
everywhere, including Splitwise.

## Splitwise (HIGH)

- API alive, self-serve keys still issue — but ToS verbatim: may not "create
  an application that replicates existing Splitwise functionality or competes
  with Splitwise." Self-serve tier non-commercial only.
- Verdict: build our own engine (re-derive bartling's Tab/split model
  relationally). At most a future "export to Splitwise" — never a dependency.
- (The "Splitwise API was shut down" folklore is actually about Venmo's 2016
  API closure.)

## Exact link formats (implement these)

| Rail | Format | Confidence |
|------|--------|------------|
| Venmo (mobile) | `venmo://paycharge?txn=pay&recipients=<user>&amount=25.50&note=<urlenc>` — `txn=charge` to request | HIGH (pay) / MED-HIGH (charge — device-test pre-ship) |
| Venmo (web fallback) | `https://account.venmo.com/pay?txn=pay&recipients=<user>&amount=25.50&note=<enc>`; profile `https://account.venmo.com/u/<user>` | HIGH (probed) |
| Cash App | `https://cash.app/$<cashtag>/25.50` — dot-decimal 2dp; **no note support**; nonexistent cashtag → 404 (**free handle validation via HEAD**) | HIGH (probed) |
| PayPal.me | `https://paypal.me/<user>/25.50USD` — **always pin USD** or recipient's default currency applies | HIGH (probed) |
| Zelle | No link, no API, no scheme (standalone app died 2025-04). Copyable email/phone handle + amount shown adjacent. Optional QR `https://enroll.zellepay.com/qr-codes?data=<b64 JSON {token,name}>` — works today but unofficial, no amount field | HIGH today / LOW stability (QR) |
| Apple Cash | **Dead end** — no third-party write path (FinanceKit read-only, Tap to Cash no API, `shoebox://` = App Review rejection). Ceiling: instruction card + optional `sms:` handoff. Skip v1 | HIGH |

- `venmo://users/<username>` is DEAD (numeric-ID only) — skip.
- Venmo `recipients=` takes usernames only (strip `@`).
- iOS: `LSApplicationQueriesSchemes: [venmo]` for canOpenURL; Android 11+:
  `<queries>` element (or catch ActivityNotFoundException).

## Recommended v1 architecture

1. **Own splitting engine**: expenses → shares → computed pairwise balances →
   optional debt simplification. Settlement = first-class ledger entry
   (`type: settlement`). Money in integer cents (Law #2); expense + splits
   write atomically (transaction-capable driver — see backend persona).
2. **Per-user payment handles on profile** (all optional):
   `venmo_username`, `cashtag` (HEAD-validated), `paypalme_username`,
   `zelle_handle` (email/US phone) + display name. (Settle Up's data model —
   per-member `paymentHandles` — is the direct precedent.)
3. **Settle screen**: "You owe Alex $25.50" → one button per handle Alex has
   (Venmo additionally gated on canOpenURL); Zelle = copyable handle; always
   an unconditional **"Mark as settled"** (incl. record-cash). On return from
   a payment app: "Did you complete the payment?" → write settlement entry.
4. **Request flow (send the bill)**: GoGo universal link showing their share +
   payer's handles; optionally Venmo `txn=charge` after device test.

## ToS red lines

- Never scrape Venmo (that's the actual prohibited activity; deeplink handoff
  is fine and precedented — Venmo's own archived iOS SDK was this pattern,
  Splitwise does it live).
- No Splitwise API in a competing product.
- No private Apple schemes.
- PayPal settle-ups framed as personal (Friends & Family) in UX copy.
- **All deeplinks are best-effort UX sugar** — undocumented, killable without
  notice (Venmo briefly broke them 2024-03). "Mark as settled" must always
  work standalone.

## Pre-ship device tests (open MEDIUMs)

1. Venmo `txn=charge` on real iPhone/Android.
2. Venmo return-to-app behavior after payment.
3. Cash App/PayPal universal links launched from our app context (not in-app
   browser).

## Cautionary precedent

Settle Up REMOVED integrated PayPal when fees appeared; the only apps that
actually move money are region-gated bolt-ons (Splitwise Pay US limited
rollout, Tink UK/EU, bunq BE/NL/DE/FR). Record-only is the right v1 — and
maybe the right v-forever.
