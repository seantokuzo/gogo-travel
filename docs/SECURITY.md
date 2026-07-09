# GoGo Travel — Security Posture

> Security findings table + fix order. One home for security state
> (see `.claude/rules/planning-doc-homes.md`). Threat-model detail lives in
> `docs/PLANNING.md § Security`; this file tracks concrete findings.

## Standing rules

- Secrets never in git. `.env` is gitignored and hook-blocked from reads.
- Auth, payments/split-money surfaces, migrations, and release workflows are
  **sensitive paths** — any blocking finding on them escalates the review.
- Money is integer cents (or `Decimal`) — never float.

## Findings

| ID | Date | Severity | Finding | Status | Fixed in |
|----|------|----------|---------|--------|----------|
| _(none yet)_ | | | | | |
