# ADR-009: Plan-doc byte budgets — STATE is a brief, QUEUE is an index, history holds snapshots

**Status:** Accepted
**Date:** 2026-10-06
**Supersedes:** ADR-001 (in part — STATE cap, plan-doc rotation, history snapshot archives)
**Superseded by:** none

## Context

[ADR-001](ADR-001-naming-convention.md) gave the plan docs a **line** cap: STATE.md "~800–1000 lines,
advisory", and none at all for QUEUE.md. Lines turned out to be a bad unit, and the docs outgrew every
consumer. Measured at `4b0e5c4` (2026-10-06):

- **`docs/QUEUE.md` is 756,763 B in 240 lines**, longest line 4,754 characters. Stripping Prettier's table
  padding (`node scripts/queue-rows.mjs normalize`) leaves 201,968 B (~202 KB). 34 `done` rows still sit in Active/Blocked, and Recently done holds 84 more.
- **`docs/STATE.md` is 64,658 B in 997 lines.** A 997-line file "complied" with the 800–1000 line
  advisory. NEXT SESSION is a ~52 KB session log, and every In-flight bullet is already resolved.
- **The user-level hooks cut STATE at 8,000 characters.** In-flight and Blockers start at byte 53,431
  and 63,516, so the model is handed the operating model plus the start of a log, never the open
  decisions or blockers. Those hooks are also outside git (`~/.claude` is not a repo), so a fresh clone
  or a second engineer gets nothing.
- **`.githooks/pre-commit` blocks commits whose staged `.md` fail `prettier --check`.** That forces table
  padding back onto QUEUE.md on every commit, so no agent can keep the file small.

"Read `docs/QUEUE.md`" therefore costs ~757 KB to find one item.

Sean ruled on the as-written numbers, the rotation rule and the detail rule (Claude-config program,
QS Q1 (a), Q2 (a), Q3 (a)).

## Decision

**STATE.md becomes a small brief that is injected whole; QUEUE.md becomes a small index that is read
by ID; everything that used to bloat them moves to append-only snapshot archives. All caps are bytes,
enforced in CI.**

### 1. Budgets (hard caps)

| File            | Max bytes | Max line bytes | Required headings (exact line match)                                                                 |
| --------------- | --------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `docs/STATE.md` | 6,144     | none           | `## CURRENT DIRECTION`, `## NEXT SESSION`, `## In-flight decisions`, `## Blockers / Waiting on Sean` |
| `docs/QUEUE.md` | 20,480    | 400            | `## Active`, `## Blocked`, `## Recently done`                                                        |

- Caps are **UTF-8 bytes** (`wc -c`), never lines or characters. A line cap can be gamed with long
  lines (that is how both docs got here). Bytes are always ≥ characters, so a byte cap is also
  conservative against the 10,000-character cap on hook output.
- QUEUE.md requires its three section headings, as whole-line matches, because rotation and the close-out
  tooling locate rows by those headings.
- **Rotate-soon advisory** at 80% (STATE ≥ 4,915 B, QUEUE ≥ 16,384 B): to be surfaced by `/tidy-docs`
  (QS-T10, a later PR), not by CI.
- Enforced by `.github/scripts/check-doc-budgets.mjs` in the CI guard job: deterministic, no LLM
  ([ADR-003](ADR-003-local-in-session-reviews.md), Law 5). Its `BUDGETS` constant must match this
  table; changing a number is a new ADR.

### 2. STATE.md is the session brief

- **Whole file, injected** by a `SessionStart` hook at startup, resume, clear and compact (in every
  session where hooks run). **Not built in this PR: QS-T6 (a later PR) adds it.** The hook will be
  committed to the repo as `.claude/hooks/session-state.sh`, wired in `.claude/settings.json`. Repo-owned,
  so it will reach a fresh clone, a second engineer and non-loop `claude -p` sessions. Subagents will not
  be injected (`SessionStart` is per session); spawn prompts carry the item ID instead.
- **The hook will never fail a session** (QS-T6). It will always exit 0. If STATE.md were ever over
  9,000 B it will emit whole lines up to 8,000 B plus a notice naming the overage, so total output stays
  under the 10,000-character cap (past it the platform swaps the output for a path and a 2,000-character
  preview).
- **A repo that ships that hook owns STATE injection.** The user-level `SessionStart` and refresh hooks
  stand down there: they keep their mtime marker and, on a change, emit a pointer instead of 8 KB. That
  stand-down is already live at user level, keyed on the existence of `.claude/hooks/session-state.sh`, so
  it takes effect the moment QS-T6 adds that file.
- **Where hooks are off** (a loop session started with hooks disabled, `--bare`), nothing injects it, so the
  entry point reads `docs/STATE.md` explicitly. At ≤ 6 KiB that is cheap.
- **Template** (section sizes are guidance; the hard cap is the file total). Replace, don't append:

  | Section                         | Guidance  | Holds                                                                               |
  | ------------------------------- | --------- | ----------------------------------------------------------------------------------- |
  | `## CURRENT DIRECTION`          | ≤ 700 B   | Operating model and current focus. The product pitch lives in CLAUDE.md             |
  | `## NEXT SESSION`               | ≤ 1,400 B | Waves and the first step, by ID                                                     |
  | `## In-flight decisions`        | ≤ 1,500 B | **Open** decisions only; one bullet of ≤ 3 lines, each ending `(detail: <pointer>)` |
  | `## Blockers / Waiting on Sean` | ≤ 1,000 B | Open blockers                                                                       |
  | `## Landmines`                  | ≤ 600 B   | Still-true failed approaches, one line plus a pointer each                          |
  | `## Archives`                   | ≤ 250 B   | Latest `STATE-` / `QUEUE-` snapshot and `docs/history/README.md`                    |

  A resolved decision leaves STATE. A locked one becomes an ADR; narrative and session logs go to a
  `docs/history/STATE-<date>.md`; work items belong in QUEUE.

### 3. QUEUE.md is a live index, read by ID

- One table row per **live** item (`queued`, `in-progress`, `blocked`, `deferred`), no narrative. The
  three tables stay, because every command and skill already describes tables. Columns: Active
  `ID | Title | Status | Priority | Depends on`; Blocked `ID | Title | Status | Priority | Blocker`;
  Recently done (newest 5 only) `ID | Title | Done`.
- Cells are separated by a pipe with a single space of padding on each side; a literal pipe inside a
  cell is `\|`. Title ≤ 160 characters is the target; the **whole line ≤ 400 B is the hard cap**.
- An ID is `P-N`, `T-N.M`, `B-N`, `S-N` (or a legacy compound such as `B-17/18`), or `—`. For a `—` row
  (113 of them today) the Title must contain that row's **handle** verbatim: the text inside the first
  `**…**` of its original Title cell (or the whole Title cell if there is none), the first 40 characters
  of it, trailing whitespace trimmed. That is the grep key to its archived detail. Giving those rows IDs
  is an ADR-001-class question and is not decided here.
- Execution order stays **derived** (ADR-001): the highest-priority `queued` row whose `depends_on` are all
  `done`. IDs never renumber. The status enum is unchanged ([ADR-002](ADR-002-status-enum-lock.md)).
- **Not Prettier-formatted, on purpose** (`.prettierignore`): padding re-inflates the file several-fold and
  the pre-commit gate would force it back. The CI byte cap is the backstop if something re-pads it.
- **Detail is read by ID, never by whole file.** Recipes (the archives are never Read whole; hand a worker
  the ID and the recipe, not the row text):

  ```bash
  grep -nE '\| (queued|in-progress) \|' docs/QUEUE.md                  # candidates
  grep -nE '^\| <ID> +\|' docs/QUEUE.md docs/history/QUEUE-*.md        # one item, live + history
  grep -nF '<handle>' docs/QUEUE.md docs/history/QUEUE-*.md            # an ID-less item
  grep -n '<ID or phrase>' docs/history/STATE-*.md                     # STATE history
  ```

- **Where new detail goes.** The row is the summary (about 60 words fit in 400 B). Longer material goes to
  the PR body once work starts, a `.specs/` spec if it is a requirement, an ADR or a STATE In-flight
  bullet if it is a decision. There is no new detail mechanism.

### 4. `docs/history/` also holds snapshot archives

- `docs/history/QUEUE-<DATE>.md` and `docs/history/STATE-<DATE>.md`. `<DATE>` is the UTC commit day
  (`date -u +%F`); add `-2`, `-3` if that name is taken. `docs/history/` is an existing home, so ADR-001's
  six homes are unchanged. They sit beside the `PHASE-NNN-<slug>.md` phase archives; they are not phase
  archives.
- **Append-only, stricter than phase archives:** never edited after merge, not even to fix a link. They are
  **not auto-loaded and grep-only**. `.prettierignore` keeps them byte-verbatim, and the pre-commit
  allowlist accepts them as new files.
- Exact header of a QUEUE snapshot (the marker line is what the lossless check cuts on):

  ```markdown
  # QUEUE snapshot — <DATE>

  > Append-only archive ([ADR-009](../decisions/ADR-009-plan-doc-byte-budgets.md)). Every row of
  > `docs/QUEUE.md` as of `<BASE_SHA>`, with prettier cell padding stripped (whitespace-only:
  > `node scripts/queue-rows.mjs normalize`). Live status is in `docs/QUEUE.md`, not here.
  > **Never read this file whole.** Grep by ID: `grep -nE '^\| B-30 +\|' docs/history/QUEUE-*.md`;
  > ID-less rows: `grep -nF '<handle>' docs/history/QUEUE-*.md`.

  <!-- verbatim snapshot below -->
  ```

  The body is `normalize(old QUEUE.md)`: the same rows with cell padding stripped, nothing else changed. A
  **rotation** archive has the same shape; its first blockquote line reads "Rows rotated out of
  `docs/QUEUE.md` on <DATE> (status done/cancelled, and Recently done beyond the newest N)", then the
  marker, then the moved rows under their source section tables.

- A STATE snapshot has the same header shape ("Byte-verbatim copy of `docs/STATE.md` as of `<BASE_SHA>`
  …"), the same marker, then the old STATE.md **byte for byte**.
- Lossless check for either kind: `sed '1,/^<!-- verbatim snapshot below -->$/d' <archive> | cmp - <expected>`.

### 5. Rotation

- `node scripts/queue-rows.mjs rotate` is to run at `/sprint-close` (QS-T11, a later PR), and whenever
  `/tidy-docs` reports QUEUE at ≥ 80% (QS-T10, a later PR). Until those land, run it by hand. Rows with status `done` or `cancelled` leave Active and Blocked; Recently done keeps the
  **newest 5** as one-liners. `queued`, `in-progress`, `blocked` and `deferred` stay.
- Moved rows go to a **new** archive. The command refuses to overwrite an existing one (exit 2, nothing
  touched), rewrites QUEUE.md with every other line byte-identical, then runs `verify` itself and
  restores both files if it fails.
- **Lossless by construction.** `verify` checks that every normalized row of the old file is in the
  archive(s) as a multiset (a duplicated row cannot hide), that every ID cell survives, and, with
  `--live`, that every live row is in the new index by ID or handle.
- A closed row that still mentions open work (`scripts/queue-rows.mjs residual` lists them) gets a written
  disposition in the PR body before it leaves: covered by another item, a new short `queued` row, or none.
- STATE is rotated by rewriting the brief and moving what left it to a new `docs/history/STATE-<date>.md`.

### What changes in ADR-001

Only: the STATE "~800–1000 lines advisory" cap becomes the hard byte cap above; the QUEUE row becomes a
live index with caps and rotation of closed rows; the history row also holds snapshot archives; and the
"STATE heavy → flag in post-merge handoff" rotation rule becomes the byte-cap rule above. The six homes,
stable IDs, derived order and PR sizing stand. ADR-001 stays `Accepted`; its `Superseded by:` header line
is the only edit to it.

## Alternatives considered

1. **Keep line caps, only strip padding.** Rejected: QUEUE lands at ~64 KB and STATE is unchanged. The
   current 997-line, 64 KB STATE already satisfied a line cap.
2. **Rotate closed rows only, strip padding.** Rejected: ~64 KB live QUEUE, three times the target, with
   no per-row home for the rest.
3. **A `## Detail` section inside QUEUE.md** (`### <ID>` blocks). Rejected: a ~70 KB file, so whole-file
   reads still cost 70 KB, and the caps would need to be section-aware.
4. **One file per item (`docs/queue/<ID>.md`).** Rejected: a new docs directory is exactly what
   ADR-001's homes rule exists to prevent.
5. **A GitHub Issue per item that needs detail.** Rejected for future detail: the repo has no issues, and
   it puts a network dependency into planning.
6. **A separate `docs/STATE-brief.md`.** Rejected: a seventh top-level docs file, two files to keep in
   sync by hand, and `/sprint-start` and the orchestrator would keep reading the 64 KB one.
7. **Import STATE with `@docs/STATE.md` in CLAUDE.md.** Rejected: it lands in every subagent (+6 KB a spawn,
   and "dispatch T-7.10" text in a reviewer's context), and it counts as instructions, not context.
8. **Keep the user-level hook and point it at the brief.** Rejected: unversioned, so a fresh clone or a
   second engineer still gets nothing, and it leaves "STATE is auto-injected" false for them.

## Consequences

### Positive

- Once the hook (QS-T6) lands, every interactive session starts with the whole open picture in ≤ 6 KiB
  instead of a truncated head that never reached the open decisions or blockers.
- Picking work costs one ≤ 20 KB read or a single grep, and the detail of any item is one grep away.
- Rotation cannot lose a row: `verify` is mechanical, and the archive is the old file with whitespace
  stripped.
- Regrowth fails CI in bytes, whatever the line lengths.

### Negative

- QUEUE rows are summaries. Existing detail lives in an archive reached by grep, and new detail has no
  home inside QUEUE.md (PR body, spec, ADR, STATE bullet).
- QUEUE.md is hand-formatted. A formatter run from outside the repo root does not see `.prettierignore`
  and would re-pad it; the byte cap catches that, after the fact.
- A 6,144 B STATE forces curation at every handoff. Narrative must be moved out, not left to accumulate.
- Subagents do not see STATE, and a session with hooks off gets it only if its entry point reads it.
- Depends on a user-level hook change, made outside git on each machine, to avoid injecting STATE twice. A
  machine without it still works but gets the brief plus the old truncated head.
- Three small pieces of plumbing to keep: the `.prettierignore` block, the pre-commit allowlist regex and
  the CI check.

### Neutral

- `docs/PLANNING.md` (~54 KB) is not budgeted here. It is not injected; budgeting it is a separate call.
- The 113 ID-less QUEUE rows stay ID-less, found by handle.
- Phase archives (`PHASE-NNN-<slug>.md`) are unchanged and may still be edited for broken links or factual
  errors; snapshot archives may not.

## Links

- [ADR-001](ADR-001-naming-convention.md) — the plan-doc homes and rotation rules this amends in part
- [ADR-002](ADR-002-status-enum-lock.md) — the status enum QUEUE keeps using
- [ADR-003](ADR-003-local-in-session-reviews.md) — no LLM in CI; why the budget check is a plain script
- `.claude/rules/planning-doc-homes.md` — the path-scoped rule that carries the caps day to day
- [`../history/README.md`](../history/README.md) — snapshot-archive rules
- `scripts/queue-rows.mjs` (`normalize`, `verify`, `rotate`, `residual`),
  `.github/scripts/check-doc-budgets.mjs` — the implementations of sections 5 and 1. Section 2's
  `.claude/hooks/session-state.sh` is not built yet (QS-T6, a later PR).
