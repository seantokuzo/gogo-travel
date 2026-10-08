---
paths: ["docs/**/*.md", "docs/*.md", ".specs/**/*.md"]
---

# Plan-Doc Homes

You're in a planning doc. These rules are non-negotiable — drift fragments the source of truth. (Planning is **file-based**: no Jira, no Confluence.)

## Canonical homes

| Path                               | Purpose                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `docs/PLANNING.md`                 | Roadmap — phases, scope, status rows                                          |
| `docs/QUEUE.md`                    | Live index — one ≤400 B row per live item, ≤20,480 B total (ADR-009)          |
| `docs/STATE.md`                    | Session brief, injected whole — ≤6,144 B hard cap (ADR-009)                   |
| `docs/SECURITY.md`                 | Security posture — known issues, threat notes, fix status                     |
| `docs/SESSION-GUIDE.md`            | Session entry point / how to work in this repo                                |
| `docs/decisions/ADR-NNN-<slug>.md` | Locked decisions, append-only                                                 |
| `docs/history/PHASE-NNN-<slug>.md` | Phase archives + `QUEUE-`/`STATE-<date>.md` snapshots; append-only, grep-only |
| `.specs/<area>/<name>.spec.md`     | Feature/impl specs (existing topology — stays)                                |

## One-home rule

Any new `docs/*.md` outside this list needs strong justification. Default when tempted: **fold it into a home above.**

- Roadmap / phase shape → `PLANNING.md`
- In-flight thinking, current task → `STATE.md`
- A decision to lock → new ADR
- A security finding → `SECURITY.md`

## Append-only: ADRs + history

Once merged, **never edit** an ADR or a `history/` archive. Change a locked decision by writing a **new** ADR that supersedes it (`Status: Superseded by ADR-XXX` on the old, `Supersedes: ADR-YYY` on the new). Correct a history mistake in the next archive, not by rewriting. Snapshot archives are byte-verbatim (`.prettierignore`d): a new file per rotation, never an edit.

## Budgets + rotation (ADR-009; Claude does this, not the user)

Caps are **bytes** (`wc -c`), never lines. CI (`check-doc-budgets`) fails an over-budget PR.

- `STATE.md` ≤ **6,144 B**; keep `## CURRENT DIRECTION`, `## NEXT SESSION`, `## In-flight decisions`, `## Blockers / Waiting on Sean` (exact lines). **Replace, don't append**; open items only.
- `QUEUE.md` ≤ **20,480 B**, every line ≤ **400 B**; not prettier-formatted. Keep `## Active`, `## Blocked`, `## Recently done` (exact lines; rotation finds rows by them). Live rows only, plus the newest 5 in Recently done. A `—` row's Title keeps its handle (first 40 chars of the text inside its first `**…**`, or of the whole Title cell if there is none).
- The row is the summary. Longer detail → the PR body, a `.specs/` spec, an ADR, or a STATE In-flight bullet.
- Decision locked → promote to a new ADR; remove from STATE.
- Phase merged → archive STATE notes to `docs/history/PHASE-NNN-<slug>.md`; flip the PLANNING row to `done` with a link.
- STATE ≥ 4,915 B or QUEUE ≥ 16,384 B (80%) → rotate: move narrative to a new `docs/history/STATE-<date>.md`; `node scripts/queue-rows.mjs rotate` moves done/cancelled rows to a new `QUEUE-<date>.md`.
- **Never Read `docs/history/QUEUE-*.md` or `STATE-*.md` whole.** One item, by ID: `grep -nE '^\| <ID> +\|' docs/QUEUE.md docs/history/QUEUE-*.md`.

## Stable IDs

`P-N` phase · `T-N.M` task (task M under phase N) · `B-N` bug · `S-N` spike. **Never renumber.** New items get the next number; gaps are fine.

## .specs vs docs

`.specs/` = feature/impl specs (the contract for building a thing). `docs/` = project state & planning. Don't migrate one into the other. Data files for a skill co-locate with the skill, not in `docs/`.
