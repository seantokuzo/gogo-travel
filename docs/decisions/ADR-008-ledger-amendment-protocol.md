# ADR-008: Feature-ledger amendment protocol — append a superseding note, never edit the step

**Status:** Proposed — direction approved by Sean's round-2 approval (2026-09-19, Q2-296, approve-all; the Rec read "needs an actual product call, not a rubber-stamp"); the concrete `amendments` key shape below is the write-back agent's design within that direction, **pending Sean's eyeball**. Moves to Accepted when Sean confirms the shape. Written back 2026-10-06.
**Date:** 2026-09-19
**Supersedes:** none
**Superseded by:** none

## Context

Law #8 makes `feature-ledger.json` append-only truth: `passes` flips only after
verified testing, and entries are never removed, weakened, or edited. That is the
right rule — and it has no answer for an entry whose verification step is
**wrong as written**.

The first real case is F-001 ("Money is integer cents at the schema level"), step 2:
_"Attempt INSERT of a fractional value into `expenses.amount_cents` via psql —
rejected by type."_ Probed 2026-07-16 (P-3 close, B-1): Postgres's **assignment
cast rounds `numeric → bigint`** (25.5 → 26), so a fractional numeric INSERT
**succeeds** — only a string literal `'25.5'` is rejected. The step can never be
satisfied, so F-001 cannot honestly flip `passes: true`, and Law #8 forbids
rewording the step. The real fractional-money protection is the app-boundary
`CentsSchema` (`z.int()` — F-007, verified) plus the negative-cents CHECKs (F-004,
verified); the ledger step simply names the wrong mechanism.

F-001 has sat `passes: false` since P-3 with B-1 `blocked` on "Sean's nod on an
amendment protocol". Without a protocol, every future wrong step has the same
two bad exits: edit it in place (violates the law) or leave the feature red forever.

## Decision

A ledger verification step that is unsatisfiable or incorrect as written is
**never edited, reworded, reordered, or removed**. It is corrected by an
**append-only superseding note** added alongside it.

1. **The original text is immutable.** Every string in an entry's `verification`
   array stays byte-identical, in place, forever. A superseded step is not "passed"
   — it is superseded.
2. **The note is a new optional sibling key `amendments`** on the same entry
   (an array, itself append-only). Each element is an object:
   - `supersedes_step` — 1-based index into `verification`
   - `date` — `YYYY-MM-DD`
   - `reason` — the evidence: what was probed, how to reproduce, what it showed
   - `replacement` — array of replacement step strings (one step may be replaced by
     several)
   - `approved_by` — who ruled and where (QUEUE row, ADR, or PR)

   A later correction to an amendment appends another amendment; amendments are
   never edited either.

3. **Effective verification** = the original steps, with each superseded step
   replaced by the `replacement` of its **latest** amendment. `passes` flips `true`
   only after **every effective step** has been executed with pasted evidence (Law #7).
4. **No weakening.** A replacement must protect the same invariant the entry
   claims — either by testing a mechanism that actually enforces it, or by naming
   which other ledger entries carry it (for F-001: F-007 `CentsSchema`, F-004
   CHECKs) and verifying the claim against them. Reviewers judge non-weakening;
   **each amendment needs Sean's explicit ruling** — this ADR approves the
   _protocol_ only. F-001's replacement wording needs Sean's sign-off in B-1's
   PR before `passes` flips. Every later amendment needs its own ruling.
5. **Mechanics preserve the audit trail.** Amendments are applied by **text
   insertion, not a JSON re-parse/re-emit** (Law #8's escape-style note). Insert
   the `amendments` key **between `verification` and `passes`** so the diff is
   pure additions — zero removed lines, and the `"passes"` line untouched. The
   later `passes` flip is then the file's only 1+/1− line. The audit is the
   numstat of the ledger file in the PR diff: an amendment PR shows `N 0`.
6. **Scope.** Verification steps only. A wrong `title`, `requirements`, `area`, or
   `phase` needs its own ADR — it is a traceability change, not a verification
   correction.

## Alternatives considered

- **Edit the step in place and rely on git history as the audit trail.** Rejected —
  this is exactly what Law #8 exists to prevent; "the history has it" is how
  ledgers get quietly weakened, and the eyeball audit stops being a one-glance check.
- **Delete F-001 and add a replacement entry (F-119).** Rejected — removing entries
  is forbidden, and the traceability from R-db-1 → F-001 → P-3's "ledger F-001..F-009
  verified" exit criterion would break.
- **Leave F-001 permanently `false` and add a corrected F-119.** Rejected — preserves
  append-only but leaves a permanently-red entry that the phase exit criterion
  can never satisfy, and duplicates the claim across two IDs.
- **Append a "SUPERSEDES step 2" string to the `verification` array itself.**
  Rejected — mixes meta-text into an array that tooling and reviewers read as
  steps, gives no structured evidence/approval fields, and the supersession is
  unmarked from the original step's side.

## Consequences

### Positive

- B-1 gets a path (once Sean confirms the key shape and the Law #8 wording is
  amended): F-001 gets honest, executable verification without touching the
  original step.
- A reusable, reviewable procedure — the next wrong step costs a PR, not an
  argument about Law #8.
- Diff-shape audit (`N 0` numstat) is mechanical and one-glance.

### Negative

- Entries gain a second place to read (`amendments`) — effective verification is a
  two-step lookup. Acceptable: the ledger is read by agents and reviewers, and the
  original step staying visible is the point.
- Each amendment costs a Sean ruling. Intended friction — it is Law #8.
- Law #8's current wording (`CLAUDE.md` Law #8; `docs/PLANNING.md` § P-2 tamper
  rule) says removing or editing ledger entries is forbidden; read literally,
  adding an `amendments` key inside an entry is an edit. The Law #8 wording
  amendment is a Sean-gated `CLAUDE.md` edit outside this ADR's PR and must land
  before B-1, or any reviewer applying Law #8 literally will block it.

### Neutral

- `feature-ledger.json` stays `.prettierignore`d; the new key does not change that.
- The ledger's top-level `version` is unchanged — `amendments` is an optional
  additive key.

## Links

- Law #8 — `CLAUDE.md`; `$schema_note` in `feature-ledger.json`
- B-1 (QUEUE) — the F-001 amendment is its build task; stays `blocked` on
  Sean confirming this shape and the Law #8 wording amendment landing first
- `docs/history/PHASE-003-foundations.md` § Ledger — the 2026-07-16 probe
- `.specs/OPEN-QUESTIONS.md` Round 2, Q2-296
