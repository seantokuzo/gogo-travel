# ADR-005: v1 is free, with entitlement seams in the data model

**Status:** Accepted
**Date:** 2026-07-09
**Supersedes:** none
**Superseded by:** none

## Context

Competitor research (`.specs/research/competitors.md`) found the category's
most-hated paywalls are offline mode and collaboration, while the things users
happily pay for are proactive alerts and AI features. GoGo v1 serves Sean +
friends, so revenue isn't a v1 goal — but retrofitting monetization later
means schema migrations and UX retrofits if nothing is prepared.

## Decision

**Everything is free in v1, but the data model ships with an entitlement
system from day one** (pattern proven in the-bach's freemium ADR): a
`plans`/`entitlements` structure keyed per user, checked at the feature seams
that could ever be gated (AI call caps, alerts, premium detail fields).
Gating later is config, not migration.

Standing product posture (from research, binding on future pricing):
- **Offline, collaboration, and expense splitting are free forever.**
- Candidates for future gating: AI usage above free caps, proactive alerts,
  premium place details.
- Affiliate deeplink revenue (invisible to users) may start any time.

## Alternatives considered

1. **Freemium from day one** — real billing (RevenueCat/StoreKit) in an early
   phase. Rejected: no v1 revenue goal; adds spec + build weight now.
2. **Everything free, no seams** — simplest. Rejected: later monetization
   becomes a migration + retrofit; seams are cheap now.

## Consequences

- Every AI endpoint checks entitlements + usage caps from day one (pairs with
  the AI kill-switch policy).
- A `plan` concept exists in `@gogo/shared` and the DB even while everyone is
  on `free`.
- Future pricing must honor the free-forever list above or supersede this ADR.
