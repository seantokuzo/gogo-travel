---
paths: ["docs/**/*.md", "docs/*.md", ".specs/**/*.md"]
---

# Plan-Doc Homes

You're in a planning doc. These rules are non-negotiable — drift fragments the source of truth. (Planning is **file-based**: no Jira, no Confluence.)

## Canonical homes

| Path                               | Purpose                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `docs/PLANNING.md`                 | Roadmap — phases, scope, status rows                                              |
| `docs/QUEUE.md`                    | Working state — what's in flight, recently done                                   |
| `docs/STATE.md`                    | Active context — in-progress decisions, scratchpad (advisory cap ~800–1000 lines) |
| `docs/SECURITY.md`                 | Security posture — known issues, threat notes, fix status                         |
| `docs/SESSION-GUIDE.md`            | Session entry point / how to work in this repo                                    |
| `docs/decisions/ADR-NNN-<slug>.md` | Locked decisions, append-only                                                     |
| `docs/history/PHASE-NNN-<slug>.md` | Completed phase archives, append-only                                             |
| `.specs/<area>/<name>.spec.md`     | Feature/impl specs (existing topology — stays)                                    |

## One-home rule

Any new `docs/*.md` outside this list needs strong justification. Default when tempted: **fold it into a home above.**

- Roadmap / phase shape → `PLANNING.md`
- In-flight thinking, current task → `STATE.md`
- A decision to lock → new ADR
- A security finding → `SECURITY.md`

## Append-only: ADRs + history

Once merged, **never edit** an ADR or a `history/` archive. Change a locked decision by writing a **new** ADR that supersedes it (`Status: Superseded by ADR-XXX` on the old, `Supersedes: ADR-YYY` on the new). Correct a history mistake in the next archive, not by rewriting.

## STATE rotation (Claude does this, not the user)

- Decision locked → promote to a new ADR; remove from STATE.
- Phase merged → archive STATE notes to `docs/history/PHASE-NNN-<slug>.md`; flip the PLANNING row to `done` with a link.
- STATE > ~800–1000 lines → flag in post-merge handoff (advisory).

## Stable IDs

`P-N` phase · `T-N.M` task (task M under phase N) · `B-N` bug · `S-N` spike. **Never renumber.** New items get the next number; gaps are fine.

## .specs vs docs

`.specs/` = feature/impl specs (the contract for building a thing). `docs/` = project state & planning. Don't migrate one into the other. Data files for a skill co-locate with the skill, not in `docs/`.
