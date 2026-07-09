---
name: tidy-docs
description: Surface plan-doc drift on demand. Lists files violating the 6-homes rule, oversized STATE.md, orphan archives, broken ADR cross-references, and proposes consolidations. Read-only — never auto-fixes; user decides every action.
---

# /tidy-docs — Plan-Doc Hygiene Audit

A read-only audit that surfaces drift from this repo's naming convention (locked in `docs/decisions/ADR-001-naming-convention.md`). Invoked by the user as `/tidy-docs`, or by Claude during post-merge handoff when STATE.md feels heavy.

This skill **never auto-fixes**. It produces a structured report; the user picks which suggestions to apply. That's the point — auto-fixes on planning docs erode trust in the source of truth.

## When to run

- User invokes `/tidy-docs` directly
- Post-merge handoff and STATE.md is heavy or many phases just merged
- You notice docs/ has files you don't recognize
- Before a major phase boundary (good time to consolidate)

## The 6-homes allowlist

| Path | Purpose |
|------|---------|
| `docs/PLANNING.md` | Roadmap |
| `docs/QUEUE.md` | Working state |
| `docs/STATE.md` | Active context |
| `docs/SESSION-GUIDE.md` | Session entry point |
| `docs/decisions/README.md` | Index for ADRs |
| `docs/decisions/ADR-template.md` | Template |
| `docs/decisions/ADR-NNN-<slug>.md` | Locked decisions |
| `docs/history/README.md` | Index for archives |
| `docs/history/PHASE-template.md` | Template |
| `docs/history/P-NNN-<slug>.md` | Phase archives |

Anything else under `docs/` is a candidate ORPHAN. The repo-root `README.md`, `CHANGELOG.md`, `LICENSE` are NOT planning docs and are explicitly out of scope.

---

## Step 1 — List planning docs and flag orphans

```bash
# Every markdown file under docs/
find docs -type f -name '*.md' | sort
```

For each file, classify against the allowlist above. Anything that doesn't match goes into the **Orphan** bucket. Be precise: `docs/decisions/ADR-001-naming-convention.md` matches; `docs/decisions/notes.md` does not.

## Step 2 — STATE.md size check

```bash
wc -l docs/STATE.md
```

If line count > 1000, flag for consolidation. Then scan the file for sections that look "locked" — decisions older than the most recent phase merge, sections with no edits in the last N commits — and propose promotion to ADRs.

```bash
# Last edit per heading section (rough heuristic)
git log --follow --since='30 days ago' --oneline -- docs/STATE.md
```

Heuristic: a section that hasn't been touched since the previous phase merged AND reads like a decision (not a scratchpad) is a promotion candidate.

## Step 3 — ADR cross-reference integrity

For each ADR, parse `Status:` and `Supersedes:` / `Superseded by:` lines.

```bash
grep -n -E '^Status:|^Supersedes:|^Superseded by:' docs/decisions/ADR-*.md
```

Flag broken pairs:

- ADR claims `Superseded by: ADR-XXX` but ADR-XXX doesn't exist
- ADR-XXX claims `Supersedes: ADR-YYY` but ADR-YYY's Status doesn't reference back
- An ADR with `Status: Active` that another ADR claims to supersede

## Step 4 — PLANNING.md / history alignment

```bash
ls docs/history/P-*.md 2>/dev/null
```

For every `P-NNN-*.md` in `docs/history/`, verify `PLANNING.md` has a corresponding row with status `done` and a link to the archive. Flag mismatches both ways:

- History file exists, no `done` row in PLANNING
- PLANNING has `done` row, no history file

## Step 5 — QUEUE "Recently done" trim suggestion

Open `docs/QUEUE.md`, locate the "Recently done" section. If it has more than 5 entries, propose trimming the oldest. Concise summaries can move to PLANNING.md status updates if not already there; full notes already live in `docs/history/`, so nothing is lost.

## Step 6 — Output report

Markdown, posted as the response. Stay under ~80 lines unless drift is significant. Sections (skip empty ones):

```
## /tidy-docs report

🚨 Orphan files (outside the 6-homes allowlist)
- `docs/foo.md` — proposed action: fold into PLANNING.md or write ADR

📦 STATE.md candidates for promotion to ADR
- "Decision: …" (lines NN-MM, untouched since phase P-003 merged)

🔗 Broken ADR cross-references
- ADR-002 says `Superseded by: ADR-007` but ADR-007 missing

📚 PLANNING ↔ history mismatches
- `docs/history/P-002-foo.md` exists, no `done` row in PLANNING.md

📋 QUEUE trim suggestions
- "Recently done" has 8 entries; trim oldest 3
```

If everything is clean: `✨ Plan-doc hygiene clean — nothing to tidy.`

---

## Skepticism rules

- **Don't flag repo-root files** — `README.md`, `CHANGELOG.md`, `LICENSE` aren't planning docs
- **Don't flag templates** — `ADR-template.md` and `PHASE-template.md` are allowlisted
- **Don't flag `decisions/README.md` or `history/README.md`** — index files are allowlisted
- **Don't fix anything** — every finding is a suggestion; the user decides

## Override

If the user says "skip the X check" (e.g., "just check orphans"), narrow scope to that step and return.

---

## Quick reference

```bash
# All planning docs
find docs -type f -name '*.md' | sort

# STATE size
wc -l docs/STATE.md

# ADR statuses
grep -n -E '^Status:|^Supersedes:|^Superseded by:' docs/decisions/ADR-*.md

# History archives
ls docs/history/P-*.md 2>/dev/null

# PLANNING done rows
grep -n -i 'done' docs/PLANNING.md
```
